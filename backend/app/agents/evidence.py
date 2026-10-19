"""Evidence locator and validator.

The locator turns channel output into findings a reviewer can check by eye:
  original characters [start, end) → the rule that fired → verbatim law text.
Model quotes are located in the script (exact match first, then a whitespace / width /
punctuation-insensitive match mapped back to original offsets). A quote that cannot be
found is rejected and logged, never shown as a finding.

The validator then re-checks every finding independently of how it was produced:
the span is in range, ``text[start:end] == quote``, the category exists, and every
"verified" citation still matches the local law snapshot.
"""

from __future__ import annotations

from copy import copy

from ..law import LawLibrary
from ..rules import RuleSet
from ..textutil import cue_for_span, find_all, normalize
from .reviewers import Candidate

CHANNEL_ORDER = {"rule": 0, "fact": 1, "llm": 2}


class EvidenceLocator:
    agent = "evidence_locator"

    def __init__(self, ruleset: RuleSet, laws: LawLibrary):
        self.ruleset = ruleset
        self.laws = laws

    # ------------------------------------------------------------------ model quotes
    def locate(self, text: str, raw_findings: list[dict]) -> tuple[list[Candidate], list[dict]]:
        located: list[Candidate] = []
        rejected: list[dict] = []
        norm = None
        for raw in raw_findings:
            quote = raw.get("quote")
            category = raw.get("category")
            reason = str(raw.get("reason", ""))
            if not isinstance(quote, str) or not quote.strip():
                rejected.append({"quote": quote, "category": category, "reason": "缺少 quote 字段"})
                continue
            if category not in self.ruleset.categories or category == "fact_mismatch":
                rejected.append({"quote": quote, "category": category, "reason": f"未知分类 {category}"})
                continue
            spans = [(p, p + len(quote)) for p in find_all(text, quote)]
            method = "exact"
            if not spans:
                norm = norm or normalize(text)
                needle = normalize(quote).text
                spans = [norm.to_original(p, p + len(needle)) for p in find_all(norm.text, needle)] if needle else []
                method = "normalized"
            if not spans:
                rejected.append({"quote": quote, "category": category,
                                 "reason": "原文中找不到该片段：模型可能改写或编造了引用"})
                continue
            for start, end in spans:
                located.append(Candidate(category=category, start=start, end=end, quote=text[start:end],
                                         channel="llm", reason=reason, locate_method=method))
        return located, rejected

    # ------------------------------------------------------------------ merge
    def merge(self, candidates: list[Candidate]) -> list[list[Candidate]]:
        """Group candidates that describe the same problem.

        Same category + any overlap → one finding. Different categories → one finding only
        when they cover mostly the same characters; the higher-priority category wins.
        """
        ordered = sorted(candidates, key=lambda c: (c.start, CHANNEL_ORDER[c.channel], -c.length))
        groups: list[list[Candidate]] = []
        for cand in ordered:
            home = None
            for group in groups:
                for member in group:
                    inter = min(member.end, cand.end) - max(member.start, cand.start)
                    if inter <= 0:
                        continue
                    if member.category == cand.category or inter / min(member.length, cand.length) >= 0.6:
                        home = group
                        break
                if home:
                    break
            if home is None:
                groups.append([cand])
            else:
                home.append(cand)
        return groups

    def _primary(self, group: list[Candidate]) -> tuple[Candidate, list[str]]:
        priority = {c.id: c.priority for c in self.ruleset.categories.values()}
        category = max({c.category for c in group}, key=lambda cid: priority.get(cid, 0))
        own = [c for c in group if c.category == category]
        precise = [c for c in own if c.channel in ("rule", "fact")] or own
        primary = copy(max(precise, key=lambda c: c.length))
        related = sorted({c.category for c in group if c.category != category})
        return primary, related

    # ------------------------------------------------------------------ findings
    def build(self, text: str, groups: list[list[Candidate]], product_category: str,
              cues: list[dict] | None) -> list[dict]:
        findings: list[dict] = []
        for group in groups:
            primary, related = self._primary(group)
            category = self.ruleset.categories[primary.category]
            rule_ids: list[str] = []
            for c in sorted(group, key=lambda c: CHANNEL_ORDER[c.channel]):
                for rid in c.rule_ids or ([c.rule_id] if c.rule_id else []):
                    if rid not in rule_ids:
                        rule_ids.append(rid)
            rule_id = primary.rule_id or next((r for r in rule_ids if self.ruleset.rules[r].category == primary.category), None)
            rule = self.ruleset.rules.get(rule_id) if rule_id else None
            basis, penalty, references = self.ruleset.refs_for(primary.category, rule_id, product_category)
            citations, seen = [], set()
            for ref, kind in [(r, "basis") for r in basis] + [(r, "penalty") for r in penalty]:
                key = (ref.law, ref.article, ref.paragraph, ref.item, kind)
                if key in seen:
                    continue
                seen.add(key)
                citations.append(self.laws.resolve(ref.law, ref.article, ref.paragraph, ref.item, kind).to_dict())
            model_reasons = [c.reason for c in group if c.channel == "llm" and c.reason]
            channels = sorted({c.channel for c in group}, key=lambda ch: CHANNEL_ORDER[ch])
            findings.append({
                "category": primary.category,
                "category_label": category.label,
                "severity": self.ruleset.severity(primary.category, rule_id),
                "start": primary.start,
                "end": primary.end,
                "quote": text[primary.start:primary.end],
                "rule_id": rule_id,
                "rule_name": rule.name if rule else None,
                "rule_ids": rule_ids,
                "channels": channels,
                "reason": primary.reason if primary.channel != "llm" else (primary.reason or category.description),
                "model_reason": model_reasons[0] if model_reasons else None,
                "locate_method": primary.locate_method,
                "related_categories": related,
                "citations": citations,
                "references": [r.model_dump() for r in references],
                "pending_basis": not any(c["status"] == "verified" and c["kind"] == "basis" for c in citations),
                "cue": cue_for_span(cues, primary.start, primary.end) if cues else None,
                "evidence": primary.evidence,
            })
        findings.sort(key=lambda f: (f["start"], f["end"]))
        for i, finding in enumerate(findings, start=1):
            finding["key"] = f"F{i}"
        return findings

    def build_disclosures(self, disclosures: list[dict]) -> list[dict]:
        out = []
        for d in disclosures:
            refs = self.ruleset.disclosure_refs(d["id"])
            citations = [self.laws.resolve(r.law, r.article, r.paragraph, r.item).to_dict() for r in refs]
            out.append({**d, "citations": citations})
        return out


