/* 图片 / 截图 input without a model: decoding, reading order, joining, anchors, alignment, and the review an
 * image produces. The model itself runs only on GitHub Actions (.github/workflows/ocr.yml). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBrowserReview, CUSTOM_PRODUCTS, decide, type ImagePayload } from "../src/demo";
import { boundaryMap, editDistance, forCer, mapSpan } from "../src/ocr/align";
import { charBoxes, ctcDecode, DOWNLOAD_BYTES } from "../src/ocr/engine";
import { buildDocument, iou, regionsForSpan, rows, union, type OcrImage, type OcrLine } from "../src/ocr/layout";
import pins from "../src/ocr/pins.json";
import { scan } from "../src/engine/rules";
import type { User } from "../src/types";

const protocol = JSON.parse(readFileSync(new URL("../../backend/evals/ocr/protocol.json", import.meta.url), "utf-8"));

/** A line whose characters are evenly spaced across its box (what the recogniser reports, idealised). */
function line(text: string, x0: number, y0: number, w: number, h = 40, conf = 0.97): OcrLine {
  const step = w / text.length;
  return { text, conf, box: { x0, y0, x1: x0 + w, y1: y0 + h }, chars: [...text].map((_, i) => [x0 + i * step, x0 + (i + 1) * step] as [number, number]) };
}
const image = (name: string, lines: OcrLine[], width = 1280, height = 720): OcrImage => ({ name, width, height, lines });

describe("pins", () => {
  it("are the protocol's runtime and weights, byte for byte", () => {
    expect(pins.runtime).toEqual(protocol.runtime);
    expect(pins.weights).toEqual(protocol.weights);
    expect(DOWNLOAD_BYTES).toBe(protocol.download_bytes);
    expect(DOWNLOAD_BYTES).toBeLessThanOrEqual(protocol.bar.download_bytes_max);
  });
});

describe("CTC decoding", () => {
  // classes: 0 blank, 1 甲, 2 乙
  const chars = ["", "甲", "乙", " "];
  const tensor = (path: number[]) => {
    const data = new Float32Array(path.length * 4);
    path.forEach((c, t) => { data[t * 4 + c] = 0.9; });
    return data;
  };
  it("collapses repeats, drops blanks, keeps a repeat separated by a blank, and records each run's time step", () => {
    const d = ctcDecode(tensor([0, 1, 1, 0, 1, 2, 2, 2, 0, 0]), 0, 10, 4, chars);
    expect(d.text).toBe("甲甲乙");
    expect(d.steps).toEqual([1.5, 4, 6]);
    expect(d.conf).toBeCloseTo(0.9);
  });
  it("places characters left to right inside the line box", () => {
    const d = ctcDecode(tensor([1, 0, 2, 0, 1, 0, 0, 0]), 0, 8, 4, chars);
    const boxes = charBoxes(d, { x0: 100, y0: 0, x1: 300, y1: 40 }, { T: 8, W: 160, tw: 160, bw: 200 });
    expect(boxes).toHaveLength(3);
    for (const [a, b] of boxes) expect(a).toBeLessThan(b);
    expect(boxes[0][0]).toBeGreaterThanOrEqual(100);
    expect(boxes[2][1]).toBeLessThanOrEqual(300);
    expect(boxes[1][0]).toBeCloseTo(boxes[0][1]);
  });
});

describe("reading order and joining", () => {
  it("orders rows top to bottom and lines in a row left to right", () => {
    const r = rows([line("下", 100, 300, 50), line("右", 600, 100, 50), line("左", 100, 104, 50)]);
    expect(r.map((row) => row.map((l) => l.text).join(""))).toEqual(["左右", "下"]);
  });

  it("joins wrapped lines with nothing, a large gap and each new image with a newline, and anchors every character", () => {
    const frame1 = image("f1.jpg", [line("全网最低价，", 300, 560, 600), line("只要今天", 400, 610, 400)]);
    const frame2 = image("f2.jpg", [line("最好用的精华", 300, 600, 600)]);
    const poster = image("p.jpg", [line("第一段", 72, 100, 300), line("第二段", 72, 400, 300, 40, 0.5)], 1080, 1440);
    const doc = buildDocument([frame1, frame2, poster]);
    expect(doc.text).toBe("全网最低价，只要今天\n最好用的精华\n第一段\n第二段");
    expect(doc.anchors).toHaveLength(doc.text.length);
    [...doc.text].forEach((ch, i) => expect(doc.anchors[i] === null).toBe(ch === "\n"));
    expect(doc.lines.map((l) => [l.image, l.start, l.end])).toEqual([[0, 0, 6], [0, 6, 10], [1, 11, 17], [2, 18, 21], [2, 22, 25]]);
    expect(doc.lines.map((l) => l.low)).toEqual([false, false, false, false, true]);
  });

  it("maps a span to one box per line part, grouped by image", () => {
    const doc = buildDocument([image("a", [line("甲乙丙丁", 0, 0, 400), line("戊己", 0, 50, 200)]), image("b", [line("庚辛", 10, 10, 200)])]);
    // 丙丁 + 戊 on image a, nothing else
    const a = regionsForSpan(doc, 2, 5);
    expect(a).toEqual([{ image: 0, boxes: [{ x0: 200, y0: 0, x1: 400, y1: 40 }, { x0: 0, y0: 50, x1: 100, y1: 90 }] }]);
    // 己 \n 庚: two images
    expect(regionsForSpan(doc, 5, 8).map((r) => r.image)).toEqual([0, 1]);
    expect(regionsForSpan(doc, 6, 7)).toEqual([]); // the joining newline alone
    expect(iou(union(a[0].boxes), { x0: 0, y0: 0, x1: 400, y1: 90 })).toBeGreaterThan(0.6);
  });
});

