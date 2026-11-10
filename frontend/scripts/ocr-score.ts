/* Scores the OCR evaluation (docs/EVALUATION.md 8.1, backend/evals/ocr/protocol.json) with the browser engine.
 * No model runs here: the OCR output comes from scripts/ocr_actions.mjs on GitHub Actions.
 *
 *   pnpm exec vite-node scripts/ocr-score.ts -- set   <set>.items.json <set>.results.json <report.json> [--aggregate-only]
 *   pnpm exec vite-node scripts/ocr-score.ts -- small <smallprint.results.json> <dev.items.json> <report.json>
 *   pnpm exec vite-node scripts/ocr-score.ts -- pool  <report.json>... --out <pooled.json> [--bar]
 *
 * T0 = engine on the evaluation text, T1 = on the text as drawn, T2 = on the OCR text. T1 and T2 spans are mapped
 * back to evaluation-text coordinates (renderer map; OCR → drawn by edit-distance alignment) and matched with the
 * section 2 rule: same category, character IoU ≥ 0.5, one-to-one greedy by IoU. */
import { readFileSync, writeFileSync } from "node:fs";
import protocol from "../../backend/evals/ocr/protocol.json";
import { verifiedArticles } from "../src/engine/laws";
import { run } from "../src/engine/pipeline";
import type { Cue } from "../src/engine/text";
import { boundaryMap, editDistance, forCer, mapSpan } from "../src/ocr/align";
import { iou, regionsForSpan, union, type Box, type OcrDocument } from "../src/ocr/layout";

interface Span { category: string; start: number; end: number }
interface Item {
  id: string; set: string; input_type: string; text: string; cues: Cue[]; gold: Span[];
  product: { category: string; name?: string; brand?: string; description?: string; facts?: { key: string; value: string }[] };
  missing_disclosures: string[];
}
type At = [number, number, number, number, number] | null;
interface Render {
  id: string; layout: "frames" | "poster"; cell: Record<string, string | number>;
  drawn: string; drawnAt: At[]; toOrig: number[]; doc: OcrDocument; join_seconds: number;
  images: { width: number; height: number; drawn: string; bytes: number; seconds: number; lines: number }[];
}

const VERIFIED = new Set(verifiedArticles());
const FACTORS = ["font", "background", "jpeg", "style", "body"] as const;

/** Section 2 matching: same category and IoU ≥ 0.5, greedy by IoU, one to one. */
export function match(gold: Span[], pred: Span[]): [number, number][] {
  const cand: [number, number, number][] = [];
  gold.forEach((g, gi) => pred.forEach((p, pi) => {
    if (g.category !== p.category) return;
    const inter = Math.min(g.end, p.end) - Math.max(g.start, p.start);
    if (inter <= 0) return;
    const score = inter / (Math.max(g.end, p.end) - Math.min(g.start, p.start));
    if (score >= 0.5) cand.push([score, gi, pi]);
  }));
  cand.sort((a, b) => b[0] - a[0]);
  const ug = new Set<number>();
  const up = new Set<number>();
  const pairs: [number, number][] = [];
  for (const [, gi, pi] of cand) {
    if (ug.has(gi) || up.has(pi)) continue;
    ug.add(gi);
    up.add(pi);
    pairs.push([gi, pi]);
  }
  return pairs;
}

const engineSpans = (findings: { category: string; start: number; end: number }[]): Span[] => findings.map((f) => ({ category: f.category, start: f.start, end: f.end }));

/** Python's code-point offsets → UTF-16 offsets. */
function cpToUnits(text: string): number[] {
  const map: number[] = [];
  let u = 0;
  for (const ch of text) {
    map.push(u);
    u += ch.length;
  }
  map.push(u);
  return map;
}

function toOrigSpan(toOrig: number[], s: Span): Span | null {
  let lo = Infinity;
  let hi = -1;
  for (let i = s.start; i < s.end && i < toOrig.length; i++) {
    if (toOrig[i] < 0) continue;
    lo = Math.min(lo, toOrig[i]);
    hi = Math.max(hi, toOrig[i]);
  }
  return hi < 0 ? null : { category: s.category, start: lo, end: hi + 1 };
}

function counters() {
  return {
    renders: 0, images: 0, chars_ref: 0, chars_edit: 0,
    t0: 0, t1: 0, t2: 0, layout_retained: 0, ocr_retained: 0, total_retained: 0, introduced: 0,
    clean_renders: 0, clean_flagged: 0, anchor_eligible: 0, anchor_hit: 0,
    gold: { t0: { tp: 0, fp: 0, fn: 0 }, t2: { tp: 0, fp: 0, fn: 0 } },
    disclosures_differ: 0, invariant_violations: 0,
  };
}
type Counters = ReturnType<typeof counters>;

