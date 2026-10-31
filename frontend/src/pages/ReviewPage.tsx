import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Check, CircleSlash, Activity as TraceIcon } from "lucide-react";
import { ApiError, DEMO, api } from "../api";
import { useAuth } from "../auth";
import { Manuscript, Redline } from "../components/Manuscript";
import { AGENT_TEXT, Empty, ErrorBanner, Modal, RiskBadge, SEVERITY_TEXT, Stamp, StatusBadge, ms, time } from "../components/ui";
import type { AgentSpan, Finding, Recheck, Review } from "../types";

type Tab = "marked" | "redline" | "clean" | "facts";

function PipelineStrip({ review }: { review: Review }) {
  const spans = review.agents ?? [];
  const running = review.status === "queued" || review.status === "running";
  const firstRewrite = spans.findIndex((s) => s.agent === "rewrite");
  const before = firstRewrite < 0 ? spans : spans.slice(0, firstRewrite);
  const after = firstRewrite < 0 ? [] : spans.slice(firstRewrite);
  const pick = (list: AgentSpan[], agent: string) => list.find((s) => s.agent === agent);
  const sum = (list: AgentSpan[]) => list.reduce((t, s) => t + s.latency_ms, 0);
  const rule = pick(before, "rule_review");
  const model = pick(before, "model_review");
  const rewrites = after.filter((s) => s.agent === "rewrite");
  const reReview = after.filter((s) => s.agent !== "rewrite" && s.agent !== "human_review");
  const human = pick(spans, "human_review");
  const steps: { key: string; name: string; meta: string; state: string; parallel?: boolean }[] = [
    { key: "sp", name: AGENT_TEXT.selling_points, ...state(pick(spans, "selling_points")) },
  ];
  if (review.mode === "generate") steps.push({ key: "sw", name: AGENT_TEXT.script_writer, ...state(pick(spans, "script_writer")) });
  steps.push({
    key: "rv", name: "规则 ∥ 模型", parallel: true,
    meta: rule || model ? `${ms(rule?.latency_ms)} ∥ ${ms(model?.latency_ms)}` : "—",
    state: worst([rule?.status, model?.status]) ?? "",
  });
  steps.push({ key: "ev", name: AGENT_TEXT.evidence_locator, ...state(pick(before, "evidence_locator")) });
  steps.push({
    key: "rw", name: AGENT_TEXT.rewrite,
    meta: rewrites.length ? `${rewrites.length} 轮 · ${ms(sum(rewrites))}` : review.status === "pending" || review.decision ? "无需改写" : "—",
    state: rewrites.length ? "ok" : review.status === "pending" || review.decision ? "ok" : "",
  });
  steps.push({ key: "rr", name: "复审", meta: reReview.length ? ms(sum(reReview)) : "—", state: reReview.length ? "ok" : "" });
  steps.push({
    key: "hr", name: AGENT_TEXT.human_review,
    meta: human ? `${review.decided_by?.name ?? ""} · ${review.decision === "reject" ? "驳回" : "通过"}` : review.status === "pending" ? "等待审核员" : "—",
    state: human ? (review.decision === "reject" ? "rejected" : "ok") : "",
  });
  let marked = false;
  for (const step of steps) {
    if (running && !step.state && !marked) {
      step.state = "running";
      marked = true;
    }
  }
  return (
    <ol className="slip" aria-label="流转单">
      {steps.map((s, i) => (
        <li key={s.key} className={`slip-step${s.parallel ? " parallel" : ""}${s.state ? ` ${s.state}` : " waiting"}`}>
          <span className="slip-no mono">{String(i + 1).padStart(2, "0")}</span>
          <span className="slip-name">{s.name}</span>
          <span className="slip-meta mono">{s.meta}</span>
        </li>
      ))}
    </ol>
  );

  function state(span?: AgentSpan) {
    return { meta: span ? ms(span.latency_ms) : "—", state: span?.status ?? "" };
  }
  function worst(states: (string | undefined)[]) {
    if (states.includes("error")) return "error";
    if (states.includes("degraded")) return "degraded";
    return states.some(Boolean) ? "ok" : undefined;
  }
}

