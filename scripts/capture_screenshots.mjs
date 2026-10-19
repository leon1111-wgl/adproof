// Capture the README screenshots from a running AdProof instance.
//
//   ADPROOF_MOCK_LATENCY_MS=260 uvicorn app.main:app --port 8710      # in backend/, fresh database
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   node scripts/capture_screenshots.mjs http://127.0.0.1:8710 docs/assets
//
// The offline model's latency in these screenshots is simulated (the trace view says so).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.argv[2] ?? "http://127.0.0.1:8710";
const out = process.argv[3] ?? "docs/assets";
mkdirSync(out, { recursive: true });

const SAMPLE = "姐妹们，这瓶烟酰胺精华我真的回购了三次，是我用过最好用的提亮精华！含30%烟酰胺，敏感肌也能用，还能消炎祛痘。\n"
  + "92%的姐妹用完都说皮肤亮了一个度，别家卖的都是智商税。\n今天直播间到手价99元，全网最低价，拍一发二！";
const SRT = "1\n00:00:00,000 --> 00:00:03,200\n家人们，这副降噪耳机今天上车了\n\n2\n00:00:03,200 --> 00:00:06,800\n降噪深度45dB，同价位吊打所有竞品\n\n"
  + "3\n00:00:06,800 --> 00:00:10,000\n单次续航8小时，行业首创智能降噪\n\n4\n00:00:10,000 --> 00:00:13,000\n到手价299元，点小黄车下单\n";

async function api(path, { token, method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const login = async (email) => (await api("/api/auth/login", { method: "POST", body: { email, password: "adproof-demo" } })).token;

async function waitReview(id, token) {
  for (let i = 0; i < 60; i++) {
    const r = await api(`/api/reviews/${id}`, { token });
    if (!["queued", "running"].includes(r.status)) return r;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`review ${id} did not finish`);
}

const emma = await login("emma@adproof.demo");
const mia = await login("mia@adproof.demo");
const products = Object.fromEntries((await api("/api/products", { token: emma })).map((p) => [p.sku, p.id]));
const serum = await api("/api/reviews", { token: mia, method: "POST", body: { product_id: products["MIA-SERUM"], content: SAMPLE, title: "Mia植萃精华 · 直播口播 v2", inject_hallucination: true } });
// Submitted by Emma so that Mia (reviewer) is allowed to sign off.
const serumForMia = await api("/api/reviews", { token: emma, method: "POST", body: { product_id: products["MIA-SERUM"], content: SAMPLE, title: "Mia植萃精华 · 直播口播 v2" } });
const srt = await api("/api/reviews", { token: emma, method: "POST", body: { product_id: products["JACK-EARBUDS"], input_type: "srt", content: SRT, title: "Jack数码耳机 · 直播字幕 v2" } });
for (const r of [serum, serumForMia, srt]) await waitReview(r.id, mia);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "zh-CN" });
const page = await context.newPage();
const shot = (name, options = {}) => page.screenshot({ path: join(out, `${name}.png`), ...options });

await page.goto(base + "/");
await page.waitForSelector(".login");
await shot("login");

await page.evaluate((t) => localStorage.setItem("adproof.token", t), mia);

// Review detail: hover the first citation chip to show the verified law text.
await page.goto(`${base}/reviews/${serumForMia.id}`);
await page.waitForSelector(".finding");
await page.locator(".finding").nth(2).locator(".quote").click();
await page.waitForTimeout(600);
await page.hover(".finding.active .cite-chip >> nth=0");
await page.waitForTimeout(300);
await shot("review-evidence");

await page.click("text=改写稿");
await page.waitForTimeout(300);
await shot("review-rewrite");

await page.goto(`${base}/reviews/${srt.id}`);
await page.waitForSelector(".cue-row");
await page.hover("mark.hl >> nth=0");
await page.waitForTimeout(300);
await shot("review-srt");

await page.goto(`${base}/reviews/${serum.id}`);
await page.waitForSelector(".finding");
await page.waitForTimeout(300);
await shot("review-hallucination-guard");

await page.goto(`${base}/workbench`);
await page.waitForSelector("textarea");
await page.click("text=填入示例");
await shot("workbench");

await page.goto(`${base}/rules`);
await page.waitForSelector(".table");
await shot("rules");
await page.click("text=法条快照");
await page.waitForSelector(".law-article");
await shot("laws");

await page.goto(`${base}/evals`);
await page.waitForSelector(".kpi");
await page.waitForTimeout(300);
await shot("evals", { fullPage: false });

const reviewDetail = await api(`/api/reviews/${serumForMia.id}`, { token: mia });
await page.goto(`${base}/traces/${reviewDetail.run_id}`);
await page.waitForSelector(".span-row");
await page.click(".span-row >> nth=2");
await page.waitForTimeout(300);
await shot("trace");

await page.emulateMedia({ colorScheme: "dark" });
await page.goto(`${base}/reviews/${serumForMia.id}`);
await page.waitForSelector(".finding");
await page.waitForTimeout(300);
await shot("review-dark");

await browser.close();
console.log("screenshots written to", out);