function add(a: Counters, b: Counters) {
  for (const k of Object.keys(a) as (keyof Counters)[]) {
    if (k === "gold") {
      for (const t of ["t0", "t2"] as const) for (const m of ["tp", "fp", "fn"] as const) a.gold[t][m] += b.gold[t][m];
    } else (a[k] as number) += b[k] as number;
  }
}

function product(item: Item) {
  return { category: item.product.category, name: item.product.name ?? "", brand: item.product.brand ?? "", description: item.product.description ?? "", facts: item.product.facts ?? [] };
}

export function scoreSet(items: Item[], results: { renders: Render[] }, aggregateOnly: boolean) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const total = counters();
  const byLayout: Record<string, Counters> = { frames: counters(), poster: counters() };
  const byFactor: Record<string, Record<string, Counters>> = {};
  const latency: Record<string, number[]> = { frames: [], poster: [] };
  const records: unknown[] = [];
  const t0Cache = new Map<string, { spans: Span[]; missing: string[] }>();
  for (const r of results.renders) {
    const item = byId.get(r.id);
    if (!item) throw new Error(`render for unknown item ${r.id}`);
    const c = counters();
    c.renders = 1;
    c.images = r.images.length;
    // T0
    let t0 = t0Cache.get(item.id);
    if (!t0) {
      const cu = cpToUnits(item.text);
      const cues = item.cues.map((q) => ({ ...q, char_start: cu[q.char_start], char_end: cu[q.char_end] }));
      const out = run({ product: product(item), script: item.text, cues, rewrite: false });
      t0 = { spans: engineSpans(out.findings), missing: out.disclosures.filter((d) => !d.present).map((d) => d.id).sort() };
      t0Cache.set(item.id, t0);
    }
    const units = cpToUnits(item.text);
    const gold = item.gold.map((g) => ({ category: g.category, start: units[g.start], end: units[g.end] }));
    // T1 on the drawn text, T2 on the OCR text
    const t1out = run({ product: product(item), script: r.drawn, rewrite: false });
    const t2out = run({ product: product(item), script: r.doc.text, rewrite: false });
    const t1 = engineSpans(t1out.findings);
    const t2 = engineSpans(t2out.findings);
    const map = boundaryMap(r.doc.text, r.drawn);
    const t2drawn = t2.map((s) => {
      const [a, b] = mapSpan(map, s.start, s.end);
      return { category: s.category, start: a, end: b };
    });
    const t1orig = t1.map((s) => toOrigSpan(r.toOrig, s)).filter((s): s is Span => s !== null);
    const t2orig = t2drawn.map((s) => toOrigSpan(r.toOrig, s)).filter((s): s is Span => s !== null);
    c.t0 = t0.spans.length;
    c.t1 = t1.length;
    c.t2 = t2.length;
    c.layout_retained = match(t0.spans, t1orig).length;
    const ocrPairs = match(t1, t2drawn);
    c.ocr_retained = ocrPairs.length;
    const totalPairs = match(t0.spans, t2orig);
    c.total_retained = totalPairs.length;
    c.introduced = t2.length - ocrPairs.length;
    if (!gold.length && !t0.spans.length) {
      c.clean_renders = 1;
      c.clean_flagged = t2.length ? 1 : 0;
    }
    // anchors: matched T2 findings, their boxes vs the drawn boxes of the same characters
    for (const [, i2] of ocrPairs) {
      c.anchor_eligible += 1;
      const pred = new Map(regionsForSpan(r.doc, t2[i2].start, t2[i2].end).map((g) => [g.image, union(g.boxes)]));
      const truth = new Map<number, Box[]>();
      for (let k = t2drawn[i2].start; k < t2drawn[i2].end; k++) {
        const at = r.drawnAt[k];
        if (!at) continue;
        const [image, x0, y0, x1, y1] = at;
        truth.set(image, [...(truth.get(image) ?? []), { x0, y0, x1, y1 }]);
      }
      const images = new Set([...pred.keys(), ...truth.keys()]);
      const hit = images.size > 0 && [...images].every((k) => pred.has(k) && truth.has(k) && iou(pred.get(k)!, union(truth.get(k)!)) >= 0.5);
      if (hit) c.anchor_hit += 1;
    }
    // gold, secondary
    for (const [key, spans] of [["t0", t0.spans], ["t2", t2orig]] as const) {
      const tp = match(gold, spans).length;
      c.gold[key].tp += tp;
      c.gold[key].fp += spans.length - tp;
      c.gold[key].fn += gold.length - tp;
    }
    const missing2 = t2out.disclosures.filter((d) => !d.present).map((d) => d.id).sort();
    c.disclosures_differ = missing2.join() === t0.missing.join() ? 0 : 1;
    // invariants on T2
    for (const f of t2out.findings) {
      if (r.doc.text.slice(f.start, f.end) !== f.quote) c.invariant_violations += 1;
      for (const cit of f.citations) if (cit.status === "verified" && !VERIFIED.has(`${cit.law_id}:${cit.article}`)) c.invariant_violations += 1;
    }
    // character accuracy per image
    const cers: number[] = [];
    r.images.forEach((im, k) => {
      const ref = forCer(im.drawn);
      const hyp = forCer(r.doc.lines.filter((l) => l.image === k).map((l) => l.text).join(""));
      const e = editDistance(hyp, ref);
      c.chars_ref += [...ref].length;
      c.chars_edit += e;
      cers.push(e / Math.max(1, [...ref].length));
      latency[r.layout].push(im.seconds + r.join_seconds / r.images.length);
    });
    add(total, c);
    add(byLayout[r.layout], c);
    for (const f of FACTORS) {
      if (r.cell[f] === undefined) continue;
      const key = String(r.cell[f]);
      byFactor[f] ??= {};
      byFactor[f][key] ??= counters();
      add(byFactor[f][key], c);
    }
    const base = { id: r.id, layout: r.layout, cell: r.cell, images: r.images.length, cer: cers, t0: c.t0, t1: c.t1, t2: c.t2, layout_retained: c.layout_retained, ocr_retained: c.ocr_retained, total_retained: c.total_retained, introduced: c.introduced, anchor: `${c.anchor_hit}/${c.anchor_eligible}`, seconds: r.images.map((x) => +x.seconds.toFixed(3)) };
    if (aggregateOnly) records.push(base);
    else {
      const matchedT0 = new Set(totalPairs.map(([g]) => g));
      const matchedT2 = new Set(ocrPairs.map(([, p]) => p));
      records.push({
        ...base,
        lost: t0.spans.filter((_, i) => !matchedT0.has(i)).map((s) => ({ category: s.category, quote: item.text.slice(s.start, s.end) })),
        extra: t2.filter((_, i) => !matchedT2.has(i)).map((s) => ({ category: s.category, quote: r.doc.text.slice(s.start, s.end) })),
        drawn: r.drawn, ocr: r.doc.text,
      });
    }
  }
  return { totals: total, by_layout: byLayout, by_factor: byFactor, latency, records };
}

