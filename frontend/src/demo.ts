/* Static demo (`vite build --mode demo`, served by GitHub Pages).
 *
 * There is no backend. Two engines answer, and every review says which one produced it:
 * - recorded: responses saved by scripts/record_demo.py, which ran the real API with the offline
 *   mock model on the SYNTHETIC demo data (seeded reviews, each sample script, generate options);
 * - browser: any other script a visitor submits is reviewed in the tab by src/engine/, a port of
 *   the backend pipeline that tests/parity.test.ts keeps identical to it. Nothing is uploaded.
 * Verdicts and sign-offs (模拟) change this tab's memory only, under the same rules as
 * backend/app/review_service.py (four-eyes, blocking findings, re-check before an edited
 * approval); a reload restores the recording. */
import { ApiError, getToken } from "./api";
import { pack } from "./engine/pack";
import { Tracer, recheck as engineRecheck, run as engineRun, type Product as EngineProduct } from "./engine/pipeline";
import { checkDisclosures, CATEGORIES, scan } from "./engine/rules";
import { scopeOf } from "./engine/scope";
import { cpLen, parseSrt, SRTError, type Cue } from "./engine/text";
import { regionsForSpan, type OcrDocument } from "./ocr/layout";
import ocrPins from "./ocr/pins.json";
import samples from "./samples.json";
import type { EngineInfo, Product, Recheck, Review, Severity, User, UserBrief } from "./types";

const SAMPLES = samples as Record<string, { text?: string; srt?: string }>;

const ROOT = `${import.meta.env.BASE_URL}demo/`;
const TOKEN_PREFIX = "demo:";
const BLOCKING: Severity[] = ["high", "medium"]; // app/agents/pipeline.py

interface DemoIndex {
  users: User[];
  provider: string;
  model: string;
  ruleset: { version: string; hash: string; name: string };
  recorded_at: string;
}

interface WorkbenchRequest {
  sku: string;
  mode: "review" | "generate";
  input_type: "text" | "srt" | "image";
  content: string;
  /** image input: the OCR document from this tab, the images' object URLs, and an optional .srt */
  ocr?: ImagePayload;
  style: string;
  tone: string;
  inject_hallucination: boolean;
}

export interface ImagePayload {
  document: OcrDocument;
  images: { name: string; width: number; height: number; url: string }[];
  srt?: string;
  seconds: number[];
}

const MAX_CHARS = 6000; // Settings.max_script_chars

const OCR_ENGINE: EngineInfo = {
  kind: "browser",
  label: "浏览器内审查 · 图片文字由本页 OCR 识别",
  detail: `图片在本页由 PP-OCRv5 mobile（onnxruntime-web，WebAssembly）识别成文字，再交给与粘贴文字相同的浏览器引擎（规则库 ${pack.ruleset.version} · ${pack.ruleset.hash}）。图片不上传；识别可能有错字和漏字，结果以原图为准。`,
};

/** Category-only choices for a visitor's own product: no product sheet, so no fact check. */
export const CUSTOM_PRODUCTS: Product[] = Object.entries(pack.product_categories).map(([category, label], i) => ({
  id: -(i + 1), sku: `CUSTOM-${category}`, name: "访客脚本", brand: "", category,
  description: `未提供商品资料，只按「${label}」类目的规则审查`, facts: [],
}));

const RECORDED_ENGINE = (recordedAt: string): EngineInfo => ({
  kind: "recorded",
  label: "回放 · 后端流水线的录制结果",
  detail: `后端 API 在进程内运行、离线确定性模型（不是语言模型）、SYNTHETIC 数据，录制于 ${recordedAt.slice(0, 10)}；没有重新计算。`,
});

const BROWSER_ENGINE: EngineInfo = {
  kind: "browser",
  label: "浏览器内审查 · 本页计算",
  detail: `后端流水线的 TypeScript 移植（规则库 ${pack.ruleset.version} · ${pack.ruleset.hash}，与后端逐条一致，见 parity 测试）。规则 + 离线语义模式，没有调用服务器或语言模型，脚本不上传。`,
};

const files = new Map<string, Promise<unknown>>();