def validate_findings(text: str, findings: list[dict], laws: LawLibrary, ruleset: RuleSet) -> tuple[list[dict], dict]:
    """Independent re-check. Anything that fails is dropped and reported, not repaired."""
    valid: list[dict] = []
    errors: list[dict] = []
    for f in findings:
        problems = []
        start, end = f.get("start"), f.get("end")
        if not isinstance(start, int) or not isinstance(end, int) or not (0 <= start < end <= len(text)):
            problems.append("字符位置越界")
        elif text[start:end] != f.get("quote"):
            problems.append("引用片段与原文不一致")
        if f.get("category") not in ruleset.categories:
            problems.append("未知分类")
        for c in f.get("citations", []):
            if c["status"] == "verified" and not laws.contains_text(c["law_id"], c["article"], c["text"]):
                problems.append(f"{c['label']} 的引文与本地法条快照不一致")
        if problems:
            errors.append({"key": f.get("key"), "quote": f.get("quote"), "problems": problems})
        else:
            valid.append(f)
    report = {
        "checked": len(findings),
        "valid": len(valid),
        "errors": errors,
        "pending_basis": sum(1 for f in valid if f.get("pending_basis")),
        "citations": sum(len(f.get("citations", [])) for f in valid),
        "citations_verified": sum(1 for f in valid for c in f.get("citations", []) if c["status"] == "verified"),
    }
    return valid, report
