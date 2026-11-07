/* The static demo's sign-off (模拟) must apply backend/app/review_service.py's rules to reviews the
 * browser engine computed: four-eyes, who may judge, when the original or the rewrite may be
 * approved, and that an edited script is re-checked before approval. */
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { buildBrowserReview, CUSTOM_PRODUCTS, decide, permissions, setVerdict } from "../src/demo";
import type { Review, User } from "../src/types";

const leon: User = { id: 1, email: "leon@adproof.demo", name: "Leon", title: "合规负责人", role: "admin" };
const mia: User = { id: 2, email: "mia@adproof.demo", name: "Mia", title: "审核员", role: "reviewer" };
const emma: User = { id: 3, email: "emma@adproof.demo", name: "Emma", title: "内容运营", role: "operator" };
const healthFood = CUSTOM_PRODUCTS.find((p) => p.category === "health_food")!;
const cosmetics = CUSTOM_PRODUCTS.find((p) => p.category === "cosmetics")!;

function submit(text: string, by: User = emma, product = cosmetics): Review {
  return buildBrowserReview(100, product, { input_type: "text", content: text, inject_hallucination: false }, by).review;
}

async function rejects(p: Promise<unknown> | (() => unknown), status: number) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    return e as ApiError;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe("模拟 sign-off follows review_service.py", () => {
  it("is labelled as the browser engine and never as compliant", () => {
    const r = submit("这款精华质地清爽，适合日常使用。");
    expect(r.engine?.kind).toBe("browser");
    expect(r.scope?.state).toBe("no_hit");
    expect(r.scope?.verdict).toContain("不等于合规");
  });

  it("permissions: operators cannot judge; the submitter cannot sign off their own script", () => {
    const r = submit("这是全网最好用的精华。");
    expect(permissions(r, emma)).toEqual({ can_verdict: false, can_decide: false, reason: "只有审核员和管理员可以终审" });
    expect(permissions(r, mia)).toEqual({ can_verdict: true, can_decide: true, reason: "" });
    const own = submit("这是全网最好用的精华。", mia);
    expect(permissions(own, mia)).toEqual({ can_verdict: true, can_decide: false, reason: "提交人不能终审自己的脚本（四眼原则）" });
  });

  it("four-eyes and role checks on the decision itself", async () => {
    await rejects(decide(submit("这是全网最好用的精华。", mia), { decision: "approve", version: "rewrite", note: "" }, mia), 403);
    await rejects(decide(submit("这是全网最好用的精华。"), { decision: "approve", version: "rewrite", note: "" }, emma), 403);
  });

  it("the original is approved only when every blocking finding is a reviewer's false positive", async () => {
    const r = submit("这是全网最好用的精华，98%的姐妹都回购了。");
    const blocking = r.findings!.filter((f) => f.severity !== "low");
    expect(blocking.length).toBe(2);
    const err = await rejects(decide(r, { decision: "approve", version: "original", note: "" }, mia), 409);
    expect((err.detail as { findings: string[] }).findings).toEqual(blocking.map((f) => f.key));
    await rejects(() => setVerdict(r, blocking[0].key, { verdict: "false_positive", note: "" }, mia), 422);
    await rejects(() => setVerdict(r, blocking[0].key, { verdict: "false_positive", note: "有依据" }, emma), 403);
    setVerdict(r, blocking[0].key, { verdict: "false_positive", note: "有依据" }, mia);
    await rejects(decide(r, { decision: "approve", version: "original", note: "" }, mia), 409);
    setVerdict(r, blocking[1].key, { verdict: "false_positive", note: "有出处" }, mia);
    await decide(r, { decision: "approve", version: "original", note: "" }, mia);
    expect([r.status, r.decision_version, r.final_text]).toEqual(["approved", "original", r.source_text]);
    await rejects(() => setVerdict(r, blocking[0].key, { verdict: null, note: "" }, mia), 409);
    await rejects(decide(r, { decision: "reject", note: "再看看" }, mia), 409);
  });

  it("a missing required statement blocks approving the original", async () => {
    const r = submit("维生素C咀嚼片，每日1片。", emma, healthFood);
    expect(r.findings).toEqual([]);
    const err = await rejects(decide(r, { decision: "approve", version: "original", note: "" }, mia), 409);
    expect((err.detail as { missing_disclosures: string[] }).missing_disclosures).toEqual(["DSC-01"]);
  });

  it("the rewrite is approved only when it passed re-review; rejection needs a reason", async () => {
    const r = submit("家人们，这个精华是国货天花板，用了以后湿疹都好了！");
    expect(r.rewrite?.passed).toBe(true);
    await rejects(decide(r, { decision: "reject", note: " " }, leon), 422);
    await decide(r, { decision: "approve", version: "rewrite", note: "" }, leon);
    expect([r.status, r.final_text]).toEqual(["approved", r.rewrite!.text]);
    const failed = submit("家人们冲！");
    failed.rewrite = { ...failed.rewrite, passed: false };
    await rejects(decide(failed, { decision: "approve", version: "rewrite", note: "" }, mia), 409);
    await decide(failed, { decision: "reject", note: "口播不完整" }, mia);
    expect([failed.status, failed.final_text]).toEqual(["rejected", null]);
  });

  it("an edited script is re-checked in the tab before it can be approved", async () => {
    const r = submit("这是全网最好用的精华。");
    await rejects(decide(r, { decision: "revise", final_text: "这是全网最好用的精华，真的最好用。", note: "" }, mia), 409);
    await rejects(decide(r, { decision: "revise", final_text: "  ", note: "" }, mia), 422);
    await decide(r, { decision: "revise", final_text: "这款精华质地清爽，适合日常使用。", note: "人工改写" }, mia);
    expect([r.status, r.decision_version, r.final_text]).toEqual(["approved", "edited", "这款精华质地清爽，适合日常使用。"]);
  });
});
