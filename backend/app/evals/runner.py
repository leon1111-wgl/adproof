"""Run the review pipeline over the annotated dataset and compute the report.

What is measured
- Span P / R / F1 per violation category (relaxed: same category and IoU ≥ 0.5; strict:
  identical boundaries) plus localisation regardless of category.
- Channel ablation: rules only, model only, both.
- Required statements (document level) and script-level detection / false alarms.
- Rewrite: share of violating scripts whose rewrite passes re-review, and share of gold
  violation spans that the rewrite actually changed.
- Evidence invariants: every reported span equals the script text, every citation
  resolves to the verified law snapshot.

With the offline model these numbers say the pipeline works as designed. They are not
model quality; re-run with a real provider for that.
"""

from __future__ import annotations

import time
from collections import Counter as Tally

from ..agents import PipelineInput, ReviewPipeline, Tracer
from .dataset import EvalItem
from .metrics import Counter, Span, percentile, prf


def changed_positions(diff: list[dict]) -> set[int]:
    """Original-text indices that the rewrite replaced or deleted."""
    changed: set[int] = set()
    cursor = 0
    for op in diff:
        length = len(op["a"])
        if op["op"] in ("replace", "delete"):
            changed.update(range(cursor, cursor + length))
        cursor += length
    return changed


class SplitStats:
    def __init__(self) -> None:
        self.main = Counter()
        self.strict = Counter()
        self.locate = Counter()
        self.rule_only = Counter()
        self.model_only = Counter()
        self.items = 0
        self.violating = 0
        self.violating_detected = 0
        self.clean = 0
        self.clean_flagged = 0
        self.rewrite_total = 0
        self.rewrite_passed = 0
        self.gold_spans = 0
        self.gold_eliminated = 0
        self.disclosure = {"tp": 0, "fp": 0, "fn": 0}
        self.checked = 0
        self.valid = 0
        self.citations = 0
        self.citations_verified = 0
        self.pending_basis = 0
        self.rejected_quotes = 0
        self.latencies: list[float] = []
        self.channels: Tally = Tally()

    def report(self, categories: list[str]) -> dict:
        main = self.main.report(categories)
        return {
            "items": self.items,
            "span": main,
            "span_strict": self.strict.report(categories)["micro"],
            "localisation": self.locate.report(categories)["micro"],
            "ablation": {
                "rule": self.rule_only.report(categories)["micro"],
                "model": self.model_only.report(categories)["micro"],
                "both": main["micro"],
            },
            "script_level": {
                "violating": self.violating,
                "detected": self.violating_detected,
                "detection_rate": round(self.violating_detected / self.violating, 4) if self.violating else None,
                "clean": self.clean,
                "clean_flagged": self.clean_flagged,
                "false_alarm_rate": round(self.clean_flagged / self.clean, 4) if self.clean else None,
            },
            "disclosures": prf(**self.disclosure),
            "rewrite": {
                "scripts": self.rewrite_total,
                "passed": self.rewrite_passed,
                "pass_rate": round(self.rewrite_passed / self.rewrite_total, 4) if self.rewrite_total else None,
                "gold_spans": self.gold_spans,
                "gold_eliminated": self.gold_eliminated,
                "elimination_rate": round(self.gold_eliminated / self.gold_spans, 4) if self.gold_spans else None,
            },
            "evidence": {
                "findings_checked": self.checked,
                "findings_valid": self.valid,
                "validity": round(self.valid / self.checked, 4) if self.checked else 1.0,
                "citations": self.citations,
                "citations_verified": self.citations_verified,
                "citation_verified_rate": round(self.citations_verified / self.citations, 4) if self.citations else 1.0,
                "pending_basis": self.pending_basis,
                "rejected_model_quotes": self.rejected_quotes,
            },
            "channels": dict(self.channels),
            "latency_ms": {
                "p50": round(percentile(self.latencies, 0.5), 1),
                "p95": round(percentile(self.latencies, 0.95), 1),
            },
        }