const pct = (n: number, d: number) => (d ? n / d : null);
export function metrics(c: Counters) {
  const prf = (g: { tp: number; fp: number; fn: number }) => {
    const p = pct(g.tp, g.tp + g.fp) ?? 0;
    const r = pct(g.tp, g.tp + g.fn) ?? 0;
    return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, ...g };
  };
  return {
    renders: c.renders, images: c.images,
    char_accuracy: c.chars_ref ? 1 - c.chars_edit / c.chars_ref : null, chars: c.chars_ref,
    layout_retention: pct(c.layout_retained, c.t0), ocr_retention: pct(c.ocr_retained, c.t1), total_retention: pct(c.total_retained, c.t0),
    ocr_introduced: pct(c.introduced, c.t2), clean_flagged: pct(c.clean_flagged, c.clean_renders), anchor_hit: pct(c.anchor_hit, c.anchor_eligible),
    counts: { t0: c.t0, t1: c.t1, t2: c.t2, layout_retained: c.layout_retained, ocr_retained: c.ocr_retained, total_retained: c.total_retained, introduced: c.introduced,
      clean_renders: c.clean_renders, clean_flagged: c.clean_flagged, anchor_eligible: c.anchor_eligible, anchor_hit: c.anchor_hit, disclosures_differ: c.disclosures_differ, invariant_violations: c.invariant_violations },
    gold_t0: prf(c.gold.t0), gold_t2: prf(c.gold.t2),
  };
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

