import { useCallback, useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Severity } from "../types";

export const ROLE_TEXT: Record<string, string> = { admin: "管理员", reviewer: "审核员", operator: "运营" };
export const SEVERITY_TEXT: Record<string, string> = { high: "高风险", medium: "中风险", low: "低风险" };
export const CHANNEL_TEXT: Record<string, string> = { rule: "规则", llm: "模型", fact: "事实核对" };
export const MODE_TEXT: Record<string, string> = { review: "审查脚本", generate: "生成脚本" };
export const AGENT_TEXT: Record<string, string> = {
  selling_points: "卖点提炼",
  script_writer: "脚本生成",
  rule_review: "规则审查",
  model_review: "模型审查",
  evidence_locator: "证据定位",
  rewrite: "改写建议",
  human_review: "人工终审",
};

const STATUS: Record<string, [string, string]> = {
  queued: ["排队中", "badge-primary"],
  running: ["审查中", "badge-primary"],
  pending: ["待终审", "badge-warning"],
  approved: ["已通过", "badge-success"],
  rejected: ["已驳回", "badge-danger"],
  failed: ["失败", "badge-danger"],
  completed: ["完成", "badge-success"],
};

export function StatusBadge({ status }: { status: string }) {
  const [text, cls] = STATUS[status] ?? [status, ""];
  return <span className={`badge ${cls}`}>{text}</span>;
}

export function RiskBadge({ level }: { level?: Severity | null }) {
  if (!level) return <span className="faint">—</span>;
  const cls = { high: "badge-danger", medium: "badge-warning", low: "badge-success" }[level];
  return <span className={`badge ${cls}`}>{level === "low" ? "未发现问题" : SEVERITY_TEXT[level]}</span>;
}

export function SeverityDot({ level }: { level: Severity }) {
  return <span className={`sev-dot ${level}`} title={SEVERITY_TEXT[level]} />;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-label={title} style={wide ? { width: "min(880px, 100%)" } : undefined}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="card-pad stack">{children}</div>
        {footer && <div className="card-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog">
        <div className="card-head" style={{ position: "sticky", top: 0, background: "var(--surface)", zIndex: 1 }}>
          <div style={{ minWidth: 0 }}>{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="card-pad">{children}</div>
      </aside>
    </>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json mono">{JSON.stringify(value, null, 2)}</pre>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({ error }: { error: string | null | undefined }) {
  return error ? <div className="error-banner">{error}</div> : null;
}

export const pct = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
export const ms = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const pad = (n: number) => String(n).padStart(2, "0");

/** 刚刚 / 5 分钟前 / 今天 14:05 / 昨天 09:12 / 10-08 14:05 */
export function time(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const seconds = (now.getTime() - d.getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return "刚刚";
  if (seconds >= 0 && seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) return `今天 ${hm}`;
  if (d.getTime() >= startOfToday - 86400000) return `昨天 ${hm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="var(--primary)" />
      <path d="M7.5 6.5h6.5l3 3v8h-9.5z" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 13l1.8 1.8 3.2-3.6" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Theme = "system" | "light" | "dark";
const THEME_KEY = "adproof.theme";

function applyTheme(theme: Theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function initTheme() {
  try {
    applyTheme((localStorage.getItem(THEME_KEY) as Theme) || "system");
  } catch {
    /* storage unavailable: follow the system */
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || "system";
    } catch {
      return "system";
    }
  });
  const update = useCallback((t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);
  return [theme, update];
}

/** Load data with loading / error state and a reload function. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
