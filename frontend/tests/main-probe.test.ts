/* Regression cases from the main session's probe of PR #1 (46 scripts written without reading the
 * rules: S should flag, C clean, H for a human). Kept as tests, not as a measurement. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/engine/pipeline";
import { scopeOf } from "../src/engine/scope";

const { cases } = JSON.parse(readFileSync(new URL("./main-probe.json", import.meta.url), "utf-8")) as { cases: { id: string; category: string; text: string }[] };
const review = (c: { category: string; text: string }) => {
  const out = run({ product: { category: c.category, facts: [] }, script: c.text });
  const missing = out.disclosures.filter((d) => !d.present);
  return { out, missing, scope: scopeOf(c.text, { category: c.category, facts: [] }, { findings: out.findings, missing: missing.length }) };
};
const SIGNAL: Record<string, string> = { H1: "赠品", H2: "代言与证言", H3: "检测、认证与荣誉", H4: "比较" };
const CATEGORY: Record<string, string> = { S7: "endorsement", S11: "disparagement", S14: "absolute_terms", S17: "guaranteed_returns", S18: "endorsement", S24: "absolute_terms", S22: "medical_claims", S8: "medical_claims" };

describe("main session probe (regression, not a measurement)", () => {
  for (const c of cases) {
    it(`${c.id} ${c.text}`, () => {
      const { out, missing, scope } = review(c);
      if (c.id === "S26") {
        expect(scope.state).toBe("not_reviewable");
      } else if (c.id.startsWith("S")) {
        expect(out.findings.length, "flagged").toBeGreaterThan(0);
        if (CATEGORY[c.id]) expect(out.findings.map((f) => f.category)).toContain(CATEGORY[c.id]);
        for (const f of out.findings) expect(f.citations.filter((x) => x.kind === "basis").every((x) => x.status === "verified")).toBe(true);
      } else {
        expect(out.findings.map((f) => f.quote)).toEqual([]);
        expect(missing.map((d) => d.id)).toEqual([]);
        expect(scope.verdict).toContain("不等于合规");
        if (SIGNAL[c.id]) expect(scope.signals.map((s) => s.topic)).toContain(SIGNAL[c.id]);
      }
    });
  }
});

const second = JSON.parse(readFileSync(new URL("./main-probe-2.json", import.meta.url), "utf-8")) as { cases: { id: string; category: string; text: string }[] };
const KNOWN_GAPS = new Set(["N2", "N4", "N5", "N6", "N16", "N20"]); // agreed with the main session, listed in CHANGELOG

describe("main session probe 2 (regression, not a measurement)", () => {
  for (const c of second.cases) {
    it(`${c.id} ${c.text}`, () => {
      const { out, missing, scope } = review(c);
      if (c.id.startsWith("K")) {
        expect(out.findings.map((f) => f.quote)).toEqual([]);
        expect(missing.map((d) => d.id)).toEqual([]);
        expect(scope.verdict).toContain("不等于合规");
      } else if (!KNOWN_GAPS.has(c.id)) {
        expect(out.findings.length, "flagged").toBeGreaterThan(0);
      }
    });
  }
  it("N8, N9, N10, N11, N21: the problem does not survive in a shown rewrite", () => {
    const keep: Record<string, string[]> = { N8: ["行的"], N9: ["某星"], N10: ["五成"], N11: ["99.9%"], N21: ["医院"] };
    for (const [id, words] of Object.entries(keep)) {
      const c = second.cases.find((x) => x.id === id)!;
      const rw = review(c).out.rewrite!;
      if (!rw.withheld) for (const w of words) expect(rw.text.includes(w), `${id} keeps ${w}`).toBe(false);
    }
  });
});