function load<T>(file: string, missing = "静态演示没有录制这个请求。完整功能请按 README 在本地运行。"): Promise<T> {
  let pending = files.get(file);
  if (!pending) {
    pending = fetch(ROOT + file).then((res) => {
      // dev servers and SPA fallbacks answer a missing file with index.html and status 200
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) throw new ApiError(404, missing);
      return res.json();
    });
    pending.catch(() => files.delete(file));
    files.set(file, pending);
  }
  return pending as Promise<T>;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const brief = (u: User): UserBrief => ({ id: u.id, name: u.name, role: u.role, title: u.title });
const now = () => new Date().toISOString();

async function viewer(): Promise<User> {
  const token = getToken();
  const user = token?.startsWith(TOKEN_PREFIX) && (await load<DemoIndex>("index.json")).users.find((u) => u.email === token.slice(TOKEN_PREFIX.length));
  if (!user) throw new ApiError(401, "请先选择一个演示账号");
  return user;
}

// ---------------------------------------------------------------- in-memory reviews and traces
let reviews: Promise<Map<number, Review>> | null = null;
const createdRuns: unknown[] = [];
const recordedRunOf = new Map<string, string>(); // run id of a review submitted here -> the recorded run it replays

function store(): Promise<Map<number, Review>> {
  reviews ??= Promise.all([load<Review[]>("reviews.json"), load<DemoIndex>("index.json")]).then(([list, index]) => {
    recordedAt = index.recorded_at;
    return new Map(list.map((r) => [r.id, clone(r)]));
  });
  return reviews;
}

// ---------------------------------------------------------------- the browser engine
const browserRuns = new Map<string, unknown>(); // run id -> trace detail of a review computed here

function prepareInput(inputType: string, content: string, ocr?: ImagePayload): [string, Cue[], number] {
  // review_service.prepare_input(); image input (demo only): an attached .srt first, then the OCR text
  let text: string;
  let cues: Cue[] = [];
  let offset = 0;
  if (inputType === "image") {
    if (!ocr || !ocr.images.length) throw new ApiError(422, "没有识别过的图片");
    let srtText = "";
    if (ocr.srt?.trim()) {
      try {
        [srtText, cues] = parseSrt(ocr.srt);
      } catch (e) {
        if (e instanceof SRTError) throw new ApiError(422, `字幕文件解析失败：${e.message}`);
        throw e;
      }
    }
    offset = srtText ? srtText.length + 1 : 0;
    text = srtText ? `${srtText}\n${ocr.document.text}` : ocr.document.text;
    if (!ocr.document.text.trim() && !srtText) throw new ApiError(422, "图片里没有识别出文字");
  } else if (inputType === "srt") {
    try {
      [text, cues] = parseSrt(content);
    } catch (e) {
      if (e instanceof SRTError) throw new ApiError(422, `字幕文件解析失败：${e.message}`);
      throw e;
    }
  } else {
    text = content.replace(/\r\n/g, "\n").trim();
  }
  if (!text.trim()) throw new ApiError(422, "脚本内容为空");
  if (cpLen(text) > MAX_CHARS) throw new ApiError(422, `脚本超过 ${MAX_CHARS} 字，请分段提交`);
  return [text, cues, offset];
}

/** Image input: each finding's boxes, from the OCR characters its span covers. */
function withRegions<T extends { start: number; end: number }>(findings: T[], doc: OcrDocument, offset: number): T[] {
  return findings.map((f) => {
    const region = regionsForSpan(doc, f.start - offset, f.end - offset);
    return region.length ? { ...f, region } : f;
  });
}

const OCR_NOT_CHECKED = [
  { label: "说出来的话", detail: "口播、配音和背景里的人声不在画面上，OCR 看不到；请附上字幕文件或粘贴口播稿。" },
  { label: "小字", detail: "角标、免责声明、价格旁的小字可能漏识或识别错；标为“可能识别错”的行请对照原图。" },
  { label: "画面本身", detail: "前后对比图、穿白大褂的人物、徽章和国旗、奖杯图标等视觉暗示不会被审查：进入规则引擎的只有文字。" },
  { label: "竖排、弧形、艺术字和倾斜文字", detail: "检测器只处理水平排列的文字，这类文字可能整段漏掉。" },
  { label: "排版", detail: "按从上到下、从左到右的顺序读；多栏、表格和环绕排版可能读乱顺序。" },
];

