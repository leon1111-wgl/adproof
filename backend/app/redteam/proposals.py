"""Rule proposals (proposals.md): every miss and every false alarm of a round, as a list the author decides on.

For a miss it lists what a rule for it would cite: the category's references for that product category, resolved
against the local verified snapshot. A reference that does not resolve is shown as 待核对 and a rule must not cite it
("引错条款比不引更糟"). Decisions go into decisions.json; accepted ones become a rule change in a separate commit.
"""

from __future__ import annotations

from ..config import BACKEND_DIR
from ..law import LawLibrary
from ..rules import RuleSet
from .common import RULES_PATH, load_policy


def citations_for(ruleset: RuleSet, laws: LawLibrary, category: str, product_category: str) -> list[str]:
    cat = ruleset.categories[category]
    out = []
    for ref in cat.law_refs + cat.penalty_refs:
        if not ref.applies(product_category):
            continue
        c = laws.resolve(ref.law, ref.article, ref.paragraph, ref.item)
        out.append(c.short_label if c.status == "verified" else f"{c.short_label}（待核对，不能引用）")
    return out


def render(round_data: dict, scores: dict, audit: dict | None) -> str:
    policy = load_policy()
    ruleset = RuleSet.load(RULES_PATH)
    laws = LawLibrary(BACKEND_DIR / "laws")
    items = round_data["items"]
    audited = (audit or {}).get("items", {})
    label = lambda c: policy["categories"][c]["label"]  # noqa: E731
    pc_label = lambda p: policy["product_categories"].get(p, p)  # noqa: E731
    engine = scores["engine"]
    misses = [i for i in items if i["kind"] == "violation" and not scores["items"][i["id"]]["caught"]]
    alarms = [i for i in items if i["kind"] == "near_miss" and scores["items"][i["id"]]["flagged"]]
    caught = sum(1 for i in items if i["kind"] == "violation" and scores["items"][i["id"]]["caught"])
    violations = sum(1 for i in items if i["kind"] == "violation")
    near = sum(1 for i in items if i["kind"] == "near_miss")
    gen = round_data.get("generator", {})

    def audit_note(item_id: str) -> str:
        a = audited.get(item_id)
        if not a:
            return "未送审"
        v = "、".join(label(c) for c in a["violates"]) or "不违规"
        tag = {"agree": "同意标签", "other": "认为是其他分类", "none": "认为不违规", "disagree": "认为违规"}[a["verdict"]]
        return f"{tag}（{v}）"

    lines = [
        f"# 红队回合 {round_data['round']}：规则提案",
        "",
        f"- 生成：{gen.get('label', '—')} · 种子 {round_data['seed']} · {round_data['created_at']}",
        f"- 引擎（修复前）：`{engine['commit'][:7]}` · 规则库 {engine['ruleset_version']}（{engine['ruleset_hash']}）",
        f"- 违规说法 {violations} 条，标出 {caught} 条；近似合规说法 {near} 条，误报 {len(alarms)} 条",
        f"- 模型审计（不是人工复核）：{(audit or {}).get('auditor', {}).get('label', '未运行')}",
        "",
        "每条在 `decisions.json` 里判定 accept / reject 并写明理由（未经人工复核）。采纳的改动只引用下面列出的已核对条款，"
        "规则修改单独提交；之后用 `score --append` 记录哪次提交标出了哪条漏检。",
        "",
        "## 漏检",
        "",
    ]
    by_cat: dict[str, list[dict]] = {}
    for i in misses:
        by_cat.setdefault(i["category"], []).append(i)
    if not misses:
        lines.append("没有漏检。")
    for cat, rows in by_cat.items():
        rule_ids = [r.id for r in ruleset.library.rules if r.category == cat]
        lines += [f"### {label(cat)}（`{cat}`，现有规则 {', '.join(rule_ids) or '无'}）", ""]
        lines += ["| 编号 | 类目 | 说法 | 引擎 | 模型审计（分诊） | 可引用的已核对条款 |", "|---|---|---|---|---|---|"]
        for i in rows:
            s = scores["items"][i["id"]]
            other = "、".join(f"{f['rule_id'] or f['category']}「{f['quote']}」" for f in s["findings"]) or "未标出"
            cites = "、".join(citations_for(ruleset, laws, cat, i["product_category"])) or "无"
            lines.append(f"| {i['id']} | {pc_label(i['product_category'])} | {i['text']} | {other} | {audit_note(i['id'])} | {cites} |")
        lines.append("")
    lines += ["## 误报（近似合规说法被标出）", ""]
    if not alarms:
        lines.append("没有误报。")
    else:
        lines += ["| 编号 | 类目 | 说法 | 标出 | 模型审计（分诊） |", "|---|---|---|---|---|"]
        for i in alarms:
            s = scores["items"][i["id"]]
            hits = "、".join(f"{f['rule_id'] or f['category']}「{f['quote']}」" for f in s["findings"])
            lines.append(f"| {i['id']} | {pc_label(i['product_category'])} | {i['text']} | {hits} | {audit_note(i['id'])} |")
    return "\n".join(lines) + "\n"
