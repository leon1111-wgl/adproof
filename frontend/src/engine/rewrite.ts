/* Port of backend/app/agents/rewriter.py with the offline provider: minimal, traceable edits
 * from the rule library's templates (the backend asks a real model for a more fluent wording
 * only when one is configured; the static demo never has one). */
import { pack } from "./pack";
import { rewriteSpec } from "./rules";
import { clauseBounds, cpLen, normalize, pyRegex } from "./text";
import type { DisclosureResult, Finding } from "./evidence";

const SCOPE_PREFIXES = pack.scope_prefixes;

export interface Edit {
  start: number;
  end: number;
  replacement: string;
  keys: string[];
  strategy: string;
  note: string;
}

export interface AppliedEdit extends Edit {
  original: string;
  new_start: number;
  new_end: number;
}

function stripScope(text: string): string {
  for (const prefix of SCOPE_PREFIXES) if (text.startsWith(prefix)) return text.slice(prefix.length);
  return text;
}

/** (replacement or null for clause deletion, strategy, note) */
export function templateSuggestion(finding: Pick<Finding, "category" | "rule_id" | "quote" | "evidence">): [string | null, string, string] {
  const category = finding.category;
  const spec = rewriteSpec(category, finding.rule_id);
  const quote = normalize(finding.quote).text;
  const evidence = finding.evidence ?? {};
  if (category === "fact_mismatch" && evidence.script_number) {
    const fixed = quote.replace(evidence.script_number, () => evidence.expected_number);
    return [fixed, "fact", `按商品资料「${evidence.fact_key}」改为 ${evidence.expected_value}`];
  }
  const replacements = new Map<string, string>();
  for (const [k, v] of Object.entries(spec.replacements)) replacements.set(normalize(k).text, v);
  if (replacements.has(quote)) return [replacements.get(quote)!, "replace", spec.note];
  for (const key of [...replacements.keys()].sort((a, b) => cpLen(b) - cpLen(a))) {
    if (key && quote.includes(key)) return [stripScope(quote.replace(key, () => replacements.get(key)!)), "replace", spec.note];
  }
  for (const sub of spec.subs) {
    const changed = quote.replace(pyRegex(sub.pattern), () => sub.replace);
    if (changed !== quote) return [changed, "replace", spec.note];
  }
  if (spec.strategy === "prefix" && spec.prefix_from && quote.includes(spec.prefix_from)) {
    return [stripScope(quote.replace(spec.prefix_from, () => spec.prefix_to ?? "")), "replace", spec.note];
  }
  if (spec.fallback !== null) return [spec.fallback, "replace", spec.note];
  return [null, "delete_clause", spec.note || "删除该表述"];
}

/** Characters to delete so that the clause disappears without leaving ",," behind. */
function clauseEdit(text: string, start: number, end: number): [number, number] {
  let [a, b] = clauseBounds(text, start, end);
  if (b < text.length && "，,、:：".includes(text[b])) b += 1;
  else if (a > 0 && "，,、:：".includes(text[a - 1])) a -= 1;
  else if (b < text.length && "。!?！？;；".includes(text[b])) b += 1;
  return [a, b];
}

export function mergeEdits(text: string, edits: Edit[]): Edit[] {
  const merged: Edit[] = [];
  const sorted = [...edits].sort((x, y) => x.start - y.start || cpLen(text, y.start, y.end) - cpLen(text, x.start, x.end));
  for (const edit of sorted) {
    const last = merged.length ? merged[merged.length - 1] : null;
    if (last && (edit.start < last.end || (edit.start === last.start && last.start === last.end && last.end === edit.end))) {
      if (last.strategy === "delete_clause" || edit.strategy === "delete_clause") {
        last.start = Math.min(last.start, edit.start);
        last.end = Math.max(last.end, edit.end);
        last.replacement = "";
        last.strategy = "delete_clause";
      }
      last.keys = [...last.keys, ...edit.keys.filter((k) => !last.keys.includes(k))];
      continue;
    }
    merged.push({ ...edit, keys: [...edit.keys] });
  }
  return merged;
}

export function applyEdits(text: string, edits: Edit[]): [string, AppliedEdit[]] {
  const out: string[] = [];
  const applied: AppliedEdit[] = [];
  let cursor = 0;
  let delta = 0;
  for (const edit of edits) {
    out.push(text.slice(cursor, edit.start), edit.replacement);
    const newStart = edit.start + delta;
    applied.push({ start: edit.start, end: edit.end, original: text.slice(edit.start, edit.end), replacement: edit.replacement, keys: edit.keys, strategy: edit.strategy, note: edit.note, new_start: newStart, new_end: newStart + edit.replacement.length });
    delta += edit.replacement.length - (edit.end - edit.start);
    cursor = edit.end;
  }
  out.push(text.slice(cursor));
  return [out.join(""), applied];
}

export function suggest(finding: Finding) {
  const [replacement, strategy, note] = templateSuggestion(finding);
  return { replacement, strategy, note };
}

export function plan(text: string, findings: Finding[], disclosures: DisclosureResult[]): Edit[] {
  const edits: Edit[] = [];
  for (const finding of findings) {
    const [replacement, strategy, note] = templateSuggestion(finding);
    if (strategy === "delete_clause") {
      const [a, b] = clauseEdit(text, finding.start, finding.end);
      edits.push({ start: a, end: b, replacement: "", keys: [finding.key], strategy, note });
    } else {
      edits.push({ start: finding.start, end: finding.end, replacement: replacement ?? "", keys: [finding.key], strategy, note });
    }
  }
  for (const d of disclosures) {
    if (d.present) continue;
    const tail = text.trimEnd();
    const sep = !tail ? "" : text.endsWith("\n") || text.includes("\n") ? "\n" : "";
    const end = text.length;
    edits.push({ start: end, end, replacement: sep + d.suggestion, keys: [d.id], strategy: "append", note: `补充必要声明：${d.required}` });
  }
  return mergeEdits(text, edits);
}

// ---------------------------------------------------------------- difflib.SequenceMatcher (autojunk=False)
type Block = [number, number, number];

function matchingBlocks(a: string[], b: string[]): Block[] {
  const b2j = new Map<string, number[]>();
  b.forEach((elt, j) => {
    const list = b2j.get(elt);
    if (list) list.push(j);
    else b2j.set(elt, [j]);
  });
  const longest = (alo: number, ahi: number, blo: number, bhi: number): Block => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const blocks: Block[] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const x = longest(alo, ahi, blo, bhi);
    const [i, j, k] = x;
    if (k) {
      blocks.push(x);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  let [i1, j1, k1] = [0, 0, 0];
  const out: Block[] = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) out.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) out.push([i1, j1, k1]);
  out.push([a.length, b.length, 0]);
  return out;
}

export interface DiffOp {
  op: "equal" | "replace" | "delete" | "insert";
  a: string;
  b: string;
}

/** rewriter.char_diff: difflib opcodes over code points. */
export function charDiff(before: string, after: string): DiffOp[] {
  const a = Array.from(before);
  const b = Array.from(after);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    let tag: DiffOp["op"] | "" = "";
    if (i < ai && j < bj) tag = "replace";
    else if (i < ai) tag = "delete";
    else if (j < bj) tag = "insert";
    if (tag) ops.push({ op: tag, a: a.slice(i, ai).join(""), b: b.slice(j, bj).join("") });
    i = ai + size;
    j = bj + size;
    if (size) ops.push({ op: "equal", a: a.slice(ai, i).join(""), b: b.slice(bj, j).join("") });
  }
  return ops;
}
