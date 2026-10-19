import { useEffect, useState } from "react";
import { ExternalLink, Play, Save, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Citations } from "../components/Citations";
import { MarkedText } from "../components/ScriptView";
import { Drawer, Empty, ErrorBanner, SEVERITY_TEXT, SeverityDot, pct, time, useLoad } from "../components/ui";
import type { Citation, ExternalRef, Severity } from "../types";

interface RuleRow {
  id: string;
  name: string;
  category: string;
  severity: Severity;
  applies_to: string[];
  patterns: string[];
  keywords: string[];
  exceptions: string[];
  negation: boolean;
  unless_sentence: string | null;
  reason: string;
  enabled: boolean;
  rewrite: Record<string, unknown> | null;
  examples: { hit: string[]; pass: string[] };
  citations: Citation[];
  references: ExternalRef[];
  stats: { hits: number; false_positives: number; confirmed: number; fp_rate: number | null };
}

interface RulesResponse {
  version: string;
  name: string;
  hash: string;
  description: string;
  product_categories: Record<string, string>;
  categories: { id: string; label: string; description: string; severity: Severity; citations: Citation[]; references: ExternalRef[] }[];
  rules: RuleRow[];
  disclosures: { id: string; name: string; applies_to: string[]; required: string[]; citations: Citation[] }[];
  warnings: string[];
}

interface Law {
  id: string;
  title: string;
  type: string;
  issuer: string;
  promulgated: string;
  effective: string;
  validity: string;
  version_history: string[];
  source: { name: string; url: string; retrieved_at: string; method: string };
  scope_note: string;
  articles: { number: number; label: string; text: string }[];
}

type Tab = "rules" | "laws" | "yaml" | "test";

function RuleDrawer({ rule, products, onClose }: { rule: RuleRow; products: Record<string, string>; onClose: () => void }) {
  return (
    <Drawer title={<span><span className="mono faint">{rule.id}</span> <b>{rule.name}</b></span>} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="muted">{rule.reason}</div>
        <div className="row row-wrap">
          <span className="badge">{SEVERITY_TEXT[rule.severity]}</span>
          <span className="badge">适用：{rule.applies_to.includes("all") ? "全部类目" : rule.applies_to.map((c) => products[c] ?? c).join("、")}</span>
          {rule.negation && <span className="badge">否定语境豁免</span>}
        </div>
        <div><div className="label">法律依据</div><div className="row row-wrap" style={{ marginTop: 6 }}><Citations citations={rule.citations} references={rule.references} /></div></div>
        {rule.patterns.length > 0 && <div><div className="label">匹配模式（运行在归一化文本上）</div>{rule.patterns.map((p) => <pre key={p} className="json mono" style={{ marginTop: 6 }}>{p}</pre>)}</div>}
        {rule.keywords.length > 0 && <div><div className="label">关键词</div><div className="row row-wrap" style={{ marginTop: 6 }}>{rule.keywords.map((k) => <span key={k} className="badge">{k}</span>)}</div></div>}
        {rule.exceptions.length > 0 && <div><div className="label">例外</div>{rule.exceptions.map((p) => <pre key={p} className="json mono" style={{ marginTop: 6 }}>{p}</pre>)}</div>}
        {rule.unless_sentence && <div><div className="label">整句豁免（例如写明了数据来源）</div><pre className="json mono" style={{ marginTop: 6 }}>{rule.unless_sentence}</pre></div>}
        <div className="grid grid-2">
          <div><div className="label">正例（必须命中）</div>{rule.examples.hit.map((e) => <div key={e} className="small" style={{ marginTop: 4 }}>✓ {e}</div>)}</div>
          <div><div className="label">反例（不能命中）</div>{rule.examples.pass.map((e) => <div key={e} className="small" style={{ marginTop: 4 }}>✗ {e}</div>)}</div>
        </div>
        {rule.rewrite && <div><div className="label">改写模板</div><pre className="json mono" style={{ marginTop: 6 }}>{JSON.stringify(rule.rewrite, null, 2)}</pre></div>}
      </div>
    </Drawer>
  );
}

