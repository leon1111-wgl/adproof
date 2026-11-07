/* Port of backend/app/textutil.py.
 *
 * Offsets: the backend counts Unicode code points, the browser slices strings by UTF-16 code
 * units. Every start/end this engine returns is a UTF-16 offset into the original text, so the
 * console can slice it directly; wherever the backend compares LENGTHS (dedupe, merge, primary
 * span, edit order) the port counts code points instead, so a span with an emoji in it sorts the
 * same way in both. parity.test.ts converts the backend's offsets before comparing. */
import { pack } from "./pack";

const ALWAYS_SKIP = new Set(pack.text.always_skip);
const DECORATIVE = new Set(pack.text.decorative);
export const SENTENCE_END = pack.text.sentence_end;
export const CLAUSE_END = pack.text.clause_end;

/** textutil.is_cjk: U+4E00–U+9FFF and U+3400–U+4DBF. */
export function isCjk(ch: string): boolean {
  return (ch >= "一" && ch <= "鿿") || (ch >= "㐀" && ch <= "䶿");
}

/** Number of code points in text[start:end] (UTF-16 offsets). */
export function cpLen(text: string, start = 0, end = text.length): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export interface Normalized {
  text: string;
  /** for each UTF-16 unit of `text`: where its source character starts / ends in the original */
  starts: number[];
  ends: number[];
}

export function toOriginal(norm: Normalized, start: number, end: number): [number, number] {
  return [norm.starts[start], norm.ends[end - 1]];
}

/** textutil.normalize: NFKC, lower-case, drop whitespace and evasion symbols between CJK. */
export function normalize(text: string): Normalized {
  const chars: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    chars.push(ch);
    offsets.push(i);
    i += ch.length;
  }
  const visible = (j: number) => !ALWAYS_SKIP.has(chars[j]) && !DECORATIVE.has(chars[j]);
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let k = 0; k < chars.length; k++) {
    const ch = chars[k];
    if (ALWAYS_SKIP.has(ch)) continue;
    if (DECORATIVE.has(ch)) {
      let p = k - 1;
      while (p >= 0 && !visible(p)) p--;
      let n = k + 1;
      while (n < chars.length && !visible(n)) n++;
      if (p >= 0 && n < chars.length && isCjk(chars[p]) && isCjk(chars[n])) continue;
    }
    for (const part of ch.normalize("NFKC").toLowerCase()) {
      if (ALWAYS_SKIP.has(part)) continue;
      for (let u = 0; u < part.length; u++) {
        out.push(part[u]);
        starts.push(offsets[k]);
        ends.push(offsets[k] + ch.length);
      }
    }
  }
  return { text: out.join(""), starts, ends };
}

export function findAll(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const found: number[] = [];
  let start = 0;
  for (;;) {
    const pos = haystack.indexOf(needle, start);
    if (pos < 0) return found;
    found.push(pos);
    start = pos + 1;
  }
}

export function sentenceBounds(text: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0 && !SENTENCE_END.includes(text[a - 1])) a--;
  let b = end;
  while (b < text.length && !SENTENCE_END.includes(text[b])) b++;
  return [a, b];
}

export function clauseBounds(text: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0 && !CLAUSE_END.includes(text[a - 1])) a--;
  let b = end;
  while (b < text.length && !CLAUSE_END.includes(text[b])) b++;
  return [a, b];
}

/** Python's `\d` is any Unicode decimal digit; JavaScript's is ASCII only. */
export function pyRegex(pattern: string, flags = ""): RegExp {
  const source = pattern.replace(/(?<!\\)((?:\\\\)*)\\d/g, "$1\\p{Nd}");
  return new RegExp(source, flags.includes("u") ? flags : flags + "u");
}

/** re.finditer over a pattern, as [start, end, groups] in UTF-16 offsets. */
export function* finditer(re: RegExp, text: string): Generator<RegExpExecArray> {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[0] === "") {
      g.lastIndex += text.codePointAt(g.lastIndex)! > 0xffff ? 2 : 1;
      continue;
    }
    yield m;
  }
}

// ---------------------------------------------------------------------------- SRT
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

const TIMING = pyRegex("(\\d{1,2}):(\\d{2}):(\\d{2})[,.](\\d{1,3})\\s*-->\\s*(\\d{1,2}):(\\d{2}):(\\d{2})[,.](\\d{1,3})");

const ND = /\p{Nd}/u;
/** int() of a run of Unicode decimal digits (each Nd block is ten consecutive code points from 0). */
export function pyInt(digits: string): number {
  let value = 0;
  for (const ch of digits) {
    let cp = ch.codePointAt(0)!;
    let k = 0;
    while (ND.test(String.fromCodePoint(cp - 1))) {
      cp--;
      k++;
    }
    value = value * 10 + (k % 10);
  }
  return value;
}

/** float() of digits with an optional ".digits" part. */
export const pyFloat = (s: string) => {
  const [whole, frac = ""] = s.split(".");
  return pyInt(whole) + (frac ? pyInt(frac) / 10 ** [...frac].length : 0);
};

const ms = (h: string, m: string, s: string, frac: string) =>
  ((pyInt(h) * 60 + pyInt(m)) * 60 + pyInt(s)) * 1000 + pyInt([...frac].concat(["0", "0", "0"]).slice(0, 3).join(""));

export function formatMs(value: number): string {
  const h = Math.floor(value / 3_600_000);
  const m = Math.floor((value % 3_600_000) / 60_000);
  const s = Math.floor((value % 60_000) / 1000);
  const rest = value % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

export class SRTError extends Error {}

const pyStrip = (s: string) => s.replace(/^[\s]+|[\s]+$/g, "");

/** textutil.parse_srt: cue texts joined with newlines; each cue owns a character range. */
export function parseSrt(raw: string): [string, Cue[]] {
  raw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^﻿+/, "");
  const blocks = pyStrip(raw).split(/\n\s*\n/).filter((b) => pyStrip(b));
  const cues: Cue[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => pyStrip(line));
    const at = lines.findIndex((line) => TIMING.test(line));
    if (at < 0) throw new SRTError(`第 ${cues.length + 1} 段字幕缺少时间轴（形如 00:00:01,000 --> 00:00:03,000）`);
    const m = TIMING.exec(lines[at])!;
    const startMs = ms(m[1], m[2], m[3], m[4]);
    const endMs = ms(m[5], m[6], m[7], m[8]);
    let body = lines.slice(at + 1).map(pyStrip).join("");
    body = body.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    if (!body) continue;
    if (cues.length) {
      parts.push("\n");
      cursor += 1;
    }
    cues.push({ index: cues.length + 1, start: formatMs(startMs), end: formatMs(endMs), start_ms: startMs, end_ms: endMs, text: body, char_start: cursor, char_end: cursor + body.length });
    parts.push(body);
    cursor += body.length;
  }
  if (!cues.length) throw new SRTError("没有解析到任何字幕内容");
  return [parts.join(""), cues];
}

export function cueForSpan(cues: Cue[], start: number, end: number) {
  const touched = cues.filter((c) => c.char_start < end && start < c.char_end);
  if (!touched.length) return null;
  const first = touched[0];
  const last = touched[touched.length - 1];
  return { index: first.index, last_index: last.index, start: first.start, end: last.end, start_ms: first.start_ms, end_ms: last.end_ms };
}
