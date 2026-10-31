import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Github } from "lucide-react";
import { DEMO } from "../api";
import { useAuth } from "../auth";
import { Manuscript, Redline } from "../components/Manuscript";
import { Logo, ThemeButton, pct } from "../components/ui";
import type { Disclosure, Finding, RewriteResult } from "../types";
import recorded from "../specimen.json";

// One seeded review as the offline model annotated it, plus the offline eval summary; both
// written by scripts/record_demo.py. Law text inside comes from the verified snapshots only.
const specimen = recorded as unknown as {
  title: string;
  product: { brand: string; name: string; category: string; facts: { key: string; value: string }[] };
  text: string;
  findings: Finding[];
  disclosures: Disclosure[];
  rewrite: RewriteResult;
  ruleset: { version: string; hash: string; name: string };
  model: string;
  eval: {
    items: { dev: number; test: number };
    test: { precision: number; recall: number; f1: number; strict_f1: number; rewrite_passed: number; rewrite_scripts: number; evidence_valid: number; evidence_checked: number };
    dev_f1: number;
  };
};

const SLIP: [string, string][] = [
  ["卖点提炼", "从商品资料提炼卖点，每条都摘抄资料原文作依据"],
  ["脚本生成（可选）", "按卖点写口播或直播话术"],
  ["规则审查 ∥ 模型审查", "YAML 规则、商品事实核对和模型语义审查并行"],
  ["证据定位与校验", "把结果落到原文的字符位置，附上已核对的法条原文；原文里找不到的引用直接拦下"],
  ["改写建议与复审", "逐条给出替换建议，改写稿用同一套审查器再审一遍"],
  ["人工终审", "审核员通过、修改或驳回；提交人不能审自己的稿子"],
];

