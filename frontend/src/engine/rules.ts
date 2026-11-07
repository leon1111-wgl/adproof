/* Port of backend/app/rules/engine.py (matching only; the library itself is validated by the
 * backend when scripts/build_browser_pack.py exports it). */
import { pack, type LawRef, type PackCategory, type PackRule, type RewriteSpec, type Severity } from "./pack";
import { cpLen, finditer, normalize, pyRegex, sentenceBounds, toOriginal } from "./text";

export interface RuleHit {
  rule_id: string;
  rule_name: string;
  category: string;
  severity: Severity;
  start: number;
  end: number;
  quote: string;
  reason: string;
  rule_ids: string[];
  length: number; // code points
}

interface Compiled {
  rule: PackRule;
  matchers: RegExp[];
  exceptions: RegExp[];
  unless: RegExp | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NEGATION = pyRegex(pack.negation);

export const CATEGORIES = new Map<string, PackCategory>(pack.categories.map((c) => [c.id, c]));
export const RULES = new Map<string, PackRule>(pack.rules.map((r) => [r.id, r]));

const COMPILED: Compiled[] = pack.rules.filter((r) => r.enabled).map((rule) => {
  const matchers = rule.patterns.map((p) => pyRegex(p));
  if (rule.keywords.length) matchers.push(pyRegex(rule.keywords.map(escape).join("|")));
  return {
    rule,
    matchers,
    exceptions: rule.exceptions.map((p) => pyRegex(p)),
    unless: rule.unless_sentence ? pyRegex(rule.unless_sentence) : null,
  };
});

const applies = (rule: PackRule, productCategory: string) => rule.applies_to.includes("all") || rule.applies_to.includes(productCategory);
export const refApplies = (ref: LawRef, productCategory: string) => ref.when === null || ref.when.includes(productCategory);

/** Rules that run for this product category. */
export function applicableRules(productCategory: string): PackRule[] {
  return COMPILED.filter((c) => applies(c.rule, productCategory)).map((c) => c.rule);
}

function negated(norm: string, start: number): boolean {
  // six code points back, as norm_text[max(0, start - 6):start]
  let i = start;
  for (let n = 0; n < 6 && i > 0; n++) {
    const lo = norm.charCodeAt(i - 1);
    i -= lo >= 0xdc00 && lo <= 0xdfff && i >= 2 && norm.charCodeAt(i - 2) >= 0xd800 && norm.charCodeAt(i - 2) <= 0xdbff ? 2 : 1;
  }
  let window = norm.slice(i, start);
  for (const boundary of ",。!?;\n") {
    const at = window.lastIndexOf(boundary);
    if (at >= 0) window = window.slice(at + 1);
  }
  return NEGATION.test(window);
}

export function scan(text: string, productCategory = "general"): RuleHit[] {
  const norm = normalize(text);
  const hits: RuleHit[] = [];
  for (const compiled of COMPILED) {
    const rule = compiled.rule;
    if (!applies(rule, productCategory)) continue;
    const category = CATEGORIES.get(rule.category)!;
    const excepted: [number, number][] = [];
    for (const p of compiled.exceptions) for (const m of finditer(p, norm.text)) excepted.push([m.index, m.index + m[0].length]);
    for (const matcher of compiled.matchers) {
      for (const m of finditer(matcher, norm.text)) {
        const s = m.index;
        const e = s + m[0].length;
        if (s === e || excepted.some(([a, b]) => a < e && s < b)) continue;
        if (rule.negation && negated(norm.text, s)) continue;
        const [start, end] = toOriginal(norm, s, e);
        if (compiled.unless) {
          const [a, b] = sentenceBounds(text, start, end);
          if (compiled.unless.test(normalize(text.slice(a, b)).text)) continue;
        }
        hits.push({
          rule_id: rule.id, rule_name: rule.name, category: rule.category, severity: rule.severity ?? category.severity,
          start, end, quote: text.slice(start, end), reason: rule.reason || category.description, rule_ids: [rule.id],
          length: cpLen(text, start, end),
        });
      }
    }
  }
  return dedupe(hits);
}

/** Within one category, overlapping hits become one finding with the longest span. */
function dedupe(hits: RuleHit[]): RuleHit[] {
  hits.sort((a, b) => a.start - b.start || b.length - a.length);
  const kept: RuleHit[] = [];
  for (const hit of hits) {
    const same = kept.find((k) => k.category === hit.category && k.start < hit.end && hit.start < k.end);
    if (!same) {
      kept.push(hit);
      continue;
    }
    if (hit.length > same.length) {
      const ids = same.rule_ids;
      Object.assign(same, { rule_id: hit.rule_id, rule_name: hit.rule_name, start: hit.start, end: hit.end, quote: hit.quote, reason: hit.reason, severity: hit.severity, length: hit.length });
      same.rule_ids = [hit.rule_id, ...ids.filter((i) => i !== hit.rule_id)];
    } else if (!same.rule_ids.includes(hit.rule_id)) {
      same.rule_ids.push(hit.rule_id);
    }
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

export interface DisclosureCheck {
  id: string;
  name: string;
  required: string;
  present: boolean;
  severity: Severity;
  suggestion: string;
}

export function applicableDisclosures(productCategory: string) {
  return pack.disclosures.filter((d) => d.applies_to.includes("all") || d.applies_to.includes(productCategory));
}

export function checkDisclosures(text: string, productCategory: string): DisclosureCheck[] {
  const norm = normalize(text).text;
  return applicableDisclosures(productCategory).map((d) => ({
    id: d.id, name: d.name, required: d.phrases.join("、"),
    present: d.phrases.some((phrase) => norm.includes(normalize(phrase).text)),
    severity: d.severity, suggestion: d.suggestion,
  }));
}

export function refsFor(categoryId: string, ruleId: string | null, productCategory: string) {
  const category = CATEGORIES.get(categoryId)!;
  const rule = ruleId ? RULES.get(ruleId) : undefined;
  let basis = category.law_refs.filter((r) => refApplies(r, productCategory));
  if (rule) basis = basis.concat(rule.law_refs.filter((r) => refApplies(r, productCategory)));
  const penaltySource = rule && rule.penalty_refs.length ? rule.penalty_refs : category.penalty_refs;
  const penalty = penaltySource.filter((r) => refApplies(r, productCategory));
  const references = [...category.references, ...(rule ? rule.references : [])];
  return { basis, penalty, references };
}

export function disclosureRefs(id: string): LawRef[] {
  return pack.disclosures.find((d) => d.id === id)?.law_refs ?? [];
}

export function rewriteSpec(categoryId: string, ruleId: string | null): RewriteSpec {
  const rule = ruleId ? RULES.get(ruleId) : undefined;
  return rule?.rewrite ?? CATEGORIES.get(categoryId)!.rewrite;
}

export function severityOf(categoryId: string, ruleId: string | null): Severity {
  const rule = ruleId ? RULES.get(ruleId) : undefined;
  return rule?.severity || CATEGORIES.get(categoryId)!.severity;
}

/** RuleSet.example_failures: every rule's own positive and negative examples. */
export function exampleFailures(): string[] {
  const failures: string[] = [];
  for (const { rule } of COMPILED) {
    const product = rule.applies_to.includes("all") ? "general" : rule.applies_to[0];
    for (const sample of rule.examples.hit) if (!scan(sample, product).some((h) => h.rule_ids.includes(rule.id))) failures.push(`${rule.id} 正例没有命中：${sample}`);
    for (const sample of rule.examples.pass) if (scan(sample, product).some((h) => h.rule_ids.includes(rule.id))) failures.push(`${rule.id} 反例被误命中：${sample}`);
  }
  return failures;
}
