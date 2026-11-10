/* 图片 / 截图 · in-browser OCR. PP-OCRv5 mobile detection + recognition through onnxruntime-web
   (WebAssembly SIMD, one thread). Nothing is fetched until the visitor clicks; every file comes from a
   pinned version and is refused unless its size and SHA-256 match src/ocr/pins.json (the same pins as
   backend/evals/ocr/protocol.json). Ported from CreditLens 0.35 (web/src/tablecheck/ocr.ts); the
   additions are per-character boxes from the CTC time steps. */
import pins from "./pins.json";
import type { Box, OcrLine } from "./layout";

type FileSpec = { bytes: number; sha256_hex?: string; sha256_base64?: string };
interface OrtTensor { dims: readonly number[]; data: Float32Array }
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  inputMetadata?: readonly { name: string; shape?: readonly (number | string)[] }[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  env: { wasm: Record<string, unknown> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
}

export const PINS = pins;
export const RUNTIME_FILES = Object.entries(pins.runtime.files as Record<string, FileSpec>);
export const WEIGHT_FILES = Object.entries(pins.weights.files as Record<string, FileSpec>);
export const DOWNLOAD_BYTES = [...RUNTIME_FILES, ...WEIGHT_FILES].reduce((n, [, f]) => n + f.bytes, 0);
const PP = pins.postprocess;

export class LoadError extends Error {
  constructor(public code: "http" | "hash" | "network" | "runtime" | "cancelled", public file: string, detail = "") {
    super(`${code}: ${file}${detail ? ` (${detail})` : ""}`);
  }
}

export type CanRun = { ok: true } | { ok: false; reason: "no_wasm" | "no_simd" | "insecure" | "no_canvas" };

/** Where the shipped path cannot run, the page hides the controls instead of failing later. */
export function canRun(): CanRun {
  if (typeof WebAssembly !== "object" || typeof WebAssembly.validate !== "function") return { ok: false, reason: "no_wasm" };
  // i32.const 0; i8x16.splat; i8x16.popcnt (the wasm-feature-detect SIMD probe)
  const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  if (!WebAssembly.validate(simd)) return { ok: false, reason: "no_simd" };
  if (typeof crypto === "undefined" || !crypto.subtle) return { ok: false, reason: "insecure" };
  if (typeof document === "undefined" || typeof createImageBitmap !== "function" || typeof document.createElement("canvas").getContext !== "function") {
    return { ok: false, reason: "no_canvas" };
  }
  return { ok: true };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}

/** Fetch one pinned file; refuse it unless size and SHA-256 match. */
export async function fetchChecked(url: string, name: string, spec: FileSpec, onBytes: (n: number) => void, signal: AbortSignal): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: "omit" });
  } catch (error) {
    if (signal.aborted) throw new LoadError("cancelled", name);
    throw new LoadError("network", name, String(error));
  }
  if (!response.ok || !response.body) throw new LoadError("http", name, `${response.status}`);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
      onBytes(value.length);
      if (size > spec.bytes * 1.05 + 1024) throw new LoadError("hash", name, "larger than pinned");
    }
  } catch (error) {
    if (signal.aborted) throw new LoadError("cancelled", name);
    throw error instanceof LoadError ? error : new LoadError("network", name, String(error));
  }
  const buffer = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    buffer.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  const ok = spec.sha256_hex ? toHex(digest) === spec.sha256_hex : toBase64(digest) === spec.sha256_base64;
  if (!ok || size !== spec.bytes) throw new LoadError("hash", name);
  return buffer.buffer;
}

export interface Engine { det: OrtSession; rec: OrtSession; chars: string[]; ort: Ort; initSeconds: number; downloadedBytes: number }

/** Weights are served from this site (copied from the pinned Hugging Face revision at build time). */
export const weightBase = () => new URL(pins.weights.served_from.site_path, new URL(import.meta.env.BASE_URL, location.origin)).href;