/** One review computed in the tab, shaped like the API's review (exported for tests). */
export function buildBrowserReview(id: number, product: Product, request: Pick<WorkbenchRequest, "input_type" | "content" | "inject_hallucination" | "ocr">, user: User) {
  const [text, cues, offset] = prepareInput(request.input_type, request.content, request.ocr);
  const ocr = request.input_type === "image" ? request.ocr! : null;
  const runId = `browser-${Date.now().toString(36)}-${id}`;
  const tracer = new Tracer();
  const out = engineRun({ product: product as EngineProduct, script: text, cues, injectHallucination: request.inject_hallucination }, tracer);
  const at = now();
  const latency = tracer.spans.reduce((t, s) => t + s.latency_ms, 0);
  const label = pack.product_categories[product.category] ?? product.category;
  const kind = ocr ? "访客图片" : "访客脚本";
  const title = product.id < 0 ? `${kind} · ${label}` : `${product.brand}${product.name} · ${kind}`;
  const findings = ocr ? withRegions(out.findings, ocr.document, offset) : out.findings;
  const review: Review = {
    id, title, status: "pending", mode: "review", input_type: request.input_type, product_id: product.id, product: clone(product),
    risk_level: out.risk_level, counts: out.counts, ruleset_version: pack.ruleset.version, ruleset_hash: pack.ruleset.hash,
    provider: "browser", model: pack.provider.model, run_id: runId, error: null, created_by: brief(user), created_at: at,
    decision: null, decision_version: null, decision_note: "", decided_by: null, decided_at: null,
    source_text: out.script, source_raw: request.input_type === "srt" ? request.content : ocr?.srt?.trim() ? ocr.srt : null, cues: out.cues,
    ocr: ocr ? { images: ocr.images, lines: ocr.document.lines, offset, seconds: ocr.seconds, engine: `PP-OCRv5 mobile · ${ocrPins.engine_version}` } : undefined,
    options: { inject_hallucination: request.inject_hallucination }, selling_points: out.selling_points,
    findings: findings.map((f, i) => ({ ...f, id: -(i + 1), verdict: null, verdict_note: "", verdict_by: null })) as Review["findings"],
    disclosures: out.disclosures as Review["disclosures"], rewrite: out.rewrite as Review["rewrite"], rejected: out.rejected as Review["rejected"],
    validation: out.validation as Review["validation"], final_text: null,
    agents: tracer.spans.map((s) => ({ agent: s.agent, name: s.name, status: s.status, started_ms: s.started_ms, latency_ms: s.latency_ms })),
    engine: ocr ? OCR_ENGINE : BROWSER_ENGINE,
  };
  review.scope = scopeOf(text, product, { findings: out.findings, missing: out.disclosures.filter((d) => !d.present).length });
  if (ocr) {
    const low = ocr.document.lines.filter((l) => l.low).length;
    review.scope = {
      ...review.scope,
      input_notes: [
        `文字来自 ${ocr.images.length} 张图片的 OCR（本页识别，图片不上传）${low ? `，其中 ${low} 行置信度低，可能识别错` : ""}；每条问题都标出它在图上的位置。`,
        ...review.scope.input_notes,
      ],
      not_checked: [...OCR_NOT_CHECKED, ...review.scope.not_checked],
    };
  }
  const row = { id: runId, kind: "review", status: "completed", provider: "browser", model: pack.provider.model, latency_ms: Math.round(latency),
    prompt_tokens: 0, completion_tokens: 0, tokens_estimated: false, error: null, created_at: at, review: { id, title, status: review.status }, spans: tracer.spans.length };
  return { review, row, detail: { ...row, spans: tracer.spans.map((s, i) => ({ id: i + 1, ...s })) } };
}

async function browserReview(product: Product, request: WorkbenchRequest, user: User): Promise<Review> {
  const all = await store();
  const id = Math.max(0, ...all.keys()) + 1;
  const { review, row, detail } = buildBrowserReview(id, product, request, user);
  all.set(id, review);
  createdRuns.unshift(row);
  browserRuns.set(row.id, detail);
  return serialize(review, user);
}

