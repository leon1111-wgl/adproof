/* Port of backend/app/agents/rewriter.py with the offline provider: minimal, traceable edits
 * from the rule library's templates (the backend asks a real model for a more fluent wording
 * only when one is configured; the static demo never has one). */
import { pack } from "./pack";
import { rewriteSpec } from "./rules";
import { CLAUSE_END, SENTENCE_END, clauseBounds, cpLen, normalize, pyRegex } from "./text";
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
  // a generic phrase, not derived from the quote: only stands in for a whole claim (see plan)
  if (spec.fallback !== null) return [spec.fallback, "fallback", spec.note];
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

const endsClause = (text: string, end: number) => end >= text.length || CLAUSE_END.includes(text[end]);

/** rewriter._tidy: deletions must not leave stray punctuation. */
function tidy(text: string, edits: Edit[]): Edit[] {
  const joined: Edit[] = [];
  for (const e of edits) {
    const last = joined.length ? joined[joined.length - 1] : null;
    if (last && last.replacement === "" && e.replacement === "" && last.strategy !== "append" && e.strategy !== "append" && last.end === e.start && e.end > e.start) {
      joined[joined.length - 1] = { ...last, end: e.end, keys: [...last.keys, ...e.keys.filter((k) => !last.keys.includes(k))] };
    } else {
      joined.push(e);
    }
  }
  const out: Edit[] = [];
  joined.forEach((e, i) => {
    if (e.replacement === "" && e.strategy !== "append" && e.end > e.start) {
      const prevEnd = out.length ? out[out.length - 1].end : -1;
      const nxt = i + 1 < joined.length ? joined[i + 1].start : text.length + 1;
      let { start, end } = e;
      const atStart = start === 0 || SENTENCE_END.includes(text[start - 1]);
      if (atStart && end < text.length && end < nxt && "，,、:：。!?！？;；\n".includes(text[end])) end += 1;
      else if (!atStart && (end >= text.length || SENTENCE_END.includes(text[end])) && start - 1 >= prevEnd && "，,、:：".includes(text[start - 1])) start -= 1;
      e = { ...e, start, end };
    }
    out.push(e);
  });
  return out;
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
  const fallbacks = new Set<string>();
  for (const finding of findings) {
    let [replacement, strategy] = templateSuggestion(finding);
    const note = templateSuggestion(finding)[2];
    // "月入十万不是梦" -> "存在亏损风险不是梦"; the same phrase twice reads as a template
    if (strategy === "fallback" && replacement && (fallbacks.has(replacement) || !endsClause(text, finding.end))) strategy = "delete_clause";
    if (strategy === "fallback") fallbacks.add(replacement ?? "");
    if (strategy !== "delete_clause" && !replacement) {
      const [a, b] = clauseBounds(text, finding.start, finding.end);
      if (text.slice(a, b).trim() === text.slice(finding.start, finding.end).trim()) strategy = "delete_clause";
    }
    if (strategy === "delete_clause") {
      const [a, b] = clauseEdit(text, finding.start, finding.end);
      edits.push({ start: a, end: b, replacement: "", keys: [finding.key], strategy, note });
    } else {
      let r = replacement ?? "";
      for (let k = Math.min(r.length, 4); k > 1; k--) {
        if (text.slice(Math.max(0, finding.start - k), finding.start) === r.slice(0, k)) {
          r = r.slice(k);
          break;
        }
      }
      for (let k = Math.min(r.length, 4); k > 1; k--) {
        if (text.slice(finding.end, finding.end + k) === r.slice(-k)) {
          r = r.slice(0, -k);
          break;
        }
      }
      edits.push({ start: finding.start, end: finding.end, replacement: r, keys: [finding.key], strategy, note });
    }
  }
  const planned = normalize(edits.map((e) => e.replacement).join("")).text;
  for (const d of disclosures) {
    const phrases = pack.disclosures.find((x) => x.id === d.id)?.phrases ?? [];
    if (!d.present && phrases.some((ph) => planned.includes(normalize(ph).text))) continue; // a replacement already says it
    if (d.present) continue;
    const tail = text.trimEnd();
    const sep = !tail ? "" : text.endsWith("\n") || text.includes("\n") ? "\n" : "";
    const end = text.length;
    edits.push({ start: end, end, replacement: sep + d.suggestion, keys: [d.id], strategy: "append", note: `补充必要声明：${d.required}` });
  }
  return tidy(text, mergeEdits(text, edits));
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

function opcodes(before: string, after: string): DiffOp[] {
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

// rewriter.char_diff with the rounds' edits: linear in the text, difflib only per changed region
// (difflib is quadratic or worse on repetitive text); a region over this many character pairs is
// one replacement. Lengths are code points, as in the backend.
export const LOCAL_DIFF_BUDGET = 40_000;

type Piece = [number, number, number, number, boolean]; // a0, a1, b0, b1, equal (UTF-16 offsets)

function local(before: string, after: string): DiffOp[] {
  if (cpLen(before) * cpLen(after) <= LOCAL_DIFF_BUDGET) return opcodes(before, after);
  return [{ op: before && after ? "replace" : before ? "delete" : "insert", a: before, b: after }];
}

function pieces(edits: AppliedEdit[], n: number): Piece[] {
  const out: Piece[] = [];
  let a = 0;
  let b = 0;
  for (const e of edits) {
    if (e.start > a) {
      out.push([a, e.start, b, b + e.start - a, true]);
      b += e.start - a;
    }
    out.push([e.start, e.end, b, b + e.replacement.length, false]);
    b += e.replacement.length;
    a = e.end;
  }
  if (a < n || !out.length) out.push([a, n, b, b + n - a, true]);
  return out;
}

function mapPos(ps: Piece[], x: number, side: 0 | 2, last: boolean): number {
  const other = side === 0 ? 2 : 0;
  const lo = (p: Piece) => p[side] as number;
  const hi = (p: Piece) => p[side + 1] as number;
  const hits = ps.filter((p) => p[4] && lo(p) <= x && x <= hi(p));
  if (hits.length) {
    const p = last ? hits[hits.length - 1] : hits[0];
    return (p[other] as number) + (x - lo(p));
  }
  const inside = ps.filter((p) => lo(p) <= x && x <= hi(p));
  const p = last ? inside[inside.length - 1] : inside[0];
  return (last ? p[other + 1] : p[other]) as number;
}

function compose(p: Piece[], q: Piece[], n0: number, n2: number): Piece[] {
  const spans = [...p.filter((x) => !x[4]).map((x) => [x[2], x[3]]), ...q.filter((x) => !x[4]).map((x) => [x[0], x[1]])]
    .sort((u, v) => u[0] - v[0] || u[1] - v[1]);
  const merged: number[][] = [];
  for (const [x, y] of spans) {
    if (merged.length && x <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], y);
    else merged.push([x, y]);
  }
  const out: Piece[] = [];
  let a = 0;
  let b = 0;
  for (const [x, y] of merged) {
    const a0 = mapPos(p, x, 2, false);
    const a1 = mapPos(p, y, 2, true);
    const b0 = mapPos(q, x, 0, false);
    const b1 = mapPos(q, y, 0, true);
    if (a0 > a) out.push([a, a0, b, b0, true]);
    out.push([a0, a1, b0, b1, false]);
    a = a1;
    b = b1;
  }
  if (a < n0 || b < n2 || !out.length) out.push([a, n0, b, n2, true]);
  return out;
}

/** rewriter.char_diff: from the applied edits of each round, or plain difflib without them. */
export function charDiff(before: string, after: string, rounds?: AppliedEdit[][]): DiffOp[] {
  if (!rounds) return opcodes(before, after);
  let ps: Piece[] | null = null;
  let text = before;
  for (const edits of rounds) {
    const step = pieces(edits, text.length);
    text = applyEdits(text, edits)[0];
    ps = ps === null ? step : compose(ps, step, before.length, text.length);
  }
  if (text !== after) throw new Error("rewrite rounds do not lead to the rewritten text");
  if (ps === null) return before ? [{ op: "equal", a: before, b: after }] : [];
  const ops: DiffOp[] = [];
  for (const [a0, a1, b0, b1, equal] of ps) {
    const chunk = equal ? [{ op: "equal" as const, a: before.slice(a0, a1), b: after.slice(b0, b1) }] : local(before.slice(a0, a1), after.slice(b0, b1));
    for (const op of chunk) {
      if (!op.a && !op.b) continue;
      const prev = ops[ops.length - 1];
      if (prev && op.op === "equal" && prev.op === "equal") ops[ops.length - 1] = { op: "equal", a: prev.a + op.a, b: prev.b + op.b };
      else ops.push(op);
    }
  }
  return ops;
}

// ---------------------------------------------------------------- quality gate (rewriter.rewrite_problems)
// A rewrite is shown only if it still reads as copy; otherwise "无法自动改写，请审核员人工改写".
const CONTENT = /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]/;
const CONTENT_G = /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]/g;
const BAD_PUNCT = /[，,、；;：:][，,、；;：:。!?！？]|[。!?！？][，,、；;：:]|(?:^|\n)\s*[，,、；;：:。!?！？]/;
const DANGLING = /^(?:吃了|喝了|用了|涂了|抹了|穿了|只要|如果|自从|坚持(?:用|吃|喝))[^，,]*$/;
const PEJORATIVE = /智商税|垃圾|辣鸡|破烂|割韭菜|偷工减料|骗人|劣质|坑人|以次充好|黑心|假货|都是坑|噱头|有毒|一用就坏|鼓包|差远了|弱爆了/;
const DOUBLED = /([\u4e00-\u9fff]{2,4})\1/g;
const PARTICLE_START = /(?:^|[，,、；;：:。!?！？\n])\s*的(?!确)/g;
const STANDALONE = new Set(["这", "那", "它", "我", "你", "您", "他", "她", "这款", "那款", "这个", "那个", "这是", "那是", "它是",
  "我们", "你们", "大家", "今天", "现在", "真的", "还有", "而且", "所以", "但是", "因为", "如果"]);
