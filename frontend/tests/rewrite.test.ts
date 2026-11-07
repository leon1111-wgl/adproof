/* A suggested rewrite is shown only if it reads as copy; otherwise it is withheld ("无法自动改写，
 * 请审核员人工改写"), never shown and never "passed". These checks are written independently of
 * rewrite.ts's own gate and run on every input this repo has: coverage cases, the main session's
 * probe and every parity input (eval set, blind set, perturbations, hostile input, SRT). */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, type Product } from "../src/engine/pipeline";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"));
const products = read("../../backend/seed/products.json") as (Product & { sku: string })[];
const inputs: { id: string; product: Product; script: string }[] = [];
for (const c of read("./coverage.json").cases) {
  inputs.push({ id: `coverage:${c.id}`, product: c.sku ? products.find((p) => p.sku === c.sku)! : { category: c.category, facts: [] }, script: c.text });
}
for (const c of read("./main-probe.json").cases) inputs.push({ id: `main-probe:${c.id}`, product: { category: c.category, facts: [] }, script: c.text });
const fixture = new URL("./fixtures/parity.json", import.meta.url);
if (existsSync(fixture)) for (const c of JSON.parse(readFileSync(fixture, "utf-8")).cases) inputs.push({ id: `parity:${c.id}`, product: c.product, script: c.script });

const CONTENT = /[一-鿿A-Za-z0-9]/;
const BOUNDARY = "，,、:：。!?！？;；\n";
const STUB = /^[\u4e00-\u9fff]{1,2}$/;
const PARTICLE_START = /(?:^|[，,、；;：:。!?！？\n])\s*的(?!确)/g;
const OK_LEFT = new Set(["这", "那", "它", "我", "你", "您", "他", "她", "这款", "那款", "这个", "那个", "这是", "那是", "它是", "我们", "你们", "大家", "今天", "现在", "真的", "还有", "而且", "所以", "但是", "因为", "如果"]);
const OK_RIGHT = new Set(["了", "吧", "呢", "啊", "呀", "哦", "啦", "吗"]);
const DOUBLED_PUNCT = /[，,、；;：:][，,、；;：:。!?！？]|[。!?！？][，,、；;：:]|(?:^|\n)\s*[，,、；;：:。!?！？]/;

describe("rewrites that are shown read as copy", () => {
  let shown = 0;
  let withheld = 0;
  it.each(inputs.map((x) => [x.id, x] as const))("%s", (_id, x) => {
    const rw = run({ product: x.product, script: x.script }).rewrite!;
    expect(rw.passed && rw.withheld).toBe(false);
    if (rw.withheld) {
      withheld++;
      expect(rw.withheld_reasons.length).toBeGreaterThan(0);
      return;
    }
    if (!rw.changed) return;
    shown++;
    expect(CONTENT.test(rw.text), "not empty or punctuation only").toBe(true);
    if (!DOUBLED_PUNCT.test(x.script)) expect(rw.text).not.toMatch(DOUBLED_PUNCT);
    const edits = rw.edits.filter((e) => e.strategy !== "append" && [...e.replacement].length >= 4);
    for (const e of edits) expect(rw.text.split(e.replacement).length - 1, `repeated: ${e.replacement}`).toBeLessThanOrEqual(Math.max(1, x.script.split(e.replacement).length - 1));
    // no word cut off at a deletion inside a clause (independent of rewrite.ts): walk the diff
    let at = 0;
    for (const op of rw.diff) {
      if (op.op === "delete" && CONTENT.test(op.a) && at > 0 && at < rw.text.length && !BOUNDARY.includes(rw.text[at - 1]) && !BOUNDARY.includes(rw.text[at])) {
        let a = at;
        while (a > 0 && !BOUNDARY.includes(rw.text[a - 1])) a--;
        let b = at;
        while (b < rw.text.length && !BOUNDARY.includes(rw.text[b])) b++;
        const left = rw.text.slice(a, at);
        const right = rw.text.slice(at, b);
        expect(STUB.test(left) && !OK_LEFT.has(left), `stub before a deletion: ${left}`).toBe(false);
        expect(STUB.test(right) && !OK_RIGHT.has(right), `stub after a deletion: ${right}`).toBe(false);
      }
      at += op.b.length;
    }
    expect((rw.text.match(PARTICLE_START) ?? []).length).toBeLessThanOrEqual((x.script.match(PARTICLE_START) ?? []).length);
    for (const e of rw.edits.filter((e) => e.strategy === "fallback" && e.replacement)) {
      const at = rw.text.indexOf(e.replacement);
      const next = rw.text[at + e.replacement.length];
      expect(next === undefined || "，,、:：。!?！？;；\n".includes(next), `graft after ${e.replacement}`).toBe(true);
    }
  });
  it("some rewrites are shown and the withheld ones are counted", () => {
    expect(shown).toBeGreaterThan(50);
    console.log(`rewrites shown ${shown}, withheld ${withheld}`);
  });
});
