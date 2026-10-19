import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { AGENT_TEXT, Empty, ErrorBanner, Json, Kpi, StatusBadge, ms, time, useLoad } from "../components/ui";

interface RunRow {
  id: string;
  kind: string;
  status: string;
  provider: string;
  model: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens_estimated: boolean;
  error: string | null;
  created_at: string;
  review: { id: number; title: string; status: string } | null;
  spans: number;
}

interface SpanRow {
  id: number;
  seq: number;
  agent: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  started_ms: number;
  latency_ms: number;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
}

interface RunDetail extends Omit<RunRow, "spans"> {
  spans: SpanRow[];
}

const KIND_TEXT: Record<string, string> = { review: "审查", recheck: "终审复检" };
const STATUS_CLASS: Record<string, string> = { ok: "", degraded: "badge-warning", error: "badge-danger", rejected: "badge-danger", skipped: "" };
const STATUS_TEXT: Record<string, string> = { ok: "成功", degraded: "已降级", error: "失败", rejected: "驳回", skipped: "跳过" };

function RunView({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const { meta } = useAuth();
  const { data, error } = useLoad(() => api.get<RunDetail>(`/api/runs/${runId}`), [runId]);
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>加载中…</Empty>;
  const machine = data.spans.filter((s) => s.agent !== "human_review");
  const human = data.spans.filter((s) => s.agent === "human_review");
  const total = Math.max(1, ...machine.map((s) => s.started_ms + s.latency_ms));
  const tokens = data.prompt_tokens + data.completion_tokens;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row row-wrap">
        <button className="btn btn-sm" onClick={() => navigate("/traces")}><ArrowLeft size={14} /> 返回列表</button>
        <span className="mono faint">trace {data.id}</span>
        {data.review && <Link to={`/reviews/${data.review.id}`} className="small">{data.review.title} →</Link>}
      </div>
      <div className="grid grid-4">
        <Kpi label="类型" value={KIND_TEXT[data.kind] ?? data.kind} sub={<StatusBadge status={data.status} />} />
        <Kpi label="端到端耗时" value={ms(data.latency_ms)} sub={time(data.created_at)} />
        <Kpi label="Agent 步骤" value={machine.length} sub={`其中降级 ${machine.filter((s) => s.status === "degraded").length} 步`} />
        <Kpi label="Token" value={tokens.toLocaleString()} sub={`${data.provider === "mock" ? "离线模型" : data.model}${data.tokens_estimated ? " · 估算值" : ""}`} />
      </div>
      <div className="card">
        <div className="card-head">
          <h3>执行时间线</h3>
          <span className="faint">
            条形的起点和长度对应开始时间与耗时，规则审查与模型审查并行执行 · 点击展开输入输出
            {data.provider === "mock" && (meta?.simulated_latency_ms ? " · 离线模型的耗时为模拟值" : " · 离线模型几乎没有耗时")}
          </span>
        </div>
        {machine.map((s) => (
          <div key={s.id}>
            <div className="span-row" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className={`badge ${STATUS_CLASS[s.status] ?? ""}`}>{AGENT_TEXT[s.agent] ?? s.agent}</span>
              <span className="ellipsis">
                <b style={{ fontWeight: 500 }}>{s.name}</b>
                {s.status !== "ok" && <span className="faint"> · {STATUS_TEXT[s.status] ?? s.status}</span>}
                {s.prompt_tokens + s.completion_tokens > 0 && <span className="faint"> · {s.prompt_tokens + s.completion_tokens} tokens</span>}
              </span>
              <div className="lane">
                <div className={`bar agent-${s.agent}`} style={{ left: `${(s.started_ms / total) * 100}%`, width: `${Math.max(0.6, (s.latency_ms / total) * 100)}%` }} />
              </div>
              <span className="mono faint">{ms(s.latency_ms)}</span>
            </div>
            {open === s.id && (
              <div className="grid grid-2" style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
                <div><div className="faint">input</div><Json value={s.input} /></div>
                <div><div className="faint">output</div><Json value={s.output} /></div>
              </div>
            )}
          </div>
        ))}
        {human.map((s) => (
          <div key={s.id}>
            <div className="span-row" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className={`badge ${s.status === "ok" ? "badge-success" : "badge-danger"}`}>人工终审</span>
              <span className="ellipsis"><b style={{ fontWeight: 500 }}>{s.name}</b> <span className="faint">· 流水线结束后 {ms(s.started_ms)}</span></span>
              <span className="faint small">不计入机器耗时</span>
              <span />
            </div>
            {open === s.id && (
              <div className="grid grid-2" style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
                <div><div className="faint">input</div><Json value={s.input} /></div>
                <div><div className="faint">output</div><Json value={s.output} /></div>
              </div>
            )}
          </div>
        ))}
        {data.spans.length === 0 && <Empty>没有记录到步骤。</Empty>}
      </div>
    </div>
  );
}

export default function TracesPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => api.get<RunRow[]>("/api/runs?limit=200"));
  if (runId) return <div className="page"><RunView runId={runId} /></div>;
  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>链路追踪</h1>
          <p>每次审查都是一条链路：卖点提炼、规则与模型审查、证据定位、改写和复审，每一步的输入、输出、耗时和 Token 都能回看；人工终审也记录在同一条链路上。</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>时间</th><th>审查</th><th>类型</th><th>状态</th><th>步骤</th><th>耗时</th><th>Token</th><th>模型</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/traces/${r.id}`)}>
                <td className="faint nowrap">{time(r.created_at)}</td>
                <td style={{ maxWidth: 320 }}><div className="ellipsis">{r.review?.title ?? "—"}</div></td>
                <td className="nowrap">{KIND_TEXT[r.kind] ?? r.kind}</td>
                <td><StatusBadge status={r.status} /></td>
                <td className="mono">{r.spans}</td>
                <td className="mono">{ms(r.latency_ms)}</td>
                <td className="mono">{(r.prompt_tokens + r.completion_tokens).toLocaleString()}{r.tokens_estimated ? <span className="faint"> 估</span> : null}</td>
                <td className="faint nowrap">{r.provider === "mock" ? "离线模型" : r.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <Empty>还没有运行记录。</Empty>}
      </div>
    </div>
  );
}