/** Reviewer's verdict on one note: confirm, or mark a false positive with a reason. */
function VerdictActions({
  finding, canVerdict, onVerdict,
}: {
  finding: Finding;
  canVerdict: boolean;
  onVerdict: (verdict: "confirmed" | "false_positive" | null, note: string) => Promise<void>;
}) {
  const [fpNote, setFpNote] = useState<string | null>(null);
  if (!canVerdict && !finding.verdict) return null;
  return (
    <div className="note-actions">
      {finding.verdict ? (
        <>
          <span className={`badge ${finding.verdict === "confirmed" ? "badge-danger" : ""}`}>
            {finding.verdict === "confirmed" ? "已确认违规" : "已标记误报"} · {finding.verdict_by?.name}
          </span>
          {finding.verdict_note && <span className="faint">{finding.verdict_note}</span>}
          {canVerdict && <button className="btn btn-text btn-sm" onClick={() => onVerdict(null, "")}>撤销</button>}
        </>
      ) : fpNote === null ? (
        <>
          <button className="btn btn-sm" onClick={() => onVerdict("confirmed", "")}><Check size={13} /> 确认违规</button>
          <button className="btn btn-sm" onClick={() => setFpNote("")}><CircleSlash size={13} /> 标记误报</button>
        </>
      ) : (
        <>
          <input className="input" style={{ height: 28 }} autoFocus aria-label="误报理由" placeholder="误报理由（会进入规则误报统计）" value={fpNote} onChange={(e) => setFpNote(e.target.value)} />
          <button className="btn btn-sm btn-primary" disabled={fpNote.trim().length < 2} onClick={() => onVerdict("false_positive", fpNote).then(() => setFpNote(null))}>提交</button>
          <button className="btn btn-sm" onClick={() => setFpNote(null)}>取消</button>
        </>
      )}
    </div>
  );
}

