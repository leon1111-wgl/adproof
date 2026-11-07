/* Port of backend/app/agents/pipeline.py with the offline provider, so the static demo can review
 * a visitor's own script in the tab:
 *
 *   卖点提炼 → 规则审查 ∥ 离线语义模式 → 证据定位 + 校验 → 改写建议 → 复审
 *
 * Same inputs, same output as ReviewPipeline.run() on the backend (frontend/tests/parity.test.ts
 * runs both on the same corpus). Offsets are UTF-16, see text.ts. */
import { pack, type Severity } from "./pack";
import {
  buildDisclosures, locate, mergeAndBuild, offlineModelChannel, ruleChannel, validateFindings,
  type DisclosureResult, type Finding, type ProductLike, type Rejected, type Validation,
} from "./evidence";
import { applyEdits, charDiff, plan, suggest, type AppliedEdit, type DiffOp } from "./rewrite";
import { normalize, type Cue } from "./text";
import type { ProductFact } from "./facts";

export const BLOCKING: Severity[] = ["high", "medium"];

export interface Product extends ProductLike {
  name?: string;
  brand?: string;
  description?: string;
  category: string;
  facts: ProductFact[];
}

export interface Span {
  seq: number;
  agent: string;
  name: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  started_ms: number;
  latency_ms: number;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
}

