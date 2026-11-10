import type { Finding, Review } from "../types";
import { noteNo } from "./Manuscript";

/** Image input: every finding's box drawn on the image its text came from. Clicking a box opens its note. */
export function ImageEvidence({ review, findings, activeKey, onSelect }: { review: Review; findings: Finding[]; activeKey: string | null; onSelect: (key: string) => void }) {
  const ocr = review.ocr;
  if (!ocr) return null;
  return (
    <section className="ocr-evidence" aria-label="图片与问题位置">
      <div className="row row-wrap" style={{ gap: 8 }}>
        <b>图片与问题位置</b>
        <span className="faint">
          {ocr.images.length} 张 · {ocr.engine} · 红框是规则命中的文字所在位置，点框展开批注；黄色虚线是置信度低、可能识别错的行
        </span>
      </div>
      <div className="ocr-grid">
        {ocr.images.map((img, k) => {
          const hits = findings.flatMap((f) => (f.region ?? []).filter((r) => r.image === k).flatMap((r) => r.boxes.map((b) => ({ f, b }))));
          const lows = ocr.lines.filter((l) => l.image === k && l.low);
          const count = new Set(hits.map((h) => h.f.key)).size;
          return (
            <figure className="ocr-figure" key={k}>
              <div className="ocr-frame">
                <img src={img.url} alt={`图 ${k + 1}：${img.name}`} />
                <svg viewBox={`0 0 ${img.width} ${img.height}`} preserveAspectRatio="none">
                  {lows.map((l, i) => (
                    <rect key={`low-${i}`} className="ocr-line low" x={l.box.x0} y={l.box.y0} width={l.box.x1 - l.box.x0} height={l.box.y1 - l.box.y0} />
                  ))}
                  {hits.map(({ f, b }, i) => (
                    <rect
                      key={`${f.key}-${i}`}
                      className={`ocr-hit ${f.severity}${f.key === activeKey ? " active" : ""}`}
                      data-key={f.key}
                      x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0}
                      role="button"
                      tabIndex={0}
                      aria-label={`批注 ${noteNo(f.key)} · ${f.category_label}：${f.quote}（图 ${k + 1}）`}
                      onClick={() => onSelect(f.key)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(f.key); } }}
                    >
                      <title>{`批注 ${noteNo(f.key)} · ${f.category_label}：${f.quote}`}</title>
                    </rect>
                  ))}
                </svg>
              </div>
              <figcaption className="faint">图 {k + 1} · {img.name} · {count ? `${count} 处问题` : "规则没有命中"}{ocr.seconds[k] !== undefined ? ` · 识别 ${ocr.seconds[k].toFixed(1)} 秒` : ""}</figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}



