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

export interface Engine { det: OrtSession; rec: OrtSession; chars: string[]; ort: Ort; initSeconds: number; downloadedBytes: number; t2s: Map<string, string> }

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
  // The recogniser sometimes returns a traditional form for a simplified glyph (别 → 別); the rules are written in
  // simplified Chinese, so recognised characters are converted (OpenCC table, src/ocr/t2s.json, loaded with the engine).
  const { pairs } = (await import("./t2s.json")).default as { pairs: string };
  const t2s = new Map<string, string>();
  const units = [...pairs];
  for (let i = 0; i + 1 < units.length; i += 2) t2s.set(units[i], units[i + 1]);
  return { det, rec, chars: ["", ...dict, " "], ort, initSeconds: (performance.now() - started) / 1000, downloadedBytes: loaded, t2s };
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

/** Input shapes the sessions report, and the last recogniser call's width and output (for the evaluation log). */
export const lastShapes: { det?: (number | string)[] | null; rec?: { W: number; T: number; C: number } } = {};
export function sessionShapes(e: Engine) {
  return { det: e.det.inputMetadata?.[0]?.shape ?? null, rec: e.rec.inputMetadata?.[0]?.shape ?? null };
}

/** Full-image OCR: text boxes from the detector, text and per-character boxes from the recogniser, in image pixels. */
/** Recognition settings tuned on dev (docs/EVALUATION.md 8.6); the evaluation hook can override them for experiments. */
export interface Tuning { rec_max_ratio: number; crop_y_shrink: number; crop_x_pad: number; smoothing: "off" | "low" | "medium" | "high"; unclip: number; rgb: boolean; t2s: boolean }
export const tuning = (over: Partial<Tuning> = {}): Tuning => ({
  rec_max_ratio: PP.rec_max_ratio, crop_y_shrink: PP.crop_y_shrink, crop_x_pad: PP.crop_x_pad, smoothing: PP.rec_smoothing as Tuning["smoothing"], unclip: PP.unclip, rgb: PP.rec_rgb, t2s: PP.t2s, ...over,
});

export async function recognise(engine: Engine, source: HTMLCanvasElement, over: Partial<Tuning> = {}): Promise<{ lines: OcrLine[]; timings: OcrTimings }> {
  const tune = tuning(over);
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
  const boxes = dbBoxes(prob, dw, dh, tune.unclip)
    .map((b) => ({ x0: Math.max(0, (b.x0 * W0) / dw), y0: Math.max(0, (b.y0 * H0) / dh), x1: Math.min(W0, (b.x1 * W0) / dw), y1: Math.min(H0, (b.y1 * H0) / dh) }))
    .filter((b) => b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2);
  const t1 = performance.now();

  const sctx = source.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const recFixed = fixedDims(engine.rec);
  const H = PP.rec_height;
  // A recogniser with a fixed input width squeezes a long line until characters drop out, so long lines are
  // read as overlapping segments; each segment keeps the characters whose centre lies in the part it owns.
  const cropOf = (b: Box): Box => {
    const h = b.y1 - b.y0;
    return { x0: Math.max(0, b.x0 - tune.crop_x_pad * h), x1: Math.min(W0, b.x1 + tune.crop_x_pad * h), y0: b.y0 + tune.crop_y_shrink * h, y1: b.y1 - tune.crop_y_shrink * h };
  };
  const crops = boxes.flatMap((b, i) => segments(cropOf(b), recFixed?.[3] ? recFixed[3] / H : tune.rec_max_ratio).map((seg, k, all) => ({ i, k, n: all.length, ...seg })));
  const order = crops.map((c, j) => ({ c, j, ratio: (c.x1 - c.x0) / (c.y1 - c.y0) })).sort((a, b) => a.ratio - b.ratio);
  const read: ({ tokens: string[]; centres: number[]; conf: number } | null)[] = new Array(crops.length).fill(null);
  for (let k = 0; k < order.length; k += PP.rec_batch) {
    const batch = order.slice(k, k + PP.rec_batch);
    const W = recFixed?.[3] ?? Math.max(PP.rec_min_width, Math.ceil(H * Math.max(...batch.map((x) => x.ratio))));
    const n = batch.length;
    const data = new Float32Array(n * 3 * H * W);
    const widths: number[] = [];
    batch.forEach(({ c }, j) => {
      const bw = Math.max(1, Math.round(c.x1 - c.x0));
      const bh = Math.max(1, Math.round(c.y1 - c.y0));
      const tw = Math.min(W, Math.max(1, Math.ceil((H * bw) / bh)));
      widths.push(tw);
      const ctx = canvas(tw, H);
      if (tune.smoothing === "off") ctx.imageSmoothingEnabled = false;
      else ctx.imageSmoothingQuality = tune.smoothing;
      ctx.drawImage(sctx.canvas, Math.round(c.x0), Math.round(c.y0), bw, bh, 0, 0, tw, H);
      const p = ctx.getImageData(0, 0, tw, H).data;
      const off = j * 3 * H * W;
      const area = H * W;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < tw; x++) {
          const s = (y * tw + x) * 4;
          const d = y * W + x;
          const first = tune.rgb ? p[s] : p[s + 2]; // PaddleOCR reads BGR
          const last = tune.rgb ? p[s + 2] : p[s];
          data[off + d] = (first / 255 - 0.5) / 0.5;
          data[off + area + d] = (p[s + 1] / 255 - 0.5) / 0.5;
          data[off + 2 * area + d] = (last / 255 - 0.5) / 0.5;
        }
      }
    });
    const out = await engine.rec.run({ [engine.rec.inputNames[0]]: new ort.Tensor("float32", data, [n, 3, H, W]) });
    const tensor = out[engine.rec.outputNames[0]];
    const [, T, C] = tensor.dims as number[];
    lastShapes.rec = { W, T, C };
    batch.forEach(({ c, j }, b) => {
      const decoded = ctcDecode(tensor.data, b * T * C, T, C, engine.chars);
      if (tune.t2s) decoded.tokens = decoded.tokens.map((t) => engine.t2s.get(t) ?? t);
      const bw = Math.max(1, Math.round(c.x1 - c.x0));
      const centres = decoded.steps.map((st) => c.x0 + (Math.min(widths[b], ((st + 0.5) * W) / T) * bw) / widths[b]);
      const keep = decoded.tokens.map((_, t) => centres[t] >= c.own0 && centres[t] < c.own1);
      const tokens = decoded.tokens.filter((_, t) => keep[t]);
      read[j] = { tokens, centres: centres.filter((_, t) => keep[t]), conf: decoded.conf };
    });
  }
  const results: (OcrLine | null)[] = boxes.map((b, i) => {
    const parts = crops.map((c, j) => ({ c, r: read[j] })).filter((x) => x.c.i === i && x.r).sort((a, b) => a.c.k - b.c.k);
    const tokens = parts.flatMap((x) => x.r!.tokens);
    const centres = parts.flatMap((x) => x.r!.centres);
    const text = tokens.join("");
    if (!text.trim()) return null;
    const weight = parts.reduce((n, x) => n + x.r!.tokens.length, 0) || 1;
    const conf = parts.reduce((n, x) => n + x.r!.conf * x.r!.tokens.length, 0) / weight;
    const box: Box = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    return { text, conf, box, chars: boxesFromCentres(tokens, centres, box) };
  });
  const t2 = performance.now();
  const lines = results.filter((x): x is OcrLine => x !== null);
  return { lines, timings: { det: (t1 - t0) / 1000, rec: (t2 - t1) / 1000, lines: lines.length, boxes: boxes.length } };
}