def run_eval(pipeline: ReviewPipeline, items: list[EvalItem]) -> dict:
    categories = [c for c in pipeline.ruleset.categories]
    stats = {"dev": SplitStats(), "test": SplitStats(), "all": SplitStats()}
    cases = []
    for item in items:
        started = time.perf_counter()
        out = pipeline.run(PipelineInput(product=item.product, script=item.text, cues=item.cues), Tracer())
        latency = (time.perf_counter() - started) * 1000
        gold = [Span(g.category, g.start, g.end) for g in item.gold]
        pred = [Span(f["category"], f["start"], f["end"]) for f in out["findings"]]
        rule_only = pipeline.review(item.text, item.product, Tracer(), cues=item.cues, channels=("rule",))
        model_only = pipeline.review(item.text, item.product, Tracer(), cues=item.cues, channels=("llm",))
        pred_missing = sorted(d["id"] for d in out["disclosures"] if not d["present"])
        gold_missing = sorted(item.missing_disclosures)
        rewrite = out["rewrite"] or {}
        changed = changed_positions(rewrite.get("diff", []))
        eliminated = [any(i in changed for i in range(g.start, g.end)) for g in item.gold]

        pairs = fn = fp = None
        for key in ("all", item.split):
            s = stats[key]
            pairs, fn, fp = s.main.add(gold, pred)
            s.strict.add(gold, pred, strict=True)
            s.locate.add(gold, pred, ignore_category=True)
            s.rule_only.add(gold, [Span(f["category"], f["start"], f["end"]) for f in rule_only.findings])
            s.model_only.add(gold, [Span(f["category"], f["start"], f["end"]) for f in model_only.findings])
            s.items += 1
            violating = bool(gold) or bool(gold_missing)
            if violating:
                s.violating += 1
                s.violating_detected += 1 if (pairs or set(pred_missing) & set(gold_missing)) else 0
                s.rewrite_total += 1
                s.rewrite_passed += 1 if rewrite.get("passed") else 0
            else:
                s.clean += 1
                s.clean_flagged += 1 if (pred or pred_missing) else 0
            s.gold_spans += len(gold)
            s.gold_eliminated += sum(eliminated)
            s.disclosure["tp"] += len(set(pred_missing) & set(gold_missing))
            s.disclosure["fp"] += len(set(pred_missing) - set(gold_missing))
            s.disclosure["fn"] += len(set(gold_missing) - set(pred_missing))
            v = out["validation"]
            s.checked += v["checked"]
            s.valid += v["valid"]
            s.citations += v["citations"]
            s.citations_verified += v["citations_verified"]
            s.pending_basis += v["pending_basis"]
            s.rejected_quotes += len(out["rejected"])
            s.latencies.append(latency)
            for f in out["findings"]:
                s.channels["+".join(f["channels"])] += 1

        cases.append({
            "id": item.id,
            "split": item.split,
            "product": item.product["sku"],
            "product_category": item.product["category"],
            "input_type": item.input_type,
            "tags": item.tags,
            "text": item.text,
            "gold": [{"category": g.category, "start": g.start, "end": g.end, "text": g.text} for g in item.gold],
            "pred": [{"key": f["key"], "category": f["category"], "start": f["start"], "end": f["end"],
                      "quote": f["quote"], "channels": f["channels"], "rule_id": f["rule_id"]} for f in out["findings"]],
            "matched": [[gi, pi] for gi, pi in pairs],
            "missed": fn,
            "false_positives": fp,
            "disclosures": {"gold_missing": gold_missing, "pred_missing": pred_missing},
            "rewrite": {
                "passed": rewrite.get("passed"),
                "rounds": len(rewrite.get("rounds", [])),
                "text": rewrite.get("text"),
                "gold_eliminated": sum(eliminated),
            },
            "latency_ms": round(latency, 2),
        })

    return {
        "categories": categories,
        "splits": {key: s.report(categories) for key, s in stats.items()},
        "cases": cases,
    }
