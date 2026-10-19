import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileUp, Play, Sparkles } from "lucide-react";
import { api } from "../api";
import { canDecide, useAuth } from "../auth";
import { ErrorBanner, RiskBadge, StatusBadge, time, useLoad } from "../components/ui";
import type { Product, Review } from "../types";

/** Demo scripts per product (SYNTHETIC). They are not part of the evaluation set. */
const SAMPLES: Record<string, { text?: string; srt?: string }> = {
  "MIA-SERUM": {
    text: "姐妹们，这瓶烟酰胺精华我真的回购了三次，是我用过最好用的提亮精华！含30%烟酰胺，敏感肌也能用，还能消炎祛痘。\n92%的姐妹用完都说皮肤亮了一个度，别家卖的都是智商税。\n今天直播间到手价99元，全网最低价，拍一发二！",
  },
  "NOAH-OAT": { text: "早餐换成Noah燕麦代餐粉，一杯顶饱一上午。我自己喝了一个月瘦了8斤，我妈喝完血压都降下来了。每份含膳食纤维6g，到手价59元。" },
  "IRIS-VC": { text: "Iris维生素C咀嚼片，每天一片，换季再也不感冒，比吃药还管用。60片一瓶，到手价89元。" },
  "JACK-EARBUDS": {
    srt: "1\n00:00:00,000 --> 00:00:03,200\n家人们，这副降噪耳机今天上车了\n\n2\n00:00:03,200 --> 00:00:06,800\n降噪深度45dB，同价位吊打所有竞品\n\n3\n00:00:06,800 --> 00:00:10,000\n单次续航8小时，行业首创智能降噪\n\n4\n00:00:10,000 --> 00:00:13,000\n到手价299元，点小黄车下单\n",
  },
  "LEON-FRANCHISE": { text: "Leon优选社区零食店，加盟费29800元，总部包选址，稳赚不赔，一年回本，在家就能收钱。" },
  "LEON-COURSE": { text: "零基础剪辑课，32节录播课，保证学会，学完就能接单，好评率高达98%。" },
};

const AGENTS: [string, string][] = [
  ["卖点提炼", "从商品资料提炼卖点，每条都要摘抄资料原文作依据"],
  ["脚本生成（可选）", "按卖点写口播或直播话术"],
  ["规则审查 ∥ 模型审查", "YAML 规则、商品事实核对与模型语义审查并行"],
  ["证据定位与校验", "把结果落到原文字符位置，附上已核对的法条原文"],
  ["改写建议与复审", "逐条给出替换建议，改写稿再审一遍"],
  ["人工终审", "审核员通过、修改或驳回，提交人不能审自己的稿子"],
];

