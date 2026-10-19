import { ExternalLink } from "lucide-react";
import type { Citation, ExternalRef } from "../types";

/** The cited paragraph or item is highlighted inside the full article text. */
function ArticleText({ citation }: { citation: Citation }) {
  const article = citation.article_text;
  const at = citation.text ? article.indexOf(citation.text) : -1;
  if (at < 0) return <div className="article">{article}</div>;
  return (
    <div className="article">
      {article.slice(0, at)}
      <b>{citation.text}</b>
      {article.slice(at + citation.text.length)}
    </div>
  );
}

export function CitationChip({ citation }: { citation: Citation }) {
  const pending = citation.status !== "verified";
  return (
    <span className={`cite-chip ${citation.kind === "penalty" ? "penalty" : ""} ${pending ? "pending" : ""}`} tabIndex={0}>
      {citation.kind === "penalty" && "罚则 · "}
      {citation.short_label}
      {pending && " · 待核对"}
      <span className="law-pop" role="tooltip">
        <b style={{ fontSize: 13 }}>{citation.label}</b>
        {pending ? (
          <div className="muted" style={{ marginTop: 6 }}>{citation.note || "原文尚未核对，系统不展示任何未经核对的条文。"}</div>
        ) : (
          <>
            {citation.lead && <div className="faint" style={{ marginTop: 6 }}>{citation.lead}</div>}
            <div style={{ marginTop: 6 }}><ArticleText citation={citation} /></div>
            <div className="src">
              来源：{citation.source_name} · {citation.version} · {citation.retrieved_at} 核对{" "}
              <a href={citation.source_url} target="_blank" rel="noreferrer">查看原文 <ExternalLink size={11} /></a>
            </div>
          </>
        )}
      </span>
    </span>
  );
}

export function Citations({ citations, references = [] }: { citations: Citation[]; references?: ExternalRef[] }) {
  return (
    <>
      {citations.map((c) => <CitationChip key={`${c.kind}-${c.label}`} citation={c} />)}
      {references.map((r) => (
        <span key={r.title} className="cite-chip pending" title={r.note}>
          《{r.title}》 · 待核对
        </span>
      ))}
    </>
  );
}
