/* The browser reviewer must produce what the backend pipeline produces.
 * Fixture: `cd backend && python ../scripts/export_parity_fixtures.py` (CI runs it first). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pack } from "../src/engine/pack";
import { recheck, run, type Product } from "../src/engine/pipeline";
import { exampleFailures } from "../src/engine/rules";
import { parseSrt, type Cue } from "../src/engine/text";

interface Case {
  id: string;
  product: Product;
  script: string;
  cues: Cue[];
  inject?: boolean;
  srt?: string;
  expected: Record<string, unknown>;
  recheck: { passed: boolean; counts: unknown; risk_level: string; keys: string[] } | null;
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf-8")) as { ruleset: string; cases: Case[] };

describe("parity with backend/app/agents/pipeline.py", () => {
  it("fixture was exported from the same rule library as pack.json", () => {
    expect(fixture.ruleset).toBe(pack.ruleset.hash);
    expect(fixture.cases.length).toBeGreaterThan(300);
  });

  it("every rule's own examples behave", () => {
    expect(exampleFailures()).toEqual([]);
  });

  for (const c of fixture.cases) {
    it(c.id, () => {
      if (c.srt !== undefined) {
        // the tab parses subtitles itself: same text, same cues (UTF-16 offsets)
        expect(parseSrt(c.srt)).toEqual([c.script, c.cues]);
      }
      const out = JSON.parse(JSON.stringify(run({ product: c.product, script: c.script, cues: c.cues, injectHallucination: Boolean(c.inject) })));
      expect(out).toEqual(c.expected);
      if (c.recheck) {
        const again = recheck(out.rewrite.text, c.product);
        expect({ passed: again.passed, counts: again.counts, risk_level: again.risk_level, keys: again.findings.map((f) => f.key) }).toEqual(c.recheck);
      }
    });
  }
});
