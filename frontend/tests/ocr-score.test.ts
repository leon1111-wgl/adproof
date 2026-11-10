/* The OCR evaluation scorer on hand-made renders (no model): perfect OCR scores 100% everywhere; a misread
 * character costs character accuracy and the finding it sits in; a box in the wrong place is not an anchor hit. */
import { describe, expect, it } from "vitest";
import { buildDocument, type OcrLine } from "../src/ocr/layout";
import { metrics, scoreSet } from "../scripts/ocr-score";

const item = {
  id: "t-01", set: "test", input_type: "text", cues: [], missing_disclosures: [],
  text: "姐妹们，这是我用过最好用的精华。今天直播间全网最低价！",
  gold: [{ category: "absolute_terms", start: 9, end: 12 }, { category: "absolute_terms", start: 21, end: 26 }],
  product: { category: "cosmetics", facts: [] },
};

/** A render with one frame per sentence; OCR text per frame may differ from what was drawn. */
function render(ocrTexts?: string[], shift = 0) {
  const pieces = ["姐妹们，这是我用过最好用的精华。", "今天直播间全网最低价！"];
  let drawn = "";
  const drawnAt: ([number, number, number, number, number] | null)[] = [];
  const toOrig: number[] = [];
  let orig = 0;
  const lines: OcrLine[][] = [];
  pieces.forEach((p, k) => {
    if (k) { drawn += "\n"; drawnAt.push(null); toOrig.push(-1); }
    for (let i = 0; i < p.length; i++) { drawnAt.push([k, 100 + i * 40, 600, 140 + i * 40, 650]); toOrig.push(orig + i); }
    drawn += p;
    orig += p.length;
    const t = ocrTexts?.[k] ?? p;
    lines.push([{ text: t, conf: 0.95, box: { x0: 100 + shift, y0: 598, x1: 100 + shift + t.length * 40, y1: 652 }, chars: [...t].map((_, i) => [100 + shift + i * 40, 140 + shift + i * 40] as [number, number]) }]);
  });
  const doc = buildDocument(lines.map((l, k) => ({ name: `f${k}`, width: 1280, height: 720, lines: l })));
  return { id: item.id, layout: "frames" as const, cell: { font: "Noto Sans CJK SC", background: "busy", jpeg: 0.7, style: "outline" }, drawn, drawnAt, toOrig, doc, join_seconds: 0.001,
    images: pieces.map((p, k) => ({ width: 1280, height: 720, drawn: p, bytes: 1, seconds: 1, lines: lines[k].length })) };
}

describe("ocr-score", () => {
  it("perfect OCR: everything retained, every box on target", () => {
    const m = metrics(scoreSet([item], { renders: [render()] }, false).totals);
    expect(m.char_accuracy).toBe(1);
    expect(m.counts.t0).toBeGreaterThanOrEqual(2);
    expect(m.total_retention).toBe(1);
    expect(m.ocr_introduced).toBe(0);
    expect(m.anchor_hit).toBe(1);
    expect(m.counts.invariant_violations).toBe(0);
  });
  it("a misread character inside 最好用 costs one finding and some accuracy", () => {
    const m = metrics(scoreSet([item], { renders: [render(["姐妹们，这是我用过最好囗的精华。"])] }, false).totals);
    expect(m.char_accuracy).toBeLessThan(1);
    expect(m.counts.total_retained).toBe(m.counts.t0 - 1);
  });
  it("boxes 200 px off are not anchor hits", () => {
    const m = metrics(scoreSet([item], { renders: [render(undefined, 200)] }, false).totals);
    expect(m.total_retention).toBe(1);
    expect(m.anchor_hit).toBe(0);
  });
  it("aggregate-only records carry no text", () => {
    const s = scoreSet([item], { renders: [render()] }, true);
    expect(JSON.stringify(s.records)).not.toContain("姐妹");
  });
});
