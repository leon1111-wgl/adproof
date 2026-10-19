import { useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { MarkedText, type TextMark } from "../components/ScriptView";
import { Empty, ErrorBanner, Kpi, ms, pct, time, useLoad } from "../components/ui";

interface Prf { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number }
interface SplitReport {
  items: number;
  span: { micro: Prf; macro_f1: number; per_category: Record<string, Prf & { support: number }> };
  span_strict: Prf;
  localisation: Prf;
  ablation: { rule: Prf; model: Prf; both: Prf };
  script_level: { violating: number; detected: number; detection_rate: number | null; clean: number; clean_flagged: number; false_alarm_rate: number | null };
  disclosures: Prf;
  rewrite: { scripts: number; passed: number; pass_rate: number | null; gold_spans: number; gold_eliminated: number; elimination_rate: number | null };
  evidence: { findings_checked: number; findings_valid: number; validity: number; citations: number; citations_verified: number; pending_basis: number; rejected_model_quotes: number };
  channels: Record<string, number>;
  latency_ms: { p50: number; p95: number };
}
interface EvalCase {
  id: string; split: string; product: string; product_category: string; input_type: string; tags: string[]; text: string;
  gold: { category: string; start: number; end: number; text: string }[];
  pred: { key: string; category: string; start: number; end: number; quote: string; channels: string[]; rule_id: string | null }[];
  matched: [number, number][]; missed: number[]; false_positives: number[];
  disclosures: { gold_missing: string[]; pred_missing: string[] };
  rewrite: { passed: boolean | null; rounds: number; gold_eliminated: number };
  latency_ms: number;
}
interface EvalRunSummary {
  id: number; created_at: string; triggered_by: string; provider: string; model: string; ruleset_version: string;
  ruleset_hash: string; dataset_hash: string; latency_ms: number; offline: boolean; items: number; test_f1: number;
  test_rewrite_pass_rate: number | null;
}
interface EvalRunDetail extends EvalRunSummary {
  metrics: { categories: string[]; splits: Record<"dev" | "test" | "all", SplitReport> };
  cases: EvalCase[];
}

type Split = "test" | "dev" | "all";

function CaseRow({ c, label }: { c: EvalCase; label: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const missed = new Set(c.missed);
  const marks: TextMark[] = [
    ...c.gold.map((g, i) => ({ id: `g${i}`, start: g.start, end: g.end, className: missed.has(i) ? "miss" : "gold" })),
    ...c.pred.map((p) => ({ id: p.key, start: p.start, end: p.end, className: "pred" })),
  ];
  return (
    <>
      <tr className="clickable" onClick={() => setOpen(!open)}>
        <td className="mono nowrap">{c.id}</td>
        <td className="nowrap">{c.product}{c.input_type === "srt" ? " · SRT" : ""}</td>
        <td className="mono num">{c.gold.length}</td>
        <td className="mono num">{c.matched.length}</td>
        <td className="mono num">{c.missed.length ? <span style={{ color: "var(--danger)" }}>{c.missed.length}</span> : 0}</td>
        <td className="mono num">{c.false_positives.length ? <span style={{ color: "var(--warning)" }}>{c.false_positives.length}</span> : 0}</td>
        <td>{c.rewrite.passed == null ? <span className="faint">—</span> : c.rewrite.passed ? <span className="badge badge-success">通过</span> : <span className="badge badge-danger">未通过</span>}</td>
        <td className="small faint">{c.tags.join(" · ")}</td>
      </tr>
      {open && (
        <tr><td colSpan={8} style={{ background: "var(--surface-2)" }}>
          <div className="case-text"><MarkedText text={c.text} marks={marks} /></div>
          <div className="legend" style={{ marginTop: 8 }}>
            <span><mark className="gold">金标</mark></span><span><mark className="pred">预测</mark></span><span><mark className="miss">漏检</mark></span>
          </div>
          <div className="small" style={{ marginTop: 8 }}>
            {c.missed.map((i) => <div key={`m${i}`} style={{ color: "var(--danger)" }}>漏检：“{c.gold[i].text}”（{label(c.gold[i].category)}）</div>)}
            {c.false_positives.map((i) => <div key={`f${i}`} style={{ color: "var(--warning)" }}>误报：“{c.pred[i].quote}”（{label(c.pred[i].category)} · {c.pred[i].rule_id ?? "模型"}）</div>)}
            {(c.disclosures.gold_missing.length > 0 || c.disclosures.pred_missing.length > 0) && (
              <div className="faint">必要声明：金标缺少 {c.disclosures.gold_missing.join("、") || "无"}，检出 {c.disclosures.pred_missing.join("、") || "无"}</div>
            )}
          </div>
        </td></tr>
      )}
    </>
  );
}

export default function EvalsPage() {
  const { user, meta } = useAuth();
  const runs = useLoad(() => api.get<EvalRunSummary[]>("/api/evals/runs"));
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<EvalRunDetail | null>(null);
  const [split, setSplit] = useState<Split>("test");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);

  useEffect(() => {
    const id = selected ?? runs.data?.[0]?.id;
    if (id) api.get<EvalRunDetail>(`/api/evals/runs/${id}`).then(setDetail).catch((e) => setError(e.message));
  }, [selected, runs.data]);

  const label = (id: string) => meta?.categories.find((c) => c.id === id)?.label ?? id;
  const report = detail?.metrics.splits[split];
  const cases = useMemo(() => (detail?.cases ?? []).filter((c) => (split === "all" || c.split === split)
    && (!onlyErrors || c.missed.length || c.false_positives.length)), [detail, split, onlyErrors]);

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<EvalRunSummary>("/api/evals/runs");
      await runs.reload();
      setSelected(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>评测报告</h1>
          <p>60 条虚构脚本，字符级标注违规片段。按违规类型计算片段级 Precision / Recall / F1（同类型且 IoU ≥ 0.5 记为命中），并统计改写后复审通过率。CI 中低于门禁即失败。</p>
        </div>
        <div className="row">
          {runs.data && runs.data.length > 0 && (
            <select className="select" style={{ width: 280 }} value={detail?.id ?? ""} onChange={(e) => setSelected(Number(e.target.value))}>
              {runs.data.map((r) => <option key={r.id} value={r.id}>#{r.id} · test F1 {pct(r.test_f1)} · {r.triggered_by} · {time(r.created_at)}</option>)}
            </select>
          )}
          {user?.role === "admin" && <button className="btn btn-primary" disabled={busy} onClick={runNow}><Play size={15} /> {busy ? "运行中…" : "运行评测"}</button>}
        </div>
      </div>
      <ErrorBanner error={error ?? runs.error} />
      {detail?.offline && (
        <div className="notice">
          <b>请如实理解这些数字：</b>结果来自离线确定性模型与合成数据（SYNTHETIC）。规则在 dev 集上调试，test 集写完后未再据此修改规则；但两部分由同一作者编写，test 上的精确率很可能偏乐观。复审使用同一套审查器，通过率只说明“改写消除了审查器能识别的问题”，不等于真正合规。
        </div>
      )}
      {!detail || !report ? <Empty>还没有评测记录。</Empty> : (
        <>
          <div className="row">
            <div className="segmented">
              {(["test", "dev", "all"] as Split[]).map((s) => (
                <button key={s} className={split === s ? "active" : ""} onClick={() => setSplit(s)}>
                  {s === "test" ? "test（报告用）" : s === "dev" ? "dev（调试用）" : "全部"} · {detail.metrics.splits[s].items}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <span className="faint">{detail.provider === "mock" ? "离线确定性模型" : detail.model} · 规则 {detail.ruleset_hash.slice(0, 7)} · 数据集 {detail.dataset_hash.slice(0, 7)} · 耗时 {ms(detail.latency_ms)}</span>
          </div>
          <div className="grid grid-4">
            <Kpi label="片段 F1（IoU ≥ 0.5）" value={pct(report.span.micro.f1)} sub={`P ${pct(report.span.micro.precision)} · R ${pct(report.span.micro.recall)} · 宏平均 ${pct(report.span.macro_f1)}`} />
            <Kpi label="严格边界 F1" value={pct(report.span_strict.f1)} sub={`不计类型的定位 F1 ${pct(report.localisation.f1)}`} />
            <Kpi label="改写后复审通过率" value={pct(report.rewrite.pass_rate)} sub={`${report.rewrite.passed}/${report.rewrite.scripts} 条 · 金标违规被改写 ${pct(report.rewrite.elimination_rate)}`} />
            <Kpi label="证据校验" value={`${report.evidence.findings_valid}/${report.evidence.findings_checked}`} sub={`法条已核对 ${report.evidence.citations_verified}/${report.evidence.citations} · 待核对依据 ${report.evidence.pending_basis}`} />
          </div>
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <div className="card table-wrap">
              <div className="card-head"><h3>按违规类型</h3><span className="faint">support = 金标片段数</span></div>
              <table className="table metric-table">
                <thead><tr><th>类型</th><th className="num">support</th><th className="num">P</th><th className="num">R</th><th className="num">F1</th><th className="num">误报</th></tr></thead>
                <tbody>
                  {Object.entries(report.span.per_category).filter(([, v]) => v.support || v.fp).map(([k, v]) => (
                    <tr key={k}>
                      <td className="nowrap">{label(k)}</td>
                      <td className="num">{v.support}</td>
                      <td className="num">{pct(v.precision)}</td>
                      <td className="num">{pct(v.recall)}</td>
                      <td className="num nowrap"><span className="bar-inline" style={{ width: Math.round(v.f1 * 40), marginRight: 6 }} />{pct(v.f1)}</td>
                      <td className="num">{v.fp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="stack" style={{ gap: 16 }}>
              <div className="card table-wrap">
                <div className="card-head"><h3>通道消融</h3><span className="faint">同一数据只开一个通道</span></div>
                <table className="table metric-table">
                  <thead><tr><th>通道</th><th className="num">P</th><th className="num">R</th><th className="num">F1</th></tr></thead>
                  <tbody>
                    {([["rule", "只用规则（含事实核对）"], ["model", "只用模型通道"], ["both", "双通道合并"]] as const).map(([k, name]) => (
                      <tr key={k}><td>{name}</td><td className="num">{pct(report.ablation[k].precision)}</td><td className="num">{pct(report.ablation[k].recall)}</td><td className="num">{pct(report.ablation[k].f1)}</td></tr>
                    ))}
                  </tbody>
                </table>
                <div className="card-pad faint small">离线时模型通道由少量上下文模式模拟，只覆盖隐含表述，所以单独使用时召回很低；它的作用是验证合并、定位和拦截流程。</div>
              </div>
              <div className="card card-pad small stack">
                <div>必要声明（文档级）F1 <b>{pct(report.disclosures.f1)}</b> · 违规脚本检出 {report.script_level.detected}/{report.script_level.violating} · 干净脚本误报 {report.script_level.clean_flagged}/{report.script_level.clean}</div>
                <div className="faint">延迟 p50 {report.latency_ms.p50}ms · p95 {report.latency_ms.p95}ms（整条流水线，含改写与复审）</div>
              </div>
            </div>
          </div>
          <div className="card table-wrap">
            <div className="card-head">
              <h3>逐条结果（{cases.length}）</h3>
              <label className="row small muted"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> 只看有漏检或误报的</label>
            </div>
            <table className="table metric-table">
              <thead><tr><th>用例</th><th>商品</th><th className="num">金标</th><th className="num">命中</th><th className="num">漏检</th><th className="num">误报</th><th>改写复审</th><th>标签</th></tr></thead>
              <tbody>{cases.map((c) => <CaseRow key={c.id} c={c} label={label} />)}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