const STANDALONE_END = new Set(["了", "吧", "呢", "啊", "呀", "哦", "啦", "吗"]);
const CJK_STUB = /^[\u4e00-\u9fff]{1,2}$/;

/** rewriter._stub: a deletion inside a clause must not leave one or two characters cut off from their word. */
function stub(after: string, diff: DiffOp[]): string | null {
  let pos = 0;
  for (const op of diff) {
    if (op.op === "delete" && CONTENT.test(op.a)) {
      const p = pos;
      if (p > 0 && p < after.length && !CLAUSE_END.includes(after[p - 1]) && !CLAUSE_END.includes(after[p])) {
        let a = p;
        while (a > 0 && !CLAUSE_END.includes(after[a - 1])) a--;
        let b = p;
        while (b < after.length && !CLAUSE_END.includes(after[b])) b++;
        const left = after.slice(a, p);
        const right = after.slice(p, b);
        if (CJK_STUB.test(left) && !STANDALONE.has(left)) return left;
        if (CJK_STUB.test(right) && !STANDALONE_END.has(right)) return right;
      }
    }
    pos += op.b.length;
  }
  return null;
}
export const KEEP_RATIO = 0.6;
const STATEMENTS = pack.disclosures.flatMap((d) => [...d.phrases, d.suggestion]);

