// 图片 / 截图 input · GitHub Actions only. Serves the built demo (frontend/dist) at /adproof/, drives Playwright
// Chromium and runs the real in-browser OCR (onnxruntime-web WASM + PP-OCRv5 mobile from the pinned files).
//   --mode eval       --set dev|test|blind_v1|blind_v2 --items <set>.items.json : SYNTHETIC renders + OCR
//                     (docs/EVALUATION.md 8.1); writes <set>.results.json for frontend/scripts/ocr-score.ts
//   --mode smallprint --items dev.items.json : one sentence per item at 10–24 px
//   --mode examples   : the visitor examples (demo sample scripts, SYNTHETIC, marked in the corner)
//   --mode check      : the visitor flow at 1440 and 375 px, light and dark, plus the existing flows
//   --mode probe      --urls "u1 u2" : public images through the real workbench; screenshots + probe.json
// Eval and smallprint need a VITE_OCR_LAB=1 build; check and probe use the public-like VITE_OCR=1 build.
// It refuses to run outside Actions: no model inference happens on a developer machine.
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

if (!process.env.GITHUB_ACTIONS) {
  console.error("Runs real OCR in a browser; GitHub Actions only.");
  process.exit(2);
}
const { chromium } = await import("playwright");
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const mode = arg("mode");
const dist = path.resolve(arg("dist", "frontend/dist"));
const out = path.resolve(arg("out", "ocr-out"));
fs.mkdirSync(out, { recursive: true });
const protocol = JSON.parse(fs.readFileSync("backend/evals/ocr/protocol.json", "utf8"));
const RENDER = path.resolve("scripts/ocr-render.js");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".onnx": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!url.startsWith("/adproof/")) { res.writeHead(404); res.end("missing"); return; }
  let file = path.join(dist, url.slice("/adproof/".length));
  if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(url)) { res.writeHead(404); res.end("missing"); return; } // a missing asset is a 404, as on Pages
    file = path.join(dist, "index.html"); // deep links (Pages serves 404.html = index.html)
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(8766, "127.0.0.1", r));
const ORIGIN = "http://127.0.0.1:8766";
const BASE = `${ORIGIN}/adproof/`;
const browser = await chromium.launch();
const results = { mode, commit: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, engine: protocol.engine_version, checks: [] };
const fail = [];
const ok = (name, pass, detail = null) => {
  results.checks.push({ name, pass: Boolean(pass), detail });
  if (!pass) fail.push(name);
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail !== null ? ` · ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", ...options });
  const page = await context.newPage();
  const log = { errors: [], hosts: new Set() };
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") log.errors.push(m.text()); });
  page.on("request", (r) => { const u = new URL(r.url()); if (u.protocol === "http:" || u.protocol === "https:") log.hosts.add(u.host); });
  return { context, page, log };
}

// ------------------------------------------------------------------------------------------ eval helpers
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
/** protocol.render.assignment: the full factor grid shuffled with the seed; item k takes cell k mod size. */
function cells(set, layout, n) {
  const R = protocol.render;
  const last = layout === "frames" ? R.layouts.frames.styles.map((style) => ({ style })) : R.layouts.poster.body_px.map((body) => ({ body }));
  const grid = [];
  for (const font of R.fonts) for (const background of Object.keys(R.backgrounds)) for (const jpeg of R.jpeg_quality) for (const x of last) grid.push({ font, background, jpeg, ...x });
  const r = rng(R.seed ^ hash(`${set}/${layout}`));
  for (let i = grid.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [grid[i], grid[j]] = [grid[j], grid[i]];
  }
  return Array.from({ length: n }, (_, k) => grid[k % grid.length]);
}

async function labPage() {
  const { page, log } = await open();
  await page.goto(BASE);
  await page.waitForFunction(() => Boolean(window.__adproofOcr), null, { timeout: 60_000 });
  await page.addScriptTag({ path: RENDER });
  const listed = execSync("fc-list : family", { encoding: "utf8" });
  for (const f of protocol.render.fonts) ok(`font installed: ${f}`, listed.includes(f));
  const prints = await page.evaluate((fonts) => window.__ocrRender.fontPrints(fonts), protocol.render.fonts);
  ok("the four fonts render differently (none fell back)", new Set(prints).size === prints.length, prints);
  const t0 = Date.now();
  results.load = await page.evaluate(() => window.__adproofOcr.load());
  results.load.wall_seconds = (Date.now() - t0) / 1000;
  results.user_agent = await page.evaluate(() => navigator.userAgent);
  ok("engine loaded from the pinned files", results.load.downloadedBytes === results.load.expectedBytes, results.load);
  return { page, log };
}

const b64 = (page, expr) => page.evaluate(expr);

// dev-only experiment: the same renders read with different recognition settings (docs/EVALUATION.md 8.6)
const VARIANTS = {
  base: { rec_max_ratio: 1e9 }, seg12: { rec_max_ratio: 12 }, unclip13: { rec_max_ratio: 1e9, unclip: 1.3 }, unclip20: { rec_max_ratio: 1e9, unclip: 2.0 },
  xpad: { rec_max_ratio: 1e9, crop_x_pad: 0.3 }, yshrink: { rec_max_ratio: 1e9, crop_y_shrink: 0.12 }, smooth_low: { rec_max_ratio: 1e9, smoothing: "low" }, smooth_off: { rec_max_ratio: 1e9, smoothing: "off" }, rgb: { rec_max_ratio: 1e9, rgb: true },
};

if (mode === "eval" || mode === "variants") {
  const set = arg("set");
  if (mode === "variants" && set !== "dev") throw new Error("variants run on dev only");
  const items = JSON.parse(fs.readFileSync(arg("items"), "utf8"));
  const sequestered = protocol.sets.test.items.some((s) => s.name === set && s.aggregate_only);
  const { page, log } = await labPage();
  if (fail.length) throw new Error(`setup failed: ${fail.join("; ")}`);
  const variants = mode === "variants" ? Object.entries(VARIANTS) : [[null, {}]];
  for (const [variant, over] of variants) {
  const renders = [];
  const keep = set === "dev" && !variant ? path.join(out, "renders") : null;
  if (keep) fs.mkdirSync(keep, { recursive: true });
  for (const layout of ["frames", "poster"]) {
    const assigned = cells(set, layout, items.length);
    for (const [k, item] of items.entries()) {
      const cell = assigned[k];
      const r = await page.evaluate(async ({ item, layout, cell, seed, keep, over }) => {
        const rendered = await window.__ocrRender.render(item, layout, cell, seed);
        const ocr = [];
        for (const [i, im] of rendered.images.entries()) ocr.push(await window.__adproofOcr.ocr(`${item.id}-${layout}-${i + 1}.jpg`, im.blob, over));
        const t = performance.now();
        const doc = window.__adproofOcr.join(ocr.map((o) => o.image));
        const join = (performance.now() - t) / 1000;
        const toB64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; b.forEach((x) => { s += String.fromCharCode(x); }); return btoa(s); };
        return {
          drawn: rendered.drawn, drawnAt: rendered.drawnAt, toOrig: rendered.toOrig, doc, join_seconds: join,
          images: rendered.images.map((im, i) => ({ width: im.width, height: im.height, drawn: im.drawn, bytes: im.blob.size, seconds: ocr[i].seconds, lines: ocr[i].image.lines.length })),
          first: keep ? await toB64(rendered.images[0].blob) : null,
        };
      }, { item, layout, cell, seed: protocol.render.seed, keep: Boolean(keep), over });
      if (keep && r.first) fs.writeFileSync(path.join(keep, `${item.id}-${layout}.jpg`), Buffer.from(r.first, "base64"));
      delete r.first;
      renders.push({ id: item.id, layout, cell, ...r });
      console.log(`${set}${variant ? `@${variant}` : ""} ${item.id} ${layout} · ${r.images.length} image(s) · ${r.images.map((x) => x.seconds.toFixed(2)).join("/")} s`);
    }
  }
  ok("no page errors", log.errors.length === 0, log.errors.slice(0, 5));
  results.rec_shapes = await page.evaluate(() => window.__adproofOcr.shapes());
  console.log("session input shapes", JSON.stringify(results.load.shapes), "last recogniser call", JSON.stringify(results.rec_shapes));
  results.set = set;
  results.renders = renders;
  // the sequestered set's results stay on the runner (scored in the same job, aggregate only)
  const where = sequestered ? path.resolve(arg("private", "ocr-private")) : out;
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(where, `${set}${variant ? `@${variant}` : ""}.results.json`), JSON.stringify({ ...results, variant, overrides: over }));
  }
} else if (mode === "smallprint") {
  const items = JSON.parse(fs.readFileSync(arg("items"), "utf8"));
  const { page } = await labPage();
  const strips = [];
  for (const item of items) {
    const m = /^[^。！？!?；;\n]{1,30}/.exec(item.text.trim());
    const sentence = m ? m[0] : item.text.trim().slice(0, 30);
    for (const px of protocol.small_print_probe.font_px) {
      const r = await page.evaluate(async ({ sentence, px }) => {
        const s = await window.__ocrRender.strip(sentence, px);
        const o = await window.__adproofOcr.ocr(`strip-${px}.jpg`, s.blob);
        return { drawn: s.drawn, ocr: o.image.lines.map((l) => l.text).join(""), seconds: o.seconds };
      }, { sentence, px });
      strips.push({ id: item.id, px, ...r });
    }
  }
  results.strips = strips;
  fs.writeFileSync(path.join(out, "smallprint.results.json"), JSON.stringify(results));
} else if (mode === "examples") {
  const { page } = await open();
  await page.goto(BASE);
  await page.addScriptTag({ path: RENDER });
  const samples = JSON.parse(fs.readFileSync("frontend/src/samples.json", "utf8"));
  const dir = path.join(out, "ocr-examples");
  fs.mkdirSync(dir, { recursive: true });
  const specs = [
    { id: "frames", sku: "MIA-SERUM", layout: "frames", cell: { font: "Noto Sans CJK SC", background: "busy", jpeg: 0.85, style: "outline" }, label: "字幕帧", note: "SYNTHETIC：演示商品的示例口播按字幕样式渲染成视频帧（合成图，不是真实广告）" },
    { id: "poster", sku: "NOAH-OAT", layout: "poster", cell: { font: "Noto Serif CJK SC", background: "gradient", jpeg: 0.85, body: 40 }, label: "海报", note: "SYNTHETIC：演示商品的示例文案渲染成海报（合成图，不是真实广告）" },
  ];
  const index = { note: "SYNTHETIC renders of the demo's sample scripts (frontend/src/samples.json) by scripts/ocr-render.js; regenerate with the examples job of .github/workflows/ocr.yml.", sets: [] };
  for (const s of specs) {
    const text = samples[s.sku].text;
    const files = await page.evaluate(async ({ s, text, seed }) => {
      const item = { id: s.id, set: "examples", input_type: "text", text, cues: [] };
      const r = await window.__ocrRender.render(item, s.layout, s.cell, seed, { label: true });
      const toB64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let x = ""; b.forEach((v) => { x += String.fromCharCode(v); }); return btoa(x); };
      return Promise.all(r.images.map(async (im) => toB64(im.blob)));
    }, { s, text, seed: protocol.render.seed });
    const names = files.map((_, i) => `${s.id}-${i + 1}.jpg`);
    files.forEach((f, i) => fs.writeFileSync(path.join(dir, names[i]), Buffer.from(f, "base64")));
    index.sets.push({ id: s.id, label: `${s.label}（${names.length} 张，SYNTHETIC）`, files: names, note: s.note });
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 1) + "\n");
  ok("examples written", index.sets.every((s) => s.files.length > 0), index.sets.map((s) => s.files.length));
} else if (mode === "check" || mode === "probe") {
  await runVisitor(mode);
} else {
  throw new Error(`unknown mode ${mode}`);
}

// ------------------------------------------------------------------------------------------ visitor flows
// Reviews live in the tab's memory, so everything after sign-in navigates in-app (no reload).
async function go(page, route) {
  await page.evaluate((u) => { history.pushState({}, "", u); dispatchEvent(new PopStateEvent("popstate")); }, `/adproof/${route}`);
}
async function signIn(page, who) {
  await page.goto(`${BASE}login`);
  await page.locator(".account", { hasText: who }).click();
  await page.waitForURL("**/workbench");
}
async function switchUser(page, who) {
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.locator(".account", { hasText: who }).click();
  await page.locator(".account").first().waitFor({ state: "detached" });
}
async function imageTab(page, category = "美妆个护") {
  await go(page, "workbench");
  await page.locator("select").first().waitFor();
  await page.locator("select").first().selectOption({ label: `不指定商品 · ${category}` });
  await page.getByRole("button", { name: "图片 / 截图" }).click();
}
async function recognised(page, n) {
  await page.waitForFunction((n) => document.querySelectorAll(".ocr-item svg").length >= n, n, { timeout: 600_000 });
  await page.waitForSelector('[data-testid="ocr-text"]', { timeout: 120_000 });
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
}

async function runVisitor(kind) {
  if (kind === "probe") {
    const urls = (arg("urls", "") ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
    const category = arg("category", "美妆个护");
    const inputs = [];
    for (const [i, u] of urls.entries()) {
      try {
        const url = new URL(u);
        if (url.protocol !== "https:") throw new Error("https only");
        const res = await fetch(url, { redirect: "follow" });
        const type = (res.headers.get("content-type") ?? "").split(";")[0];
        if (!res.ok || !["image/png", "image/jpeg", "image/webp"].includes(type)) throw new Error(`${res.status} ${type}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 15 * 1024 * 1024) throw new Error("larger than 15 MB");
        const name = `probe-${i + 1}.${type.split("/")[1].replace("jpeg", "jpg")}`;
        fs.writeFileSync(path.join(out, name), buf);
        inputs.push({ url: u, file: path.join(out, name), bytes: buf.length });
      } catch (e) {
        inputs.push({ url: u, error: String(e) });
      }
    }
    results.inputs = inputs;
    const files = inputs.filter((x) => x.file).map((x) => x.file);
    const { page, log } = await open();
    await signIn(page, "Emma");
    await imageTab(page, category);
    await page.getByTestId("ocr-load").click();
    await page.setInputFiles('[data-testid="ocr-files"]', files);
    if (files.length) await recognised(page, files.length);
    results.ocr_text = await page.locator('[data-testid="ocr-text"]').textContent().catch(() => null);
    await shot(page, "probe-workbench");
    if (files.length && results.ocr_text?.trim()) {
      await page.getByRole("button", { name: "开始审查" }).click();
      await page.waitForURL("**/reviews/**");
      await page.waitForSelector(".sheet-card");
      results.findings = await readFindings(page);
      results.scope = await page.locator(".scope-sheet").textContent().catch(() => null);
      await shot(page, "probe-review");
    }
    results.page_errors = log.errors;
    ok("probe ran", true);
    return;
  }

  // ---- check: before the click
  const { page, log } = await open();
  await signIn(page, "Emma");
  await imageTab(page);
  const card = await page.getByTestId("ocr-model").textContent();
  ok("download size and sources shown before any download", /35\.7 MB/.test(card) && /SHA-256/.test(card) && /本站/.test(card), card);
  ok("no request leaves the site before the click", [...log.hosts].every((h) => h === "127.0.0.1:8766"), [...log.hosts]);
  ok("what OCR cannot see is stated", /说出来的话/.test(await page.locator(".ocr-limits").textContent()));
  await shot(page, "check-1440-light-before");

  // ---- load, example, review
  const t0 = Date.now();
  await page.getByTestId("ocr-load").click();
  await page.waitForSelector('[data-testid="ocr-model"]', { state: "detached", timeout: 900_000 });
  results.load_seconds = (Date.now() - t0) / 1000;
  ok("requests go only to this site (weights) and jsDelivr (runtime)", [...log.hosts].every((h) => h === "127.0.0.1:8766" || h === "cdn.jsdelivr.net"), [...log.hosts]);
  await page.getByRole("button", { name: /示例：字幕帧/ }).click();
  const frames = await page.locator(".ocr-item").count();
  await recognised(page, frames);
  const text = await page.getByTestId("ocr-text").textContent();
  results.example_text = text;
  ok("example frames are read into text", frames >= 2 && /精华/.test(text), { frames, text });
  await page.getByRole("button", { name: "开始审查" }).click();
  await page.waitForURL("**/reviews/**");
  await page.waitForSelector(".ocr-evidence");
  const findings = await readFindings(page);
  results.example_findings = findings;
  ok("findings are boxed on the image their text came from", findings.hits.length > 0 && findings.hits.every((h) => h.w > 0 && h.h > 0), findings.hits.slice(0, 4));
  ok("the engine banner says the text came from OCR", /OCR/.test(await page.locator(".engine-note").textContent()));
  ok("the scope lists what OCR cannot see", /说出来的话/.test(await page.locator(".scope-sheet").textContent()));
  await page.locator(".ocr-hit").first().click();
  ok("clicking a box opens its note", (await page.locator(".note.active").count()) === 1 && /图 \d/.test(await page.locator(".note.active .where").textContent()));
  const reviewUrl = page.url();
  for (const [w, h, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [375, 812, "dark"], [375, 812, "light"]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`review ${w}px ${scheme}: no horizontal overflow`, overflow <= 1, overflow);
    await shot(page, `check-review-${w}-${scheme}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });

  // ---- sign-off on the image review (模拟): a reviewer rejects it with a note
  await switchUser(page, "Mia");
  await page.waitForSelector(".ocr-evidence");
  ok("the reviewer sees the image review with its boxes", page.url() === reviewUrl && (await page.locator(".ocr-hit").count()) > 0);
  const reject = page.getByRole("button", { name: "驳回" });
  if (await reject.count()) {
    await page.getByLabel("终审备注").fill("画面文字含绝对化用语（检查任务）");
    await reject.click();
    await page.waitForTimeout(500);
    ok("reviewer rejects the image review (模拟)", /驳回/.test(await page.locator(".review-head").textContent()));
  } else {
    ok("reviewer has a reject action", false);
  }
  await switchUser(page, "Emma");

  // ---- workbench at 375 in both themes, with images recognised
  for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: scheme });
    await imageTab(page);
    await page.getByRole("button", { name: /示例：海报/ }).click();
    await recognised(page, 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`workbench 375px ${scheme}: poster example recognised, no overflow`, overflow <= 1, overflow);
    await shot(page, `check-workbench-375-${scheme}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });

  // ---- existing flows still work: own script → review → 红笔改稿 → reviewer 采用改写稿通过 (模拟); 红队回合
  await go(page, "workbench");
  await page.locator("select").first().selectOption({ label: "不指定商品 · 美妆个护" });
  await page.getByRole("button", { name: "口播文案" }).click();
  await page.locator("textarea").first().fill("姐妹们，这是我用过最好用的精华，今天全网最低价，用完皮肤立刻变白。");
  await page.getByRole("button", { name: "开始审查" }).click();
  await page.waitForURL("**/reviews/**");
  await page.waitForSelector(".sheet-card");
  ok("pasted script: findings in the margin", (await page.locator(".note").count()) >= 2);
  await page.getByRole("tab", { name: "红笔改稿" }).click();
  ok("红笔改稿 tab shows a rewrite or says why not", (await page.locator(".sheet-card").textContent()).length > 0);
  await switchUser(page, "Mia");
  await page.waitForSelector(".sheet-card");
  const adopt = page.getByRole("button", { name: "采用改写稿通过" });
  if (await adopt.isEnabled()) {
    await adopt.click();
    await page.waitForTimeout(500);
    ok("reviewer adopts the rewrite (模拟)", /采用改写稿/.test(await page.locator("body").textContent()));
  } else {
    ok("reviewer adopt button state is explained", Boolean(await adopt.getAttribute("title")));
  }
  await go(page, "redteam");
  await page.waitForSelector("table");
  ok("红队回合 page renders", (await page.locator("table").count()) > 0);
  ok("no console errors in the main flow", log.errors.length === 0, log.errors.slice(0, 5));

  // ---- failure paths in fresh tabs
  const u = await open();
  await u.page.addInitScript(() => { WebAssembly.validate = () => false; });
  await signIn(u.page, "Emma");
  await imageTab(u.page);
  ok("without WASM SIMD the image input is replaced by a note", (await u.page.getByTestId("ocr-unsupported").count()) === 1 && (await u.page.getByTestId("ocr-load").count()) === 0);
  await u.context.close();

  const t = await open();
  await t.page.route("**/models/pp-ocrv5/ch_PP-OCRv5_det.onnx", async (route) => {
    const res = await route.fetch();
    const body = Buffer.from(await res.body());
    body[1000] ^= 0xff;
    await route.fulfill({ response: res, body });
  });
  await signIn(t.page, "Emma");
  await imageTab(t.page);
  await t.page.getByTestId("ocr-load").click();
  await t.page.waitForSelector('[role="alert"]', { timeout: 600_000 });
  const msg = await t.page.locator('[role="alert"]').textContent();
  ok("a tampered weight file is refused and nothing runs", /校验不符/.test(msg) && (await t.page.evaluate(() => typeof window.ort === "undefined")), msg);
  await t.context.close();

  const c = await open();
  await c.page.route("**/models/pp-ocrv5/*.onnx", async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  await signIn(c.page, "Emma");
  await imageTab(c.page);
  await c.page.getByTestId("ocr-load").click();
  await c.page.getByRole("button", { name: "取消" }).click();
  await c.page.waitForSelector('[role="alert"]', { timeout: 120_000 });
  ok("cancel stops the download and the text inputs still work", /已取消/.test(await c.page.locator('[role="alert"]').textContent()) && (await c.page.getByTestId("ocr-load").count()) === 1);
  await c.context.close();
}

