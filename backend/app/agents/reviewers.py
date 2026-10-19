"""The two review channels.

Rule channel: YAML rules + product-fact consistency + required statements. Precise,
explainable, free, and blind to paraphrase.
Model channel: asks a model for quotes of implicit problems. Better recall on paraphrase,
but its quotes are claims, not evidence, until the evidence locator finds them in the
script.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..llm.base import LLMError, LLMProvider, complete_json, payload_message
from ..rules import RuleSet, check_facts
from . import prompts
from .tracing import Tracer
from .writers import product_brief

# Demo switch: a quote that is not in any script. With "inject_hallucination" the model
# channel returns it on purpose and the evidence locator has to reject it.
HALLUCINATED_QUOTE = "国家药监局认证的特效配方"


@dataclass
class Candidate:
    category: str
    start: int
    end: int
    quote: str
    channel: str  # rule | fact | llm
    rule_id: str | None = None
    rule_ids: list[str] = field(default_factory=list)
    rule_name: str | None = None
    severity: str | None = None
    reason: str = ""
    evidence: dict | None = None
    locate_method: str = "exact"

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass
class ChannelResult:
    candidates: list[Candidate] = field(default_factory=list)
    raw: list[dict] = field(default_factory=list)  # model findings before location
    disclosures: list[dict] = field(default_factory=list)
    status: str = "ok"


class RuleReviewer:
    agent = "rule_review"

    def __init__(self, ruleset: RuleSet):
        self.ruleset = ruleset

    def run(self, text: str, product: dict, tracer: Tracer, label: str = "规则审查") -> ChannelResult:
        category = product.get("category", "general")
        with tracer.span(self.agent, label, {
            "chars": len(text), "product_category": category,
            "ruleset": f"{self.ruleset.version} · {self.ruleset.hash}",
        }) as span:
            hits = self.ruleset.scan(text, category)
            facts = check_facts(text, product.get("facts", []))
            disclosures = self.ruleset.check_disclosures(text, category)
            candidates = [
                Candidate(category=h.category, start=h.start, end=h.end, quote=h.quote, channel="rule",
                          rule_id=h.rule_id, rule_ids=list(h.rule_ids), rule_name=h.rule_name,
                          severity=h.severity, reason=h.reason)
                for h in hits
            ]
            for f in facts:
                candidates.append(Candidate(
                    category="fact_mismatch", start=f["start"], end=f["end"], quote=f["quote"], channel="fact",
                    reason=f"脚本写的是“{f['script_value']}”，商品资料「{f['fact_key']}」为“{f['fact_value']}”",
                    evidence={"type": "product_fact", **{k: f[k] for k in (
                        "fact_key", "fact_value", "script_value", "expected_value", "script_number", "expected_number")}},
                ))
            span.set(
                rule_hits=[{"rule": h.rule_id, "quote": h.quote, "span": [h.start, h.end]} for h in hits],
                fact_mismatches=[{"quote": f["quote"], "fact": f["fact_value"]} for f in facts],
                disclosures=[{"id": d["id"], "present": d["present"]} for d in disclosures],
            )
        return ChannelResult(candidates=candidates, disclosures=disclosures)


class ModelReviewer:
    agent = "model_review"

    def __init__(self, provider: LLMProvider, ruleset: RuleSet):
        self.provider = provider
        self.ruleset = ruleset

    def _system_prompt(self) -> str:
        lines = [f"- {c.id}：{c.label}（{c.description}）" for c in self.ruleset.categories.values()
                 if c.id != "fact_mismatch"]
        return prompts.REVIEW.format(categories="\n".join(lines))

    def run(self, text: str, product: dict, tracer: Tracer, inject_hallucination: bool = False,
            label: str = "模型审查") -> ChannelResult:
        brief = product_brief(product)
        with tracer.span(self.agent, label, {"model": self.provider.model, "chars": len(text)}) as span:
            messages = [
                {"role": "system", "content": self._system_prompt()},
                {"role": "user", "content": payload_message(
                    "请审查下面的带货脚本。", {"product": {k: brief[k] for k in ("name", "category", "facts")}, "script": text})},
            ]
            try:
                data, result = complete_json(self.provider, messages, task="review")
            except LLMError as exc:
                # Degrade instead of failing the review: the rule channel still runs.
                span.degrade(f"模型通道不可用，本次只使用规则通道：{exc}")
                return ChannelResult(status="degraded")
            span.usage(result)
            raw = [f for f in (data.get("findings") or []) if isinstance(f, dict)]
            if inject_hallucination:
                raw.append({"quote": HALLUCINATED_QUOTE, "category": "authority_endorsement",
                            "reason": "（演示开关）注入一条原文中不存在的引用", "confidence": 0.9})
                span.set(demo="已注入 1 条原文中不存在的引用，用于演示证据定位的拦截")
            span.set(findings=[{"quote": f.get("quote"), "category": f.get("category")} for f in raw])
        return ChannelResult(raw=raw)
