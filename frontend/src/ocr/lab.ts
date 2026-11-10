/* Evaluation hook, present only in builds made with VITE_OCR_LAB=1 (the Actions evaluation job; never the
   public site). It exposes the same engine and joining code the workbench uses, so scripts/ocr_actions.mjs
   can OCR rendered images without driving the UI for each one. */
import { DOWNLOAD_BYTES, lastShapes, sessionShapes, type Tuning } from "./engine";
import { buildDocument, type OcrImage } from "./layout";
import { getEngine, ocrBlob } from "./run";

declare global {
  interface Window {
    __adproofOcr?: {
      load(): Promise<{ initSeconds: number; downloadedBytes: number; expectedBytes: number; seconds: number; shapes: unknown }>;
      shapes(): unknown;
      ocr(name: string, blob: Blob, over?: Partial<Tuning>): Promise<{ image: OcrImage; seconds: number }>;
      join: typeof buildDocument;
    };
  }
}

window.__adproofOcr = {
  async load() {
    const started = performance.now();
    const e = await getEngine(() => undefined, new AbortController().signal);
    return { initSeconds: e.initSeconds, downloadedBytes: e.downloadedBytes, expectedBytes: DOWNLOAD_BYTES, seconds: (performance.now() - started) / 1000, shapes: sessionShapes(e) };
  },
  shapes: () => lastShapes,
  async ocr(name, blob, over = {}) {
    const e = await getEngine(() => undefined, new AbortController().signal);
    return ocrBlob(e, name, blob, over);
  },
  join: buildDocument,
};