export async function loadEngine(onProgress: (loaded: number, total: number, file: string) => void, signal: AbortSignal): Promise<Engine> {
  let loaded = 0;
  const bump = (file: string) => (n: number) => {
    loaded += n;
    onProgress(loaded, DOWNLOAD_BYTES, file);
  };
  const fetched: Record<string, ArrayBuffer> = {};
  for (const [name, spec] of RUNTIME_FILES) fetched[name] = await fetchChecked(pins.runtime.base_url + name, name, spec, bump(name), signal);
  for (const [name, spec] of WEIGHT_FILES) fetched[name] = await fetchChecked(weightBase() + name, name, spec, bump(name), signal);
  if (signal.aborted) throw new LoadError("cancelled", "");
  const started = performance.now();
  const w = window as unknown as { ort?: Ort; __adproofOrtInjected?: boolean };
  // Only the hash-checked runtime may run: refuse a global `ort` this module did not inject itself.
  if (w.ort && !w.__adproofOrtInjected) throw new LoadError("runtime", "ort.wasm.min.js", "unexpected global runtime");
  if (!w.ort) {
    const url = URL.createObjectURL(new Blob([fetched["ort.wasm.min.js"]], { type: "text/javascript" }));
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new LoadError("runtime", "ort.wasm.min.js"));
      document.head.append(s);
    });
    w.__adproofOrtInjected = true;
  }
  const ort = w.ort;
  if (!ort) throw new LoadError("runtime", "ort.wasm.min.js", "no global");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = fetched["ort-wasm-simd-threaded.wasm"];
  ort.env.wasm.wasmPaths = {
    mjs: URL.createObjectURL(new Blob([fetched["ort-wasm-simd-threaded.mjs"]], { type: "text/javascript" })),
    wasm: URL.createObjectURL(new Blob([fetched["ort-wasm-simd-threaded.wasm"]], { type: "application/wasm" })),
  };
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  let det: OrtSession;
  let rec: OrtSession;
  try {
    det = await ort.InferenceSession.create(new Uint8Array(fetched["ch_PP-OCRv5_det.onnx"]), options);
    rec = await ort.InferenceSession.create(new Uint8Array(fetched["ch_PP-OCRv5_rec.onnx"]), options);
  } catch (error) {
    throw new LoadError("runtime", "InferenceSession", String(error));
  }
  const dict = new TextDecoder().decode(fetched["ch_PP-OCRv5_dict.txt"]).split(/\r?\n/);
  if (dict[dict.length - 1] === "") dict.pop();
  return { det, rec, chars: ["", ...dict, " "], ort, initSeconds: (performance.now() - started) / 1000, downloadedBytes: loaded };
}

// ------------------------------------------------------------------------------------------ inference

function fixedDims(session: OrtSession): (number | null)[] | null {
  const shape = session.inputMetadata?.[0]?.shape;
  return shape ? shape.map((d) => (typeof d === "number" && d > 0 ? d : null)) : null;
}

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
}

export interface OcrTimings { det: number; rec: number; lines: number; boxes: number }

/** Full-image OCR: text boxes from the detector, text and per-character boxes from the recogniser, in image pixels. */
export async function recognise(engine: Engine, source: HTMLCanvasElement): Promise<{ lines: OcrLine[]; timings: OcrTimings }> {
  const { ort } = engine;
  const W0 = source.width;
  const H0 = source.height;
  const t0 = performance.now();
  const fixed = fixedDims(engine.det);
  const scale = Math.min(1, PP.det_max_side / Math.max(W0, H0));
  const dw = fixed?.[3] ?? Math.max(32, Math.round((W0 * scale) / 32) * 32);
  const dh = fixed?.[2] ?? Math.max(32, Math.round((H0 * scale) / 32) * 32);
  const dctx = canvas(dw, dh);
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(source, 0, 0, dw, dh);
  const px = dctx.getImageData(0, 0, dw, dh).data;
  const plane = dw * dh;
  const input = new Float32Array(3 * plane);
  // PaddleOCR order: BGR, (v/255 - mean) / std with ImageNet statistics.
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < plane; i++) {
    const r = px[i * 4] / 255;
    const g = px[i * 4 + 1] / 255;
    const b = px[i * 4 + 2] / 255;
    input[i] = (b - mean[0]) / std[0];
    input[plane + i] = (g - mean[1]) / std[1];
    input[2 * plane + i] = (r - mean[2]) / std[2];
  }
  const detOut = await engine.det.run({ [engine.det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, dh, dw]) });
  const prob = detOut[engine.det.outputNames[0]].data;
  const boxes = dbBoxes(prob, dw, dh)
    .map((b) => ({ x0: Math.max(0, (b.x0 * W0) / dw), y0: Math.max(0, (b.y0 * H0) / dh), x1: Math.min(W0, (b.x1 * W0) / dw), y1: Math.min(H0, (b.y1 * H0) / dh) }))
    .filter((b) => b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2);
  const t1 = performance.now();

  const sctx = source.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const order = boxes.map((b, i) => ({ b, i, ratio: (b.x1 - b.x0) / (b.y1 - b.y0) })).sort((a, b) => a.ratio - b.ratio);
  const results: (OcrLine | null)[] = new Array(boxes.length).fill(null);
  const recFixed = fixedDims(engine.rec);
  const H = PP.rec_height;
  for (let k = 0; k < order.length; k += PP.rec_batch) {
    const batch = order.slice(k, k + PP.rec_batch);
    const W = recFixed?.[3] ?? Math.max(PP.rec_min_width, Math.ceil(H * Math.max(...batch.map((x) => x.ratio))));
    const n = batch.length;
    const data = new Float32Array(n * 3 * H * W);
    const widths: number[] = [];
    batch.forEach(({ b }, j) => {
      const bw = Math.max(1, Math.round(b.x1 - b.x0));
      const bh = Math.max(1, Math.round(b.y1 - b.y0));
      const tw = Math.min(W, Math.max(1, Math.ceil((H * bw) / bh)));
      widths.push(tw);
      const ctx = canvas(tw, H);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sctx.canvas, Math.round(b.x0), Math.round(b.y0), bw, bh, 0, 0, tw, H);
      const p = ctx.getImageData(0, 0, tw, H).data;
      const off = j * 3 * H * W;
      const area = H * W;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < tw; x++) {
          const s = (y * tw + x) * 4;
          const d = y * W + x;
          data[off + d] = (p[s + 2] / 255 - 0.5) / 0.5;
          data[off + area + d] = (p[s + 1] / 255 - 0.5) / 0.5;
          data[off + 2 * area + d] = (p[s] / 255 - 0.5) / 0.5;
        }
      }
    });
    const out = await engine.rec.run({ [engine.rec.inputNames[0]]: new ort.Tensor("float32", data, [n, 3, H, W]) });
    const tensor = out[engine.rec.outputNames[0]];
    const [, T, C] = tensor.dims as number[];
    batch.forEach(({ b, i }, j) => {
      const decoded = ctcDecode(tensor.data, j * T * C, T, C, engine.chars);
      if (!decoded.text.trim()) return;
      const box: Box = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
      const bw = Math.max(1, Math.round(b.x1 - b.x0));
      results[i] = { text: decoded.text, conf: decoded.conf, box, chars: charBoxes(decoded, box, { T, W, tw: widths[j], bw }) };
    });
  }
  const t2 = performance.now();
  const lines = results.filter((x): x is OcrLine => x !== null);
  return { lines, timings: { det: (t1 - t0) / 1000, rec: (t2 - t1) / 1000, lines: lines.length, boxes: boxes.length } };
}