function commit() {
  return process.env.GITHUB_SHA ?? "unknown";
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === "set") {
    const [itemsFile, resultsFile, outFile] = rest.filter((a) => !a.startsWith("--"));
    const aggregateOnly = rest.includes("--aggregate-only");
    const items: Item[] = JSON.parse(readFileSync(itemsFile, "utf-8"));
    const results = JSON.parse(readFileSync(resultsFile, "utf-8"));
    const scored = scoreSet(items, results, aggregateOnly);
    const report = {
      set: results.set, commit: commit(), results_commit: results.commit, run_id: results.run_id, engine: protocol.engine_version, aggregate_only: aggregateOnly,
      load: results.load, user_agent: results.user_agent, items: items.length,
      raw: { totals: scored.totals, by_layout: scored.by_layout, by_factor: scored.by_factor, latency: scored.latency },
      metrics: metrics(scored.totals), by_layout: Object.fromEntries(Object.entries(scored.by_layout).map(([k, v]) => [k, metrics(v)])),
      latency: Object.fromEntries(Object.entries(scored.latency).map(([k, v]) => [k, { p50: quantile(v, 0.5), p95: quantile(v, 0.95), n: v.length }])),
      records: scored.records,
    };
    writeFileSync(outFile, JSON.stringify(report, null, 1) + "\n");
    console.log(summary([report], false));
    return;
  }
  if (cmd === "small") {
    const [resultsFile, , outFile] = rest;
    const results = JSON.parse(readFileSync(resultsFile, "utf-8"));
    const bySize: Record<number, { ref: number; edit: number; n: number }> = {};
    for (const s of results.strips as { px: number; drawn: string; ocr: string }[]) {
      const ref = forCer(s.drawn);
      bySize[s.px] ??= { ref: 0, edit: 0, n: 0 };
      bySize[s.px].ref += [...ref].length;
      bySize[s.px].edit += editDistance(forCer(s.ocr), ref);
      bySize[s.px].n += 1;
    }
    const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);
    const acc = Object.fromEntries(sizes.map((px) => [px, 1 - bySize[px].edit / Math.max(1, bySize[px].ref)]));
    const limit = sizes.find((px) => sizes.filter((q) => q >= px).every((q) => acc[q] >= 0.95)) ?? null;
    const report = { commit: commit(), run_id: results.run_id, by_px: Object.fromEntries(sizes.map((px) => [px, { ...bySize[px], accuracy: acc[px] }])), small_print_px: limit };
    writeFileSync(outFile, JSON.stringify(report, null, 1) + "\n");
    console.log(`small print: ${sizes.map((px) => `${px}px ${(acc[px] * 100).toFixed(1)}%`).join(" · ")} → limit ${limit ?? "none"} px`);
    return;
  }
  if (cmd === "pool") {
    const outAt = rest.indexOf("--out");
    const outFile = rest[outAt + 1];
    const files = rest.filter((a, i) => !a.startsWith("--") && i !== outAt + 1);
    const reports = files.map((f) => JSON.parse(readFileSync(f, "utf-8")));
    const total = counters();
    const byLayout: Record<string, Counters> = { frames: counters(), poster: counters() };
    const byFactor: Record<string, Record<string, Counters>> = {};
    const latency: Record<string, number[]> = { frames: [], poster: [] };
    for (const r of reports) {
      add(total, r.raw.totals);
      for (const l of ["frames", "poster"]) add(byLayout[l], r.raw.by_layout[l]);
      for (const [f, levels] of Object.entries(r.raw.by_factor as Record<string, Record<string, Counters>>)) {
        byFactor[f] ??= {};
        for (const [lv, c] of Object.entries(levels)) {
          byFactor[f][lv] ??= counters();
          add(byFactor[f][lv], c);
        }
      }
      for (const l of ["frames", "poster"]) latency[l].push(...r.raw.latency[l]);
    }
    const m = metrics(total);
    const layouts = Object.fromEntries(Object.entries(byLayout).map(([k, v]) => [k, metrics(v)]));
    const lat = Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, { p50: quantile(v, 0.5), p95: quantile(v, 0.95), n: v.length }]));
    const init = Math.max(...reports.map((r) => r.load?.initSeconds ?? Infinity));
    const bytes = Math.max(...reports.map((r) => r.load?.downloadedBytes ?? Infinity));
    const B = protocol.bar;
    const bar = [
      ["char_accuracy ≥ " + B.char_accuracy_min, (m.char_accuracy ?? 0) >= B.char_accuracy_min, m.char_accuracy],
      ["total_retention ≥ " + B.total_retention_min, (m.total_retention ?? 0) >= B.total_retention_min, m.total_retention],
      ...Object.entries(layouts).map(([k, v]) => [`total_retention ${k} ≥ ${B.total_retention_per_layout_min}`, (v.total_retention ?? 0) >= B.total_retention_per_layout_min, v.total_retention]),
      ["ocr_introduced ≤ " + B.ocr_introduced_max, (m.ocr_introduced ?? 1) <= B.ocr_introduced_max, m.ocr_introduced],
      ["clean_flagged ≤ " + B.clean_flagged_max, (m.clean_flagged ?? 0) <= B.clean_flagged_max, m.clean_flagged],
      ["anchor_hit ≥ " + B.anchor_hit_min, (m.anchor_hit ?? 0) >= B.anchor_hit_min, m.anchor_hit],
      ...Object.entries(B.latency_p95_seconds_max).map(([k, max]) => [`latency p95 ${k} ≤ ${max} s`, (lat[k].p95 ?? Infinity) <= (max as number), lat[k].p95]),
      ["init ≤ " + B.init_seconds_max + " s", init <= B.init_seconds_max, init],
      ["download ≤ " + B.download_bytes_max, bytes <= B.download_bytes_max, bytes],
      ["invariants hold", m.counts.invariant_violations === 0, m.counts.invariant_violations],
    ] as [string, boolean, unknown][];
    const report = {
      sets: reports.map((r) => ({ set: r.set, run_id: r.run_id, results_commit: r.results_commit, items: r.items })), commit: commit(), engine: protocol.engine_version,
      metrics: m, by_layout: layouts, latency: lat, init_seconds: init, downloaded_bytes: bytes,
      by_factor: Object.fromEntries(Object.entries(byFactor).map(([f, lv]) => [f, Object.fromEntries(Object.entries(lv).map(([k, c]) => [k, metrics(c)]))])),
      bar: rest.includes("--bar") ? { checks: bar.map(([name, pass, value]) => ({ name, pass, value })), pass: bar.every(([, p]) => p) } : null,
    };
    writeFileSync(outFile, JSON.stringify(report, null, 1) + "\n");
    console.log(summary([{ ...report, set: reports.map((r) => r.set).join(" + ") }], true));
    return;
  }
  throw new Error("usage: ocr-score.ts set|small|pool …");
}

