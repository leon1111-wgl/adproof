/* Port of backend/app/agents/evidence.py and the review channels of reviewers.py.
 *
 * The locator turns channel output into findings a reviewer can check by eye:
 * original characters [start, end) → the rule that fired → verbatim law text.
 * A quote from the context channel that cannot be found in the script is rejected and listed,
 * never shown as a finding. The validator re-checks every finding independently. */
import { pack, type ExternalRef, type Severity } from "./pack";
import { containsText, resolve, type Citation } from "./laws";
import { CATEGORIES, RULES, checkDisclosures, disclosureRefs, refsFor, scan, severityOf, type DisclosureCheck } from "./rules";
import { checkFacts, type ProductFact } from "./facts";
import { cpLen, cueForSpan, findAll, finditer, normalize, pyRegex, toOriginal, type Cue } from "./text";

export const CHANNEL_ORDER: Record<string, number> = { rule: 0, fact: 1, llm: 2 };

export interface Candidate {
  category: string;
  start: number;
  end: number;
  quote: string;
  channel: "rule" | "fact" | "llm";
  rule_id: string | null;
  rule_ids: string[];
  rule_name: string | null;
  severity: Severity | null;
  reason: string;
  evidence: Record<string, string> | null;
  locate_method: string;
  length: number;
}

export interface RawModelFinding {
  quote?: unknown;
  category?: unknown;
  reason?: unknown;
  confidence?: number;
}

export interface Finding {
  key: string;
  category: string;
  category_label: string;
  severity: Severity;
  start: number;
  end: number;
  quote: string;
  rule_id: string | null;
  rule_name: string | null;
  rule_ids: string[];
  channels: ("rule" | "fact" | "llm")[];
  reason: string;
  model_reason: string | null;
  locate_method: string;
  related_categories: string[];
  citations: Citation[];
  references: ExternalRef[];
  pending_basis: boolean;
  cue: ReturnType<typeof cueForSpan>;
  evidence: Record<string, string> | null;
  suggestion?: { replacement: string | null; strategy: string; note: string };
}

export interface Rejected {
  quote: unknown;
  category: unknown;
  reason: string;
  stage?: string;
}

export interface ProductLike {
  category?: string;
  facts?: ProductFact[];
}

// ---------------------------------------------------------------- channels (reviewers.py)
export interface RuleChannel {
  candidates: Candidate[];
  disclosures: DisclosureCheck[];
  hits: ReturnType<typeof scan>;
  facts: ReturnType<typeof checkFacts>;
}

export function ruleChannel(text: string, product: ProductLike): RuleChannel {
  const category = product.category ?? "general";
  const hits = scan(text, category);
  const facts = checkFacts(text, product.facts ?? []);
  const disclosures = checkDisclosures(text, category);
  const candidates: Candidate[] = hits.map((h) => ({
    category: h.category, start: h.start, end: h.end, quote: h.quote, channel: "rule", rule_id: h.rule_id,
    rule_ids: [...h.rule_ids], rule_name: h.rule_name, severity: h.severity, reason: h.reason, evidence: null,
    locate_method: "exact", length: h.length,
  }));
  for (const f of facts) {
    candidates.push({
      category: "fact_mismatch", start: f.start, end: f.end, quote: f.quote, channel: "fact", rule_id: null, rule_ids: [],
      rule_name: null, severity: null, reason: `脚本写的是“${f.script_value}”，商品资料「${f.fact_key}」为“${f.fact_value}”`,
      evidence: {
        type: "product_fact", fact_key: f.fact_key, fact_value: f.fact_value, script_value: f.script_value,
        expected_value: f.expected_value, script_number: f.script_number, expected_number: f.expected_number,
      },
      locate_method: "exact", length: cpLen(text, f.start, f.end),
    });
  }
  return { candidates, disclosures, hits, facts };
}

const SEMANTIC = pack.semantic_patterns.map((p) => ({ ...p, re: pyRegex(p.pattern) }));

/** The offline deterministic "model" (backend/app/llm/mock.py): context patterns for implicit
 * claims. It is not a language model and its output is never presented as model quality. */