/** review_service.permissions() */
export function permissions(review: Review, user: User): NonNullable<Review["permissions"]> {
  const decider = user.role === "admin" || user.role === "reviewer";
  const own = review.created_by.id === user.id;
  const open = review.status === "pending";
  let reason = "";
  if (!decider) reason = "只有审核员和管理员可以终审";
  else if (own) reason = "提交人不能终审自己的脚本（四眼原则）";
  else if (!open) reason = review.decision ? "该脚本已完成终审" : "流水线尚未完成";
  return { can_verdict: decider && open, can_decide: decider && open && !own, reason };
}

let recordedAt = "";

/** Every review answers with its engine and a default-deny scope statement. */
function annotate(review: Review): void {
  review.engine ??= RECORDED_ENGINE(recordedAt);
  if (!review.scope && review.source_text && review.status !== "queued" && review.status !== "running") {
    review.scope = scopeOf(review.source_text, review.product, {
      findings: review.findings ?? [], missing: (review.disclosures ?? []).filter((d) => !d.present).length,
    });
  }
}

const serialize = (review: Review, user: User): Review => {
  annotate(review);
  return { ...clone(review), permissions: permissions(review, user) };
};

async function getReview(id: number): Promise<Review> {
  const all = await store();
  const review = all.get(id);
  if (!review) {
    const recorded = Math.max(0, ...(await load<Review[]>("reviews.json")).map((r) => r.id));
    throw new ApiError(404, id > recorded ? "这条审查只存在于刷新之前的页面内存中（静态演示不保存新提交），请从工作台重新提交" : "审查记录不存在");
  }
  return review;
}

function requireDecider(user: User) {
  if (user.role !== "admin" && user.role !== "reviewer") throw new ApiError(403, "当前角色无权执行该操作");
}

const templateName = (r: WorkbenchRequest) => // scripts/record_demo.py template_name()
  [r.sku, r.mode, ...(r.mode === "review" ? [] : [r.style, r.tone]), r.inject_hallucination ? "1" : "0"].join(".");

async function createReview(body: Record<string, unknown>, user: User): Promise<Review> {
  const products = [...(await load<Product[]>("api/products.json")), ...CUSTOM_PRODUCTS];
  const product = products.find((p) => p.id === body.product_id);
  if (product && product.id < 0 && body.mode !== "review") throw new ApiError(422, "生成脚本需要商品资料，请选择一个演示商品");
  if (!product) throw new ApiError(404, "商品不存在");
  const inject = Boolean(body.inject_hallucination);
  if (inject && user.role === "operator") throw new ApiError(403, "演示开关仅对审核员和管理员开放");
  const request = { sku: product.sku, mode: body.mode, input_type: body.input_type, content: String(body.content ?? ""),
    style: body.style, tone: body.tone, inject_hallucination: inject,
    ocr: body.input_type === "image" ? (body.ocr as ImagePayload | undefined) : undefined } as WorkbenchRequest;
  type Template = { request: WorkbenchRequest; review: Review; run_row: Record<string, unknown> | null };
  const sameText = (a: string) => a.replace(/\r\n/g, "\n").trim();
  let recorded: Template;
  if (request.mode === "review") {
    // the recorded run when this is exactly a sample script; the browser engine for anything else
    // (only samples were recorded, so nothing else is fetched)
    const sample = SAMPLES[request.sku];
    const sampleText = request.input_type === "srt" ? sample?.srt : sample?.text;
    const isSample = product.id > 0 && sampleText !== undefined && sameText(sampleText) === sameText(request.content);
    const template = isSample ? await load<Template>(`templates/${templateName(request)}.json`).catch(() => null) : null;
    if (!template || request.input_type !== template.request.input_type || sameText(request.content) !== sameText(template.request.content)) {
      return browserReview(product as Product, request, user);
    }
    recorded = template;
  } else {
    recorded = await load<Template>(`templates/${templateName(request)}.json`, "静态演示没有录制这组选项。完整功能请按 README 在本地运行。");
  }
  const all = await store();
  const id = Math.max(0, ...all.keys()) + 1;
  const runId = recorded.review.run_id ? `${recorded.review.run_id}-demo${id}` : null;
  if (runId) recordedRunOf.set(runId, recorded.review.run_id!);
  const review: Review = { ...clone(recorded.review), id, run_id: runId, created_by: brief(user), created_at: now() };
  all.set(review.id, review);
  if (recorded.run_row) createdRuns.unshift({ ...recorded.run_row, id: runId, created_at: review.created_at, review: { id, title: review.title, status: review.status } });
  return serialize(review, user);
}

