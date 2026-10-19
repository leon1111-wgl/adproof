import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { Cue, Finding } from "../types";
import { CHANNEL_TEXT, SEVERITY_TEXT } from "./ui";

export interface TextMark {
  id: string;
  start: number;
  end: number;
  className: string;
  label?: string; // small superscript shown after the mark (e.g. F3)
}

const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Split [from, to) of the text at every mark boundary; overlapping marks share a segment. */
function segments(marks: TextMark[], from: number, to: number) {
  const cuts = new Set([from, to]);
  for (const m of marks) {
    if (m.end <= from || m.start >= to) continue;
    cuts.add(Math.max(from, m.start));
    cuts.add(Math.min(to, m.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: { start: number; end: number; marks: TextMark[] }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    out.push({ start: a, end: b, marks: marks.filter((m) => m.start <= a && m.end >= b) });
  }
  return out;
}

export function MarkedText({
  text, marks, from = 0, to = text.length, activeId, onSelect, onHover,
}: {
  text: string;
  marks: TextMark[];
  from?: number;
  to?: number;
  activeId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null, el: HTMLElement | null) => void;
}) {
  return (
    <>
      {segments(marks, from, to).map((seg) => {
        const content = text.slice(seg.start, seg.end);
        if (seg.marks.length === 0) return <Fragment key={seg.start}>{content}</Fragment>;
        const main = [...seg.marks].sort((a, b) => (RANK[b.className.split(" ")[1]] ?? 0) - (RANK[a.className.split(" ")[1]] ?? 0))[0];
        const active = seg.marks.some((m) => m.id === activeId);
        const ends = seg.marks.filter((m) => m.end === seg.end && m.label);
        return (
          <mark
            key={seg.start}
            className={`${main.className}${active ? " active" : ""}`}
            data-ids={seg.marks.map((m) => m.id).join(" ")}
            onClick={() => onSelect?.(main.id)}
            onMouseEnter={(e) => onHover?.(main.id, e.currentTarget)}
            onMouseLeave={() => onHover?.(null, null)}
          >
            {content}
            {ends.map((m) => <span key={m.id} className="ref">{m.label}</span>)}
          </mark>
        );
      })}
    </>
  );
}

function Tip({ finding, anchor }: { finding: Finding; anchor: HTMLElement }) {
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + 8 + 220 > window.innerHeight ? rect.top - 8 : rect.bottom + 8;
  const style = { left: Math.min(rect.left, window.innerWidth - 360), top, transform: top < rect.top ? "translateY(-100%)" : undefined };
  const basis = finding.citations.find((c) => c.kind === "basis");
  return (
    <div className="hl-tip" style={style}>
      <b>{finding.key} · {finding.category_label}</b> <span className="faint">{SEVERITY_TEXT[finding.severity]} · {finding.channels.map((c) => CHANNEL_TEXT[c]).join(" + ")}</span>
      <div>{finding.rule_name ?? finding.model_reason ?? finding.reason}</div>
      {basis && (
        <div className="law">
          <b>{basis.label}</b>
          <div>{basis.status === "verified" ? basis.text : "原文待核对"}</div>
        </div>
      )}
    </div>
  );
}

/** The annotated script: plain text, or SRT cues with their timestamps. */
export function FindingScript({
  text, findings, cues, activeKey, onSelect, pulse,
}: {
  text: string;
  findings: Finding[];
  cues?: Cue[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  pulse: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ key: string; el: HTMLElement } | null>(null);
  const marks: TextMark[] = findings.map((f) => ({
    id: f.key, start: f.start, end: f.end, label: f.key,
    className: `hl ${f.severity}${f.verdict === "false_positive" ? " fp" : ""}`,
  }));

  useEffect(() => {
    if (!activeKey || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`mark[data-ids~="${activeKey}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeKey, pulse]);

  const common = {
    text, marks, activeId: activeKey, onSelect,
    onHover: (id: string | null, el: HTMLElement | null) => setHover(id && el ? { key: id, el } : null),
  };
  let body: ReactNode;
  if (cues && cues.length > 0) {
    body = (
      <div className="script-cues">
        {cues.map((cue) => (
          <div className="cue-row" key={cue.index}>
            <span className="cue-time">#{cue.index} {cue.start.slice(3, 8)}–{cue.end.slice(3, 8)}</span>
            <span><MarkedText {...common} from={cue.char_start} to={cue.char_end} /></span>
          </div>
        ))}
      </div>
    );
  } else {
    body = <div className="script"><MarkedText {...common} /></div>;
  }
  const hovered = hover ? findings.find((f) => f.key === hover.key) : null;
  return (
    <div ref={box} key={pulse}>
      {body}
      {hovered && hover && <Tip finding={hovered} anchor={hover.el} />}
    </div>
  );
}
