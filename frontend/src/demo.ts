/* Static demo (`vite build --mode demo`, served by GitHub Pages).
 *
 * There is no backend. Reads come from responses recorded by scripts/record_demo.py, which ran
 * the real API with the offline mock model on the SYNTHETIC demo data. Submitting from the
 * workbench returns the recorded review for that exact input. Verdicts and sign-offs change
 * this tab's memory only, under the same rules as backend/app/review_service.py (four-eyes,
 * blocking findings, re-check before an edited approval); a reload restores the recording. */
import { ApiError, getToken } from "./api";
import type { Recheck, Review, Severity, User, UserBrief } from "./types";

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
  input_type: "text" | "srt";
  content: string;
  style: string;
  tone: string;
  inject_hallucination: boolean;
}

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

function store(): Promise<Map<number, Review>> {
  reviews ??= load<Review[]>("reviews.json").then((list) => new Map(list.map((r) => [r.id, clone(r)])));
  return reviews;
}

/** review_service.permissions() */
function permissions(review: Review, user: User): NonNullable<Review["permissions"]> {
  const decider = user.role === "admin" || user.role === "reviewer";
  const own = review.created_by.id === user.id;
  const open = review.status === "pending";
  let reason = "";
  if (!decider) reason = "只有审核员和管理员可以终审";
  else if (own) reason = "提交人不能终审自己的脚本（四眼原则）";
  else if (!open) reason = review.decision ? "该脚本已完成终审" : "流水线尚未完成";
  return { can_verdict: decider && open, can_decide: decider && open && !own, reason };
}

const serialize = (review: Review, user: User): Review => ({ ...clone(review), permissions: permissions(review, user) });

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
  const products = await load<{ id: number; sku: string }[]>("api/products.json");
  const product = products.find((p) => p.id === body.product_id);
  if (!product) throw new ApiError(404, "商品不存在");
  const inject = Boolean(body.inject_hallucination);
  if (inject && user.role === "operator") throw new ApiError(403, "演示开关仅对审核员和管理员开放");
  const request = { sku: product.sku, mode: body.mode, input_type: body.input_type, content: String(body.content ?? ""),
    style: body.style, tone: body.tone, inject_hallucination: inject } as WorkbenchRequest;
  const recorded = await load<{ request: WorkbenchRequest; review: Review; run_row: Record<string, unknown> | null }>(
    `templates/${templateName(request)}.json`, "静态演示没有录制这组选项。完整功能请按 README 在本地运行。",
  );
  const sameText = (a: string) => a.replace(/\r\n/g, "\n").trim();
  if (request.mode === "review" && (request.input_type !== recorded.request.input_type || sameText(request.content) !== sameText(recorded.request.content))) {
    throw new ApiError(422, "静态演示只能审查录制好的示例脚本：点“填入示例”后再提交。审查自己的脚本请按 README 在本地运行完整服务。");
  }
  const all = await store();
  const review: Review = { ...clone(recorded.review), id: Math.max(0, ...all.keys()) + 1, created_by: brief(user), created_at: now() };
  all.set(review.id, review);
  if (recorded.run_row) createdRuns.unshift({ ...recorded.run_row, created_at: review.created_at, review: { id: review.id, title: review.title, status: review.status } });
  return serialize(review, user);
}

/** review_service.set_verdict() */
function setVerdict(review: Review, key: string, body: { verdict?: string | null; note?: string }, user: User): void {
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

async function findRecheck(review: Review, text: string): Promise<Recheck> {
  const rechecks = await load<{ sku: string; text: string; result: Recheck }[]>("rechecks.json");
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new ApiError(422, "脚本内容为空");
  const hit = rechecks.find((r) => r.sku === review.product.sku && r.text === normalized);
  if (!hit) throw new ApiError(422, "静态演示只录制了未改动改写稿的复检。改动后的文本需要完整服务复检（按 README 在本地运行）。");
  return clone(hit.result);
}

/** review_service.decide() */
async function decide(review: Review, body: { decision?: string; version?: string | null; final_text?: string | null; note?: string }, user: User): Promise<void> {
  requireDecider(user);
  if (body.decision === "approve" && !body.version) throw new ApiError(422, "请选择通过原稿还是改写稿");
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
    if (!review.rewrite?.passed) throw new ApiError(409, "改写稿没有通过复审，请修改后再提交", { message: "改写稿没有通过复审，请修改后再提交" });
    finalText = review.rewrite.text || review.source_text || null;
  } else if (body.decision === "revise") {
    if (!body.final_text?.trim()) throw new ApiError(422, "请提供修改后的脚本");
    const check = await findRecheck(review, body.final_text);
    if (!check.passed) throw new ApiError(409, "修改稿复检仍有问题，请继续修改");
    finalText = check.text;
    version = "edited";
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
  if (route === "/api/runs") return [...createdRuns, ...(await load<unknown[]>("api/runs@limit=200.json"))] as T;
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
    const runs = await load<{ text: string; product_category: string; result: T }[]>("rules-test.json");
    const hit = runs.find((r) => r.text === String(data.text ?? "").trim() && r.product_category === data.product_category);
    if (hit) return hit.result;
    throw new ApiError(422, "静态演示只录制了默认示例文本的试运行；改动后的文本需要完整服务（按 README 在本地运行）。");
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
