/* Look-alikes: compliant livestream copy that resembles the patterns added from the red-team rounds must not be
 * flagged. The release review found that the first version of those patterns cited a law article at sentences like
 * "等过敏好了再接着用" and "今天直播间销量突破一千单了"; the generator's own near-misses were too narrow to show it.
 * Written after the rules were read (review, author's probe, r1 near-misses): a regression set, not a measurement. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/engine/pipeline";

const { cases } = JSON.parse(readFileSync(new URL("./lookalikes.json", import.meta.url), "utf-8")) as {
  cases: { text: string; product_category: string; near: string; by: string }[];
};

describe("look-alikes of the red-team patterns are not flagged", () => {
  it("has cases from the review and from the author", () => {
    expect(cases.filter((c) => c.by === "reviewer").length).toBeGreaterThanOrEqual(14);
  });
  for (const c of cases) {
    it(`${c.near} · ${c.text}`, () => {
      const out = run({ product: { category: c.product_category, facts: [], name: "", brand: "", description: "" }, script: c.text, rewrite: false });
      expect(out.findings.map((f) => `${f.rule_id}「${f.quote}」`)).toEqual([]);
    });
  }
});
