import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Cue, Disclosure, Finding, RewriteResult } from "../types";
import { Citations, CitationChip } from "./Citations";
import { MarkedText, type TextMark } from "./ScriptView";
import { CHANNEL_TEXT, SEVERITY_TEXT } from "./ui";

const WIDE = 760; // below this sheet width the margin notes flow under the text
const GAP = 10;

export const noteNo = (key: string) => key.replace(/^\D+/, "");

function suggestionText(f: Finding): string | null {
  const s = f.suggestion;
  if (!s) return null;
  if (s.strategy === "delete_clause") return "删去这一分句";
  return s.replacement ? `改为“${s.replacement}”` : "删去";
}

/** One editor's note in the margin: compact until selected, then reason, all citations and actions. */
function Note({ finding, active, onSelect, actions }: { finding: Finding; active: boolean; onSelect: () => void; actions?: ReactNode }) {
  const basis = finding.citations.filter((c) => c.kind === "basis");
  const penalty = finding.citations.filter((c) => c.kind === "penalty");
  const fix = suggestionText(finding);
  return (
    <article
      className={`note sev-${finding.severity}${active ? " active" : ""}${finding.verdict === "false_positive" ? " fp" : ""}`}
      data-key={finding.key}
      onClick={onSelect}
    >
      <header>
        <button type="button" className="note-toggle" aria-expanded={active} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
          <span className="note-no" aria-hidden="true">{noteNo(finding.key)}</span>
          <b>{finding.category_label}</b>
          <span className="visually-hidden">（批注 {noteNo(finding.key)}，{active ? "收起" : "展开"}）</span>
        </button>
        <span className="note-sev">{SEVERITY_TEXT[finding.severity]}</span>
        {finding.verdict && <span className={`note-verdict ${finding.verdict}`}>{finding.verdict === "confirmed" ? "已确认" : "误报"}</span>}
      </header>
      <div className="note-line">
        <span className="note-cite" onClick={(e) => e.stopPropagation()}>
          {basis[0] ? <CitationChip citation={basis[0]} /> : finding.references[0] ? <Citations citations={[]} references={finding.references.slice(0, 1)} /> : <span className="faint">依据待核对</span>}
          {basis.length > 1 && !active && <span className="faint">+{basis.length - 1}</span>}
        </span>
        {fix && <span className="note-fix">{fix}</span>}
      </div>
      {active && (
        <div className="note-more">
          <q>{finding.quote}</q>
          <span className="where mono">
            {finding.cue ? `字幕 #${finding.cue.index} ${finding.cue.start.slice(3, 8)} · ` : ""}字符 {finding.start}–{finding.end} · {finding.channels.map((c) => CHANNEL_TEXT[c]).join(" + ")}
          </span>
          <p>
            {finding.reason}
            {finding.model_reason && finding.channels.includes("rule") && <span className="faint">（模型：{finding.model_reason}）</span>}
          </p>
          {finding.evidence && <p>商品资料「{finding.evidence.fact_key}」：{finding.evidence.fact_value}</p>}
          <div className="note-cites" onClick={(e) => e.stopPropagation()}>
            <Citations citations={basis.slice(1)} references={finding.references} />
            <Citations citations={penalty} />
          </div>
          {finding.suggestion?.note && <p className="faint">{finding.suggestion.note}</p>}
          {actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
        </div>
      )}
    </article>
  );
}

/**
 * The script as an editor's proof: flagged spans in red pen with a numbered note in the margin
 * beside each one. Selecting a span or a note opens the note and draws a leader line between them.
 */
export function Manuscript({
  text,
  cues,
  findings,
  missing = [],
  rejected = [],
  activeKey,
  onSelect,
  actionsFor,
}: {
  text: string;
  cues?: Cue[];
  findings: Finding[];
  missing?: Disclosure[];
  rejected?: { quote: string; reason: string }[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  actionsFor?: (finding: Finding) => ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [layout, setLayout] = useState<{ tops: Record<string, number>; height: number; leader: string | null }>({ tops: {}, height: 0, leader: null });
  const wide = width >= WIDE;
  const marks: TextMark[] = findings.map((f) => ({
    id: f.key,
    start: f.start,
    end: f.end,
    label: noteNo(f.key),
    className: `hl ${f.severity}${f.verdict === "false_positive" ? " fp" : ""}`,
  }));

  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // place each note level with its span, pushed down when it would overlap the one above
  useLayoutEffect(() => {
    const root = body.current;
    if (!root || !wide) return;
    const origin = root.getBoundingClientRect();
    const tops: Record<string, number> = {};
    let floor = 0;
    for (const f of findings) {
      const mark = root.querySelector<HTMLElement>(`mark[data-ids~="${f.key}"]`);
      const note = root.querySelector<HTMLElement>(`.note[data-key="${f.key}"]`);
      if (!mark || !note) continue;
      const want = mark.getBoundingClientRect().top - origin.top - 6;
      tops[f.key] = Math.max(want, floor);
      floor = tops[f.key] + note.offsetHeight + GAP;
    }
    let leader: string | null = null;
    const active = activeKey ? root.querySelectorAll<HTMLElement>(`mark[data-ids~="${activeKey}"]`) : null;
    const notes = root.querySelector<HTMLElement>(".margin");
    if (active?.length && notes && tops[activeKey!] !== undefined) {
      const rects = active[active.length - 1].getClientRects();
      const last = rects[rects.length - 1];
      // run just under the text line so the line never crosses the words
      const x1 = last.right - origin.left + 2;
      const y1 = last.bottom - origin.top + 4;
      const x2 = notes.getBoundingClientRect().left - origin.left;
      const y2 = tops[activeKey!] + 15;
      const bend = x2 - 14;
      leader = `M${x1} ${y1} H${Math.max(x1 + 6, bend)} L${x2} ${y2}`;
    }
    setLayout({ tops, height: floor, leader });
  }, [findings, activeKey, wide, width, text]);

  // wide: keep the span in view (its note sits beside it); narrow: bring the opened note into view.
  // Only when the selection changes: a preselected note must not scroll the page away from its top.
  const shown = useRef(activeKey);
  useEffect(() => {
    if (shown.current === activeKey) return;
    shown.current = activeKey;
    if (!activeKey || !body.current) return;
    const target = body.current.querySelector<HTMLElement>(wide ? `mark[data-ids~="${activeKey}"]` : `.note[data-key="${activeKey}"]`);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const textBody =
    cues && cues.length > 0 ? (
      <div className="ms-cues">
        {cues.map((cue) => (
          <div className="ms-cue" key={cue.index}>
            <span className="ms-time mono">
              #{cue.index} {cue.start.slice(3, 8)}
            </span>
            <span>
              <MarkedText text={text} marks={marks} from={cue.char_start} to={cue.char_end} activeId={activeKey} onSelect={onSelect} />
            </span>
          </div>
        ))}
      </div>
    ) : (
      <div className="ms-text">
        <MarkedText text={text} marks={marks} activeId={activeKey} onSelect={onSelect} />
      </div>
    );

  return (
    <div className={`manuscript${wide ? " wide" : ""}`} ref={sheet}>
      {(missing.length > 0 || rejected.length > 0) && (
        <div className="ms-header">
          {missing.map((d) => (
            <div className="ms-flag" key={d.id}>
              <b>缺少必要声明</b>
              <span>
                全文没有出现“{d.required}”。建议在结尾补充“{d.suggestion}”。
              </span>
              <span className="row row-wrap" style={{ gap: 6 }}>
                <Citations citations={d.citations} />
              </span>
            </div>
          ))}
          {rejected.length > 0 && (
            <div className="ms-flag guard">
              <b>已拦截 {rejected.length} 条模型引用</b>
              <span>模型通道引用的原文在稿子里找不到，证据校验没有放行：{rejected.map((r) => `“${r.quote}”`).join("、")}</span>
            </div>
          )}
        </div>
      )}
      <div className="ms-body" ref={body} style={wide ? { minHeight: layout.height } : undefined}>
        {textBody}
        {findings.length > 0 && (
          <div className="margin" aria-label="批注">
            {findings.map((f) => (
              <div key={f.key} className="note-slot" style={wide && layout.tops[f.key] !== undefined ? { top: layout.tops[f.key] } : undefined}>
                <Note finding={f} active={activeKey === f.key} onSelect={() => onSelect(f.key)} actions={actionsFor?.(f)} />
              </div>
            ))}
          </div>
        )}
        {wide && layout.leader && (
          <svg className="leader" aria-hidden="true">
            <path d={layout.leader} />
          </svg>
        )}
      </div>
    </div>
  );
}

/** Redline: deletions struck in red pen, insertions written in after a caret. */
export function Redline({ rewrite }: { rewrite: RewriteResult }) {
  if (!rewrite.diff) return null;
  return (
    <div className="redline">
      {rewrite.diff.map((op, i) =>
        op.op === "equal" ? (
          <span key={i}>{op.a}</span>
        ) : op.op === "insert" ? (
          <ins key={i}>{op.b}</ins>
        ) : op.op === "delete" ? (
          <del key={i}>{op.a}</del>
        ) : (
          <span key={i}>
            <del>{op.a}</del>
            <ins>{op.b}</ins>
          </span>
        ),
      )}
    </div>
  );
}