/** review_service.set_verdict() */
export function setVerdict(review: Review, key: string, body: { verdict?: string | null; note?: string }, user: User): void {
  requireDecider(user);
  const finding = review.findings?.find((f) => f.key === key);
  if (!finding) throw new ApiError(404, "该条结果不存在");
  if (review.status !== "pending") throw new ApiError(409, "终审完成后不能再修改判定");
  const note = (body.note ?? "").trim();
  if (body.verdict === "false_positive" && note.length < 2) throw new ApiError(422, "标记误报时请写明理由，方便规则维护");
  finding.verdict = (body.verdict ?? null) as typeof finding.verdict;
  finding.verdict_note = note;
  finding.verdict_by = body.verdict ? brief(user) : null;
}

/** review_service.recheck(): the recorded re-check when there is one, otherwise the browser engine. */
async function findRecheck(review: Review, text: string): Promise<Recheck> {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new ApiError(422, "脚本内容为空");
  if (review.engine?.kind !== "browser") {
    const rechecks = await load<{ sku: string; text: string; result: Recheck }[]>("rechecks.json");
    const hit = rechecks.find((r) => r.sku === review.product.sku && r.text === normalized);
    if (hit) return { ...clone(hit.result), engine: RECORDED_ENGINE(recordedAt) };
  }
  const result = engineRecheck(normalized, review.product as EngineProduct);
  return { ...(clone(result) as unknown as Recheck), engine: BROWSER_ENGINE };
}

/** review_service.decide() */
export async function decide(review: Review, body: { decision?: string; version?: string | null; final_text?: string | null; note?: string }, user: User): Promise<void> {
  requireDecider(user);
  if (review.status !== "pending") throw new ApiError(409, "该脚本不在待终审状态");
  if (review.created_by.id === user.id) throw new ApiError(403, "提交人不能终审自己的脚本（四眼原则）");
  const note = (body.note ?? "").trim();
  let version: Review["decision_version"] = (body.version ?? null) as Review["decision_version"];
  let finalText: string | null;
  if (body.decision === "reject") {
    if (note.length < 2) throw new ApiError(422, "驳回时请写明原因");
    version = null;
    finalText = null;
  } else if (body.decision === "approve" && body.version === "original") {
    const open = (review.findings ?? []).filter((f) => BLOCKING.includes(f.severity) && f.verdict !== "false_positive").map((f) => f.key);
    const missing = (review.disclosures ?? []).filter((d) => !d.present).map((d) => d.id);
    if (open.length || missing.length) {
      const detail = { message: "原稿仍有未标记为误报的问题，不能直接通过", findings: open, missing_disclosures: missing };
      throw new ApiError(409, detail.message, detail);
    }
    finalText = review.source_text ?? null;
  } else if (body.decision === "approve" && body.version === "rewrite") {
    if (review.rewrite?.withheld) throw new ApiError(409, "无法自动改写，请用“修改后通过”人工改写", { message: "无法自动改写，请用“修改后通过”人工改写" });
    if (!review.rewrite?.passed) throw new ApiError(409, "改写稿没有通过复审，请修改后再提交", { message: "改写稿没有通过复审，请修改后再提交" });
    finalText = review.rewrite.text || review.source_text || null;
  } else if (body.decision === "revise") {
    if (!body.final_text?.trim()) throw new ApiError(422, "请提供修改后的脚本");
    const check = await findRecheck(review, body.final_text);
    if (!check.passed) {
      const detail = {
        message: "修改稿复检仍有问题，请继续修改",
        findings: check.findings.filter((f) => BLOCKING.includes(f.severity)).map((f) => ({ quote: f.quote, category_label: f.category_label })),
        missing_disclosures: check.disclosures.filter((d) => !d.present).map((d) => d.id),
      };
      throw new ApiError(409, detail.message, detail);
    }
    finalText = check.text;
    version = "edited";
    review.final_check = { counts: check.counts, risk_level: check.risk_level, passed: check.passed, engine: check.engine };
  } else {
    throw new ApiError(422, "未知的终审决定");
  }
  const at = now();
  review.status = body.decision === "reject" ? "rejected" : "approved";
  review.final_text = finalText;
  review.decision = body.decision as Review["decision"];
  review.decision_version = version;
  review.decision_note = note;
  review.decided_by = brief(user);
  review.decided_at = at;
  const started = Math.max(0, new Date(at).getTime() - new Date(review.created_at).getTime());
  review.agents = [...(review.agents ?? []), { agent: "human_review", name: "人工终审", status: review.status === "approved" ? "ok" : "rejected", started_ms: started, latency_ms: 0 }];
}

