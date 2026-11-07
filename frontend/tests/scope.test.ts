/* Default-deny: no review is presented as compliant because no rule fired, unknown input is
 * answered honestly, and claims the rules do not cover are listed for a human. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/engine/pipeline";
import { scopeOf } from "../src/engine/scope";

const NEVER = /审查通过|已合规|符合规定|合规，可|可以发布|无风险/;
const scopeFor = (text: string, category = "cosmetics", facts: { key: string; value: string }[] = []) => {
  const out = run({ product: { category, facts }, script: text });
  return scopeOf(text, { category, facts }, { findings: out.findings, missing: out.disclosures.filter((d) => !d.present).length });
};

describe("scope statement", () => {
  it("a script with no rule hit says so, and says it is not a compliance verdict", () => {
    const s = scopeFor("这款精华质地清爽，适合日常使用。");
    expect(s.state).toBe("no_hit");
    expect(s.verdict).toContain("不等于合规");
    expect(s.verdict).not.toMatch(NEVER);
    expect(s.checked.find((c) => c.label === "商品资料核对")!.detail).toContain("未执行");
    expect(s.not_checked.length).toBeGreaterThanOrEqual(5);
  });

  it("every look-alike coverage case gets the same honest wording", () => {
    const { cases } = JSON.parse(readFileSync(new URL("./coverage.json", import.meta.url), "utf-8")) as { cases: { text: string; category?: string; expect: unknown }[] };
    for (const c of cases.filter((x) => !x.expect && x.category)) {
      const s = scopeFor(c.text, c.category);
      expect(s.state, c.text).toBe("no_hit");
      expect(s.verdict).not.toMatch(NEVER);
    }
  });

  it("text the rules cannot read is not reviewable rather than clean", () => {
    const s = scopeFor("This serum is the best in the world, guaranteed results in 3 days.");
    expect(s.state).toBe("not_reviewable");
    expect(s.verdict).toMatch(/^未能有效审查/);
    expect(scopeFor("12345 678").state).toBe("not_reviewable");
    expect(scopeFor("好").input_notes.join()).toContain("只有 1 个字");
  });

  it("claims outside the rule library are listed with their clause, not as findings", () => {
    const s = scopeFor("原价199，今天只要99！买二送一，库存不多。明星同款，有检测报告。");
    expect(s.signals.map((x) => x.topic)).toEqual(["价格与促销", "赠品", "价格与促销", "代言与证言", "检测、认证与荣誉"]);
    for (const x of s.signals) expect(x.sentence.slice(x.at[0], x.at[1])).toBe(x.quote);
    expect(s.verdict).toContain("超出规则库范围");
  });

  it("a flagged script reports counts and the missing statement", () => {
    const s = scopeFor("维生素C咀嚼片，保证三天见效。", "health_food");
    expect(s.state).toBe("flagged");
    expect(s.verdict).toMatch(/发现 1 处问题、缺少 1 项必要声明/);
  });
});
