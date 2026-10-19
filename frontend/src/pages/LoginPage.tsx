import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Logo, ROLE_TEXT } from "../components/ui";

interface DemoAccounts {
  accounts: { email: string; name: string; role: string; title: string }[];
  password: string | null;
}

const CAPABILITIES: [string, string][] = [
  ["逐字定位", "每条问题都标出原文的字符起止位置，字幕文件还能定位到时间轴。"],
  ["法条可核对", "命中的规则对应法条原文，原文取自国家法律法规数据库；没核对过的一律标“待核对”。"],
  ["双通道审查", "规则引擎负责确定性的词和事实，模型负责换了说法的隐含宣称，两边结果合并后再校验。"],
  ["人工终审", "改写建议只是建议：通过、修改还是驳回由审核员决定，提交人不能审自己的稿子。"],
];

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoAccounts | null>(null);

  useEffect(() => {
    api.get<DemoAccounts>("/api/auth/demo-accounts").then(setDemo).catch(() => setDemo(null));
  }, []);

  async function submit(e?: FormEvent, override?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(override?.email ?? email, override?.password ?? password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-intro">
        <div className="row" style={{ gap: 10 }}>
          <Logo size={28} />
          <b style={{ fontSize: 16 }}>AdProof</b>
        </div>
        <div className="headline">
          <h1>带货素材合规审查台</h1>
          <p className="lead">
            短视频脚本和直播话术提交后，先由多个审查环节逐条标出问题，再交给审核员终审。每条问题都能追溯到原文片段、命中的规则和法条原文。
          </p>
          <div className="capabilities">
            {CAPABILITIES.map(([title, text], i) => (
              <div className="capability" key={title}>
                <span className="no">0{i + 1}</span>
                <b>{title}</b>
                <span className="desc">{text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="foot">Leon Wang · 个人作品 · 品牌、商品和脚本均为虚构 · 不构成法律意见</div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div>
            <h1>登录</h1>
            <p className="muted" style={{ marginTop: 4 }}>使用工作邮箱登录，或选择下方的演示账号</p>
          </div>
          <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
            <label className="field">
              邮箱
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="name@company.com" />
            </label>
            <label className="field">
              密码
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {error && <div className="error-banner">{error}</div>}
            <button className="btn btn-primary" disabled={busy || !email || !password} style={{ width: "100%" }}>
              {busy ? "登录中…" : "登录"}
            </button>
          </form>
          {demo && demo.accounts.length > 0 && (
            <div className="stack">
              <div className="faint">演示账号 · 点击即可进入，不同角色能做的操作不同</div>
              <div className="account-list">
                <div className="account-group">Leon优选 · 内容合规中心</div>
                {demo.accounts.map((a) => (
                  <button key={a.email} className="account" disabled={busy}
                    onClick={() => submit(undefined, { email: a.email, password: demo.password ?? "" })}>
                    <span className="avatar me">{a.name.slice(0, 1)}</span>
                    <span style={{ minWidth: 0, lineHeight: 1.35 }}>
                      <div style={{ fontSize: 13 }}>{a.name} <span className="badge">{a.title} · {ROLE_TEXT[a.role]}</span></div>
                      <div className="faint ellipsis">{a.email}</div>
                    </span>
                    <span className="go">进入 →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
