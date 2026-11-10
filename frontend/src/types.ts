export type Role = "admin" | "reviewer" | "operator";
export type Severity = "high" | "medium" | "low";

export interface User {
  id: number;
  email: string;
  name: string;
  title: string;
  role: Role;
}

export interface UserBrief {
  id: number;
  name: string;
  role: Role;
  title: string;
}

export interface Fact {
  key: string;
  value: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  facts: Fact[];
}

export interface Citation {
  law_id: string;
  article: number;
  paragraph: number | null;
  item: number | null;
  kind: "basis" | "penalty";
  status: "verified" | "pending";
  label: string;
  law_title: string;
  short_label: string;
  lead: string;
  text: string;
  article_text: string;
  version: string;
  source_name: string;
  source_url: string;
  retrieved_at: string;
  note: string;
  when?: string[] | null;
}

export interface ExternalRef {
  title: string;
  issuer: string;
  status: "pending";
  note: string;
}

export interface Cue {
  index: number;
  start: string;
  end: string;
  start_ms: number;
  end_ms: number;
  text: string;
  char_start: number;
  char_end: number;
}

export interface Finding {
  id?: number;
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
  channels: ("rule" | "llm" | "fact")[];
  reason: string;
  model_reason: string | null;
  locate_method: string;
  related_categories: string[];
  citations: Citation[];
  references: ExternalRef[];
  pending_basis: boolean;
  cue: { index: number; last_index: number; start: string; end: string } | null;
  /** image input (static demo): where the quoted text is on which image, one box per line part */
  region?: { image: number; boxes: { x0: number; y0: number; x1: number; y1: number }[] }[];
  evidence: { fact_key: string; fact_value: string; script_value: string; expected_value: string } | null;
  suggestion?: { replacement: string | null; strategy: string; note: string };
  verdict?: "confirmed" | "false_positive" | null;
  verdict_note?: string;
  verdict_by?: UserBrief | null;
}

export interface Disclosure {
  id: string;
  name: string;
  required: string;
  present: boolean;
  severity: Severity;
  suggestion: string;
  citations: Citation[];
}

export interface RewriteResult {
  text?: string;
  changed?: boolean;
  passed?: boolean;
  review_passed?: boolean;
  /** the automatic rewrite does not read as copy: it is not shown and cannot be approved */
  withheld?: boolean;
  withheld_reasons?: string[];
  rounds?: { round: number; edits: number; remaining: number; remaining_blocking: number; missing_disclosures: number }[];
  edits?: { start: number; end: number; original: string; replacement: string; keys: string[]; strategy: string; note: string }[];
  diff?: { op: "equal" | "replace" | "delete" | "insert"; a: string; b: string }[];
  remaining?: Finding[];
}

export interface Counts {
  high: number;
  medium: number;
  low: number;
  total: number;
  missing_disclosures: number;
  by_category: Record<string, number>;
}

export interface AgentSpan {
  agent: string;
  name: string;
  status: string;
  started_ms: number;
  latency_ms: number;
}

/** Static demo: which engine produced an answer (src/demo.ts). */
export interface EngineInfo {
  kind: "recorded" | "browser";
  label: string;
  detail: string;
}

export interface ScopeReport {
  verdict: string;
  state: "flagged" | "no_hit" | "not_reviewable";
  input_notes: string[];
  checked: { label: string; detail: string }[];
  not_checked: { label: string; detail: string }[];
  signals: { topic: string; quote: string; sentence: string; at: [number, number]; start: number; end: number; note: string }[];
}

export type InputType = "text" | "srt" | "image";

/** Image input (static demo only): the images OCR read in this tab, and the recognised lines. */
export interface ReviewImages {
  images: { name: string; width: number; height: number; url: string }[];
  lines: { image: number; text: string; conf: number; box: { x0: number; y0: number; x1: number; y1: number }; start: number; end: number; low: boolean }[];
  /** where the OCR text starts in source_text (after an attached .srt, if any) */
  offset: number;
  seconds: number[];
  engine: string;
}

export interface Review {
  id: number;
  title: string;
  status: "queued" | "running" | "pending" | "approved" | "rejected" | "failed";
  mode: "review" | "generate";
  input_type: InputType;
  product_id: number;
  product: Product;
  risk_level: Severity | null;
  counts: Partial<Counts>;
  ruleset_version: string;
  ruleset_hash: string;
  provider: string;
  model: string;
  run_id: string | null;
  error: string | null;
  created_by: UserBrief;
  created_at: string;
  decision: "approve" | "revise" | "reject" | null;
  decision_version: "original" | "rewrite" | "edited" | null;
  decision_note: string;
  decided_by: UserBrief | null;
  decided_at: string | null;
  source_text?: string;
  source_raw?: string | null;
  cues?: Cue[];
  ocr?: ReviewImages;
  options?: { style?: string; tone?: string; inject_hallucination?: boolean };
  selling_points?: { title: string; detail: string; source_field: string; evidence: string }[];
  findings?: Finding[];
  disclosures?: Disclosure[];
  rewrite?: RewriteResult;
  rejected?: { quote: string; category: string; reason: string; stage: string }[];
  validation?: { checked: number; valid: number; citations: number; citations_verified: number; pending_basis: number; errors: unknown[] };
  final_text?: string | null;
  final_check?: { counts: Partial<Counts>; risk_level: Severity; passed: boolean; engine?: EngineInfo } | null;
  permissions?: { can_verdict: boolean; can_decide: boolean; reason: string };
  agents?: AgentSpan[];
  engine?: EngineInfo;
  scope?: ScopeReport;
}

export interface Meta {
  provider: string;
  model: string;
  offline: boolean;
  simulated_latency_ms: number;
  ruleset: { version: string; hash: string; name: string };
  product_categories: Record<string, string>;
  categories: { id: string; label: string; severity: Severity; description: string }[];
  agents: Record<string, string>;
  laws: { id: string; title: string; version: string }[];
}

export interface Recheck {
  text: string;
  findings: Finding[];
  disclosures: Disclosure[];
  counts: Counts;
  risk_level: Severity;
  passed: boolean;
  engine?: EngineInfo;
}
