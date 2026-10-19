"""Rewrite agent: minimal, traceable edits instead of a free re-write.

Each finding becomes one edit on its own characters (or on its clause when the rule says
the claim has to go), so the reviewer sees exactly what changed and why. Suggestions come
from the rule library's templates; with a real model the agent asks for a more fluent
replacement and keeps it only if it passes the rule engine and does not repeat the
violating text. Product-fact mismatches are corrected from the product sheet itself.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

from ..llm.base import LLMError, LLMProvider, complete_json, payload_message
from ..rules import RuleSet
from ..textutil import clause_bounds, normalize, sentence_bounds
from . import prompts
from .tracing import SpanHandle

SCOPE_PREFIXES = ("全网", "全国", "全球", "史上", "行业", "业内", "同类", "同价位", "全场", "本店", "市面上")


@dataclass
class Edit:
    start: int
    end: int
    replacement: str
    keys: list[str]
    strategy: str
    note: str = ""

    def to_dict(self, text: str) -> dict:
        return {
            "start": self.start, "end": self.end, "original": text[self.start:self.end],
            "replacement": self.replacement, "keys": self.keys, "strategy": self.strategy, "note": self.note,
        }


def _strip_scope(text: str) -> str:
    for prefix in SCOPE_PREFIXES:
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


def template_suggestion(ruleset: RuleSet, finding: dict) -> tuple[str | None, str, str]:
    """Return (replacement or None for clause deletion, strategy, note)."""
    category = finding["category"]
    spec = ruleset.rewrite_spec(category, finding.get("rule_id"))
    quote = normalize(finding["quote"]).text
    evidence = finding.get("evidence") or {}
    if category == "fact_mismatch" and evidence.get("script_number"):
        fixed = quote.replace(evidence["script_number"], evidence["expected_number"], 1)
        return fixed, "fact", f"按商品资料「{evidence.get('fact_key')}」改为 {evidence.get('expected_value')}"
    replacements = {normalize(k).text: v for k, v in spec.replacements.items()}
    if quote in replacements:
        return replacements[quote], "replace", spec.note
    for key in sorted(replacements, key=len, reverse=True):
        if key and key in quote:
            return _strip_scope(quote.replace(key, replacements[key], 1)), "replace", spec.note
    for sub in spec.subs:
        changed = re.sub(sub.pattern, sub.replace, quote, count=1)
        if changed != quote:
            return changed, "replace", spec.note
    if spec.strategy == "prefix" and spec.prefix_from and spec.prefix_from in quote:
        changed = quote.replace(spec.prefix_from, spec.prefix_to or "", 1)
        return _strip_scope(changed), "replace", spec.note
    if spec.fallback is not None:
        return spec.fallback, "replace", spec.note
    return None, "delete_clause", spec.note or "删除该表述"


def _clause_edit(text: str, start: int, end: int) -> tuple[int, int]:
    """Characters to delete so that the clause disappears without leaving ",," behind."""
    a, b = clause_bounds(text, start, end)
    if b < len(text) and text[b] in "，,、:：":
        b += 1  # drop the comma after the clause
    elif a > 0 and text[a - 1] in "，,、:：":
        a -= 1  # last clause of a sentence: drop the comma before it, keep the full stop
    elif b < len(text) and text[b] in "。!?！？;；":
        b += 1  # the clause is a whole sentence
    return a, b


def merge_edits(edits: list[Edit]) -> list[Edit]:
    merged: list[Edit] = []
    for edit in sorted(edits, key=lambda e: (e.start, -(e.end - e.start))):
        last = merged[-1] if merged else None
        if last and edit.start < last.end or last and edit.start == last.start == last.end == edit.end:
            # Overlap: a clause deletion swallows edits inside it.
            if last.strategy == "delete_clause" or edit.strategy == "delete_clause":
                last.start, last.end = min(last.start, edit.start), max(last.end, edit.end)
                last.replacement, last.strategy = "", "delete_clause"
            last.keys = last.keys + [k for k in edit.keys if k not in last.keys]
            continue
        merged.append(Edit(edit.start, edit.end, edit.replacement, list(edit.keys), edit.strategy, edit.note))
    return merged


def apply_edits(text: str, edits: list[Edit]) -> tuple[str, list[dict]]:
    out, cursor, delta, applied = [], 0, 0, []
    for edit in edits:
        out.append(text[cursor:edit.start])
        out.append(edit.replacement)
        new_start = edit.start + delta
        applied.append({**edit.to_dict(text), "new_start": new_start, "new_end": new_start + len(edit.replacement)})
        delta += len(edit.replacement) - (edit.end - edit.start)
        cursor = edit.end
    out.append(text[cursor:])
    return "".join(out), applied


def char_diff(before: str, after: str) -> list[dict]:
    matcher = difflib.SequenceMatcher(a=before, b=after, autojunk=False)
    return [
        {"op": op, "a": before[i1:i2], "b": after[j1:j2]}
        for op, i1, i2, j1, j2 in matcher.get_opcodes()
    ]


class RewriteAgent:
    agent = "rewrite"

    def __init__(self, provider: LLMProvider, ruleset: RuleSet):
        self.provider = provider
        self.ruleset = ruleset

    def suggest(self, text: str, finding: dict) -> dict:
        replacement, strategy, note = template_suggestion(self.ruleset, finding)
        return {"replacement": replacement, "strategy": strategy, "note": note}

    def plan(self, text: str, findings: list[dict], disclosures: list[dict], product: dict,
             span: SpanHandle | None = None) -> list[Edit]:
        edits: list[Edit] = []
        model_used = 0
        for finding in findings:
            replacement, strategy, note = template_suggestion(self.ruleset, finding)
            if self.provider.name != "mock" and finding["category"] != "fact_mismatch":
                candidate = self._model_rewrite(text, finding, replacement, product, span)
                if candidate is not None:
                    replacement, strategy, note = candidate, "model", "模型改写（已通过规则复核）"
                    model_used += 1
            if strategy == "delete_clause":
                a, b = _clause_edit(text, finding["start"], finding["end"])
                edits.append(Edit(a, b, "", [finding["key"]], strategy, note))
            else:
                edits.append(Edit(finding["start"], finding["end"], replacement or "", [finding["key"]], strategy, note))
        for d in disclosures:
            if not d["present"]:
                tail = text.rstrip()
                sep = "" if not tail else ("\n" if text.endswith("\n") or "\n" in text else "")
                end = len(text)
                edits.append(Edit(end, end, sep + d["suggestion"], [d["id"]], "append", f"补充必要声明：{d['required']}"))
        if span is not None and model_used:
            span.set(model_rewrites=model_used)
        return merge_edits(edits)

    def _model_rewrite(self, text: str, finding: dict, hint: str | None, product: dict,
                       span: SpanHandle | None) -> str | None:
        a, b = sentence_bounds(text, finding["start"], finding["end"])
        payload = {
            "quote": finding["quote"], "sentence": text[a:b], "category": finding["category_label"],
            "reason": finding.get("reason", ""), "hint": hint if hint is not None else "（删除该表述）",
            "facts": product.get("facts", []),
        }
        messages = [
            {"role": "system", "content": prompts.REWRITE},
            {"role": "user", "content": payload_message("请改写下面的违规片段。", payload)},
        ]
        try:
            data, result = complete_json(self.provider, messages, task="rewrite")
        except LLMError:
            return None
        if span is not None:
            span.usage(result)
        candidate = str(data.get("replacement", ""))
        # Keep the model's wording only if it is clean on its own and inside its sentence.
        if finding["quote"] in candidate or len(candidate) > len(text[a:b]) + 20:
            return None
        if self.ruleset.scan(candidate, product.get("category", "general")):
            return None
        return candidate
