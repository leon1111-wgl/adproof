import { useMemo, useState } from "react";
import { ExternalLink, FlaskConical } from "lucide-react";
import data from "../redteam-report.json";
import { pack } from "../engine/pack";
import { run } from "../engine/pipeline";
import { Empty, Kpi, pct } from "../components/ui";

/* 红队回合: recorded red-team rounds (backend/app/redteam, .github/workflows/redteam.yml). Everything on this page
 * except the "试一句" box is a recording of committed files; the box runs the same browser engine as the workbench. */

type Outcome = "caught" | "other" | "missed" | "clean" | "false_alarm";

interface Item {
  id: string;
  kind: "violation" | "near_miss";
  category: string;
  product_category: string;
  source: "generated" | "seed";
  text: string;
  outcome: Outcome;
  findings: { rule_id: string | null; category: string; quote: string }[];
  audit: { verdict: "agree" | "other" | "none" | "disagree"; violates: string[]; sampled: boolean; triage: boolean } | null;
  decision: { decision: "accept" | "reject"; reason: string; rules?: string[] } | null;
  fixed_in: { commit: string; ruleset_version: string; rules: string[] } | null;
  now: Outcome;
}

interface Round {
  id: string;
  created_at: string;
  seed: number;
  run: { id?: number; url?: string; commit?: string };
  generator: { label?: string; url?: string };
  auditor: { label?: string } | null;
  engine: { commit: string; ruleset_version: string; ruleset_hash: string };
  throughput: { generator: { generation_tok_s_median?: number | null; wall_s?: number } | null; auditor: { wall_s?: number } | null };
  counts: { violations: number; caught: number; other: number; missed: number; near_misses: number; false_alarms: number; seeds: number };
  per_category: Record<string, { violations: number; caught: number; near_misses: number; false_alarms: number }>;
  audit: { sampled: number; disputed: number; rate: number | null; by_kind: Record<string, { sampled: number; disputed: number }> } | null;
  rule_commits: { commit: string; ruleset_version: string; caught: number; false_alarms: number }[];
  items: Item[];
}

interface BlindRun {
  commit: string; label: string; blind: boolean; ruleset_version: string; precision: number; recall: number; f1: number;
  strict_f1: number; clean: number; clean_flagged: number; tp: number; fp: number; fn: number;
}

const REPORT = data as unknown as { rounds: Round[]; blind: { set: string; runs: BlindRun[] } | null };
const REPO = "https://github.com/leon1111-wgl/adproof";
const short = (sha?: string) => (sha ?? "").slice(0, 7);
const catLabel = (id: string) => pack.categories.find((c) => c.id === id)?.label ?? id;
const pcLabel = (id: string) => pack.product_categories[id] ?? id;

function Commit({ sha }: { sha?: string }) {
  if (!sha) return <span className="mono">—</span>;
  return <a className="mono" href={`${REPO}/commit/${sha}`} target="_blank" rel="noreferrer">{short(sha)}</a>;
}

const OUTCOME: Record<Outcome, [string, string]> = {
  caught: ["已标出", "badge-success"],
  other: ["标成其他分类", "badge-warning"],
  missed: ["漏检", "badge-danger"],
  clean: ["合规 · 未标出", "badge-success"],
  false_alarm: ["误报", "badge-danger"],
};

type Filter = "all" | "missed" | "false_alarm" | "fixed" | "rejected";

function AuditNote({ a }: { a: Item["audit"] }) {
  if (!a) return null;
  const text = a.verdict === "agree" ? "同意生成时的标签"
    : a.verdict === "other" ? `认为属于${a.violates.map(catLabel).join("、")}`
    : a.verdict === "none" ? "认为不违规" : `认为违规（${a.violates.map(catLabel).join("、")}）`;
  return (
    <span className={a.verdict === "agree" ? "faint" : "rt-dispute"}>
      模型审计{a.sampled ? "（抽样）" : "（分诊）"}：{text}
    </span>
  );
}

