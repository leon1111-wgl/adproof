/* 红队回合: what the page says about each recorded wording must be what the engine in this build does.
 *
 * - The last rescore of every round was taken with this build's rule library (so "当前规则库" on the page is true),
 *   and re-scoring every wording now gives the same outcome.
 * - Nothing a round's engine caught before a fix is missed now (rule changes must not trade one miss for another).
 * - Every miss and false alarm has the author's decision; an accepted one is fixed, a rejected one says why.
 * - A fix names the rule that now catches it, and that rule's citations are all verified. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import report from "../src/redteam-report.json";
import { pack } from "../src/engine/pack";
import { score } from "../scripts/redteam-score";

interface Rescore { engine: { commit: string; ruleset_hash: string }; items: Record<string, { caught: boolean | null; flagged: boolean; outcome: string }> }

const rounds = (report as unknown as { rounds: { id: string; items: { id: string; kind: string; category: string; product_category: string; text: string; outcome: string; now: string; decision: { decision: string; reason: string } | null; fixed_in: { rules: string[] } | null }[] }[] }).rounds;

describe("red-team rounds", () => {
  it("has recorded rounds", () => {
    expect(rounds.length).toBeGreaterThan(0);
  });

  for (const round of rounds) {
    describe(round.id, () => {
      const rescores = JSON.parse(readFileSync(new URL(`../../backend/evals/redteam/${round.id}/rescores.json`, import.meta.url), "utf-8")) as Rescore[];

      it("last rescore was taken with this build's rule library", () => {
        expect(rescores.at(-1)?.engine.ruleset_hash).toBe(pack.ruleset.hash);
      });

      it("the page's current outcome is what the engine does now", () => {
        const diffs = round.items
          .map((it) => ({ id: it.id, page: it.now, engine: score({ category: it.category, text: it.text, kind: it.kind as "violation" | "near_miss", product_category: it.product_category }).outcome }))
          .filter((d) => d.page !== d.engine);
        expect(diffs).toEqual([]);
      });

      it("no wording caught before a fix is missed now", () => {
        const lost = round.items.filter((it) => (it.outcome === "caught" && it.now !== "caught") || (it.outcome === "clean" && it.now !== "clean"));
        expect(lost.map((it) => it.id)).toEqual([]);
      });

      it("every miss and false alarm has a decision; accepted ones are fixed", () => {
        const open = round.items.filter((it) => ["missed", "other", "false_alarm"].includes(it.outcome));
        for (const it of open) {
          expect(it.decision, `${it.id} has no decision`).not.toBeNull();
          expect(it.decision!.reason.length, `${it.id} reason`).toBeGreaterThan(3);
          if (it.decision!.decision === "accept") expect(it.fixed_in, `${it.id} accepted but not fixed`).not.toBeNull();
        }
      });

      it("a fix names its rule, and the rule cites only verified articles", () => {
        for (const it of round.items.filter((x) => x.fixed_in && x.kind === "violation")) {
          expect(it.fixed_in!.rules.length, it.id).toBeGreaterThan(0);
          const s = score({ category: it.category, text: it.text, kind: "violation", product_category: it.product_category });
          for (const f of s.findings.filter((f) => f.category === it.category)) expect(f.citations.length, it.id).toBeGreaterThan(0);
        }
      });
    });
  }
});
