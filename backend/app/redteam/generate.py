"""Generator: new evasive wordings per violation category, plus clean near-misses (round.json).

Each round picks, with the round's seed, two products per category and asks the model for `per_product` violating
wordings and `near_misses` compliant look-alikes for each. Seed wordings (the workflow's `seeds` input) join the round
as their own items and are shown to the generator as style examples for their category.

The model writes text only. Its intended label is checked on a fixed sample by another model family (audit.py); whether
the reviewer catches a wording is decided by the engine (frontend/scripts/redteam-score.ts).
"""

from __future__ import annotations

import datetime as dt
import random
from typing import Any

from .common import (
    OBVIOUS, SCOPE, SHORT, TARGETS, LlamaServer, clean_wording, dedupe_key, load_policy, load_products,
)

SYSTEM = (
    "你在为一家电商平台的广告合规团队做红队测试：写出带货主播在直播间或短视频里真的会说的话，用来检验审查系统能不能发现违规。"
    "所有商品、品牌和人物都是虚构的。不要提到真实的品牌、机构、医院、学校或人物。只按要求输出 JSON。"
)

TACTICS = "口语化的说法、暗示、比喻、借顾客或家人之口、谐音或拼音缩写、口语里的数字（“九成”“小半年”）、把一个宣称拆到两个分句里"


def build_prompt(category: str, policy: dict, product: dict, per_product: int, near_misses: int,
                 examples: list[str]) -> str:
    c = policy["categories"][category]
    pc_label = policy["product_categories"].get(product["category"], product["category"])
    scope = f"\n适用范围：{SCOPE[category]}" if category in SCOPE else ""
    style = ""
    if examples:
        style = "\n参考这些说法的风格（不要照抄）：\n" + "\n".join(f"- {e}" for e in examples[:5])
    return (
        f"违规分类：「{c['label']}」——{c['description']}{scope}\n"
        f"商品：{product['name']}（{pc_label}），{product.get('description', '')}\n\n"
        f"1. 写 {per_product} 句明确属于「{c['label']}」的违规话术。不要用最直白的词（例如：{OBVIOUS[category]}），"
        f"每句换一种手法，例如：{TACTICS}。每句都必须让合规审核员一看就认定属于这一类违规，不能有争议。\n"
        f"2. 再写 {near_misses} 句看起来像这一类、但其实合规的话（例如用法建议、注明出处的数据、否定句、序数词、可核实的事实）。\n"
        f"每句 10 到 45 个字，像主播口播，不要编号，不要解释。{style}"
    )


def schema(per_product: int, near_misses: int) -> dict:
    s = {"type": "string", "minLength": 6, "maxLength": 60}
    return {
        "type": "object",
        "properties": {
            "violations": {"type": "array", "items": s, "minItems": per_product, "maxItems": per_product},
            "near_misses": {"type": "array", "items": s, "minItems": near_misses, "maxItems": near_misses},
        },
        "required": ["violations", "near_misses"],
    }


def pick_products(rng: random.Random, products: list[dict], category: str, k: int = 2) -> list[dict]:
    """k products for a category, from different product categories when there are enough."""
    allowed = TARGETS[category]
    pool = [p for p in products if p["category"] in allowed]
    rng.shuffle(pool)
    chosen: list[dict] = []
    for p in pool:  # first pass: one per product category
        if len(chosen) < k and p["category"] not in {c["category"] for c in chosen}:
            chosen.append(p)
    for p in pool:
        if len(chosen) < k and p not in chosen:
            chosen.append(p)
    return chosen


def parse_seeds(raw: Any, policy: dict) -> list[dict]:
    """The workflow's `seeds` input: a JSON list of {category, text, kind?, product_category?}."""
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list):
        raise ValueError("seeds 必须是 JSON 列表")
    if len(raw) > 50:
        raise ValueError("seeds 最多 50 条")
    out = []
    for i, s in enumerate(raw, 1):
        if not isinstance(s, dict):
            raise ValueError(f"seeds[{i}] 必须是对象")
        category = s.get("category")
        if category not in TARGETS:
            raise ValueError(f"seeds[{i}] 的 category 必须是 {', '.join(TARGETS)} 之一")
        kind = s.get("kind", "violation")
        if kind not in ("violation", "near_miss"):
            raise ValueError(f"seeds[{i}] 的 kind 必须是 violation 或 near_miss")
        text = clean_wording(s.get("text"))
        if text is None:
            raise ValueError(f"seeds[{i}] 的 text 需要 4–80 个字、至少 4 个汉字")
        pc = s.get("product_category") or TARGETS[category][0]
        if pc not in policy["product_categories"]:
            raise ValueError(f"seeds[{i}] 的 product_category 未知：{pc}")
        out.append({"category": category, "kind": kind, "text": text, "product_category": pc})
    return out


def generate_round(server: LlamaServer, *, round_id: str, seed: int, per_product: int, near_misses: int,
                   categories: list[str] | None = None, seeds: list[dict] | None = None,
                   generator: dict | None = None) -> dict:
    policy = load_policy()
    products = load_products()
    rng = random.Random(f"adproof-redteam-{round_id}-{seed}")
    seeds = seeds or []
    items: list[dict] = []
    seen: set[str] = set()
    dropped: list[dict] = []

    def add(item: dict) -> None:
        key = dedupe_key(item["text"])
        if key in seen:
            dropped.append({"text": item["text"], "why": "duplicate"})
            return
        seen.add(key)
        items.append(item)

    for i, s in enumerate(seeds, 1):
        add({"id": f"{round_id}-seed-{i:02d}", "source": "seed", "sku": None, **s})

    calls = 0
    for category in categories or list(TARGETS):
        examples = [s["text"] for s in seeds if s["category"] == category and s["kind"] == "violation"]
        nv = nn = 0
        for product in pick_products(rng, products, category):
            prompt = build_prompt(category, policy, product, per_product, near_misses, examples)
            calls += 1
            out = server.chat(SYSTEM, prompt, schema(per_product, near_misses), temperature=0.9, seed=seed * 1000 + calls,
                              max_tokens=120 + 60 * (per_product + near_misses))
            for kind, texts in (("violation", out.get("violations", [])), ("near_miss", out.get("near_misses", []))):
                for raw in texts:
                    text = clean_wording(raw)
                    if text is None:
                        dropped.append({"text": str(raw)[:80], "why": "not usable copy"})
                        continue
                    if kind == "violation":
                        nv += 1
                        item_id = f"{round_id}-{SHORT[category]}-v{nv}"
                    else:
                        nn += 1
                        item_id = f"{round_id}-{SHORT[category]}-n{nn}"
                    add({"id": item_id, "source": "generated", "category": category, "kind": kind, "text": text,
                         "product_category": product["category"], "sku": product["sku"]})
    return {
        "round": round_id,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "seed": seed,
        "per_product": per_product,
        "near_misses": near_misses,
        "categories": categories or list(TARGETS),
        "generator": generator or {},
        "throughput": server.throughput(),
        "items": items,
        "dropped": dropped,
    }