function LawsTab() {
  const { data, error } = useLoad(() => api.get<Law[]>("/api/laws"));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <ErrorBanner error={error} />
      <div className="notice">
        条文摘自国家法律法规数据库，只收录规则库引用到的条款；仓库里的 <span className="mono">scripts/verify_law_snapshot.py</span> 可以随时对照官方数据库复核。规则引用了快照以外的条款时，界面一律显示“待核对”，不展示任何未经核对的条文。
      </div>
      {data?.map((law) => (
        <div className="card" key={law.id}>
          <div className="card-head">
            <div>
              <h3>{law.title}</h3>
              <div className="faint">{law.type} · {law.issuer} · {law.promulgated} 公布 · {law.effective} 施行 · {law.validity}</div>
            </div>
            <a className="btn btn-sm" href={law.source.url} target="_blank" rel="noreferrer">官方原文 <ExternalLink size={13} /></a>
          </div>
          <div className="card-pad faint small" style={{ borderBottom: "1px solid var(--border-2)" }}>
            {law.source.name} · {law.source.retrieved_at} 摘录 · {law.scope_note}
            {law.version_history.length > 0 && <div style={{ marginTop: 4 }}>{law.version_history[law.version_history.length - 1]}</div>}
          </div>
          {law.articles.map((a) => <div className="law-article" key={a.number}><pre>{a.text}</pre></div>)}
        </div>
      ))}
    </div>
  );
}