async function readFindings(page) {
  const hits = await page.$$eval(".ocr-hit", (rs) => rs.map((r) => ({ key: r.getAttribute("data-key"), title: r.querySelector("title")?.textContent ?? "",
    x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") })));
  const notes = await page.$$eval(".note", (ns) => ns.map((n) => ({ key: n.getAttribute("data-key"), text: n.textContent })));
  return { hits, notes };
}

// ------------------------------------------------------------------------------------------ report
results.failed = fail;
fs.writeFileSync(path.join(out, `${mode}.json`), JSON.stringify({ ...results, renders: undefined }, null, 1));
const md = [`### OCR ${mode}${arg("set") ? ` · ${arg("set")}` : ""}`, "", `commit \`${(process.env.GITHUB_SHA ?? "").slice(0, 7)}\` · run ${process.env.GITHUB_RUN_ID}`, "",
  ...results.checks.map((c) => `- ${c.pass ? "✅" : "❌"} ${c.name}`), ""];
if (results.load) md.push(`load: init ${results.load.initSeconds.toFixed(2)} s · ${results.load.downloadedBytes} bytes · wall ${results.load.wall_seconds.toFixed(1)} s`, "");
fs.writeFileSync(path.join(out, `${mode}-summary.md`), md.join("\n"));
await browser.close();
server.close();
process.exit(fail.length ? 1 : 0);
