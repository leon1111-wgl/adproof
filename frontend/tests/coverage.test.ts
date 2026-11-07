/* Coverage: every rule category the demo claims and every verified law article gets a plain and a
 * colloquial livestream wording that must be flagged with exactly the citations listed in
 * coverage.json, and look-alike wording that must not be flagged at all. A flag citing the wrong
 * article is worse than no flag, so citations are compared as a whole, not "contains". */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pack } from "../src/engine/pack";
import { containsText, verifiedArticles } from "../src/engine/laws";
import { run, type Product } from "../src/engine/pipeline";

interface CoverageCase {
  id: string;
  wording: "plain" | "colloquial" | "lookalike";
  text: string;
  sku?: string;
  category?: string;
  expect: null | { category?: string; quote_contains?: string; missing_disclosure?: string; citations: string[] };
}

const { cases } = JSON.parse(readFileSync(new URL("./coverage.json", import.meta.url), "utf-8")) as { cases: CoverageCase[] };
const products = JSON.parse(readFileSync(new URL("../../backend/seed/products.json", import.meta.url), "utf-8")) as (Product & { sku: string })[];

export function productFor(c: { sku?: string; category?: string }): Product {
  if (c.sku) return products.find((p) => p.sku === c.sku)!;
  return { category: c.category!, facts: [], name: "", brand: "", description: "" };
}

const label = (x: { law_id: string; article: number; paragraph: number | null; item: number | null; kind: string }) =>
  [x.law_id, x.article, x.paragraph, x.item].filter((v) => v !== null).join(":") + "/" + x.kind;

describe("coverage: categories and verified articles", () => {
  const positives = cases.filter((c) => c.expect);

  it("each category has a plain and a colloquial wording", () => {
    for (const category of pack.categories.map((c) => c.id)) {
      for (const wording of ["plain", "colloquial"]) {
        expect(positives.some((c) => c.wording === wording && c.expect!.category === category), `${category} ${wording}`).toBe(true);
      }
    }
  });

  it("each verified article is cited by a plain and a colloquial wording", () => {
    for (const article of verifiedArticles()) {
      for (const wording of ["plain", "colloquial"]) {
        const covered = positives.some((c) => c.wording === wording && c.expect!.citations.some((x) => x.split("/")[0].split(":").slice(0, 2).join(":") === article));
        expect(covered, `${article} ${wording}`).toBe(true);
      }
    }
  });

  for (const c of cases) {
    it(`${c.wording} · ${c.id}`, () => {
      const out = run({ product: productFor(c), script: c.text });
      const missing = out.disclosures.filter((d) => !d.present);
      // every citation shown as verified is verbatim in the snapshot; pending ones carry no text
      for (const f of [...out.findings, ...missing]) {
        for (const x of f.citations) {
          if (x.status === "verified") expect(containsText(x.law_id, x.article, x.text)).toBe(true);
          else expect(x.text).toBe("");
        }
      }
      for (const f of out.findings) for (const r of f.references) expect(r.status).toBe("pending");
      if (!c.expect) {
        expect(out.findings.map((f) => `${f.category}:${f.quote}`)).toEqual([]);
        expect(missing.map((d) => d.id)).toEqual([]);
        return;
      }
      if (c.expect.missing_disclosure) {
        const d = missing.find((m) => m.id === c.expect!.missing_disclosure);
        expect(d, "missing statement reported").toBeTruthy();
        expect(d!.citations.map((x) => label({ ...x, kind: "basis" }))).toEqual(c.expect.citations);
        expect(d!.citations.every((x) => x.status === "verified")).toBe(true);
        expect(out.rewrite?.passed).toBe(!out.rewrite?.withheld);
        return;
      }
      const f = out.findings.find((x) => x.category === c.expect!.category && x.quote.includes(c.expect!.quote_contains!));
      expect(f, `finding ${c.expect.category} containing ${c.expect.quote_contains}: got ${out.findings.map((x) => `${x.category}:${x.quote}`).join(", ")}`).toBeTruthy();
      expect(f!.citations.map(label)).toEqual(c.expect.citations);
      expect(f!.citations.every((x) => x.status === "verified")).toBe(true);
      expect(f!.pending_basis).toBe(false);
      // a rewrite is either shown (passed re-review, flagged words gone) or withheld with a reason
      if (out.rewrite!.withheld) {
        expect(out.rewrite!.passed).toBe(false);
        expect(out.rewrite!.withheld_reasons.length).toBeGreaterThan(0);
      } else {
        expect(out.rewrite?.passed).toBe(true);
        expect(out.rewrite!.text.includes(f!.quote)).toBe(false);
      }
    });
  }
});
