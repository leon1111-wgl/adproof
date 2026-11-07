/* Visitor input runs in the tab, so hostile input must not freeze the page: every engine step on a
 * 6000-character script (the backend's limit) has to finish in bounded time. */
import { describe, expect, it } from "vitest";
import { run } from "../src/engine/pipeline";

const N = 6000;
const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
const INPUTS: [string, string][] = [
  ["one repeated trigger", fill("最")],
  ["dense findings", fill("全网最好用，")],
  ["digits without a unit", fill("1")],
  ["digits and dots", fill("1.")],
  ["long clause, no boundary", "保证" + fill("一").slice(2)],
  ["disparagement prefix then filler", "别家的" + fill("很").slice(3)],
  ["evasion symbols", fill("最*好*用 ")],
  ["emoji", fill("🔥最好用👍🏻")],
  ["mixed triggers", fill("家人们七天瘦十斤！98%的宝子都回购了，别家都是智商税，国宴特供，专利配方，比吃药还管用。")],
];

describe("bounded time on hostile 6000-character input", () => {
  for (const [name, text] of INPUTS) {
    it(name, () => {
      const t0 = performance.now();
      const out = run({ product: { category: "health_food", facts: [{ key: "价格", value: "到手价 89 元" }, { key: "规格", value: "60片/瓶" }] }, script: text });
      const ms = performance.now() - t0;
      expect(out.validation.errors).toEqual([]);
      expect(ms, `${name}: ${Math.round(ms)} ms`).toBeLessThan(2000);
      console.log(`${name}: ${Math.round(ms)} ms, ${out.findings.length} findings`);
    });
  }
});