function runReview(all: Map<number, Review>, row: { review: { id: number } }) {
  const review = all.get(row.review.id);
  return review ? { id: review.id, title: review.title, status: review.status } : row.review;
}

/** A recorded trace, pointed at the in-memory review it belongs to, with the sign-off made here appended. */
async function runDetail(runId: string) {
  const computed = browserRuns.get(runId);
  if (computed) {
    const review = [...(await store()).values()].find((r) => r.run_id === runId);
    const out = clone(computed) as { review: unknown; spans: Record<string, unknown>[] };
    if (review) {
      out.review = { id: review.id, title: review.title, status: review.status };
      if (review.decision) {
        out.spans.push({ id: out.spans.length + 1, seq: out.spans.length + 1, agent: "human_review", name: "人工终审（模拟）", status: review.status === "approved" ? "ok" : "rejected",
          input: { reviewer: review.decided_by?.name, open_findings: (review.findings ?? []).filter((f) => !f.verdict).map((f) => f.key) },
          output: { decision: review.decision, version: review.decision_version, note: review.decision_note },
          started_ms: Math.max(0, new Date(review.decided_at ?? review.created_at).getTime() - new Date(review.created_at).getTime()), latency_ms: 0, model: null, prompt_tokens: 0, completion_tokens: 0 });
      }
    }
    return out;
  }
  const detail = clone(await load<{ id: string; review: { id: number; title: string; status: string } | null; spans: Record<string, unknown>[] }>(
    `api/runs/${recordedRunOf.get(runId) ?? runId}.json`,
  ));
  const review = [...(await store()).values()].find((r) => r.run_id === runId);
  if (!review) return detail;
  detail.id = runId;
  detail.review = { id: review.id, title: review.title, status: review.status };
  const human = review.agents?.find((a) => a.agent === "human_review");
  if (human && !detail.spans.some((s) => s.agent === "human_review")) {
    detail.spans.push({
      id: detail.spans.length + 1, seq: detail.spans.length + 1, agent: "human_review", name: "人工终审", status: human.status,
      input: { reviewer: review.decided_by?.name, open_findings: (review.findings ?? []).filter((f) => !f.verdict).map((f) => f.key) },
      output: { decision: review.decision, version: review.decision_version, note: review.decision_note },
      started_ms: human.started_ms, latency_ms: 0, model: null, prompt_tokens: 0, completion_tokens: 0,
    });
  }
  return detail;
}

// ---------------------------------------------------------------- API surface used by api.ts
// mirrors file_for() in scripts/record_demo.py
const fileFor = (path: string) => `${path.replace(/^\//, "").replace("?", "@")}.json`;

