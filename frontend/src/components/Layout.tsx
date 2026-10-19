import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, BookCheck, FilePenLine, FlaskConical, ListChecks, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Logo, ROLE_TEXT, useTheme } from "./ui";

const TITLES: Record<string, string> = {
  workbench: "脚本工作台",
  reviews: "审查记录",
  rules: "规则库",
  evals: "评测报告",
  traces: "链路追踪",
};

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
}

export default function Layout() {
  const { user, meta, logout } = useAuth();
  const location = useLocation();
  const [pending, setPending] = useState(0);
  const [theme, setTheme] = useTheme();

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

  const section = location.pathname.split("/")[1] || "workbench";
  const groups: [string, NavItem[]][] = [
    ["审查", [
      { to: "/workbench", label: "脚本工作台", icon: <FilePenLine size={16} /> },
      { to: "/reviews", label: "审查记录", icon: <ListChecks size={16} />, count: pending },
    ]],
    ["质量", [
      { to: "/rules", label: "规则库", icon: <BookCheck size={16} /> },
      { to: "/evals", label: "评测报告", icon: <FlaskConical size={16} /> },
    ]],
    ["运维", [{ to: "/traces", label: "链路追踪", icon: <Activity size={16} /> }]],
  ];
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const themeLabel = { system: "跟随系统", light: "浅色", dark: "深色" }[theme];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span className="brand-name">AdProof</span>
        </div>
        <div className="tenant-card">
          <div className="name">Leon优选 · 内容合规中心</div>
          <div className="meta">带货素材审查 · 演示环境</div>
        </div>
        <nav className="nav">
          {groups.map(([group, items]) => (
            <div key={group}>
              <div className="nav-group">{group}</div>
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
                  {item.icon}
                  {item.label}
                  {item.count ? <span className="count">{item.count}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar me">{user?.name.slice(0, 1)}</span>
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div className="ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{user?.name}</div>
            <div className="faint">{user?.title} · {ROLE_TEXT[user?.role ?? ""]}</div>
          </div>
          <span className="spacer" />
          <button className="icon-btn" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut size={15} /></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span className="ellipsis">内容合规中心</span>
            <span>/</span>
            <b>{TITLES[section] ?? "AdProof"}</b>
          </div>
          <div className="row">
            {meta && (
              <span className="badge" title={`规则库 ${meta.ruleset.version} · ${meta.ruleset.hash}`}>
                {meta.offline ? "离线确定性模型" : `模型 ${meta.model}`} · 规则 {meta.ruleset.hash.slice(0, 7)}
              </span>
            )}
            <span className="badge">数据均为虚构（SYNTHETIC）</span>
            <button className="icon-btn" title={`主题：${themeLabel}（点击切换）`} aria-label="切换主题" onClick={() => setTheme(nextTheme)}>
              {theme === "light" ? <Sun size={16} /> : theme === "dark" ? <Moon size={16} /> : <Monitor size={16} />}
            </button>
          </div>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