/** DB post-processing for axis-aligned text: threshold, 4-connected components, mean-probability
    score, then the usual unclip by area × ratio / perimeter. */
export function dbBoxes(prob: Float32Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number; score: number }[] {
  const seen = new Uint8Array(w * h);
  const out: { x0: number; y0: number; x1: number; y1: number; score: number }[] = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= PP.det_thresh) continue;
    let top = 0;
    let sum = 0;
    let count = 0;
    let minx = w;
    let miny = h;
    let maxx = -1;
    let maxy = -1;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      sum += prob[p];
      count += 1;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (x > 0 && !seen[p - 1] && prob[p - 1] > PP.det_thresh) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && !seen[p + 1] && prob[p + 1] > PP.det_thresh) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && !seen[p - w] && prob[p - w] > PP.det_thresh) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && !seen[p + w] && prob[p + w] > PP.det_thresh) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    if (Math.min(bw, bh) < PP.min_size || out.length >= 3000) continue;
    const score = sum / count;
    if (score < PP.box_thresh) continue;
    const d = (bw * bh * PP.unclip) / (2 * (bw + bh));
    out.push({ x0: Math.max(0, minx - d), y0: Math.max(0, miny - d), x1: Math.min(w, maxx + 1 + d), y1: Math.min(h, maxy + 1 + d), score });
  }
  return out;
}

export interface Decoded { text: string; conf: number; tokens: string[]; steps: number[] }

/** Greedy CTC decoding; for each emitted token, the mean time step of its run (used for its x position). */
export function ctcDecode(data: Float32Array, offset: number, T: number, C: number, chars: string[]): Decoded {
  const tokens: string[] = [];
  const steps: number[] = [];
  let last = -1;
  let sum = 0;
  let runStart = 0;
  let open = -1; // index into tokens of the run still being extended
  for (let t = 0; t < T; t++) {
    let best = 0;
    let bestP = -Infinity;
    const base = offset + t * C;
    for (let c = 0; c < C; c++) {
      const v = data[base + c];
      if (v > bestP) {
        bestP = v;
        best = c;
      }
    }
    if (best !== last) {
      if (open >= 0) steps[open] = (runStart + t - 1) / 2;
      open = -1;
      if (best !== 0) {
        tokens.push(chars[best] ?? "");
        sum += bestP;
        open = tokens.length - 1;
        runStart = t;
      }
    }
    last = best;
  }
  if (open >= 0) steps[open] = (runStart + T - 1) / 2;
  return { text: tokens.join(""), conf: tokens.length ? sum / tokens.length : 0, tokens, steps };
}

/** Per UTF-16 unit of the line text: its x range in image pixels, from the CTC step of its token. */
export function charBoxes(d: Decoded, box: Box, g: { T: number; W: number; tw: number; bw: number }): [number, number][] {
  const centres = d.steps.map((s) => {
    const xin = Math.min(g.tw, ((s + 0.5) * g.W) / g.T);
    return Math.min(box.x1, Math.max(box.x0, box.x0 + (xin * g.bw) / g.tw));
  });
  const out: [number, number][] = [];
  centres.forEach((c, i) => {
    const prev = i > 0 ? centres[i - 1] : null;
    const next = i < centres.length - 1 ? centres[i + 1] : null;
    const half = next !== null ? (next - c) / 2 : prev !== null ? (c - prev) / 2 : (box.x1 - box.x0) / 2;
    const left = prev !== null ? (prev + c) / 2 : Math.max(box.x0, c - half);
    const right = next !== null ? (c + next) / 2 : Math.min(box.x1, c + half);
    for (let u = 0; u < d.tokens[i].length; u++) out.push([left, right]);
  });
  return out;
}
