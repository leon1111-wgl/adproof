"""Span-level precision / recall / F1.

A prediction matches a gold span when the categories agree and the character IoU is at
least 0.5 (relaxed). "Strict" requires identical boundaries. Matching is one-to-one and
greedy by IoU, so one long prediction cannot claim two gold spans.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass


@dataclass(frozen=True)
class Span:
    category: str
    start: int
    end: int


def iou(a: Span, b: Span) -> float:
    inter = min(a.end, b.end) - max(a.start, b.start)
    if inter <= 0:
        return 0.0
    union = max(a.end, b.end) - min(a.start, b.start)
    return inter / union


def match(gold: list[Span], pred: list[Span], *, strict: bool = False, threshold: float = 0.5,
          ignore_category: bool = False) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    """Return (matched (gold_idx, pred_idx) pairs, unmatched gold, unmatched predictions)."""
    candidates = []
    for gi, g in enumerate(gold):
        for pi, p in enumerate(pred):
            if not ignore_category and g.category != p.category:
                continue
            score = iou(g, p)
            ok = (g.start == p.start and g.end == p.end) if strict else score >= threshold
            if ok:
                candidates.append((score, gi, pi))
    candidates.sort(key=lambda c: -c[0])
    used_g, used_p, pairs = set(), set(), []
    for _, gi, pi in candidates:
        if gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        pairs.append((gi, pi))
    return pairs, [i for i in range(len(gold)) if i not in used_g], [i for i in range(len(pred)) if i not in used_p]


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f1, 4), "tp": tp, "fp": fp, "fn": fn}


class Counter:
    """Accumulates tp / fp / fn overall and per category."""

    def __init__(self) -> None:
        self.total = {"tp": 0, "fp": 0, "fn": 0}
        self.by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})

    def add(self, gold: list[Span], pred: list[Span], **kwargs) -> tuple[list[tuple[int, int]], list[int], list[int]]:
        pairs, fn, fp = match(gold, pred, **kwargs)
        self.total["tp"] += len(pairs)
        self.total["fn"] += len(fn)
        self.total["fp"] += len(fp)
        for gi, _ in pairs:
            self.by_category[gold[gi].category]["tp"] += 1
        for gi in fn:
            self.by_category[gold[gi].category]["fn"] += 1
        for pi in fp:
            self.by_category[pred[pi].category]["fp"] += 1
        return pairs, fn, fp

    def report(self, categories: list[str]) -> dict:
        per = {}
        for cat in categories:
            c = self.by_category.get(cat, {"tp": 0, "fp": 0, "fn": 0})
            per[cat] = {**prf(c["tp"], c["fp"], c["fn"]), "support": c["tp"] + c["fn"]}
        with_support = [v for v in per.values() if v["support"]]
        macro_f1 = sum(v["f1"] for v in with_support) / len(with_support) if with_support else 0.0
        return {"micro": prf(**self.total), "macro_f1": round(macro_f1, 4), "per_category": per}


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[index]