function ItemRow({ it }: { it: Item }) {
  const [label, cls] = OUTCOME[it.outcome];
  const bad = it.outcome === "missed" || it.outcome === "other" || it.outcome === "false_alarm";
  return (
    <li className="rt-item">
      <div className="rt-item-head">
        <span className={`badge ${cls}`}>{label}</span>
        <span className="faint mono">{it.id}</span>
        {it.source === "seed" && <span className="tag">种子说法</span>}
      </div>
      <q className="rt-text serif">{it.text}</q>
      <div className="rt-meta small">
        <span>{it.kind === "near_miss" ? "近似合规说法 · " : ""}{catLabel(it.category)} · {pcLabel(it.product_category)}</span>
        {it.findings.length > 0 && (
          <span className="faint">引擎：{it.findings.map((f) => `${f.rule_id ?? catLabel(f.category)}「${f.quote}」`).join("；")}</span>
        )}
        <AuditNote a={it.audit} />
      </div>
      {bad && (
        <div className="rt-fix small">
          {it.fixed_in ? (
            <span>
              <b>{it.kind === "near_miss" ? "已不再误报" : "已修复"}</b>：{it.fixed_in.rules.length ? `规则 ${it.fixed_in.rules.join("、")} · ` : ""}提交 <Commit sha={it.fixed_in.commit} />（规则库 {it.fixed_in.ruleset_version}）
            </span>
          ) : it.decision ? (
            <span><b>{it.decision.decision === "reject" ? "未采纳" : "已采纳，尚未修复"}</b>：{it.decision.reason}</span>
          ) : (
            <span className="faint">待作者决定</span>
          )}
        </div>
      )}
    </li>
  );
}

