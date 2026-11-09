"""Model audit of generated labels (audit.json). No human audits these labels, and this is not a human review.

A model of a third family (the generator is GLM, the blind set was written by Claude, the auditor is Qwen) reads the
category policy and labels:

- a fixed random sample of the round (the same ids for the same round, whatever the engine did): the share of sampled
  items whose intended label it disputes is reported as the round's label-noise rate, as a model audit;
- every miss and every flagged near-miss, for triage only. Triage labels feed the author's decisions; they are not
  gold and are not part of the noise rate.
"""

from __future__ import annotations

import hashlib
import random

from .common import TARGETS, LlamaServer, load_policy, policy_text

SYSTEM = (
    "你是电商广告合规审核员。下面是本平台的违规分类口径。判断一句直播带货话术违反了哪些分类；只依据口径，"
    "说法含糊、需要更多事实才能判断的，不算违规。只按要求输出 JSON。\n\n分类口径：\n{policy}"
)

USER = "商品类目：{pc}\n话术：{text}\n\n这句话违反了哪些分类？没有违规就返回空列表。"


def schema(categories: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "violates": {"type": "array", "items": {"type": "string", "enum": categories}, "maxItems": 3},
            "reason": {"type": "string", "maxLength": 50},
        },
        "required": ["violates", "reason"],
    }


def sample_ids(round_id: str, ids: list[str], k: int) -> list[str]:
    """Fixed random sample: depends on the round id and the item ids only."""
    pool = sorted(ids)
    return sorted(random.Random(f"adproof-redteam-audit-{round_id}").sample(pool, min(k, len(pool))))


def verdict(item: dict, violates: list[str]) -> str:
    """agree / other (a violation, but of another category) / none (not a violation) for violations;
    agree / disagree for near-misses."""
    if item["kind"] == "near_miss":
        return "agree" if not violates else "disagree"
    if item["category"] in violates:
        return "agree"
    return "other" if violates else "none"


def noise(audited: dict[str, dict], sample: list[str]) -> dict:
    rows = [audited[i] for i in sample if i in audited]
    disputed = [r for r in rows if r["verdict"] != "agree"]
    by_kind = {}
    for kind in ("violation", "near_miss"):
        k_rows = [r for r in rows if r["kind"] == kind]
        by_kind[kind] = {"sampled": len(k_rows), "disputed": sum(1 for r in k_rows if r["verdict"] != "agree")}
    return {
        "sampled": len(rows),
        "disputed": len(disputed),
        "rate": round(len(disputed) / len(rows), 4) if rows else None,
        "by_kind": by_kind,
        "by_verdict": {v: sum(1 for r in rows if r["verdict"] == v) for v in ("agree", "other", "none", "disagree")},
    }


def audit_round(server: LlamaServer, round_data: dict, scores: dict, *, sample: int, auditor: dict | None = None) -> dict:
    policy = load_policy()
    categories = list(TARGETS)
    system = SYSTEM.format(policy=policy_text(policy, categories))
    items = {i["id"]: i for i in round_data["items"]}
    sampled = sample_ids(round_data["round"], list(items), sample)
    triage = []
    for item_id, s in scores["items"].items():
        item = items.get(item_id)
        if item is None:
            continue
        if (item["kind"] == "violation" and not s["caught"]) or (item["kind"] == "near_miss" and s["flagged"]):
            triage.append(item_id)
    todo = sorted(set(sampled) | set(triage))
    audited: dict[str, dict] = {}
    for item_id in todo:
        item = items[item_id]
        pc = policy["product_categories"].get(item["product_category"], item["product_category"])
        # the request for an item depends on the item only (not on which other items the engine missed)
        seed = int(hashlib.sha256(item_id.encode()).hexdigest()[:8], 16)
        out = server.chat(system, USER.format(pc=pc, text=item["text"]), schema(categories), temperature=0.0,
                          seed=seed, max_tokens=120)
        violates = [c for c in out.get("violates", []) if c in categories]
        audited[item_id] = {
            "kind": item["kind"], "category": item["category"], "violates": violates,
            "verdict": verdict(item, violates), "reason": str(out.get("reason", ""))[:50],
            "sampled": item_id in sampled, "triage": item_id in triage,
        }
    return {
        "round": round_data["round"],
        "auditor": auditor or {},
        "sample_size": sample,
        "sample": sampled,
        "noise": noise(audited, sampled),
        "items": audited,
        "throughput": server.throughput(),
        "note": "模型审计：由另一家族的模型按分类口径标注，不是人工复核。抽样不看引擎结果；漏检与误报另行送审，只用于分诊，不计入噪声率。",
    }
