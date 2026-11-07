/* Typed view of pack.json, which scripts/build_browser_pack.py exports from the backend's rule
 * library, law snapshots and offline model. The engine has no rules or law text of its own. */
import data from "./pack.json";

export type Severity = "high" | "medium" | "low";

export interface LawRef {
  law: string;
  article: number;
  paragraph: number | null;
  item: number | null;
  when: string[] | null;
}

export interface ExternalRef {
  title: string;
  issuer: string;
  status: "pending";
  note: string;
}

export interface RewriteSpec {
  strategy: "replace" | "delete_clause" | "prefix";
  replacements: Record<string, string>;
  subs: { pattern: string; replace: string }[];
  prefix_from: string | null;
  prefix_to: string | null;
  fallback: string | null;
  note: string;
}

export interface PackCategory {
  id: string;
  label: string;
  description: string;
  severity: Severity;
  priority: number;
  law_refs: LawRef[];
  penalty_refs: LawRef[];
  references: ExternalRef[];
  rewrite: RewriteSpec;
}

export interface PackRule {
  id: string;
  name: string;
  category: string;
  severity: Severity | null;
  applies_to: string[];
  patterns: string[];
  keywords: string[];
  exceptions: string[];
  negation: boolean;
  unless_sentence: string | null;
  law_refs: LawRef[];
  penalty_refs: LawRef[];
  references: ExternalRef[];
  reason: string;
  rewrite: RewriteSpec | null;
  examples: { hit: string[]; pass: string[] };
  enabled: boolean;
}

export interface PackDisclosure {
  id: string;
  name: string;
  applies_to: string[];
  phrases: string[];
  severity: Severity;
  law_refs: LawRef[];
  suggestion: string;
}

export interface LawArticle {
  number: number;
  paragraphs: { text: string; items?: string[] }[];
}

export interface LawFile {
  id: string;
  title: string;
  short_title?: string;
  type?: string;
  issuer?: string;
  promulgated?: string;
  effective?: string;
  validity?: string;
  source?: { name?: string; url?: string; retrieved_at?: string };
  articles: LawArticle[];
}

export interface Pack {
  ruleset: { version: string; name: string; hash: string; description: string };
  provider: { name: string; model: string };
  product_categories: Record<string, string>;
  categories: PackCategory[];
  rules: PackRule[];
  disclosures: PackDisclosure[];
  negation: string;
  semantic_patterns: { category: string; pattern: string; reason: string }[];
  hallucinated_quote: string;
  scope_prefixes: string[];
  facts: { units: Record<string, string>; num_unit: string; price_words: string[]; self_describing: string[]; skip_words: string[] };
  text: { always_skip: string[]; decorative: string[]; sentence_end: string; clause_end: string };
  laws: LawFile[];
  pack_hash: string;
}

export const pack = data as unknown as Pack;