export function offlineModelChannel(text: string, injectHallucination = false): RawModelFinding[] {
  const norm = normalize(text);
  const findings: RawModelFinding[] = [];
  for (const p of SEMANTIC) {
    for (const m of finditer(p.re, norm.text)) {
      const [start, end] = toOriginal(norm, m.index, m.index + m[0].length);
      findings.push({ quote: text.slice(start, end), category: p.category, reason: p.reason, confidence: 0.7 });
    }
  }
  if (injectHallucination) {
    findings.push({ quote: pack.hallucinated_quote, category: "authority_endorsement", reason: "（演示开关）注入一条原文中不存在的引用", confidence: 0.9 });
  }
  return findings;
}

// ---------------------------------------------------------------- locator
export function locate(text: string, raw: RawModelFinding[]): [Candidate[], Rejected[]] {
  const located: Candidate[] = [];
  const rejected: Rejected[] = [];
  let norm: ReturnType<typeof normalize> | null = null;
  for (const r of raw) {
    const quote = r.quote;
    const category = r.category;
    const reason = String(r.reason ?? "");
    if (typeof quote !== "string" || !quote.trim()) {
      rejected.push({ quote, category, reason: "缺少 quote 字段" });
      continue;
    }
    if (typeof category !== "string" || !CATEGORIES.has(category) || category === "fact_mismatch") {
      rejected.push({ quote, category, reason: `未知分类 ${category}` });
      continue;
    }
    let spans: [number, number][] = findAll(text, quote).map((p) => [p, p + quote.length]);
    let method = "exact";
    if (!spans.length) {
      norm ??= normalize(text);
      const needle = normalize(quote).text;
      const n = norm;
      spans = needle ? findAll(n.text, needle).map((p) => toOriginal(n, p, p + needle.length)) : [];
      method = "normalized";
    }
    if (!spans.length) {
      rejected.push({ quote, category, reason: "原文中找不到该片段：模型可能改写或编造了引用" });
      continue;
    }
    for (const [start, end] of spans) {
      located.push({
        category, start, end, quote: text.slice(start, end), channel: "llm", rule_id: null, rule_ids: [], rule_name: null,
        severity: null, reason, evidence: null, locate_method: method, length: cpLen(text, start, end),
      });
    }
  }
  return [located, rejected];
}

/** Same category + any overlap → one finding; different categories only when they mostly coincide. */
export function merge(text: string, candidates: Candidate[]): Candidate[][] {
  const ordered = [...candidates].sort((a, b) => a.start - b.start || CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel] || b.length - a.length);
  const groups: Candidate[][] = [];
  for (const cand of ordered) {
    let home: Candidate[] | null = null;
    for (const group of groups) {
      for (const member of group) {
        const inter = Math.min(member.end, cand.end) - Math.max(member.start, cand.start);
        if (inter <= 0) continue;
        // overlap in code points, as the backend measures it
        const overlap = cpLen(text, Math.max(member.start, cand.start), Math.min(member.end, cand.end));
        if (member.category === cand.category || overlap / Math.min(member.length, cand.length) >= 0.6) {
          home = group;
          break;
        }
      }
      if (home) break;
    }
    if (home) home.push(cand);
    else groups.push([cand]);
  }
  return groups;
}

const firstMax = <T,>(list: T[], key: (x: T) => number): T => list.reduce((best, x) => (key(x) > key(best) ? x : best));

function primaryOf(group: Candidate[]): [Candidate, string[]] {
  const cats = [...new Set(group.map((c) => c.category))];
  const category = firstMax(cats, (id) => CATEGORIES.get(id)?.priority ?? 0);
  const own = group.filter((c) => c.category === category);
  const precise = own.filter((c) => c.channel === "rule" || c.channel === "fact");
  const primary = { ...firstMax(precise.length ? precise : own, (c) => c.length) };
  const related = [...new Set(group.filter((c) => c.category !== category).map((c) => c.category))].sort();
  return [primary, related];
}