function TryOne() {
  const [text, setText] = useState("");
  const [pc, setPc] = useState("food");
  const [out, setOut] = useState<ReturnType<typeof run> | null>(null);
  return (
    <div className="card card-pad stack" style={{ gap: 10 }}>
      <div className="row row-wrap" style={{ justifyContent: "space-between" }}>
        <h3 className="serif" style={{ fontSize: 15 }}>试一句：你来当红队</h3>
        <span className="faint">浏览器内审查 · 规则库 {pack.ruleset.version} · 与工作台同一个引擎，不上传</span>
      </div>
      <p className="small muted">写一句你觉得规则会漏掉的带货话术。这里只按类目审查（不核对商品资料）；没被标出的说法就是一条漏检，规则修改要由作者单独提交。</p>
      <div className="rt-try">
        <input className="input" aria-label="试一句话术" maxLength={200} value={text} placeholder="例如：喝了小半年，我爸体检单上的箭头都没了" onChange={(e) => { setText(e.target.value); setOut(null); }} />
        <select className="select" aria-label="商品类目" value={pc} onChange={(e) => { setPc(e.target.value); setOut(null); }}>
          {Object.entries(pack.product_categories).filter(([k]) => k !== "general").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => setOut(run({ product: { category: pc, facts: [], name: "", brand: "", description: "" }, script: text.trim(), rewrite: false }))}>
          <FlaskConical size={15} /> 审一下
        </button>
      </div>
      {out && (
        out.findings.length ? (
          <ul className="rt-try-out">
            {out.findings.map((f) => (
              <li key={f.key}>
                <span className="badge badge-danger">{f.category_label}</span> <b>{f.rule_id ?? "模型"}</b> 标出「{f.quote}」
                <span className="faint"> · {f.citations.filter((c) => c.status === "verified").map((c) => c.short_label).join("、") || "无已核对条款"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="notice">规则库没有标出这句话。这不等于合规：它可能正是一条漏检，也可能本来就没有问题。</div>
        )
      )}
    </div>
  );
}

export default function RedTeamPage() {
  const rounds = REPORT.rounds;
  const [rid, setRid] = useState(rounds[0]?.id ?? "");
  const [filter, setFilter] = useState<Filter>("all");
  const round = rounds.find((r) => r.id === rid) ?? rounds[0];
  const blind = REPORT.blind?.runs ?? [];
  const firstBlind = blind[0];
  const lastBlind = blind[blind.length - 1];

  const items = useMemo(() => (round?.items ?? []).filter((it) => {
    if (filter === "missed") return it.outcome === "missed" || it.outcome === "other";
    if (filter === "false_alarm") return it.outcome === "false_alarm";
    if (filter === "fixed") return Boolean(it.fixed_in);
    if (filter === "rejected") return it.decision?.decision === "reject" && !it.fixed_in;
    return true;
  }), [round, filter]);

  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>红队回合</h1>
          <p>
            每一轮，一个开源模型按违规分类写出新的规避说法和合规的近似说法；当时的审查引擎在任何修复之前先审一遍。漏检和误报变成规则提案，由作者逐条决定；采纳的规则单独提交，只引用已核对的法条。
          </p>
        </div>
        <span className="tag tag-replay" title="本页不重新运行模型">录制结果</span>
      </div>

      <p className="rt-industry small">
        业界做法：字节跳动巨量引擎的审核模型按条文给出结构化的拒审理由，自动修复的素材先交广告主确认才投放（
        <a href="https://news.sina.cn/ai/2026-07-09/detail-inihfpqs7466787.d.html" target="_blank" rel="noreferrer">新浪科技，2026-07-09</a>
        ）。本页的规则修复同样只是提案，逐条决定后单独提交。
      </p>

      {round && (
        <div className="grid grid-4">
          {rounds.slice(0, 2).map((r) => (
            <Kpi key={r.id} label={`${r.id} 修复前标出（生成的违规说法）`} value={`${r.counts.caught}/${r.counts.violations}`}
              sub={`${pct(r.counts.caught / r.counts.violations)} · 近似合规误报 ${r.counts.false_alarms}/${r.counts.near_misses} · 回合统计，不是质量指标`} />
          ))}
          <Kpi label="模型审计：标签存疑" value={round.audit ? `${round.audit.disputed}/${round.audit.sampled}` : "—"}
            sub={round.audit ? `${round.id} 固定抽样 ${pct(round.audit.rate)} · ${round.auditor?.label?.split(" (")[0] ?? ""} · 不是人工复核` : "未运行"} />
          {firstBlind && (
            <Kpi label="盲测集 v2 片段 F1（唯一的质量数字）" value={pct(lastBlind.f1)}
              sub={`P ${pct(lastBlind.precision)} · R ${pct(lastBlind.recall)} · 干净脚本误报 ${lastBlind.clean_flagged}/${lastBlind.clean} · ${short(lastBlind.commit)}；首跑 ${pct(firstBlind.f1)}`} />
          )}
        </div>
      )}

      {blind.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>盲测集 v2：唯一当作质量报告的数字</h3><span className="faint">{REPORT.blind?.set}</span></div>
          <div className="card-pad small muted stack">
            <span>60 条虚构脚本（18 条干净），由另一个模型家族（Claude Sonnet）只依据分类说明、标注口径和商品资料编写，在本轮任何规则改动之前提交；作者没有读过其中的脚本。指标是片段级 P / R / F1（同类型且 IoU ≥ 0.5），干净脚本误报写在旁边。</span>
          </div>
          <div className="table-wrap">
            <table className="table metric-table rt-blind">
              <thead><tr><th>提交</th><th>何时</th><th className="num">P</th><th className="num">R</th><th className="num">F1</th><th className="num">干净误报</th></tr></thead>
              <tbody>
                {blind.map((b) => (
                  <tr key={b.commit}>
                    <td><Commit sha={b.commit} /></td>
                    <td>{b.label}{b.blind ? "" : "（已看过，非盲）"}</td>
                    <td className="num">{pct(b.precision)}</td>
                    <td className="num">{pct(b.recall)}</td>
                    <td className="num">{pct(b.f1)}</td>
                    <td className="num">{b.clean_flagged}/{b.clean}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!round ? <Empty>还没有录制的红队回合。</Empty> : (
        <>
          <div className="row row-wrap">
            <div className="segmented" role="tablist" aria-label="回合">
              {rounds.map((r) => (
                <button key={r.id} role="tab" aria-selected={r.id === round.id} className={r.id === round.id ? "active" : ""} onClick={() => { setRid(r.id); setFilter("all"); }}>
                  {r.id} · {r.counts.caught}/{r.counts.violations}
                </button>
              ))}
            </div>
          </div>

          <div className="engine-note browser rt-provenance">
            <b>录制</b>
            <span>回合 {round.id} · {round.created_at.slice(0, 10)} · 种子 {round.seed}</span>
            <span>生成：{round.generator.label ?? "—"}</span>
            <span>引擎（修复前）：<Commit sha={round.engine.commit} /> · 规则库 {round.engine.ruleset_version}</span>
            {round.run.url && <a href={round.run.url} target="_blank" rel="noreferrer">Actions 运行 {round.run.id} <ExternalLink size={11} /></a>}
            {round.throughput.generator?.generation_tok_s_median && <span>生成速度 {round.throughput.generator.generation_tok_s_median} token/s（4 核 CPU）</span>}
          </div>

          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <div className="card table-wrap">
              <div className="card-head"><h3>按分类</h3><span className="faint">修复前 → 当前规则库</span></div>
              <table className="table metric-table rt-cats">
                <thead><tr><th>分类</th><th className="num">违规标出</th><th className="num">近似误报</th></tr></thead>
                <tbody>
                  {Object.entries(round.per_category).map(([c, x]) => {
                    const now = round.items.filter((i) => i.category === c);
                    const caughtNow = now.filter((i) => i.kind === "violation" && i.now === "caught").length;
                    const faNow = now.filter((i) => i.kind === "near_miss" && i.now === "false_alarm").length;
                    return (
                      <tr key={c}>
                        <td>{catLabel(c)}</td>
                        <td className="num nowrap">{x.caught}/{x.violations} → {caughtNow}</td>
                        <td className="num nowrap">{x.false_alarms}/{x.near_misses} → {faNow}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card card-pad small stack">
              <div><b>规则提交</b>（每次修改后用同一批说法重审，记录哪次提交标出了哪条）</div>
              {round.rule_commits.length ? (
                <ul className="rt-commits">
                  {round.rule_commits.map((c) => (
                    <li key={c.commit}><Commit sha={c.commit} /> 规则库 {c.ruleset_version}：违规标出 {c.caught}/{round.counts.violations} · 近似误报 {c.false_alarms}/{round.counts.near_misses}</li>
                  ))}
                </ul>
              ) : <span className="faint">这一轮之后还没有规则提交。</span>}
              {round.audit && (
                <div className="faint">
                  模型审计：{round.auditor?.label ?? ""} 按分类口径标注固定随机抽样的 {round.audit.sampled} 条（不看引擎结果），{round.audit.disputed} 条与生成时的标签不一致，记为标签噪声 {pct(round.audit.rate)}。漏检和误报另外送审，只用于分诊。这是另一个模型的意见，不是人工复核。
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head rt-list-head">
              <h3>逐条（{items.length}）</h3>
              <div className="segmented" aria-label="筛选">
                {([["all", "全部"], ["missed", "漏检"], ["false_alarm", "误报"], ["fixed", "已修复"], ["rejected", "未采纳"]] as [Filter, string][]).map(([k, v]) => (
                  <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{v}</button>
                ))}
              </div>
            </div>
            {items.length ? <ul className="rt-list">{items.map((it) => <ItemRow key={it.id} it={it} />)}</ul> : <div className="card-pad faint">没有符合条件的说法。</div>}
          </div>
        </>
      )}

      <TryOne />
    </div>
  );
}
