"""Selling-point agent and script-writer agent.

The selling-point agent is evidence-first too: each point must quote the product sheet.
Points whose evidence cannot be found in the sheet are dropped and listed in the trace,
so a model cannot slip an invented ingredient or award into the script upstream.
"""

from __future__ import annotations

from ..llm.base import LLMError, LLMProvider, complete_json, payload_message
from ..textutil import normalize
from . import prompts
from .tracing import Tracer


def product_brief(product: dict) -> dict:
    return {
        "name": product.get("name", ""),
        "brand": product.get("brand", ""),
        "category": product.get("category", "general"),
        "description": product.get("description", ""),
        "facts": product.get("facts", []),
    }


def _corpus(product: dict) -> str:
    parts = [product.get("name", ""), product.get("brand", ""), product.get("description", "")]
    parts += [f"{f.get('key', '')} {f.get('value', '')}" for f in product.get("facts", [])]
    return normalize(" ".join(parts)).text


class SellingPointAgent:
    agent = "selling_points"

    def __init__(self, provider: LLMProvider):
        self.provider = provider

    def run(self, product: dict, tracer: Tracer) -> list[dict]:
        brief = product_brief(product)
        with tracer.span(self.agent, "卖点提炼", {"product": brief}) as span:
            messages = [
                {"role": "system", "content": prompts.SELLING_POINTS},
                {"role": "user", "content": payload_message("请根据下面的商品资料提炼卖点。", {"product": brief})},
            ]
            try:
                data, result = complete_json(self.provider, messages, task="selling_points")
                span.usage(result)
                raw = data.get("selling_points") or []
            except LLMError as exc:
                span.degrade(f"模型调用失败，改用商品资料直接生成：{exc}")
                raw = [{"title": f["key"], "detail": f["value"], "source_field": f"facts.{f['key']}", "evidence": f["value"]}
                       for f in brief["facts"][:5]]
            corpus = _corpus(product)
            grounded, dropped = [], []
            for point in raw if isinstance(raw, list) else []:
                if not isinstance(point, dict):
                    continue
                evidence = str(point.get("evidence", "")).strip()
                item = {
                    "title": str(point.get("title", "")).strip(),
                    "detail": str(point.get("detail", "")).strip(),
                    "source_field": str(point.get("source_field", "")).strip(),
                    "evidence": evidence,
                }
                if evidence and normalize(evidence).text in corpus:
                    grounded.append(item)
                else:
                    dropped.append({**item, "reason": "evidence 在商品资料中找不到"})
            span.set(selling_points=grounded, dropped=dropped)
        return grounded


class ScriptWriterAgent:
    agent = "script_writer"

    def __init__(self, provider: LLMProvider, max_chars: int = 6000):
        self.provider = provider
        self.max_chars = max_chars

    def run(self, product: dict, selling_points: list[dict], style: str, tone: str, tracer: Tracer) -> str:
        payload = {"product": product_brief(product), "selling_points": selling_points, "style": style, "tone": tone}
        with tracer.span(self.agent, "脚本生成", {"style": style, "tone": tone, "selling_points": len(selling_points)}) as span:
            system = prompts.WRITE_SCRIPT_AGGRESSIVE if tone == "aggressive" else prompts.WRITE_SCRIPT
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": payload_message("请根据下面的卖点写脚本。", payload)},
            ]
            data, result = complete_json(self.provider, messages, task="write_script")
            span.usage(result)
            script = str(data.get("script", "")).strip()
            if not script:
                raise LLMError("模型没有返回脚本内容")
            script = script[: self.max_chars]
            span.set(script=script, chars=len(script))
        return script
