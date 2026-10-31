import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { DEMO, api } from "../api";
import { useAuth } from "../auth";
import { Logo, ROLE_TEXT, ThemeButton } from "../components/ui";

interface DemoAccounts {
  accounts: { email: string; name: string; role: string; title: string }[];
  password: string | null;
}

const CAN: Record<string, string> = {
  admin: "签发、维护规则库、运行评测",
  reviewer: "确认或标记误报、签发他人提交的稿子",
  operator: "提交脚本或按资料生成，查看批注",
};

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
      if (location.pathname === "/login") navigate("/workbench", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <header className="land-top">
        <Link to="/" className="mast-brand">
          <Logo size={26} />
          <span>
            <b className="serif">AdProof</b>
            <span>带货素材合规审查</span>
          </span>
        </Link>
        <span className="spacer" />
        <ThemeButton />
      </header>
      <main className="login-main">
        <div className="login-card">
          <Link to="/" className="back-link small">
            <ArrowLeft size={13} /> 返回介绍
          </Link>
          <div>
            <span className="eyebrow">SIGN IN · 选择账号</span>
            <h1 className="serif">今天由谁来审稿？</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              不同角色能做的事不同：运营提交，审核员判定和签发，提交人不能审自己的稿子。
              {DEMO && " 静态演示里不需要密码，账号切换只在本页生效。"}
            </p>
          </div>
          {demo && demo.accounts.length > 0 && (
            <ul className="account-list">
              {demo.accounts.map((a) => (
                <li key={a.email}>
                  <button className="account" disabled={busy} onClick={() => submit(undefined, { email: a.email, password: demo.password ?? "" })}>
                    <span className="avatar">{a.name.slice(0, 1)}</span>
                    <span className="account-text">
                      <b>
                        {a.name} <span className="muted">· {a.title}</span>
                      </b>
                      <span className="faint">{CAN[a.role]}</span>
                    </span>
                    <span className={`role-tag role-${a.role}`}>{ROLE_TEXT[a.role]}</span>
                    <ArrowRight size={15} className="go" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!DEMO && (
            <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
              <span className="label">或使用工作邮箱登录</span>
              <input className="input" aria-label="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="name@company.com" />
              <input className="input" aria-label="密码" type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              <button className="btn btn-primary" disabled={busy || !email || !password}>
                {busy ? "登录中…" : "登录"}
              </button>
            </form>
          )}
          {error && <div className="error-banner">{error}</div>}
          <p className="faint">Leon Wang · 个人作品 · 品牌、商品和脚本均为虚构 · 不构成法律意见</p>
        </div>
      </main>
    </div>
  );
}
