import { Fragment } from "react";

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
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onKeyDown={(e) => {
              if (!onSelect || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              onSelect(main.id);
            }}
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
