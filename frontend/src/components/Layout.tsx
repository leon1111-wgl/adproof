import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { LogOut, Menu, X } from "lucide-react";
import { DEMO, api } from "../api";
import { useAuth } from "../auth";
import { Logo, ROLE_TEXT, ThemeButton } from "./ui";

/** Console sections, set like a journal's table of contents (§1–§5). */
const SECTIONS = [
  { to: "/workbench", label: "脚本工作台", hint: "提交脚本或按资料生成" },
  { to: "/reviews", label: "审查记录", hint: "批注稿、改写与终审" },
  { to: "/rules", label: "规则库", hint: "规则、法条快照与试运行" },
  { to: "/evals", label: "评测报告", hint: "离线评测与逐条对照" },
  { to: "/traces", label: "链路追踪", hint: "每个环节的输入输出" },
];

export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <span className="demo-tag">静态演示</span>
      <span>
        回放离线确定性模型在 SYNTHETIC 数据上的保存结果 · 判定与签发只在本页内存中生效 · 完整服务请按{" "}
        <a href="https://github.com/leon1111-wgl/adproof#快速开始" target="_blank" rel="noreferrer">
          README
        </a>{" "}
        本地运行
      </span>
    </div>
  );
}

export default function Layout() {
  const { user, meta, logout } = useAuth();
  const location = useLocation();
  const [pending, setPending] = useState(0);
  const [toc, setToc] = useState(false);

  useEffect(() => {
    const load = () =>
      api
        .get<{ status_counts: Record<string, number> }>("/api/reviews?limit=1")
        .then((r) => setPending(r.status_counts.pending ?? 0))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, [location.pathname]);

  useEffect(() => setToc(false), [location.pathname]);
  useEffect(() => {
    if (!toc) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setToc(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toc]);

  const links = (className: string) =>
    SECTIONS.map((s, i) => (
      <NavLink key={s.to} to={s.to} className={className}>
        <span className="folio">§{i + 1}</span>
        <span className="toc-label">{s.label}</span>
        <span className="toc-leader" aria-hidden="true" />
        <span className="toc-hint">{s.hint}</span>
        {s.to === "/reviews" && pending > 0 && <span className="count" title="待终审">{pending}</span>}
      </NavLink>
    ));

  return (
    <div className="shell">
      <header className="masthead">
        <div className="mast-inner">
          <Link to="/" className="mast-brand" title="AdProof 介绍页">
            <Logo size={26} />
            <span>
              <b className="serif">AdProof</b>
              <span>Leon优选 · 内容合规中心</span>
            </span>
          </Link>
          <nav className="mast-nav" aria-label="控制台导航">
            {links("mast-link")}
          </nav>
          <span className="spacer" />
          {meta && (
            <span className="tag mast-model" title={`规则库 ${meta.ruleset.version} · ${meta.ruleset.hash}`}>
              {meta.offline ? "离线确定性模型" : meta.model} · 规则 {meta.ruleset.hash.slice(0, 7)}
            </span>
          )}
          <span className="tag mast-synthetic">SYNTHETIC</span>
          {DEMO && <span className="tag tag-replay">回放</span>}
          <ThemeButton />
          <span className="mast-user" title={`${user?.title} · ${ROLE_TEXT[user?.role ?? ""]}`}>
            <span className="avatar">{user?.name.slice(0, 1)}</span>
            <span className="mast-user-text">
              {user?.name} <span className="faint">{ROLE_TEXT[user?.role ?? ""]}</span>
            </span>
          </span>
          <button className="icon-btn" title="退出登录" aria-label="退出登录" onClick={logout}>
            <LogOut size={15} />
          </button>
          <button className="icon-btn mast-toc" aria-expanded={toc} aria-controls="toc-sheet" aria-label="目录" onClick={() => setToc(!toc)}>
            {toc ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
        {toc && (
          <nav className="toc-sheet" id="toc-sheet" aria-label="目录">
            <div className="toc-title serif">目录</div>
            {links("toc-link")}
          </nav>
        )}
      </header>
      <div className="desk">
        <Outlet />
      </div>
    </div>
  );
}
