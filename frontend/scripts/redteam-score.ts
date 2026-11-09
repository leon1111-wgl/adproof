/* Scores red-team wordings with the browser engine: the same code the static demo runs on a visitor's script, at
 * whatever commit is checked out. No model, no network.
 *
 *   pnpm exec vite-node scripts/redteam-score.ts -- <round.json | wordings.json> [out.json] [--append]
 *
 * Input is a round (backend/evals/redteam/r*\/round.json) or your own list of wordings:
 *   [{"category": "medical_claims", "text": "…", "kind": "violation" | "near_miss", "product_category": "food"}]
 * Each wording is reviewed as a one-line script for its product category with no product sheet (the demo's
 * "不指定商品 · 类目"), so only wording is judged, not facts.
 *
 * A violation is caught when a finding has its intended category; flagged under another category only is "other".
 * A near-miss is a false alarm when anything is flagged.
 *
 * Without out.json it prints a table. With out.json it writes scores.json; with --append it adds this commit's
 * scores to a list (rescores.json), which is how the 红队回合 page knows which rule commit caught which miss. */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pack } from "../src/engine/pack";
import { run } from "../src/engine/pipeline";

export interface Wording {
  id?: string;
  category: string;
  text: string;
  kind?: "violation" | "near_miss";
  product_category?: string;
}

export interface Score {
  caught: boolean | null;
  outcome: "caught" | "other" | "missed" | "clean" | "false_alarm";
  flagged: boolean;
  findings: { category: string; rule_id: string | null; quote: string; citations: string[] }[];
}

export function score(w: Wording): Score {
  const out = run({ product: { category: w.product_category ?? "general", facts: [], name: "", brand: "", description: "" }, script: w.text, rewrite: false });
  const findings = out.findings.map((f) => ({
    category: f.category,
    rule_id: f.rule_id,
    quote: f.quote,
    citations: f.citations.filter((c) => c.status === "verified").map((c) => c.short_label),
  }));
  const flagged = findings.length > 0;
  if ((w.kind ?? "violation") === "near_miss") return { caught: null, outcome: flagged ? "false_alarm" : "clean", flagged, findings };
  const caught = findings.some((f) => f.category === w.category);
  return { caught, outcome: caught ? "caught" : flagged ? "other" : "missed", flagged, findings };
}

function commit(): string {
  if (process.env.REDTEAM_COMMIT) return process.env.REDTEAM_COMMIT;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function main(argv: string[]) {
  const append = argv.includes("--append");
  const [input, output] = argv.filter((a) => !a.startsWith("--"));
  if (!input) throw new Error("usage: redteam-score.ts <round.json | wordings.json> [out.json] [--append]");
  const data = JSON.parse(readFileSync(input, "utf-8"));
  const list: Wording[] = Array.isArray(data) ? data : data.items;
  const items: Record<string, Score> = {};
  list.forEach((w, i) => {
    if (!w || typeof w.text !== "string" || typeof w.category !== "string") throw new Error(`item ${i + 1}: needs category and text`);
    items[w.id ?? `w${String(i + 1).padStart(2, "0")}`] = score(w);
  });
  const result = {
    engine: { commit: commit(), ruleset_version: pack.ruleset.version, ruleset_hash: pack.ruleset.hash, scored_at: new Date().toISOString().slice(0, 19) + "Z" },
    items,
  };
  if (!output) {
    for (const [id, s] of Object.entries(items)) {
      const w = list.find((x, i) => (x.id ?? `w${String(i + 1).padStart(2, "0")}`) === id)!;
      const hits = s.findings.map((f) => `${f.rule_id ?? f.category}「${f.quote}」${f.citations.length ? " " + f.citations.join("、") : ""}`).join("；");
      console.log(`${id}\t${w.kind ?? "violation"}\t${w.category}\t${s.outcome}\t${w.text}\t${hits || "—"}`);
    }
    const v = Object.entries(items).filter(([, s]) => s.caught !== null);
    const n = Object.values(items).filter((s) => s.caught === null);
    console.log(`\nengine ${result.engine.commit.slice(0, 7)} · rules ${pack.ruleset.version} (${pack.ruleset.hash})`);
    console.log(`violations caught ${v.filter(([, s]) => s.caught).length}/${v.length} · near-misses flagged ${n.filter((s) => s.flagged).length}/${n.length}`);
    return;
  }
  if (append) {
    const prev = existsSync(output) ? JSON.parse(readFileSync(output, "utf-8")) : [];
    const kept = (prev as { engine: { commit: string } }[]).filter((r) => r.engine.commit !== result.engine.commit);
    writeFileSync(output, JSON.stringify([...kept, result], null, 1) + "\n");
  } else {
    writeFileSync(output, JSON.stringify(result, null, 1) + "\n");
  }
  console.log(`scored ${list.length} wordings with rules ${pack.ruleset.version} (${pack.ruleset.hash}) at ${result.engine.commit.slice(0, 7)} → ${output}`);
}

if (!process.env.VITEST) main(process.argv.slice(2));
