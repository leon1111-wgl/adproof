// Regenerate the README screenshots from the static demo build: the same recordings that
// GitHub Pages serves, so the shots need no backend and come out the same every time.
//
//   cd frontend && pnpm build:demo && pnpm preview --mode demo --port 4173 --strictPort &
//   node scripts/screenshots.mjs
//
// Optional:
//   BASE_URL=http://127.0.0.1:4173/adproof/                (default)
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright     (default: import "playwright")
//   CHROME_PATH=/path/to/chrome                            (default: Playwright's Chromium)
//   OUT_DIR=docs/assets
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, "index.mjs")).href
  : "playwright";
const { chromium } = await import(moduleUrl);

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:4173/adproof/").replace(/\/?$/, "/");
const OUT = process.env.OUT_DIR ?? "docs/assets";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const errors = [];

async function session(options, fn) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    reducedMotion: "reduce",
    ...options,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await fn(page);
  await context.close();
}

const shot = async (page, name, options = {}) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`), ...options });
  console.log(`saved ${name}.png`);
};

async function loginAs(page, name) {
  await page.goto(`${BASE}login`);
  await page.locator(".account", { hasText: name }).click();
  await page.waitForURL("**/workbench");
}

async function openReview(page, title) {
  await page.goto(`${BASE}reviews`);
  await page.locator("tr", { hasText: title }).first().click();
  await page.waitForSelector(".sheet-card");
}

/** Submits a recorded workbench input (product, sample or generate options) and opens the result. */
async function submit(page, { product, generate = false, tone, inject = false }) {
  await page.goto(`${BASE}workbench`);
  await page.locator("select").first().selectOption({ label: product });
  if (generate) {
    await page.getByRole("button", { name: "生成新脚本" }).click();
    if (tone) await page.locator("select").nth(2).selectOption(tone);
  } else {
    await page.getByRole("button", { name: "填入示例" }).click();
  }
  if (inject) await page.getByText("演示开关").click();
  await page.getByRole("button", { name: generate ? "生成并审查" : "开始审查" }).click();
  await page.waitForURL("**/reviews/**");
  await page.waitForSelector(".sheet-card");
}

// 1. landing with the annotated specimen, 2. sign-in
await session({ viewport: { width: 1440, height: 1500 } }, async (page) => {
  await page.goto(BASE);
  await page.locator(".specimen .note").nth(2).click();
  await shot(page, "landing");
});
await session({}, async (page) => {
  await page.goto(`${BASE}login`);
  await page.locator(".account").first().waitFor();
  await shot(page, "login");
});

// 3. Mia reviews Emma's script: margin notes, verified law text, redline, clean copy
await session({ viewport: { width: 1440, height: 1100 } }, async (page) => {
  await loginAs(page, "Mia");
  await openReview(page, "精华");
  await page.locator("mark.hl").nth(2).click();
  await page.locator(".note.active .cite-chip").first().hover();
  await shot(page, "review-evidence");
  await page.getByRole("tab", { name: "红笔改稿" }).click();
  await shot(page, "review-rewrite");

  // 4. an injected model quote that is not in the script is stopped by the evidence check
  await submit(page, { product: "Mia植萃 烟酰胺焕亮精华 30ml · 美妆个护", inject: true });
  await shot(page, "review-hallucination-guard");

  await page.goto(`${BASE}workbench`);
  await page.getByRole("button", { name: "填入示例" }).click();
  await shot(page, "workbench");
});

// 5. SRT cues, rules, laws, evals, trace
await session({}, async (page) => {
  await loginAs(page, "Leon");
  await openReview(page, "耳机");
  await shot(page, "review-srt");
  const trace = page.getByRole("link", { name: "链路追踪" }).last();
  await page.goto(`${BASE}rules`);
  await page.locator(".table").first().waitFor();
  await shot(page, "rules");
  await page.getByRole("button", { name: "法条快照" }).click();
  await page.locator(".law-article").first().waitFor();
  await shot(page, "laws");
  await page.goto(`${BASE}evals`);
  await page.locator(".kpi").first().waitFor();
  await shot(page, "evals");
  await openReview(page, "耳机");
  await trace.click();
  await page.waitForURL("**/traces/**");
  await page.locator(".span-row").first().waitFor();
  await shot(page, "trace");
});

// 6. dark theme, 7. a phone
await session({ colorScheme: "dark", viewport: { width: 1440, height: 1000 } }, async (page) => {
  await loginAs(page, "Mia");
  await openReview(page, "精华");
  await page.locator("mark.hl").nth(4).click();
  await shot(page, "review-dark");
});
await session({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, async (page) => {
  await loginAs(page, "Mia");
  await openReview(page, "精华");
  await page.locator("mark.hl").first().tap();
  await shot(page, "mobile");
});

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
