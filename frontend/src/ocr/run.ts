/* The OCR session of one tab: the engine is loaded once (after a click) and reused for every image. */
import { canRun, loadEngine, recognise, type Engine, type Tuning } from "./engine";
import type { OcrImage } from "./layout";

/** Images may be large photos; the detector works at 1600 px anyway, so the working copy is capped. */
export const MAX_SIDE = 2400;
export const MAX_IMAGES = 8;
export const MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Build flag: the 图片 / 截图 input exists only in builds made with VITE_OCR=1 (docs/EVALUATION.md 8.1, decision). */
export const OCR_ENABLED = import.meta.env.VITE_OCR === "1";

let engine: Promise<Engine> | null = null;

export function engineLoaded(): boolean {
  return engine !== null;
}

export function getEngine(onProgress: (loaded: number, total: number, file: string) => void, signal: AbortSignal): Promise<Engine> {
  if (!engine) {
    const pending = loadEngine(onProgress, signal);
    engine = pending;
    pending.catch(() => {
      if (engine === pending) engine = null;
    });
  }
  return engine;
}

export async function imageCanvas(blob: Blob, maxSide = MAX_SIDE): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bitmap.width * scale));
  c.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff"; // transparent PNGs: text on transparency reads as text on white
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
  return c;
}

/** OCR of one image: lines with boxes in the working copy's pixels, and the seconds it took. */
export async function ocrBlob(e: Engine, name: string, blob: Blob, over: Partial<Tuning> = {}): Promise<{ image: OcrImage; seconds: number }> {
  const c = await imageCanvas(blob);
  const started = performance.now();
  const { lines } = await recognise(e, c, over);
  return { image: { name, width: c.width, height: c.height, lines }, seconds: (performance.now() - started) / 1000 };
}

export { canRun };
