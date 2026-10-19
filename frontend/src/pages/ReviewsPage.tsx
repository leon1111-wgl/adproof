import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Empty, ErrorBanner, MODE_TEXT, RiskBadge, StatusBadge, time, useLoad } from "../components/ui";
import type { Review } from "../types";

const FILTERS: [string, string][] = [["", "全部"], ["pending", "待终审"], ["approved", "已通过"], ["rejected", "已驳回"], ["failed", "失败"]];

export default function ReviewsPage() {
  const { meta } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const { data, error } = useLoad(
    () => api.get<{ items: Review[]; status_counts: Record<string, number> }>(`/api/reviews?limit=200${status ? `&status=${status}` : ""}`),
    [status],
  );
  const counts = data?.status_counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>审查记录</h1>
          <p>每条记录都保存了当时的商品资料、规则库版本和模型，规则以后改了也能解释当时为什么这样判。</p>
        </div>
        <Link to="/workbench" className="btn btn-primary"><Plus size={15} /> 新建审查</Link>
      </div>
      <div className="tabs">
        {FILTERS.map(([key, label]) => (
          <button key={key} className={status === key ? "active" : ""} onClick={() => setStatus(key)}>
            {label} {key ? counts[key] ?? 0 : total}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>标题</th><th>商品</th><th>类型</th><th>状态</th><th>风险</th><th>问题</th><th>提交人</th><th>终审</th><th>时间</th></tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/reviews/${r.id}`)}>
                <td className="mono faint">{r.id}</td>
                <td style={{ maxWidth: 300 }}><div className="ellipsis">{r.title}</div></td>
                <td className="nowrap">{r.product.brand} <span className="faint">{meta?.product_categories[r.product.category] ?? r.product.category}</span></td>
                <td className="nowrap">{MODE_TEXT[r.mode]}{r.input_type === "srt" ? " · SRT" : ""}</td>
                <td><StatusBadge status={r.status} /></td>
                <td><RiskBadge level={r.risk_level} /></td>
                <td className="mono">{r.counts?.total ?? "—"}{r.counts?.high ? <span className="faint"> · 高 {r.counts.high}</span> : null}</td>
                <td className="nowrap">{r.created_by.name}</td>
                <td className="nowrap">{r.decided_by ? `${r.decided_by.name} · ${r.decision === "reject" ? "驳回" : "通过"}` : <span className="faint">—</span>}</td>
                <td className="faint nowrap">{time(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.items.length === 0 && <Empty>暂无记录。</Empty>}
      </div>
    </div>
  );
}