function EditModal({ review, onClose, onDone }: { review: Review; onClose: () => void; onDone: (r: Review) => void }) {
  const [text, setText] = useState(review.rewrite?.text || review.source_text || "");
  const [check, setCheck] = useState<Recheck | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      setCheck(await api.post<Recheck>(`/api/reviews/${review.id}/recheck`, { text }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<Review>(`/api/reviews/${review.id}/decision`, { decision: "revise", final_text: text, note }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const blocking = check?.findings.filter((f) => f.severity !== "low") ?? [];
  const missing = check?.disclosures.filter((d) => !d.present) ?? [];
  return (
    <Modal title="修改后通过" onClose={onClose} wide footer={
      <>
        <button className="btn" disabled={busy} onClick={recheck}>复检修改稿</button>
        <button className="btn btn-primary" disabled={busy || !check || !check.passed || check.text !== text.trim()} onClick={approve}>确认通过</button>
      </>
    }>
      <p className="muted small">在改写稿基础上人工修改。提交前必须复检：复检使用同一套规则和模型通道，仍有高、中风险问题时不能通过。</p>
      {DEMO && <p className="faint">静态演示只录制了未改动改写稿的复检；改动后的文本需要完整服务。</p>}
      <textarea className="textarea serif" aria-label="修改稿" style={{ minHeight: 200, fontSize: 15 }} value={text} onChange={(e) => { setText(e.target.value); setCheck(null); }} />
      <input className="input" aria-label="终审备注" placeholder="终审备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      <ErrorBanner error={error} />
      {check && (
        check.passed
          ? <div className="notice">复检通过：没有高、中风险问题，也没有缺少的必要声明。</div>
          : <div className="error-banner">
              复检仍有问题：{blocking.map((f) => `“${f.quote}”（${f.category_label}）`).join("、")}
              {missing.length > 0 && ` 缺少声明：${missing.map((d) => d.required).join("、")}`}
            </div>
      )}
    </Modal>
  );
}

export default function ReviewPage() {
  const { reviewId } = useParams();
  const { meta } = useAuth();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("marked");
  const [active, setActive] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const load = async () => {
      try {
        const r = await api.get<Review>(`/api/reviews/${reviewId}`);
        if (stopped) return;
        setReview(r);
        setError(null);
        if (r.status === "queued" || r.status === "running") timer = window.setTimeout(load, 700);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [reviewId]);

  const findings = useMemo(() => review?.findings ?? [], [review]);
  const select = (key: string) => {
    setActive((current) => (current === key ? null : key));
    setTab("marked");
  };

  async function verdict(key: string, value: "confirmed" | "false_positive" | null, text: string) {
    try {
      setReview(await api.post<Review>(`/api/reviews/${reviewId}/findings/${key}/verdict`, { verdict: value, note: text }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function decide(decision: "approve" | "reject", version?: "original" | "rewrite") {
    setBusy(true);
    setError(null);
    try {
      setReview(await api.post<Review>(`/api/reviews/${reviewId}/decision`, { decision, version, note }));
    } catch (e) {
      if (e instanceof ApiError && e.detail && typeof e.detail === "object" && "findings" in e.detail) {
        const keys = (e.detail as { findings: string[] }).findings;
        setError(`${e.message}${keys.length ? `：${keys.join("、")}` : ""}`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (error && !review) return <div className="page"><ErrorBanner error={error} /></div>;
  if (!review) return <div className="page"><Empty>加载中…</Empty></div>;

  const running = review.status === "queued" || review.status === "running";
  const counts = review.counts ?? {};
  const perms = review.permissions;
  const rewrite = review.rewrite ?? {};
  const missing = (review.disclosures ?? []).filter((d) => !d.present);
  const categoryName = (c: string) => meta?.product_categories[c] ?? c;

  return (
    <div className="page stack" style={{ gap: 14 }}>
      <div className="review-head">
        <Link to="/reviews" className="back-link small"><ArrowLeft size={14} /> 审查记录</Link>
        <div className="row row-wrap" style={{ gap: 10 }}>
          <h1 className="serif">{review.title}</h1>
          <StatusBadge status={review.status} />
          <RiskBadge level={review.risk_level} />
          <span className="spacer" />
          {review.run_id && <Link className="btn btn-sm" to={`/traces/${review.run_id}`}><TraceIcon size={14} /> 链路追踪</Link>}
        </div>
        <div className="faint">
          {review.product.brand} {review.product.name} · {categoryName(review.product.category)} ·
          {" "}{review.mode === "generate" ? `系统生成（${review.options?.tone === "aggressive" ? "激进·演示" : "稳妥"}）` : review.input_type === "srt" ? "SRT 字幕" : "口播文案"} ·
          {" "}{review.created_by.name} 提交于 {time(review.created_at)} · 规则库 {review.ruleset_version}（{review.ruleset_hash.slice(0, 7)}）· {review.provider === "mock" ? "离线确定性模型" : review.model}
        </div>
      </div>
      <PipelineStrip review={review} />
      <ErrorBanner error={error ?? review.error} />
      {running ? <div className="card"><Empty>多个审查环节正在运行，结果出来后会自动刷新…</Empty></div> : (
        <section className="sheet-card">
          <div className="sheet-tabs">
            <div className="tabs" role="tablist" aria-label="稿件视图">
              {([
                ["marked", `批注稿 · ${findings.length + missing.length}`],
                ["redline", "红笔改稿"],
                ["clean", "清样"],
                ["facts", "卖点与资料"],
              ] as [Tab, string][]).map(([key, label]) => (
                <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>
            <span className="spacer" />
            {tab === "marked" && review.validation && (
              <span className="faint" title="每条结果都重新核对了原文片段和法条快照">
                证据校验 {review.validation.valid}/{review.validation.checked} · 法条已核对 {review.validation.citations_verified}/{review.validation.citations}
              </span>
            )}
            {(tab === "redline" || tab === "clean") && rewrite.rounds && (
              <span className={`badge ${rewrite.passed ? "badge-success" : "badge-danger"}`}>
                {rewrite.passed ? "改写稿复审通过" : "改写稿复审未通过"} · {rewrite.rounds.length} 轮
              </span>
            )}
          </div>
          {tab === "marked" && (
            <>
              {findings.length === 0 && missing.length === 0 && (review.rejected?.length ?? 0) === 0 ? (
                <div className="manuscript"><div className="ms-text">{review.source_text}</div><Empty>没有发现问题。</Empty></div>
              ) : (
                <Manuscript
                  text={review.source_text ?? ""}
                  cues={review.cues}
                  findings={findings}
                  missing={missing}
                  rejected={review.rejected}
                  activeKey={active}
                  onSelect={select}
                  actionsFor={(f) => <VerdictActions finding={f} canVerdict={Boolean(perms?.can_verdict)} onVerdict={(v, n) => verdict(f.key, v, n)} />}
                />
              )}
              <div className="sheet-legend">
                <span><mark className="hl high">删去</mark> 高风险</span>
                <span><mark className="hl medium">波浪线</mark> 中风险</span>
                <span className="faint">点红笔处或批注展开依据；法条标签悬停可看已核对的原文</span>
              </div>
            </>
          )}
          {tab === "redline" && (
            rewrite.diff ? (
              <>
                <Redline rewrite={rewrite} />
                {rewrite.edits && rewrite.edits.length > 0 && (
                  <div className="table-wrap" style={{ borderTop: "1px solid var(--border-2)" }}>
                    <table className="table"><tbody>
                      {rewrite.edits.map((e, i) => (
                        <tr key={i}>
                          <td className="mono faint nowrap">{e.keys.join(" ")}</td>
                          <td><del className="pen-del">{e.original || "（无）"}</del></td>
                          <td>{e.replacement ? <ins className="pen-ins">{e.replacement}</ins> : <span className="faint">删除</span>}</td>
                          <td className="faint small">{e.note}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  </div>
                )}
              </>
            ) : <Empty>没有需要改写的内容。</Empty>
          )}
          {tab === "clean" && (
            <div className="clean-copy">
              <div className="ms-text">{rewrite.text || review.source_text}</div>
              <div className="faint">清样：按红笔改稿逐条替换后的全文，改写稿会用同一套规则和模型再审一遍{rewrite.changed === false ? "（本稿无需改动）" : ""}。</div>
            </div>
          )}
          {tab === "facts" && (
            <div className="card-pad stack" style={{ gap: 16 }}>
              <div>
                <div className="label" style={{ marginBottom: 6 }}>卖点提炼（每条都摘抄了资料原文）</div>
                {review.selling_points?.length ? (
                  <table className="facts"><tbody>
                    {review.selling_points.map((p) => (
                      <tr key={p.title + p.detail}><td>{p.title}</td><td>{p.detail}<div className="faint">依据：{p.source_field} · “{p.evidence}”</div></td></tr>
                    ))}
                  </tbody></table>
                ) : <span className="faint">没有可用的卖点</span>}
              </div>
              <div>
                <div className="label" style={{ marginBottom: 6 }}>商品资料（审查时的快照）</div>
                <table className="facts"><tbody>
                  {review.product.facts.map((f) => <tr key={f.key}><td>{f.key}</td><td>{f.value}</td></tr>)}
                </tbody></table>
              </div>
            </div>
          )}
        </section>
      )}

      {!running && review.decision && (
        <div className="verdict-card">
          <Stamp status={review.status} />
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <b>
              {review.decision === "reject" ? "驳回" : review.decision_version === "rewrite" ? "采用改写稿" : review.decision_version === "edited" ? "人工修改后通过" : "原稿通过"}
              <span className="faint" style={{ fontWeight: 400 }}> · {review.decided_by?.name} · {time(review.decided_at)}</span>
            </b>
            {review.decision_note && <div className="muted">{review.decision_note}</div>}
            {review.final_text && <div className="final-text">{review.final_text}</div>}
          </div>
        </div>
      )}

      {!running && !review.decision && review.status === "pending" && (
        <div className="decision-bar">
          <b className="serif">终审签发</b>
          {perms?.can_decide ? (
            <>
              <textarea className="textarea" aria-label="终审备注" placeholder="终审备注（驳回时必填）" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn btn-primary" disabled={busy || !rewrite.passed} title={rewrite.passed ? "" : "改写稿没有通过复审"} onClick={() => decide("approve", "rewrite")}>采用改写稿通过</button>
              <button className="btn" disabled={busy} onClick={() => setEditing(true)}>修改后通过</button>
              <button className="btn" disabled={busy} title="仅当所有高、中风险问题都标记为误报时可用" onClick={() => decide("approve", "original")}>原稿通过</button>
              <button className="btn btn-danger" disabled={busy || note.trim().length < 2} onClick={() => decide("reject")}>驳回</button>
            </>
          ) : <span className="muted">{perms?.reason}</span>}
          <span className="spacer" />
          <span className="faint">
            {SEVERITY_TEXT.high} {counts.high ?? 0} · {SEVERITY_TEXT.medium} {counts.medium ?? 0} · 已判定 {findings.filter((f) => f.verdict).length}/{findings.length}
            {DEMO && " · 静态演示：判定和签发只在本页内存中生效，规则与服务端相同"}
          </span>
        </div>
      )}
      {editing && <EditModal review={review} onClose={() => setEditing(false)} onDone={(r) => { setReview(r); setEditing(false); }} />}
    </div>
  );
}
