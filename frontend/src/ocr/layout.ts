/* From recognised lines to the text the rule engine reads, and back from a finding's span to boxes on the
   images. Pure functions (no model, no DOM), so the joining and the anchors are unit-tested. */
import pins from "./pins.json";

export interface Box { x0: number; y0: number; x1: number; y1: number }

/** One recognised text line: the detector's box, the text, a confidence, and an x range per UTF-16 unit. */
export interface OcrLine { text: string; conf: number; box: Box; chars: [number, number][] }

export interface OcrImage { name: string; width: number; height: number; lines: OcrLine[] }

export interface CharAnchor { image: number; line: number; x0: number; x1: number }

export interface DocLine { image: number; text: string; conf: number; box: Box; start: number; end: number; low: boolean }

export interface OcrDocument {
  /** what the rule engine reads: rows joined with nothing, paragraphs and images with a newline */
  text: string;
  /** per UTF-16 unit of text: where it is on which image (null for the joining newlines) */
  anchors: (CharAnchor | null)[];
  /** lines in reading order with their character range in text */
  lines: DocLine[];
  images: { name: string; width: number; height: number }[];
}

export interface Region { image: number; boxes: Box[] }

const PP = pins.postprocess;
const height = (b: Box) => b.y1 - b.y0;

/** Reading order: lines that overlap vertically by at least `overlap` of the smaller height form a row;
    rows top to bottom, lines in a row left to right. */
export function rows(lines: OcrLine[], overlap = PP.row_overlap): OcrLine[][] {
  const sorted = [...lines].sort((a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2 || a.box.x0 - b.box.x0);
  const out: { top: number; bottom: number; lines: OcrLine[] }[] = [];
  for (const line of sorted) {
    const row = out.find((r) => {
      const inter = Math.min(r.bottom, line.box.y1) - Math.max(r.top, line.box.y0);
      return inter >= overlap * Math.min(r.bottom - r.top, height(line.box));
    });
    if (row) {
      row.lines.push(line);
      row.top = Math.min(row.top, line.box.y0);
      row.bottom = Math.max(row.bottom, line.box.y1);
    } else {
      out.push({ top: line.box.y0, bottom: line.box.y1, lines: [line] });
    }
  }
  return out.sort((a, b) => a.top - b.top).map((r) => r.lines.sort((a, b) => a.box.x0 - b.box.x0));
}

/** Join the images' lines into one text, keeping where every character came from. */
export function buildDocument(images: OcrImage[], opts: { paragraphGap?: number; lowConfidence?: number } = {}): OcrDocument {
  const gap = opts.paragraphGap ?? PP.paragraph_gap;
  const low = opts.lowConfidence ?? PP.low_confidence;
  let text = "";
  const anchors: (CharAnchor | null)[] = [];
  const lines: DocLine[] = [];
  const newline = () => {
    if (text && !text.endsWith("\n")) {
      text += "\n";
      anchors.push(null);
    }
  };
  images.forEach((image, k) => {
    newline();
    let prev: { top: number; bottom: number } | null = null;
    for (const row of rows(image.lines)) {
      const top = Math.min(...row.map((l) => l.box.y0));
      const bottom = Math.max(...row.map((l) => l.box.y1));
      if (prev) {
        const lineHeight = Math.min(prev.bottom - prev.top, bottom - top);
        if (top - prev.bottom > gap * lineHeight) newline();
      }
      prev = { top, bottom };
      let right = -Infinity; // the detector sometimes returns two overlapping boxes for one line: read the overlap once
      for (const line of row) {
        // separate blocks at the same height (a price tag beside a slogan, two columns): a newline, so the rules
        // never read across them; pieces of one line split by the detector stay joined
        const first = line.chars.length ? line.chars[0][0] : line.box.x0;
        if (right > -Infinity && first - right > (bottom - top)) newline();
        const start = text.length;
        let kept = "";
        for (let u = 0; u < line.text.length; u++) {
          const [x0, x1] = line.chars[u] ?? [line.box.x0, line.box.x1];
          if ((x0 + x1) / 2 < right) continue;
          kept += line.text[u];
          anchors.push({ image: k, line: lines.length, x0, x1 });
        }
        // where this line's text ends (its last character's box, not the detector's padded box)
        right = Math.max(right, line.chars.length ? line.chars[line.chars.length - 1][1] : line.box.x1);
        if (!kept) continue;
        text += kept;
        lines.push({ image: k, text: kept, conf: line.conf, box: line.box, start, end: text.length, low: line.conf < low });
      }
    }
  });
  return { text, anchors, lines, images: images.map(({ name, width, height: h }) => ({ name, width, height: h })) };
}

/** The boxes a span of the document covers: per image, one box per line part (line height, character x range). */
export function regionsForSpan(doc: Pick<OcrDocument, "anchors" | "lines">, start: number, end: number): Region[] {
  const parts = new Map<number, Box>();
  for (let i = Math.max(0, start); i < Math.min(end, doc.anchors.length); i++) {
    const a = doc.anchors[i];
    if (!a) continue;
    const line = doc.lines[a.line];
    const cur = parts.get(a.line);
    if (cur) {
      cur.x0 = Math.min(cur.x0, a.x0);
      cur.x1 = Math.max(cur.x1, a.x1);
    } else {
      parts.set(a.line, { x0: a.x0, y0: line.box.y0, x1: a.x1, y1: line.box.y1 });
    }
  }
  const byImage = new Map<number, Box[]>();
  for (const [lineIndex, box] of [...parts.entries()].sort((a, b) => a[0] - b[0])) {
    const image = doc.lines[lineIndex].image;
    byImage.set(image, [...(byImage.get(image) ?? []), box]);
  }
  return [...byImage.entries()].map(([image, boxes]) => ({ image, boxes }));
}

export const union = (boxes: Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
});

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
}