export default function WorkbenchPage() {
  const { user, meta } = useAuth();
  const navigate = useNavigate();
  const products = useLoad(() => api.get<Product[]>("/api/products"));
  const recent = useLoad(() => api.get<{ items: Review[] }>("/api/reviews?limit=6"));
  const [productId, setProductId] = useState<number | null>(null);
  const [mode, setMode] = useState<"review" | "generate">("review");
  const [inputType, setInputType] = useState<"text" | "srt">("text");
  const [content, setContent] = useState("");
  const [style, setStyle] = useState<"short_video" | "live">("short_video");
  const [tone, setTone] = useState<"safe" | "aggressive">("safe");
  const [inject, setInject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (productId == null && products.data?.length) setProductId(products.data[0].id);
  }, [products.data, productId]);

  const product = useMemo(() => products.data?.find((p) => p.id === productId) ?? null, [products.data, productId]);
  const sample = product ? SAMPLES[product.sku] : undefined;

  function fillSample() {
    if (!sample) return;
    if (sample.srt) {
      setInputType("srt");
      setContent(sample.srt);
    } else {
      setInputType("text");
      setContent(sample.text ?? "");
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setContent(String(reader.result ?? ""));
      setInputType(file.name.toLowerCase().endsWith(".srt") ? "srt" : "text");
    };
    reader.readAsText(file, "utf-8");
  }

  async function submit() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const review = await api.post<Review>("/api/reviews", {
        product_id: product.id, mode, input_type: inputType, content: mode === "review" ? content : "",
        style, tone, inject_hallucination: inject,
      });
      navigate(`/reviews/${review.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const categoryName = (c: string) => meta?.product_categories[c] ?? c;
  const ready = product && (mode === "generate" || content.trim().length > 0);

  return (
    <div className="page stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>脚本工作台</h1>
          <p>提交短视频脚本或直播字幕（.srt），或让系统按商品资料生成一版。审查结果会标出每处问题的原文位置、命中的规则和法条原文，最后由审核员终审。</p>
        </div>
      </div>
      <ErrorBanner error={error ?? products.error} />
      <div className="review-grid">
        <div className="card">
          <div className="card-head">
            <h3>新建审查</h3>
            <div className="segmented">
              <button className={mode === "review" ? "active" : ""} onClick={() => setMode("review")}>审查已有脚本</button>
              <button className={mode === "generate" ? "active" : ""} onClick={() => setMode("generate")}>生成新脚本</button>
            </div>
          </div>
          <div className="card-pad stack" style={{ gap: 14 }}>
            <label className="field">
              商品
              <select className="select" value={productId ?? ""} onChange={(e) => setProductId(Number(e.target.value))}>
                {products.data?.map((p) => (
                  <option key={p.id} value={p.id}>{p.brand} {p.name} · {categoryName(p.category)}</option>
                ))}
              </select>
            </label>
            {mode === "review" ? (
              <>
                <div className="row row-wrap">
                  <div className="segmented">
                    <button className={inputType === "text" ? "active" : ""} onClick={() => setInputType("text")}>口播文案</button>
                    <button className={inputType === "srt" ? "active" : ""} onClick={() => setInputType("srt")}>SRT 字幕</button>
                  </div>
                  <span className="spacer" />
                  <button className="btn btn-sm" onClick={() => fileInput.current?.click()}><FileUp size={14} /> 上传 .srt / .txt</button>
                  <input ref={fileInput} type="file" accept=".srt,.txt,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} />
                  <button className="btn btn-sm" disabled={!sample} onClick={fillSample}>填入示例</button>
                </div>
                <textarea
                  className="textarea mono"
                  style={{ minHeight: 240, fontFamily: inputType === "srt" ? "var(--mono)" : "var(--font)", fontSize: 14 }}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={inputType === "srt" ? "1\n00:00:00,000 --> 00:00:03,000\n字幕内容……" : "粘贴短视频口播或直播话术……"}
                />
                <div className="faint">{content.length} 字 · 上限 6000 字</div>
              </>
            ) : (
              <>
                <div className="row row-wrap" style={{ gap: 16 }}>
                  <label className="field" style={{ flex: 1 }}>
                    体裁
                    <select className="select" value={style} onChange={(e) => setStyle(e.target.value as "short_video" | "live")}>
                      <option value="short_video">短视频口播（约 150 字）</option>
                      <option value="live">直播话术（约 250 字）</option>
                    </select>
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    风格
                    <select className="select" value={tone} onChange={(e) => setTone(e.target.value as "safe" | "aggressive")}>
                      <option value="safe">稳妥：生成时就遵守合规约束</option>
                      <option value="aggressive">激进（演示）：模拟不受约束的带货话术</option>
                    </select>
                  </label>
                </div>
                <div className="notice">“激进”只用于演示审查链路：生成环节不加合规约束，后面的审查和改写会把问题找出来。</div>
              </>
            )}
            {canDecide(user) && (
              <label className="row small muted">
                <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} />
                演示开关：让模型通道额外返回一条原文中不存在的引用，观察证据定位如何拦截
              </label>
            )}
            <div className="row">
              <span className="faint">{meta?.offline ? "当前使用离线确定性模型（无需 API Key）" : `当前模型：${meta?.model}`}</span>
              <span className="spacer" />
              <button className="btn btn-primary" disabled={!ready || busy} onClick={submit}>
                {mode === "review" ? <Play size={15} /> : <Sparkles size={15} />}
                {busy ? "提交中…" : mode === "review" ? "开始审查" : "生成并审查"}
              </button>
            </div>
          </div>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head"><h3>商品资料</h3><span className="faint">审查时用于核对价格、成分、规格</span></div>
            <div className="card-pad">
              {product ? (
                <>
                  <div style={{ fontWeight: 500 }}>{product.brand} {product.name}</div>
                  <div className="faint" style={{ margin: "2px 0 8px" }}>{product.sku} · {categoryName(product.category)} · {product.description}</div>
                  <table className="facts"><tbody>
                    {product.facts.map((f) => <tr key={f.key}><td>{f.key}</td><td>{f.value}</td></tr>)}
                  </tbody></table>
                </>
              ) : <span className="faint">加载中…</span>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>审查流程</h3><span className="faint">每一步都记录在链路追踪里</span></div>
            <div className="card-pad"><ol className="agent-list" style={{ margin: 0, padding: 0 }}>
              {AGENTS.map(([name, desc]) => <li key={name}><b>{name}</b><span>{desc}</span></li>)}
            </ol></div>
          </div>
        </div>
      </div>
      <div className="card table-wrap">
        <div className="card-head"><h3>最近审查</h3><Link to="/reviews" className="small">全部记录 →</Link></div>
        <table className="table">
          <thead><tr><th>标题</th><th>状态</th><th>风险</th><th>问题</th><th>提交人</th><th>时间</th></tr></thead>
          <tbody>
            {recent.data?.items.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/reviews/${r.id}`)}>
                <td>{r.title}</td>
                <td><StatusBadge status={r.status} /></td>
                <td><RiskBadge level={r.risk_level} /></td>
                <td className="mono">{r.counts?.total ?? "—"}</td>
                <td className="nowrap">{r.created_by?.name}</td>
                <td className="faint nowrap">{time(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
