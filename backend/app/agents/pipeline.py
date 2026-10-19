"""Orchestrator for the review pipeline.

    卖点提炼 → (脚本生成) → 规则审查 ∥ 模型审查 → 证据定位 + 校验 → 改写建议 → 复审 → 人工终审

Agents hand typed data to each other; each step is a traced span. The two review
channels run in parallel threads. Failures degrade instead of crashing: if the model
channel is down the review continues on rules alone and the trace says so.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from ..law import LawLibrary
from ..llm.base import LLMProvider
from ..rules import RuleSet
from .evidence import EvidenceLocator, validate_findings
from .reviewers import ChannelResult, ModelReviewer, RuleReviewer
from .rewriter import RewriteAgent, apply_edits, char_diff
from .tracing import Tracer
from .writers import ScriptWriterAgent, SellingPointAgent

BLOCKING = ("high", "medium")


@dataclass
class PipelineInput:
    product: dict
    mode: str = "review"  # review | generate
    script: str = ""
    cues: list[dict] = field(default_factory=list)
    style: str = "short_video"  # short_video | live
    tone: str = "safe"  # safe | aggressive (demo)
    inject_hallucination: bool = False
    rewrite: bool = True
    channels: tuple[str, ...] | None = None


@dataclass
class ReviewPass:
    text: str
    findings: list[dict]
    disclosures: list[dict]
    rejected: list[dict]
    validation: dict
    channels: dict

    @property
    def blocking(self) -> list[dict]:
        return [f for f in self.findings if f["severity"] in BLOCKING]

    @property
    def missing_disclosures(self) -> list[dict]:
        return [d for d in self.disclosures if not d["present"]]

    def passed(self) -> bool:
        return not self.blocking and not self.missing_disclosures


def summarize(findings: list[dict], disclosures: list[dict]) -> tuple[dict, str]:
    counts = {"high": 0, "medium": 0, "low": 0, "total": len(findings)}
    by_category: dict[str, int] = {}
    for f in findings:
        counts[f["severity"]] += 1
        by_category[f["category"]] = by_category.get(f["category"], 0) + 1
    counts["by_category"] = by_category
    counts["missing_disclosures"] = sum(1 for d in disclosures if not d["present"])
    if counts["high"] or counts["missing_disclosures"]:
        risk = "high"
    elif counts["medium"]:
        risk = "medium"
    else:
        risk = "low"
    return counts, risk


class ReviewPipeline:
    def __init__(self, provider: LLMProvider, ruleset: RuleSet, laws: LawLibrary,
                 channels: tuple[str, ...] = ("rule", "llm"), max_rounds: int = 2, max_chars: int = 6000):
        self.provider = provider
        self.ruleset = ruleset
        self.laws = laws
        self.channels = channels
        self.max_rounds = max_rounds
        self.selling = SellingPointAgent(provider)
        self.writer = ScriptWriterAgent(provider, max_chars)
        self.rule_reviewer = RuleReviewer(ruleset)
        self.model_reviewer = ModelReviewer(provider, ruleset)
        self.locator = EvidenceLocator(ruleset, laws)
        self.rewriter = RewriteAgent(provider, ruleset)

    # ------------------------------------------------------------------ one review pass
    def review(self, text: str, product: dict, tracer: Tracer, *, cues: list[dict] | None = None,
               stage: str = "original", inject_hallucination: bool = False,
               channels: tuple[str, ...] | None = None) -> ReviewPass:
        channels = channels or self.channels
        suffix = "" if stage == "original" else f"（{stage}）"
        empty = ChannelResult(status="off")
        with ThreadPoolExecutor(max_workers=2) as pool:
            rule_future = pool.submit(self.rule_reviewer.run, text, product, tracer, "规则审查" + suffix) \
                if "rule" in channels else None
            model_future = pool.submit(self.model_reviewer.run, text, product, tracer, inject_hallucination,
                                       "模型审查" + suffix) if "llm" in channels else None
            rule_out = rule_future.result() if rule_future else empty
            model_out = model_future.result() if model_future else empty
        tracer.flush()

        with tracer.span(EvidenceLocator.agent, "证据定位与校验" + suffix, {
            "rule_candidates": len(rule_out.candidates), "model_quotes": len(model_out.raw),
        }) as span:
            located, rejected = self.locator.locate(text, model_out.raw)
            groups = self.locator.merge(rule_out.candidates + located)
            category = product.get("category", "general")
            built = self.locator.build(text, groups, category, cues)
            findings, validation = validate_findings(text, built, self.laws, self.ruleset)
            for i, finding in enumerate(findings, start=1):
                finding["key"] = f"F{i}"
            for item in rejected:
                item["stage"] = stage
            disclosures = self.locator.build_disclosures(rule_out.disclosures)
            span.set(
                findings=[{"key": f["key"], "quote": f["quote"], "span": [f["start"], f["end"]],
                           "category": f["category"], "channels": f["channels"]} for f in findings],
                rejected=rejected,
                validation={k: v for k, v in validation.items() if k != "errors"},
                validation_errors=validation["errors"],
            )
        tracer.flush()
        return ReviewPass(
            text=text, findings=findings, disclosures=disclosures, rejected=rejected, validation=validation,
            channels={"rule": rule_out.status if rule_future else "off", "llm": model_out.status if model_future else "off"},
        )

    # ------------------------------------------------------------------ rewrite loop
    def rewrite(self, original: ReviewPass, product: dict, tracer: Tracer) -> dict:
        text = original.text
        current = original
        rounds = []
        edits_first: list[dict] = []
        for round_no in range(1, self.max_rounds + 1):
            if current.passed():
                break
            todo = [f for f in current.findings if f["severity"] in BLOCKING]
            with tracer.span(RewriteAgent.agent, f"改写建议（第 {round_no} 轮）", {
                "findings": [f["key"] for f in todo], "missing_disclosures": [d["id"] for d in current.missing_disclosures],
            }) as span:
                edits = self.rewriter.plan(current.text, todo, current.disclosures, product, span)
                new_text, applied = apply_edits(current.text, edits)
                span.set(edits=applied, chars_before=len(current.text), chars_after=len(new_text))
            tracer.flush()
            if round_no == 1:
                edits_first = applied
            current = self.review(new_text, product, tracer, stage=f"复审 {round_no}")
            rounds.append({
                "round": round_no, "edits": len(applied), "remaining": len(current.findings),
                "remaining_blocking": len(current.blocking), "missing_disclosures": len(current.missing_disclosures),
            })
        return {
            "text": current.text,
            "changed": current.text != text,
            "edits": edits_first,
            "rounds": rounds,
            "passed": current.passed(),
            "remaining": current.findings,
            "remaining_disclosures": current.missing_disclosures,
            "diff": char_diff(text, current.text),
        }

    # ------------------------------------------------------------------ full run
    def run(self, inp: PipelineInput, tracer: Tracer) -> dict:
        product = inp.product
        selling_points = self.selling.run(product, tracer)
        tracer.flush()
        if inp.mode == "generate":
            script, cues = self.writer.run(product, selling_points, inp.style, inp.tone, tracer), []
            tracer.flush()
        else:
            script, cues = inp.script, inp.cues
        original = self.review(script, product, tracer, cues=cues,
                               inject_hallucination=inp.inject_hallucination, channels=inp.channels)
        for finding in original.findings:
            suggestion = self.rewriter.suggest(script, finding)
            finding["suggestion"] = suggestion
        rewrite = self.rewrite(original, product, tracer) if inp.rewrite else None
        counts, risk = summarize(original.findings, original.disclosures)
        return {
            "script": script,
            "cues": cues,
            "selling_points": selling_points,
            "findings": original.findings,
            "disclosures": original.disclosures,
            "rejected": original.rejected,
            "validation": original.validation,
            "channels": original.channels,
            "rewrite": rewrite,
            "counts": counts,
            "risk_level": risk,
        }