export async function demoGet<T>(path: string): Promise<T> {
  if (path === "/api/auth/demo-accounts") {
    const { users } = await load<DemoIndex>("index.json");
    return { password: null, accounts: users.map(({ email, name, role, title }) => ({ email, name, role, title })) } as T;
  }
  const user = await viewer();
  if (path === "/api/auth/me") return user as T;
  const [route, query = ""] = path.split("?");
  if (route === "/api/reviews") {
    const params = new URLSearchParams(query);
    const all = [...(await store()).values()].sort((a, b) => b.id - a.id);
    const status = params.get("status");
    const status_counts: Record<string, number> = {};
    for (const r of all) status_counts[r.status] = (status_counts[r.status] ?? 0) + 1;
    const items = all.filter((r) => !status || r.status === status).slice(0, Number(params.get("limit") ?? 100));
    return { items: items.map((r) => serialize(r, user)), status_counts } as T;
  }
  const one = route.match(/^\/api\/reviews\/(\d+)$/);
  if (one) return serialize(await getReview(Number(one[1])), user) as T;
  if (route === "/api/runs") {
    const rows = [...createdRuns, ...(await load<{ id: string; review: { id: number; status: string } | null }[]>("api/runs@limit=200.json"))];
    const all = await store();
    return rows.map((row) => (row as { review: { id: number } | null }).review ? { ...(row as object), review: runReview(all, row as { review: { id: number } }) } : row) as T;
  }
  const run = route.match(/^\/api\/runs\/([\w-]+)$/);
  if (run) return (await runDetail(run[1])) as T;
  return load<T>(fileFor(path));
}

export async function demoPost<T>(path: string, body?: unknown): Promise<T> {
  const data = (body ?? {}) as Record<string, unknown>;
  if (path === "/api/auth/login") {
    const user = (await load<DemoIndex>("index.json")).users.find((u) => u.email === String(data.email ?? "").trim().toLowerCase());
    if (!user) throw new ApiError(401, "静态演示只提供页面上列出的演示账号");
    return { token: TOKEN_PREFIX + user.email, user } as T;
  }
  const user = await viewer();
  if (path === "/api/reviews") return (await createReview(data, user)) as T;
  const verdict = path.match(/^\/api\/reviews\/(\d+)\/findings\/([\w-]+)\/verdict$/);
  if (verdict) {
    const review = await getReview(Number(verdict[1]));
    setVerdict(review, verdict[2], data, user);
    return serialize(review, user) as T;
  }
  const recheck = path.match(/^\/api\/reviews\/(\d+)\/recheck$/);
  if (recheck) {
    requireDecider(user);
    const review = await getReview(Number(recheck[1]));
    if (review.status !== "pending") throw new ApiError(409, "该脚本不在待终审状态");
    return (await findRecheck(review, String(data.text ?? ""))) as T;
  }
  const decision = path.match(/^\/api\/reviews\/(\d+)\/decision$/);
  if (decision) {
    const review = await getReview(Number(decision[1]));
    await decide(review, data, user);
    return serialize(review, user) as T;
  }
  if (path === "/api/rules/validate") {
    const recorded = await load<{ yaml: string; result: T }>("rules-validate.json");
    if (data.yaml === recorded.yaml) return recorded.result;
    throw new ApiError(422, "静态演示只能校验未修改的规则库；修改后的校验需要完整服务（按 README 在本地运行）。");
  }
  if (path === "/api/rules/test") {
    // api/rules.py test_rules(), on the browser engine's copy of the same rule library
    const category = String(data.product_category ?? "");
    if (!(category in pack.product_categories)) throw new ApiError(422, "未知的商品类目");
    const text = String(data.text ?? "");
    return {
      hits: scan(text, category).map((h) => ({ rule_id: h.rule_id, rule_ids: h.rule_ids, rule_name: h.rule_name, category: h.category,
        category_label: CATEGORIES.get(h.category)!.label, severity: h.severity, start: h.start, end: h.end, quote: h.quote })),
      disclosures: checkDisclosures(text, category),
      engine: BROWSER_ENGINE,
    } as T;
  }
  if (path === "/api/evals/runs") {
    throw new ApiError(409, "静态演示不能重新运行评测。完整服务里管理员可以在这里触发；CI 每次提交都会运行同一套评测。");
  }
  throw new ApiError(405, "静态演示不支持这个操作，完整功能请按 README 在本地运行。");
}

export async function demoPut<T>(path: string): Promise<T> {
  await viewer();
  if (path === "/api/rules/yaml") throw new ApiError(409, "静态演示不能保存规则库。完整服务里管理员保存前会自动校验并跑回归。");
  throw new ApiError(405, "静态演示不支持这个操作，完整功能请按 README 在本地运行。");
}