function YamlTab({ canSave, onSaved }: { canSave: boolean; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState<{ hash: string; version: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; errors: string[]; warnings: string[]; rules?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useLoad(() => api.get<{ at: string; user: string; from: string; to: string; version: string }[]>("/api/rules/history"));

  useEffect(() => {
    api.get<{ yaml: string; hash: string; version: string }>("/api/rules/yaml").then((r) => {
      setText(r.yaml);
      setLoaded({ hash: r.hash, version: r.version });
    }).catch((e) => setError(e.message));
  }, []);

  async function validate() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post("/api/rules/validate", { yaml: text }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ hash: string; version: string; warnings: string[] }>("/api/rules/yaml", { yaml: text });
      setLoaded({ hash: r.hash, version: r.version });
      setResult({ ok: true, errors: [], warnings: r.warnings });
      history.reload();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start" }}>
      <div className="card">
        <div className="card-head">
          <span className="faint">当前版本 {loaded?.version} · {loaded?.hash}</span>
          <div className="row">
            <button className="btn btn-sm" disabled={busy} onClick={validate}><ShieldCheck size={14} /> 校验</button>
            <button className="btn btn-sm btn-primary" disabled={busy || !canSave} title={canSave ? "" : "只有管理员可以保存规则库"} onClick={save}><Save size={14} /> 保存</button>
          </div>
        </div>
        <textarea className="textarea code-editor" spellCheck={false} style={{ border: "none", borderRadius: 0 }} value={text}
          onChange={(e) => { setText(e.target.value); setResult(null); }} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <ErrorBanner error={error} />
        <div className="card card-pad stack">
          <b>保存前自动检查</b>
          <ol className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>YAML 语法与字段格式</li>
            <li>每条正则都能编译</li>
            <li>每条规则自带的正例必须命中、反例不能命中</li>
            <li>法条引用能否在本地快照中找到（找不到的标“待核对”）</li>
          </ol>
          {result && (
            result.ok
              ? <div className="notice">校验通过{result.rules ? `，共 ${result.rules} 条规则` : ""}。</div>
              : <div className="error-banner">{result.errors.map((e) => <div key={e}>{e}</div>)}</div>
          )}
          {result && result.warnings.length > 0 && (
            <div className="small" style={{ color: "var(--warning)" }}>{result.warnings.map((w) => <div key={w}>待核对：{w}</div>)}</div>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h3>修改记录</h3></div>
          {history.data?.length ? history.data.map((h) => (
            <div key={h.at} className="card-pad small" style={{ borderBottom: "1px solid var(--border-2)" }}>
              {h.user} · {time(h.at)}<div className="faint mono">{h.from} → {h.to}</div>
            </div>
          )) : <Empty>还没有在线修改过。</Empty>}
        </div>
      </div>
    </div>
  );
}

function TestTab({ products }: { products: Record<string, string> }) {
  const [text, setText] = useState("这款精华是全网最好用的！98%的姐妹都回购了，别家都是智商税。本品不能代替药物。");
  const [category, setCategory] = useState("cosmetics");
  const [result, setResult] = useState<{ hits: { rule_id: string; category_label: string; start: number; end: number; quote: string; severity: Severity }[] } | null>(null);
  async function run() {
    setResult(await api.post("/api/rules/test", { text, product_category: category }));
  }
  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card card-pad stack">
        <div className="row">
          <select className="select" style={{ width: 160 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(products).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="spacer" />
          <button className="btn btn-primary btn-sm" onClick={run}><Play size={14} /> 只跑规则引擎</button>
        </div>
        <textarea className="textarea" style={{ minHeight: 200 }} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="faint">规则试运行只走规则通道，不调用模型，方便调试正则和例外。</div>
      </div>
      <div className="card">
        <div className="card-head"><h3>命中结果</h3>{result && <span className="faint">{result.hits.length} 处</span>}</div>
        {result ? (
          <>
            <div className="script"><MarkedText text={text} marks={result.hits.map((h, i) => ({ id: String(i), start: h.start, end: h.end, className: `hl ${h.severity}`, label: h.rule_id }))} /></div>
            <table className="table"><tbody>
              {result.hits.map((h, i) => <tr key={i}><td className="mono nowrap">{h.rule_id}</td><td>{h.category_label}</td><td>“{h.quote}”</td><td className="mono faint">{h.start}–{h.end}</td></tr>)}
            </tbody></table>
          </>
        ) : <Empty>点击左侧按钮运行。</Empty>}
      </div>
    </div>
  );
}

export default function RulesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("rules");
  const [open, setOpen] = useState<RuleRow | null>(null);
  const { data, error, reload } = useLoad(() => api.get<RulesResponse>("/api/rules"));
  const products = data?.product_categories ?? {};
  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>规则库</h1>
          <p>规则以 YAML 维护：每条规则写明匹配模式、例外、正反例、改写模板和法律依据。审核员标记的误报会回流到这里，作为调整规则的依据。</p>
        </div>
        {data && <span className="badge">{data.name} · {data.version} · {data.hash}</span>}
      </div>
      <div className="tabs">
        {([["rules", "规则列表"], ["laws", "法条快照"], ["yaml", "YAML 编辑"], ["test", "规则试运行"]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <ErrorBanner error={error} />
      {data && data.warnings.length > 0 && tab === "rules" && (
        <div className="error-banner" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
          {data.warnings.length} 处法条引用未在本地快照中核对，相关结果会标注“待核对”。
        </div>
      )}
      {tab === "rules" && data && (
        <>
          {data.categories.map((cat) => {
            const rules = data.rules.filter((r) => r.category === cat.id);
            return (
              <div className="card" key={cat.id}>
                <div className="card-head" style={{ alignItems: "flex-start", padding: "12px 16px" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row"><SeverityDot level={cat.severity} /><h3>{cat.label}</h3><span className="faint mono">{cat.id}</span></div>
                    <div className="faint" style={{ marginTop: 2 }}>{cat.description}</div>
                    <div className="row row-wrap" style={{ marginTop: 8 }}><Citations citations={cat.citations} references={cat.references} /></div>
                  </div>
                </div>
                {rules.length > 0 ? (
                  <div className="table-wrap"><table className="table">
                    <thead><tr><th>编号</th><th>规则</th><th>适用类目</th><th>匹配</th><th>补充依据</th><th className="num">命中</th><th className="num">误报率</th></tr></thead>
                    <tbody>
                      {rules.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => setOpen(r)}>
                          <td className="mono nowrap">{r.id}</td>
                          <td>{r.name}<div className="faint">{r.examples.hit[0] ? `例：${r.examples.hit[0]}` : ""}</div></td>
                          <td className="small">{r.applies_to.includes("all") ? "全部" : r.applies_to.map((c) => products[c] ?? c).join("、")}</td>
                          <td className="small faint nowrap">{r.patterns.length} 个模式{r.keywords.length ? ` · ${r.keywords.length} 个词` : ""}{r.exceptions.length ? ` · ${r.exceptions.length} 个例外` : ""}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {r.citations.some((c) => c.kind === "basis")
                              ? <div className="row row-wrap"><Citations citations={r.citations.filter((c) => c.kind === "basis")} /></div>
                              : <span className="faint small">沿用分类依据</span>}
                          </td>
                          <td className="mono num">{r.stats.hits}</td>
                          <td className="mono num">{r.stats.fp_rate == null ? "—" : pct(r.stats.fp_rate, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                ) : <div className="card-pad faint small">该分类由事实核对模块实现：脚本中的数字与商品资料逐项比对。</div>}
              </div>
            );
          })}
          <div className="card">
            <div className="card-head"><h3>必要声明</h3><span className="faint">文档级检查：全文必须出现其中一个表述</span></div>
            <table className="table"><tbody>
              {data.disclosures.map((d) => (
                <tr key={d.id}>
                  <td className="mono nowrap">{d.id}</td>
                  <td>{d.name}<div className="faint">{d.required.join(" / ")}</div></td>
                  <td className="small">{d.applies_to.map((c) => products[c] ?? c).join("、")}</td>
                  <td><div className="row row-wrap"><Citations citations={d.citations} /></div></td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </>
      )}
      {tab === "laws" && <LawsTab />}
      {tab === "yaml" && <YamlTab canSave={user?.role === "admin"} onSaved={reload} />}
      {tab === "test" && <TestTab products={products} />}
      {open && <RuleDrawer rule={open} products={products} onClose={() => setOpen(null)} />}
    </div>
  );
}