const f1 = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
function summary(reports: { set: string; metrics: ReturnType<typeof metrics>; by_layout: Record<string, ReturnType<typeof metrics>>; latency: Record<string, { p50: number | null; p95: number | null }>; bar?: { checks: { name: string; pass: boolean; value: unknown }[]; pass: boolean } | null }[], pooled: boolean) {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`#### ${pooled ? "Pooled" : "Set"}: ${r.set}`, "", "| | all | frames | poster |", "|---|---|---|---|");
    const row = (name: string, get: (m: ReturnType<typeof metrics>) => number | null) => lines.push(`| ${name} | ${f1(get(r.metrics))} | ${f1(get(r.by_layout.frames))} | ${f1(get(r.by_layout.poster))} |`);
    row("character accuracy", (m) => m.char_accuracy);
    row("layout retention (T0→T1)", (m) => m.layout_retention);
    row("OCR retention (T1→T2)", (m) => m.ocr_retention);
    row("total retention (T0→T2)", (m) => m.total_retention);
    row("OCR-introduced findings", (m) => m.ocr_introduced);
    row("clean renders flagged", (m) => m.clean_flagged);
    row("anchor hit", (m) => m.anchor_hit);
    row("gold F1 T0", (m) => m.gold_t0.f1);
    row("gold F1 T2", (m) => m.gold_t2.f1);
    lines.push(`| latency p50 / p95 (s) | | ${r.latency.frames.p50?.toFixed(2)} / ${r.latency.frames.p95?.toFixed(2)} | ${r.latency.poster.p50?.toFixed(2)} / ${r.latency.poster.p95?.toFixed(2)} |`, "");
    lines.push(`counts: ${JSON.stringify(r.metrics.counts)}`, "");
    if (r.bar) lines.push("**Bar** (protocol.json):", "", ...r.bar.checks.map((c) => `- ${c.pass ? "✅" : "❌"} ${c.name} · ${typeof c.value === "number" ? +c.value.toFixed(4) : c.value}`), "", `**Decision: ${r.bar.pass ? "visible" : "hidden"}**`, "");
  }
  return lines.join("\n");
}

if (!process.env.VITEST) main(process.argv.slice(2).filter((a) => a !== "--"));