/** In-tab trace with real timings; the offline channel uses no tokens, so none are reported. */
export class Tracer {
  spans: Span[] = [];
  private t0 = now();
  span<T>(agent: string, name: string, input: Record<string, unknown>, fn: (out: Record<string, unknown>) => T, model: string | null = null): T {
    const started = now();
    const output: Record<string, unknown> = {};
    const record: Span = { seq: this.spans.length + 1, agent, name, status: "ok", input, output, started_ms: Math.round(started - this.t0), latency_ms: 0, model, prompt_tokens: 0, completion_tokens: 0 };
    this.spans.push(record);
    try {
      return fn(output);
    } catch (e) {
      record.status = "error";
      output.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      record.latency_ms = Math.max(0, Math.round((now() - started) * 10) / 10);
    }
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export interface ReviewPass {
  text: string;
  findings: Finding[];
  disclosures: DisclosureResult[];
  rejected: Rejected[];
  validation: Validation;
  channels: { rule: string; llm: string };
}

const blockingOf = (p: ReviewPass) => p.findings.filter((f) => BLOCKING.includes(f.severity));
const missingOf = (p: ReviewPass) => p.disclosures.filter((d) => !d.present);
export const passed = (p: ReviewPass) => !blockingOf(p).length && !missingOf(p).length;

export interface Counts {
  high: number;
  medium: number;
  low: number;
  total: number;
  by_category: Record<string, number>;
  missing_disclosures: number;
}

export function summarize(findings: Finding[], disclosures: DisclosureResult[]): [Counts, Severity] {
  const counts: Counts = { high: 0, medium: 0, low: 0, total: findings.length, by_category: {}, missing_disclosures: 0 };
  for (const f of findings) {
    counts[f.severity] += 1;
    counts.by_category[f.category] = (counts.by_category[f.category] ?? 0) + 1;
  }
  counts.missing_disclosures = disclosures.filter((d) => !d.present).length;
  const risk: Severity = counts.high || counts.missing_disclosures ? "high" : counts.medium ? "medium" : "low";
  return [counts, risk];
}

export type Channel = "rule" | "llm";

export interface ReviewOptions {
  cues?: Cue[] | null;
  stage?: string;
  injectHallucination?: boolean;
  channels?: Channel[];
}

export function review(text: string, product: Product, tracer: Tracer, opts: ReviewOptions = {}): ReviewPass {
  const stage = opts.stage ?? "original";
  const channels = opts.channels ?? ["rule", "llm"];
  const suffix = stage === "original" ? "" : `（${stage}）`;
  const category = product.category ?? "general";
  const rule = channels.includes("rule")
    ? tracer.span("rule_review", "规则审查" + suffix, { chars: text.length, product_category: category, ruleset: `${pack.ruleset.version} · ${pack.ruleset.hash}` }, (out) => {
        const r = ruleChannel(text, product);
        out.rule_hits = r.hits.map((h) => ({ rule: h.rule_id, quote: h.quote, span: [h.start, h.end] }));
        out.fact_mismatches = r.facts.map((f) => ({ quote: f.quote, fact: f.fact_value }));
        out.disclosures = r.disclosures.map((d) => ({ id: d.id, present: d.present }));
        return r;
      })
    : null;
  const raw = channels.includes("llm")
    ? tracer.span("model_review", "离线语义模式" + suffix, { model: pack.provider.model, chars: text.length }, (out) => {
        const found = offlineModelChannel(text, Boolean(opts.injectHallucination));
        if (opts.injectHallucination) out.demo = "已注入 1 条原文中不存在的引用，用于演示证据定位的拦截";
        out.findings = found.map((f) => ({ quote: f.quote, category: f.category }));
        return found;
      }, pack.provider.model)
    : [];
  return tracer.span("evidence_locator", "证据定位与校验" + suffix, { rule_candidates: rule?.candidates.length ?? 0, model_quotes: raw.length }, (out) => {
    const [located, rejected] = locate(text, raw);
    const built = mergeAndBuild(text, [...(rule?.candidates ?? []), ...located], category, opts.cues ?? null);
    const [findings, validation] = validateFindings(text, built);
    findings.forEach((f, i) => (f.key = `F${i + 1}`));
    for (const item of rejected) item.stage = stage;
    const disclosures = buildDisclosures(rule?.disclosures ?? []);
    out.findings = findings.map((f) => ({ key: f.key, quote: f.quote, span: [f.start, f.end], category: f.category, channels: f.channels }));
    out.rejected = rejected;
    out.validation = { ...validation, errors: undefined };
    out.validation_errors = validation.errors;
    return { text, findings, disclosures, rejected, validation, channels: { rule: rule ? "ok" : "off", llm: channels.includes("llm") ? "ok" : "off" } };
  });
}

export interface RewriteResult {
  text: string;
  changed: boolean;
  edits: AppliedEdit[];
  rounds: { round: number; edits: number; remaining: number; remaining_blocking: number; missing_disclosures: number }[];
  passed: boolean;
  remaining: Finding[];
  remaining_disclosures: DisclosureResult[];
  diff: DiffOp[];
}

export const MAX_ROUNDS = 2; // Settings.rewrite_max_rounds

export function rewriteLoop(original: ReviewPass, product: Product, tracer: Tracer): RewriteResult {
  const text = original.text;
  let current = original;
  const rounds: RewriteResult["rounds"] = [];
  let first: AppliedEdit[] = [];
  const appliedRounds: AppliedEdit[][] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (passed(current)) break;
    const todo = current.findings.filter((f) => BLOCKING.includes(f.severity));
    const base = current;
    const [newText, applied] = tracer.span("rewrite", `改写建议（第 ${round} 轮）`, { findings: todo.map((f) => f.key), missing_disclosures: missingOf(base).map((d) => d.id) }, (out) => {
      const result = applyEdits(base.text, plan(base.text, todo, base.disclosures));
      out.edits = result[1];
      out.chars_before = base.text.length;
      out.chars_after = result[0].length;
      return result;
    });
    appliedRounds.push(applied);
    if (round === 1) first = applied;
    current = review(newText, product, tracer, { stage: `复审 ${round}` });
    rounds.push({ round, edits: applied.length, remaining: current.findings.length, remaining_blocking: blockingOf(current).length, missing_disclosures: missingOf(current).length });
  }
  return {
    text: current.text, changed: current.text !== text, edits: first, rounds, passed: passed(current),
    remaining: current.findings, remaining_disclosures: missingOf(current), diff: charDiff(text, current.text, appliedRounds),
  };
}

export interface SellingPoint {
  title: string;
  detail: string;
  source_field: string;
  evidence: string;
}

/** SellingPointAgent with the offline provider: the first five facts, each quoting the sheet. */
export function sellingPoints(product: Product, tracer: Tracer): SellingPoint[] {
  return tracer.span("selling_points", "卖点提炼", { product: { name: product.name ?? "", category: product.category } }, (out) => {
    const corpus = normalize([product.name ?? "", product.brand ?? "", product.description ?? "", ...(product.facts ?? []).map((f) => `${f.key ?? ""} ${f.value ?? ""}`)].join(" ")).text;
    const raw = (product.facts ?? []).slice(0, 5)
      .map((f) => ({ key: String(f.key ?? "").trim(), value: String(f.value ?? "").trim() }))
      .filter((f) => f.key && f.value)
      .map((f) => ({ title: f.key, detail: f.value, source_field: `facts.${f.key}`, evidence: f.value }));
    const grounded = raw.filter((p) => p.evidence && corpus.includes(normalize(p.evidence).text));
    out.selling_points = grounded;
    out.dropped = raw.filter((p) => !grounded.includes(p));
    return grounded;
  }, pack.provider.model);
}

export interface RunInput {
  product: Product;
  script: string;
  cues?: Cue[];
  injectHallucination?: boolean;
  rewrite?: boolean;
  channels?: Channel[];
}

export interface RunOutput {
  script: string;
  cues: Cue[];
  selling_points: SellingPoint[];
  findings: Finding[];
  disclosures: DisclosureResult[];
  rejected: Rejected[];
  validation: Validation;
  channels: { rule: string; llm: string };
  rewrite: RewriteResult | null;
  counts: Counts;
  risk_level: Severity;
}

/** ReviewPipeline.run(mode="review"). */
export function run(inp: RunInput, tracer = new Tracer()): RunOutput {
  const selling = sellingPoints(inp.product, tracer);
  const cues = inp.cues ?? [];
  const original = review(inp.script, inp.product, tracer, { cues, injectHallucination: inp.injectHallucination, channels: inp.channels });
  for (const f of original.findings) f.suggestion = suggest(f);
  const rewrite = inp.rewrite === false ? null : rewriteLoop(original, inp.product, tracer);
  const [counts, risk] = summarize(original.findings, original.disclosures);
  return {
    script: inp.script, cues, selling_points: selling, findings: original.findings, disclosures: original.disclosures,
    rejected: original.rejected, validation: original.validation, channels: original.channels, rewrite, counts, risk_level: risk,
  };
}

/** review_service.recheck(): both channels on an edited script, nothing rewritten. */
export function recheck(text: string, product: Product, tracer = new Tracer()) {
  const result = review(text, product, tracer, { stage: "终审复检" });
  const [counts, risk] = summarize(result.findings, result.disclosures);
  return { text, findings: result.findings, disclosures: result.disclosures, counts, risk_level: risk, passed: passed(result), validation: result.validation };
}
