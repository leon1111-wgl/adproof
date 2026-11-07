/* Regression cases from this iteration's own probe (fresh scripts run through the real path and
 * read by hand after the blind run). Written with knowledge of the rules: not a measurement. */
import { describe, expect, it } from "vitest";
import { run } from "../src/engine/pipeline";
import { scopeOf } from "../src/engine/scope";

const review = (category: string, text: string) => {
  const out = run({ product: { category, facts: [] }, script: text });
  const scope = scopeOf(text, { category, facts: [] }, { findings: out.findings, missing: out.disclosures.filter((d) => !d.present).length });
  return { out, scope, flags: out.findings.map((f) => `${f.category}:${f.quote}`) };
};

describe("probe regressions", () => {
  it("advice with 最好 is not an absolute term", () => {
    expect(review("cosmetics", "我建议大家看SPF和PA值，最好每两小时补涂一次。").flags).toEqual([]);
    expect(review("cosmetics", "这是市面上最好的精华。").flags).toEqual(["absolute_terms:市面上最好"]);
  });

  it("a payback claim gets the franchise rule and a readable rewrite", () => {
    const { out, flags } = review("franchise", "奶茶店加盟，总部全程扶持，很多加盟商半年就回本了。投资有风险。");
    expect(flags).toEqual(["guaranteed_returns:半年就回本了"]);
    expect(out.findings[0].rule_id).toBe("RET-01");
    expect(out.rewrite?.passed).toBe(true);
    expect(out.rewrite?.text).toBe("奶茶店加盟，总部全程扶持，很多加盟商收益受选址和经营情况影响，存在亏损风险。投资有风险。");
  });

  it("disease prevention and doctors' endorsement in health food and food", () => {
    expect(review("health_food", "这款鱼油能软化血管，预防心脑血管疾病。本品不能代替药物。").flags).toEqual(["medical_claims:软化血管", "medical_claims:预防心脑血管疾病"]);
    expect(review("food", "家人们，医生都推荐我吃。").flags).toEqual(["medical_claims:医生都推荐"]);
    expect(review("home", "睡一晚就能改善失眠。").flags).toEqual(["medical_claims:改善失眠"]);
  });

  it("an off-topic text is answered with what was and was not checked", () => {
    const { scope, flags } = review("general", "今天天气不错，我们来聊聊周末去哪里玩。");
    expect(flags).toEqual([]);
    expect(scope.verdict).toContain("不等于合规");
  });

  it("comparisons and gifts are listed for a human, not judged", () => {
    expect(review("digital", "这款扫地机器人比某米的强三倍。").scope.signals.map((s) => s.topic)).toEqual(["比较"]);
    expect(review("cosmetics", "今天下单送小样，冲！").scope.signals.map((s) => s.topic)).toEqual(["赠品"]);
  });
});