const contentCount = (text: string) => (text.match(CONTENT_G) ?? []).length;
const countOf = (text: string, part: string) => (part ? text.split(part).length - 1 : 0);

export function rewriteProblems(before: string, after: string, findings: Pick<Finding, "start" | "end">[], rounds: AppliedEdit[][], diff: DiffOp[]): string[] {
  const problems: string[] = [];
  const edits = rounds.flat();
  const templates = edits.filter((e) => e.strategy === "fallback" && e.replacement).map((e) => e.replacement);
  let body = after;
  for (const phrase of [...new Set([...STATEMENTS, ...templates].filter(Boolean))].sort((x, y) => cpLen(y) - cpLen(x) || (x < y ? -1 : x > y ? 1 : 0))) {
    body = body.split(phrase).join("");
  }
  if (contentCount(body) === 0) problems.push("改写后除了模板语句和必要声明没有剩下内容");
  for (const raw of after.split(/[。!?！？\n]/)) {
    const sentence = raw.trim();
    if (sentence && DANGLING.test(sentence) && [..."，,"].some((c) => before.includes(sentence + c))) {
      problems.push(`改写后句子不完整：${sentence}`);
      break;
    }
  }
  const cut = stub(after, diff);
  if (cut) problems.push(`删改后留下了被截断的字：${cut}`);
  if ((after.match(PARTICLE_START) ?? []).length > (before.match(PARTICLE_START) ?? []).length) problems.push("改写后有分句以“的”开头");
  const left = PEJORATIVE.exec(after);
  if (left) problems.push(`改写后仍有贬低性的说法：${left[0]}`);
  if (BAD_PUNCT.test(after)) problems.push("改写后标点残缺");
  const doubled = [...after.matchAll(DOUBLED)].map((m) => m[0]).filter((d) => !before.includes(d));
  if (doubled.length) problems.push(`改写后出现重复的词：${doubled[0]}`);
  const replacements = [...new Set(edits.filter((e) => e.strategy !== "append" && cpLen(e.replacement) >= 4).map((e) => e.replacement))];
  for (const r of replacements) {
    if (countOf(after, r) > Math.max(1, countOf(before, r))) {
      problems.push(`同一替换语重复出现：${r}`);
      break;
    }
  }
  for (const r of [...new Set(templates)]) {
    const at = after.indexOf(r);
    if (at >= 0 && !endsClause(after, at + r.length)) {
      problems.push(`替换语没有落在分句末尾：${r}`);
      break;
    }
  }
  const flagged = new Set<number>();
  for (const f of findings) for (let i = f.start; i < f.end; i++) flagged.add(i);
  let base = 0;
  for (let i = 0; i < before.length; i++) if (!flagged.has(i) && CONTENT.test(before[i])) base++;
  let kept = 0;
  let pos = 0;
  for (const op of diff) {
    if (op.op === "equal") for (let k = 0; k < op.a.length; k++) if (!flagged.has(pos + k) && CONTENT.test(op.a[k])) kept++;
    pos += op.a.length;
  }
  if (base && kept / base < KEEP_RATIO) problems.push(`改写删掉了大部分没有问题的内容（保留 ${kept}/${base} 字）`);
  return problems;
}