/** DB post-processing for axis-aligned text: threshold, 4-connected components, mean-probability
    score, then the usual unclip by area × ratio / perimeter. */
export function dbBoxes(prob: Float32Array, w: number, h: number, unclip = PP.unclip): { x0: number; y0: number; x1: number; y1: number; score: number }[] {
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
    const d = (bw * bh * unclip) / (2 * (bw + bh));
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

/** Split a text box into overlapping segments no wider than the recogniser takes (maxRatio = width / height);
    segment k owns [own0, own1): the middle of each overlap is the boundary. Overlap 1.5 × box height, so a
    character cut at one segment's edge is whole in its neighbour. */
export function segments(b: Box, maxRatio: number): { x0: number; y0: number; x1: number; y1: number; own0: number; own1: number }[] {
  const h = b.y1 - b.y0;
  const width = b.x1 - b.x0;
  const span = 0.9 * maxRatio * h;
  if (!Number.isFinite(span) || width <= span) return [{ ...b, own0: -Infinity, own1: Infinity }];
  const overlap = 1.5 * h;
  const step = Math.max(h, span - overlap);
  const out: { x0: number; y0: number; x1: number; y1: number; own0: number; own1: number }[] = [];
  for (let s = b.x0; ; s += step) {
    const e = Math.min(b.x1, s + span);
    out.push({ x0: s, y0: b.y0, x1: e, y1: b.y1, own0: -Infinity, own1: Infinity });
    if (e >= b.x1) break;
  }
  for (let k = 0; k + 1 < out.length; k++) {
    const mid = (out[k + 1].x0 + out[k].x1) / 2;
    out[k].own1 = mid;
    out[k + 1].own0 = mid;
  }
  return out;
}

/** Per UTF-16 unit of the line text: its x range in image pixels, from its token's centre (CTC step). */
export function boxesFromCentres(tokens: string[], centres: number[], box: Box): [number, number][] {
  const c = centres.map((x) => Math.min(box.x1, Math.max(box.x0, x)));
  const out: [number, number][] = [];
  c.forEach((x, i) => {
    const prev = i > 0 ? c[i - 1] : null;
    const next = i < c.length - 1 ? c[i + 1] : null;
    const half = next !== null ? (next - x) / 2 : prev !== null ? (x - prev) / 2 : (box.x1 - box.x0) / 2;
    const left = prev !== null ? (prev + x) / 2 : Math.max(box.x0, x - half);
    const right = next !== null ? (x + next) / 2 : Math.min(box.x1, x + half);
    for (let u = 0; u < tokens[i].length; u++) out.push([left, right]);
  });
  return out;
}

/** charBoxes for one decoded crop (kept for tests and callers that decode a whole line). */
export function charBoxes(d: Decoded, box: Box, g: { T: number; W: number; tw: number; bw: number }): [number, number][] {
  const centres = d.steps.map((s) => box.x0 + (Math.min(g.tw, ((s + 0.5) * g.W) / g.T) * g.bw) / g.tw);
  return boxesFromCentres(d.tokens, centres, box);
}