export function build(text: string, groups: Candidate[][], productCategory: string, cues: Cue[] | null): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    const [primary, related] = primaryOf(group);
    const category = CATEGORIES.get(primary.category)!;
    const ruleIds: string[] = [];
    for (const c of [...group].sort((a, b) => CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel])) {
      for (const rid of c.rule_ids.length ? c.rule_ids : c.rule_id ? [c.rule_id] : []) if (!ruleIds.includes(rid)) ruleIds.push(rid);
    }
    const ruleId = primary.rule_id || (ruleIds.find((r) => RULES.get(r)!.category === primary.category) ?? null);
    const rule = ruleId ? RULES.get(ruleId) : undefined;
    const { basis, penalty, references } = refsFor(primary.category, ruleId, productCategory);
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const [ref, kind] of [...basis.map((r) => [r, "basis"] as const), ...penalty.map((r) => [r, "penalty"] as const)]) {
      const key = JSON.stringify([ref.law, ref.article, ref.paragraph, ref.item, kind]);
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(resolve(ref.law, ref.article, ref.paragraph, ref.item, kind));
    }
    const modelReasons = group.filter((c) => c.channel === "llm" && c.reason).map((c) => c.reason);
    const channels = [...new Set(group.map((c) => c.channel))].sort((a, b) => CHANNEL_ORDER[a] - CHANNEL_ORDER[b]);
    findings.push({
      key: "",
      category: primary.category,
      category_label: category.label,
      severity: severityOf(primary.category, ruleId),
      start: primary.start,
      end: primary.end,
      quote: text.slice(primary.start, primary.end),
      rule_id: ruleId,
      rule_name: rule ? rule.name : null,
      rule_ids: ruleIds,
      channels,
      reason: primary.channel !== "llm" ? primary.reason : primary.reason || category.description,
      model_reason: modelReasons.length ? modelReasons[0] : null,
      locate_method: primary.locate_method,
      related_categories: related,
      citations,
      references: references.map((r) => ({ ...r })),
      pending_basis: !citations.some((c) => c.status === "verified" && c.kind === "basis"),
      cue: cues && cues.length ? cueForSpan(cues, primary.start, primary.end) : null,
      evidence: primary.evidence,
    });
  }
  findings.sort((a, b) => a.start - b.start || a.end - b.end);
  findings.forEach((f, i) => (f.key = `F${i + 1}`));
  return findings;
}

export function mergeAndBuild(text: string, candidates: Candidate[], productCategory: string, cues: Cue[] | null): Finding[] {
  return build(text, merge(text, candidates), productCategory, cues);
}

export interface DisclosureResult extends DisclosureCheck {
  citations: Citation[];
}

export function buildDisclosures(disclosures: DisclosureCheck[]): DisclosureResult[] {
  return disclosures.map((d) => ({ ...d, citations: disclosureRefs(d.id).map((r) => resolve(r.law, r.article, r.paragraph, r.item)) }));
}

export interface Validation {
  checked: number;
  valid: number;
  errors: { key: string; quote: string; problems: string[] }[];
  pending_basis: number;
  citations: number;
  citations_verified: number;
}

/** Independent re-check. Anything that fails is dropped and reported, not repaired. */
export function validateFindings(text: string, findings: Finding[]): [Finding[], Validation] {
  const valid: Finding[] = [];
  const errors: Validation["errors"] = [];
  for (const f of findings) {
    const problems: string[] = [];
    const { start, end } = f;
    if (!Number.isInteger(start) || !Number.isInteger(end) || !(start >= 0 && start < end && end <= text.length)) problems.push("字符位置越界");
    else if (text.slice(start, end) !== f.quote) problems.push("引用片段与原文不一致");
    if (!CATEGORIES.has(f.category)) problems.push("未知分类");
    for (const c of f.citations) {
      if (c.status === "verified" && !containsText(c.law_id, c.article, c.text)) problems.push(`${c.label} 的引文与本地法条快照不一致`);
    }
    if (problems.length) errors.push({ key: f.key, quote: f.quote, problems });
    else valid.push(f);
  }
  return [valid, {
    checked: findings.length,
    valid: valid.length,
    errors,
    pending_basis: valid.filter((f) => f.pending_basis).length,
    citations: valid.reduce((n, f) => n + f.citations.length, 0),
    citations_verified: valid.reduce((n, f) => n + f.citations.filter((c) => c.status === "verified").length, 0),
  }];
}
