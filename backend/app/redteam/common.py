"""Shared pieces of the red-team rounds: the categories in play, which products they are written for, the policy text
both models see, and a minimal client for llama.cpp's OpenAI-compatible server."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import httpx
import yaml

from ..config import BACKEND_DIR

RULES_PATH = BACKEND_DIR / "rules" / "adproof_rules.yaml"
PRODUCTS_PATH = BACKEND_DIR / "seed" / "products.json"
REDTEAM_DIR = BACKEND_DIR / "evals" / "redteam"

# Categories the generator writes for, with the product categories each one is written against. fact_mismatch is left
# out: whether a number contradicts the product sheet is a lookup, not wording, and the blind set covers it.
TARGETS: dict[str, list[str]] = {
    "absolute_terms": ["cosmetics", "food", "digital", "home"],
    "authority_endorsement": ["food", "health_food", "cosmetics", "home"],
    "medical_claims": ["food", "health_food", "cosmetics", "home"],
    "effect_claims": ["cosmetics", "food", "health_food", "digital"],
    "unsourced_data": ["cosmetics", "food", "digital", "home", "education"],
    "disparagement": ["cosmetics", "food", "digital", "home"],
    "guaranteed_returns": ["franchise", "education"],
    "endorsement": ["health_food", "education"],
    "patent_claims": ["home", "digital", "cosmetics"],
}

SHORT = {
    "absolute_terms": "ABS", "authority_endorsement": "AUT", "medical_claims": "MED", "effect_claims": "EFF",
    "unsourced_data": "DAT", "disparagement": "DIS", "guaranteed_returns": "RET", "endorsement": "END",
    "patent_claims": "PAT",
}

# Policy-level scope notes, the same ones the blind-set writer saw (evals/blind_v2_brief.md). No rule patterns.
SCOPE = {
    "guaranteed_returns": "只适用于招商加盟和课程培训。",
    "endorsement": "只适用于保健食品和课程培训；其他类目的专家、医生推荐不在本分类内。",
    "medical_claims": "适用于普通食品、保健食品、美妆、家居、服饰等非医疗商品。",
}

# The most obvious textbook words per category. The generator is asked to avoid them so that a round tests wording a
# keyword list may not have anticipated; these are generic examples, not the rule library's word lists.
OBVIOUS = {
    "absolute_terms": "最好、最佳、第一、顶级、NO.1、天花板",
    "authority_endorsement": "国家指定、政府推荐、特供、国宴",
    "medical_claims": "治疗、治愈、消炎、降血压、降血糖",
    "effect_claims": "保证有效、立竿见影、7天瘦10斤、无效退款",
    "unsourced_data": "98%的用户、研究表明、实验证明",
    "disparagement": "智商税、垃圾、骗人",
    "guaranteed_returns": "稳赚不赔、保本、保证通过、包过",
    "endorsement": "专家推荐、医生推荐、教授推荐",
    "patent_claims": "专利技术、专利配方",
}


def load_policy(rules_path: Path = RULES_PATH) -> dict:
    """Category labels and descriptions from the rule library (its public part; no patterns)."""
    data = yaml.safe_load(rules_path.read_text(encoding="utf-8"))
    return {
        "product_categories": data["product_categories"],
        "categories": {c["id"]: {"label": c["label"], "description": c["description"]} for c in data["categories"]},
    }


def load_products(path: Path = PRODUCTS_PATH) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def policy_text(policy: dict, categories: list[str]) -> str:
    lines = []
    for cid in categories:
        c = policy["categories"][cid]
        scope = f"（{SCOPE[cid]}）" if cid in SCOPE else ""
        lines.append(f"- {cid}「{c['label']}」：{c['description']}{scope}")
    return "\n".join(lines)


ROUND_ID = re.compile(r"^r\d{1,3}$")
CJK = re.compile(r"[一-鿿]")


def clean_wording(text: Any) -> str | None:
    """A generated wording as it will be scored: one line, no wrapping quotes; None if it is not usable copy."""
    if not isinstance(text, str):
        return None
    s = re.sub(r"\s+", " ", text).strip().strip("\"'“”‘’「」『』")
    s = re.sub(r"^(?:\d+[.、)）]\s*|[-*•]\s*)", "", s).strip()
    if not (4 <= len(s) <= 80) or len(CJK.findall(s)) < 4:
        return None
    return s


def dedupe_key(text: str) -> str:
    return re.sub(r"[\s，。！？、,.!?~～…：:；;\"'“”]", "", text).lower()


class LlamaServer:
    """llama.cpp's server (`llama-server --jinja`) through its OpenAI-compatible chat endpoint. Output is constrained by a
    JSON schema (the server turns it into a grammar), so a reply is always parseable."""

    def __init__(self, url: str, *, timeout: float = 900.0, transport: httpx.BaseTransport | None = None):
        self.url = url.rstrip("/")
        self.client = httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0), transport=transport)
        self.calls: list[dict] = []

    def chat(self, system: str, user: str, schema: dict, *, temperature: float, seed: int, max_tokens: int) -> dict:
        body = {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": temperature, "top_p": 0.95, "seed": seed, "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": "out", "schema": schema}},
        }
        started = time.perf_counter()
        r = self.client.post(f"{self.url}/v1/chat/completions", json=body)
        r.raise_for_status()
        data = r.json()
        wall = time.perf_counter() - started
        timings = data.get("timings") or {}
        usage = data.get("usage") or {}
        self.calls.append({
            "wall_s": round(wall, 2),
            "prompt_tokens": usage.get("prompt_tokens", timings.get("prompt_n")),
            "completion_tokens": usage.get("completion_tokens", timings.get("predicted_n")),
            "prompt_per_second": timings.get("prompt_per_second"),
            "predicted_per_second": timings.get("predicted_per_second"),
        })
        return json.loads(data["choices"][0]["message"]["content"])

    def throughput(self) -> dict:
        calls = self.calls
        gen = [c["predicted_per_second"] for c in calls if c.get("predicted_per_second")]
        pp = [c["prompt_per_second"] for c in calls if c.get("prompt_per_second")]
        return {
            "calls": len(calls),
            "wall_s": round(sum(c["wall_s"] for c in calls), 1),
            "completion_tokens": sum(c.get("completion_tokens") or 0 for c in calls),
            "prompt_tokens": sum(c.get("prompt_tokens") or 0 for c in calls),
            "generation_tok_s_median": round(sorted(gen)[len(gen) // 2], 2) if gen else None,
            "prompt_tok_s_median": round(sorted(pp)[len(pp) // 2], 2) if pp else None,
        }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