describe("alignment for the evaluation", () => {
  it("character accuracy compares NFKC text without whitespace, punctuation included", () => {
    expect(forCer("全网 最低价！")).toBe("全网最低价!");
    expect(editDistance(forCer("全网最低价，"), forCer("全网最低价,"))).toBe(0);
    expect(editDistance("最好用的精华", "最好用约精华")).toBe(1);
  });
  it("maps OCR spans onto the drawn text through substitutions, insertions and deletions", () => {
    const drawn = "今天全网最低价只要九十九";
    const ocr = "今天全冈最低价只要九十九"; // one substitution
    expect(mapSpan(boundaryMap(ocr, drawn), 2, 7)).toEqual([2, 7]);
    const ins = "今天,全网最低价只要九十九"; // one inserted character before the span
    expect(mapSpan(boundaryMap(ins, drawn), 3, 8)).toEqual([2, 7]);
    const del = "今天全网最价只要九十九"; // one deleted character inside the span
    expect(mapSpan(boundaryMap(del, drawn), 2, 6)).toEqual([2, 7]);
  });
});

describe("a review from images", () => {
  const leon: User = { id: 1, email: "leon@adproof.demo", name: "Leon", title: "合规负责人", role: "admin" };
  const emma: User = { id: 3, email: "emma@adproof.demo", name: "Emma", title: "内容运营", role: "operator" };
  const cosmetics = CUSTOM_PRODUCTS.find((p) => p.category === "cosmetics")!;
  const frames = [
    image("f1.jpg", [line("姐妹们这是我用过", 300, 560, 640), line("最好用的一瓶精华", 300, 610, 640)]),
    image("f2.jpg", [line("今天直播间全网最低价", 260, 600, 760)]),
  ];
  const payload = (srt?: string): ImagePayload => {
    const document = buildDocument(frames);
    return { document, images: frames.map((f) => ({ name: f.name, width: f.width, height: f.height, url: `blob:${f.name}` })), srt, seconds: [1.2, 0.9] };
  };
  const review = (p: ImagePayload) => buildBrowserReview(200, cosmetics, { input_type: "image", content: p.document.text, inject_hallucination: false, ocr: p }, emma).review;

  it("finds the same problems as the pasted text, each with a box on the right image and snapshot-only citations", () => {
    const r = review(payload());
    const text = buildBrowserReview(201, cosmetics, { input_type: "text", content: "姐妹们这是我用过最好用的一瓶精华\n今天直播间全网最低价", inject_hallucination: false }, emma).review;
    expect(r.findings!.map((f) => [f.category, f.quote])).toEqual(text.findings!.map((f) => [f.category, f.quote]));
    expect(r.findings!.length).toBeGreaterThanOrEqual(2);
    for (const f of r.findings!) {
      expect(r.source_text!.slice(f.start, f.end)).toBe(f.quote);
      expect(f.region?.length).toBeGreaterThan(0);
      for (const c of f.citations.filter((c) => c.status === "verified")) expect(c.source_url).toBeTruthy();
    }
    const best = r.findings!.find((f) => f.quote.includes("最好用"))!;
    expect(best.region!.map((x) => x.image)).toEqual([0]);
    expect(best.region![0].boxes[0].y0).toBe(610); // second line of frame 1
    const lowest = r.findings!.find((f) => f.quote.includes("最低价"))!;
    expect(lowest.region!.map((x) => x.image)).toEqual([1]);
    expect(r.engine?.label).toContain("OCR");
    expect(r.input_type).toBe("image");
    expect(r.ocr?.images).toHaveLength(2);
    expect(r.scope?.not_checked.map((n) => n.label)).toEqual(expect.arrayContaining(["说出来的话", "小字", "画面本身"]));
    expect(r.scope?.input_notes[0]).toContain("2 张图片");
  });

  it("puts an attached .srt first: subtitle findings keep their time, image findings their box", () => {
    const srt = "1\n00:00:01,000 --> 00:00:03,000\n这款精华能消炎祛痘\n";
    const r = review(payload(srt));
    expect(r.source_text!.startsWith("这款精华能消炎祛痘\n")).toBe(true);
    const med = r.findings!.find((f) => f.category === "medical_claims")!;
    expect(med.cue?.start).toBe("00:00:01,000");
    expect(med.region).toBeUndefined();
    const best = r.findings!.find((f) => f.quote.includes("最好用"))!;
    expect(best.cue).toBeNull();
    expect(best.region![0].image).toBe(0);
    expect(r.ocr!.offset).toBe("这款精华能消炎祛痘".length + 1);
  });

  it("refuses an empty recognition and a broken subtitle file", () => {
    const empty: ImagePayload = { document: buildDocument([image("blank.png", [])]), images: [{ name: "blank.png", width: 10, height: 10, url: "blob:x" }], seconds: [0.1] };
    expect(() => review(empty)).toThrow(/没有识别出文字/);
    expect(() => review(payload("not a subtitle"))).toThrow(/字幕文件解析失败/);
  });

  it("keeps the sign-off rules: the submitter cannot approve; a reviewer can reject", async () => {
    const r = review(payload());
    await expect(decide(r, { decision: "approve", version: "original" }, emma)).rejects.toThrow();
    await decide(r, { decision: "reject", note: "图片里有绝对化用语" }, leon);
    expect(r.status).toBe("rejected");
  });

  it("the rule engine itself is untouched: OCR text goes through the same scan", () => {
    const doc = payload().document;
    expect(scan(doc.text, "cosmetics").length).toBeGreaterThan(0);
  });
});
