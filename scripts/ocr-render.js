/* SYNTHETIC renders for the OCR evaluation (docs/EVALUATION.md 8.1, backend/evals/ocr/protocol.json "render").
 * Injected into Chromium on GitHub Actions by scripts/ocr_actions.mjs; it is not part of the site.
 * Every render returns the JPEG blobs, the exact text drawn on each image, each drawn character's box, and for
 * every character of the joined drawn text the index of the evaluation-text character it came from. */
(() => {
  const FRAME = { w: 1280, h: 720, px: 44, lineChars: 18, maxLines: 2, bottom: 70, lineStep: 1.4 };
  const POSTER = { w: 1080, h: 1440, margin: 72, lineHeight: 1.5, paraGap: 0.6 };
  const SENT = new Set([..."。！？；!?;"]);
  const COMMA = new Set([..."，,、"]);

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) {
    let h = 2166136261;
    for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    return h;
  }

  /** [start, end) ranges of text without newlines and without leading/trailing whitespace. */
  function paragraphs(item) {
    if (item.input_type === "srt") return item.cues.map((c) => [c.char_start, c.char_end]);
    const out = [];
    let start = 0;
    for (let i = 0; i <= item.text.length; i++) {
      if (i === item.text.length || item.text[i] === "\n") {
        let a = start;
        let b = i;
        while (a < b && /\s/.test(item.text[a])) a++;
        while (b > a && /\s/.test(item.text[b - 1])) b--;
        if (b > a) out.push([a, b]);
        start = i + 1;
      }
    }
    return out;
  }

  /** Subtitle pieces: cues as they are; text cut after sentence marks, long pieces after a comma within 36, else at 36. */
  function framePieces(item) {
    if (item.input_type === "srt") return paragraphs(item);
    const out = [];
    for (const [a, b] of paragraphs(item)) {
      let s = a;
      for (let i = a; i < b; i++) {
        if (SENT.has(item.text[i])) {
          out.push([s, i + 1]);
          s = i + 1;
        }
      }
      if (s < b) out.push([s, b]);
    }
    const max = FRAME.lineChars * FRAME.maxLines;
    const fitted = [];
    for (let [a, b] of out) {
      while (a < b && /\s/.test(item.text[a])) a++;
      while (b - a > max) {
        let cut = -1;
        for (let i = a; i < a + max; i++) if (COMMA.has(item.text[i])) cut = i + 1;
        if (cut <= a) cut = a + max;
        fitted.push([a, cut]);
        a = cut;
        while (a < b && /\s/.test(item.text[a])) a++;
      }
      if (b > a) fitted.push([a, b]);
    }
    return fitted;
  }

  function background(ctx, w, h, kind, r) {
    if (kind === "light") {
      ctx.fillStyle = "#f6f3ee";
      ctx.fillRect(0, 0, w, h);
      return "dark";
    }
    if (kind === "dark") {
      ctx.fillStyle = "#15171b";
      ctx.fillRect(0, 0, w, h);
      return "light";
    }
    if (kind === "gradient") {
      const lightBg = r() < 0.5;
      const L = lightBg ? 82 : 22;
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${Math.floor(r() * 360)}, 45%, ${L}%)`);
      g.addColorStop(1, `hsl(${Math.floor(r() * 360)}, 50%, ${L + (lightBg ? -10 : 10)}%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return lightBg ? "dark" : "light";
    }
    // busy: mid tones, random shapes, per-pixel noise
    ctx.fillStyle = `hsl(${Math.floor(r() * 360)}, 25%, 50%)`;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      ctx.globalAlpha = 0.5 + r() * 0.4;
      ctx.fillStyle = `hsl(${Math.floor(r() * 360)}, ${35 + Math.floor(r() * 25)}%, ${30 + Math.floor(r() * 40)}%)`;
      const x = r() * w;
      const y = r() * h;
      const s = 20 + r() * 220;
      if (r() < 0.5) ctx.fillRect(x - s / 2, y - s / 3, s, s * (0.3 + r()));
      else {
        ctx.beginPath();
        ctx.arc(x, y, s / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 48;
      img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);
    return "busy";
  }

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return [c, c.getContext("2d", { willReadFrequently: true })];
  }

  const jpeg = (c, q) => new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", q));

  /** Box of every UTF-16 unit of s drawn at (x, yc) with textBaseline middle. */
  function boxes(ctx, s, x, yc, px) {
    const out = [];
    for (let j = 0; j < s.length; j++) {
      const left = x + ctx.measureText(s.slice(0, j)).width;
      const right = x + ctx.measureText(s.slice(0, j + 1)).width;
      out.push([left, yc - 0.55 * px, right, yc + 0.55 * px]);
    }
    return out;
  }

  /** One render of an item: {images: [{blob, name, width, height, drawn}], drawn, drawnAt, toOrig}. */
  async function render(item, layout, cell, seed, opts = {}) {
    const r = rng(seed ^ hash(`${item.set}/${item.id}/${layout}`));
    const images = [];
    const pages = []; // per image: list of [text, boxes per unit, orig index per unit] chunks joined by "\n" inside the image
    if (layout === "frames") {
      for (const [a, b] of framePieces(item)) {
        const piece = item.text.slice(a, b);
        const lines = [];
        for (let i = 0; i < piece.length; i += FRAME.lineChars) lines.push([a + i, a + Math.min(piece.length, i + FRAME.lineChars)]);
        const [c, ctx] = canvas(FRAME.w, FRAME.h);
        background(ctx, FRAME.w, FRAME.h, cell.background, r);
        ctx.font = `${FRAME.px}px "${cell.font}"`;
        ctx.textBaseline = "middle";
        const n = lines.length;
        const placed = lines.map(([s, e], i) => {
          const text = item.text.slice(s, e);
          const width = ctx.measureText(text).width;
          return { s, e, text, x: (FRAME.w - width) / 2, yc: FRAME.h - FRAME.bottom - (n - 1 - i) * FRAME.px * FRAME.lineStep, width };
        });
        if (cell.style === "box") {
          const x0 = Math.min(...placed.map((p) => p.x)) - 16;
          const x1 = Math.max(...placed.map((p) => p.x + p.width)) + 16;
          ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
          ctx.fillRect(x0, placed[0].yc - 0.75 * FRAME.px, x1 - x0, placed[n - 1].yc - placed[0].yc + 1.5 * FRAME.px);
        }
        let drawn = "";
        const at = [];
        const orig = [];
        for (const p of placed) {
          if (cell.style === "outline") {
            ctx.lineJoin = "round";
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 6;
            ctx.strokeText(p.text, p.x, p.yc);
          }
          ctx.fillStyle = "#fff";
          ctx.fillText(p.text, p.x, p.yc);
          drawn += p.text;
          at.push(...boxes(ctx, p.text, p.x, p.yc, FRAME.px));
          for (let i = p.s; i < p.e; i++) orig.push(i);
        }
        if (opts.label) label(ctx, FRAME.w);
        images.push({ blob: await jpeg(c, cell.jpeg), width: FRAME.w, height: FRAME.h, drawn, at, orig });
      }
    } else {
      const px = cell.body;
      const lh = px * POSTER.lineHeight;
      const maxW = POSTER.w - 2 * POSTER.margin;
      let cur = null;
      const fresh = () => {
        const [c, ctx] = canvas(POSTER.w, POSTER.h);
        const tone = background(ctx, POSTER.w, POSTER.h, cell.background, r);
        ctx.font = `${px}px "${cell.font}"`;
        ctx.textBaseline = "middle";
        cur = { c, ctx, tone, y: POSTER.margin, drawn: "", at: [], orig: [] };
      };
      const flush = async () => {
        if (!cur || !cur.drawn) return;
        if (opts.label) label(cur.ctx, POSTER.w);
        images.push({ blob: await jpeg(cur.c, cell.jpeg), width: POSTER.w, height: POSTER.h, drawn: cur.drawn, at: cur.at, orig: cur.orig });
        cur = null;
      };
      fresh();
      for (const [a, b] of paragraphs(item)) {
        // wrap by measured width
        const wrapped = [];
        let s = a;
        for (let i = a + 1; i <= b; i++) {
          if (cur.ctx.measureText(item.text.slice(s, i)).width > maxW) {
            wrapped.push([s, i - 1]);
            s = i - 1;
          }
        }
        if (s < b) wrapped.push([s, b]);
        let first = true;
        for (const [s0, e0] of wrapped) {
          if (cur.y + lh > POSTER.h - POSTER.margin) {
            await flush();
            fresh();
            first = true;
          }
          const text = item.text.slice(s0, e0);
          const yc = cur.y + lh / 2;
          const { ctx } = cur;
          if (cur.tone === "busy") {
            ctx.lineJoin = "round";
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 4;
            ctx.strokeText(text, POSTER.margin, yc);
            ctx.fillStyle = "#fff";
          } else {
            ctx.fillStyle = cur.tone === "dark" ? "#1b1b1b" : "#f1f1f1";
          }
          ctx.fillText(text, POSTER.margin, yc);
          if (first && cur.drawn) {
            cur.drawn += "\n";
            cur.at.push(null);
            cur.orig.push(-1);
          }
          first = false;
          cur.drawn += text;
          cur.at.push(...boxes(ctx, text, POSTER.margin, yc, px));
          for (let i = s0; i < e0; i++) cur.orig.push(i);
          cur.y += lh;
        }
        cur.y += px * POSTER.paraGap;
      }
      await flush();
    }
    // join images with a newline (the same as parse_srt / buildDocument)
    let drawn = "";
    const drawnAt = [];
    const toOrig = [];
    images.forEach((im, k) => {
      if (k) {
        drawn += "\n";
        drawnAt.push(null);
        toOrig.push(-1);
      }
      drawn += im.drawn;
      im.at.forEach((b) => drawnAt.push(b ? [k, ...b] : null));
      toOrig.push(...im.orig);
    });
    return { images, drawn, drawnAt, toOrig };
  }

  /** Visitor examples only: a small SYNTHETIC mark in the corner (OCR reads it as text). */
  function label(ctx, w) {
    ctx.save();
    ctx.font = '20px "Noto Sans CJK SC"';
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(w - 150, 14, 136, 30);
    ctx.fillStyle = "#fff";
    ctx.fillText("SYNTHETIC", w - 140, 19);
    ctx.restore();
  }

  /** Small-print probe: one sentence at a given size on a light screenshot. */
  async function strip(text, px, font = "Noto Sans CJK SC") {
    // a whole 1080 x 1440 screenshot with one line in the middle (a thin strip gets stretched by a detector
    // with a fixed square input; found on dev run 42806792269)
    const [c, ctx] = canvas(1080, 1440);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = `${px}px "${font}"`;
    ctx.textBaseline = "middle";
    let s = text;
    while (s && ctx.measureText(s).width > 1032) s = s.slice(0, -1);
    ctx.fillStyle = "#222";
    ctx.fillText(s, 24, c.height / 2);
    return { blob: await jpeg(c, 0.92), drawn: s };
  }

  /** Pixel hash of a string in each font: a missing font falls back to the same face, so hashes collide. */
  function fontPrints(fonts) {
    return fonts.map((f) => {
      const [, ctx] = canvas(400, 60);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 400, 60);
      ctx.font = `40px "${f}"`;
      ctx.fillStyle = "#000";
      ctx.textBaseline = "middle";
      ctx.fillText("永国最好AaWg", 4, 30);
      const d = ctx.getImageData(0, 0, 400, 60).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (Math.imul(h, 31) + d[i]) >>> 0;
      return h;
    });
  }

  window.__ocrRender = { render, strip, fontPrints, framePieces, paragraphs };
})();