function Specimen() {
  const [active, setActive] = useState<string | null>(specimen.findings[0]?.key ?? null);
  const [view, setView] = useState<"marked" | "redline" | "clean">("marked");
  return (
    <div className="sheet-card specimen">
      <div className="sheet-tabs">
        <div className="tabs" role="tablist" aria-label="样稿视图">
          {(
            [
              ["marked", "批注稿"],
              ["redline", "红笔改稿"],
              ["clean", "清样"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={view === key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="faint">
          {specimen.product.brand}
          {specimen.product.name} · 录制的真实输出 · SYNTHETIC
        </span>
      </div>
      {view === "marked" && <Manuscript text={specimen.text} findings={specimen.findings} activeKey={active} onSelect={(k) => setActive(active === k ? null : k)} />}
      {view === "redline" && <Redline rewrite={specimen.rewrite} />}
      {view === "clean" && (
        <div className="clean-copy">
          <div className="ms-text">{specimen.rewrite.text}</div>
          <div className="faint">改写稿用同一套审查器复审{specimen.rewrite.passed ? "通过" : "未通过"}；是否发布仍由审核员签字决定。</div>
        </div>
      )}
    </div>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const enter = user ? "/workbench" : "/login";
  const t = specimen.eval.test;
  const lawCount = new Set(specimen.findings.flatMap((f) => f.citations.filter((c) => c.status === "verified").map((c) => c.label))).size;

  return (
    <div className="landing">
      <header className="land-top">
        <Link to="/" className="mast-brand">
          <Logo size={26} />
          <span>
            <b className="serif">AdProof</b>
            <span>带货素材合规审查</span>
          </span>
        </Link>
        <nav className="land-nav" aria-label="介绍页目录">
          <a href="#proof">批注样稿</a>
          <a href="#slip">流转单</a>
          <a href="#evals">离线评测</a>
        </nav>
        <span className="spacer" />
        <ThemeButton />
        <a className="icon-btn" href="https://github.com/leon1111-wgl/adproof" target="_blank" rel="noreferrer" title="GitHub 代码" aria-label="GitHub 代码">
          <Github size={16} />
        </a>
        <Link className="btn btn-primary" to={enter}>
          {user ? "回到审查台" : "进入审查台"}
        </Link>
      </header>

      <main>
        <section className="hero">
          <div>
            <span className="eyebrow">AD COMPLIANCE · 带货素材合规审查</span>
            <h1 className="serif">
              每一处违规，都用红笔圈出来，
              <br />
              并在页边写明依据
            </h1>
            <p className="lead">
              短视频口播和直播字幕交上来，多个 Agent 逐条标出问题：落到原文的第几个字、命中哪条规则、对应《广告法》哪一条的原文；
              再给出改写稿并复审一遍，最后由审核员签字。
            </p>
            <div className="hero-cta">
              <Link className="btn btn-primary btn-lg" to={enter}>
                {user ? "回到审查台" : "进入审查台"} <ArrowRight size={16} />
              </Link>
              <a className="btn btn-lg" href="#proof">
                先看一份批注稿
              </a>
            </div>
          </div>
          <dl className="colophon">
            <dt>本页样稿</dt>
            <dd>{specimen.title}</dd>
            <dt>批注</dt>
            <dd>
              {specimen.findings.length} 处 · 引用已核对条文 {lawCount} 条
            </dd>
            <dt>规则库</dt>
            <dd className="mono">
              {specimen.ruleset.version} · {specimen.ruleset.hash.slice(0, 7)}
            </dd>
            <dt>模型</dt>
            <dd>离线确定性模型（{specimen.model}）</dd>
            <dt>数据</dt>
            <dd>品牌、商品和脚本均为虚构（SYNTHETIC）</dd>
            <dt>版本</dt>
            <dd>{DEMO ? "静态演示 · 回放录制结果" : "完整服务"}</dd>
          </dl>
        </section>

        <section id="proof" className="land-section">
          <div className="section-head">
            <span className="folio">§1</span>
            <h2 className="serif">一份批注稿</h2>
            <p>点红笔圈住的地方或页边批注，展开理由和依据；法条标签悬停可看原文（摘自国家法律法规数据库的已核对快照，注明版本和核对日期）。再切到“红笔改稿”和“清样”。</p>
          </div>
          <Specimen />
        </section>

        <section id="slip" className="land-section">
          <div className="section-head">
            <span className="folio">§2</span>
            <h2 className="serif">一份稿件的流转单</h2>
            <p>每个环节都写进链路追踪，规则库版本和商品资料随审查记录一起保存：规则以后改了，也能解释当时为什么这样判。</p>
          </div>
          <ol className="routing">
            {SLIP.map(([name, desc], i) => (
              <li key={name}>
                <span className="routing-no mono">{String(i + 1).padStart(2, "0")}</span>
                <b className="serif">{name}</b>
                <span>{desc}</span>
                <span className="routing-box" aria-hidden="true" />
              </li>
            ))}
          </ol>
        </section>

        <section id="evals" className="land-section">
          <div className="section-head">
            <span className="folio">§3</span>
            <h2 className="serif">离线评测：请带着前提读</h2>
            <p>
              {specimen.eval.items.dev + specimen.eval.items.test} 条虚构脚本（dev {specimen.eval.items.dev} / test {specimen.eval.items.test}），字符级标注违规片段；CI 每次提交都跑，低于门槛就失败。
            </p>
          </div>
          <div className="eval-sheet">
            <table className="table">
              <tbody>
                <tr>
                  <td>片段级 Precision / Recall / F1（test）</td>
                  <td className="mono num">
                    {pct(t.precision)} / {pct(t.recall)} / {pct(t.f1)}
                  </td>
                </tr>
                <tr>
                  <td>严格边界 F1（test）</td>
                  <td className="mono num">{pct(t.strict_f1)}</td>
                </tr>
                <tr>
                  <td>改写后复审通过（test）</td>
                  <td className="mono num">
                    {t.rewrite_passed}/{t.rewrite_scripts}
                  </td>
                </tr>
                <tr>
                  <td>证据校验（片段与原文一致）</td>
                  <td className="mono num">
                    {t.evidence_valid}/{t.evidence_checked}
                  </td>
                </tr>
                <tr>
                  <td>dev F1（规则在 dev 上调试，仅供参考）</td>
                  <td className="mono num">{pct(specimen.eval.dev_f1)}</td>
                </tr>
              </tbody>
            </table>
            <p className="caveat">
              <b>前提</b>：结果来自<b>离线确定性模型</b>和 <b>SYNTHETIC 脚本</b>，只说明流水线、定位、校验和门禁按设计工作，<b>不代表模型的审查质量</b>。规则和测试集出自同一个作者，test 上的精确率很可能偏乐观；
              “复审通过”只说明改写消除了审查器能识别的问题，不等于真正合规。审查结果不构成法律意见。
            </p>
          </div>
        </section>

        <section className="land-end">
          <div>
            <h2 className="serif">四个演示账号，三种权限</h2>
            <p className="muted">合规负责人、审核员和两位运营。运营提交的稿子，审核员才能签发；提交人不能审自己的稿子。</p>
          </div>
          <Link className="btn btn-primary btn-lg" to={enter}>
            {user ? "回到审查台" : "选择账号进入"} <ArrowRight size={16} />
          </Link>
        </section>
      </main>

      <footer className="land-foot">
        <span>Leon Wang · 个人作品 · 品牌、商品和脚本均为虚构 · 不构成法律意见 · 与任何平台无关联</span>
        <span className="mono">model: {specimen.model}</span>
      </footer>
    </div>
  );
}
