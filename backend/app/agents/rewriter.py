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


# difflib's matcher is quadratic or worse on repetitive text: a 6000-character chant such as
# "全网最好用，" x 1000 took over a minute. The rewrite diff is therefore built from the rewrite's
# own edits (which characters changed is known exactly) and difflib only runs inside each changed
# region, for the fine-grained redline; a region larger than this many character pairs is shown as
# one replacement. The browser port (frontend/src/engine/rewrite.ts) does the same.
LOCAL_DIFF_BUDGET = 40_000


def _opcodes(before: str, after: str) -> list[dict]:
    matcher = difflib.SequenceMatcher(a=before, b=after, autojunk=False)
    return [
        {"op": op, "a": before[i1:i2], "b": after[j1:j2]}
        for op, i1, i2, j1, j2 in matcher.get_opcodes()
    ]


def _local(before: str, after: str) -> list[dict]:
    if len(before) * len(after) <= LOCAL_DIFF_BUDGET:
        return _opcodes(before, after)
    op = "replace" if before and after else ("delete" if before else "insert")
    return [{"op": op, "a": before, "b": after}]


def _pieces(edits: list[dict], n: int) -> list[tuple[int, int, int, int, bool]]:
    """(a0, a1, b0, b1, equal) pieces covering a text of length n and its edited version."""
    out, a, b = [], 0, 0
    for e in edits:
        if e["start"] > a:
            out.append((a, e["start"], b, b + e["start"] - a, True))
            b += e["start"] - a
        out.append((e["start"], e["end"], b, b + len(e["replacement"]), False))
        b += len(e["replacement"])
        a = e["end"]
    if a < n or not out:
        out.append((a, n, b, b + n - a, True))
    return out


def _map(pieces, x: int, side: int, last: bool) -> int:
    """Map position x on one side (0 = before, 2 = after) to the other side. Inside an equal
    piece the offset carries over; inside a changed piece the mapping widens to its bounds."""
    other = 2 if side == 0 else 0
    hits = [p for p in pieces if p[4] and p[side] <= x <= p[side + 1]]
    if hits:
        piece = hits[-1] if last else hits[0]
        return piece[other] + (x - piece[side])
    inside = [p for p in pieces if p[side] <= x <= p[side + 1]]
    piece = inside[-1] if last else inside[0]
    return piece[other + 1] if last else piece[other]


def _compose(p, q, n0: int, n2: int):
    """Pieces text0 -> text1 and text1 -> text2 become pieces text0 -> text2."""
    spans = sorted([(b0, b1) for _, _, b0, b1, eq in p if not eq] + [(a0, a1) for a0, a1, _, _, eq in q if not eq])
    merged: list[list[int]] = []
    for x, y in spans:
        if merged and x <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], y)
        else:
            merged.append([x, y])
    out, a, b = [], 0, 0
    for x, y in merged:
        a0, a1 = _map(p, x, 2, False), _map(p, y, 2, True)
        b0, b1 = _map(q, x, 0, False), _map(q, y, 0, True)
        if a0 > a:
            out.append((a, a0, b, b0, True))
        out.append((a0, a1, b0, b1, False))
        a, b = a1, b1
    if a < n0 or b < n2 or not out:
        out.append((a, n0, b, n2, True))
    return out


def char_diff(before: str, after: str, rounds: list[list[dict]] | None = None) -> list[dict]:
    """Character diff of a rewrite. Given the applied edits of each round it is linear in the text,
    with difflib per changed region; without them it is plain difflib."""
    if rounds is None:
        return _opcodes(before, after)
    pieces, text = None, before
    for edits in rounds:
        step = _pieces(edits, len(text))
        text = apply_edits(text, [Edit(e["start"], e["end"], e["replacement"], [], "") for e in edits])[0]
        pieces = step if pieces is None else _compose(pieces, step, len(before), len(text))
    if text != after:
        raise ValueError("rewrite rounds do not lead to the rewritten text")
    if pieces is None:
        return [{"op": "equal", "a": before, "b": after}] if before else []
    ops: list[dict] = []
    for a0, a1, b0, b1, equal in pieces:
        chunk = [{"op": "equal", "a": before[a0:a1], "b": after[b0:b1]}] if equal else _local(before[a0:a1], after[b0:b1])
        for op in chunk:
            if not op["a"] and not op["b"]:
                continue
            if ops and op["op"] == "equal" and ops[-1]["op"] == "equal":
                ops[-1] = {"op": "equal", "a": ops[-1]["a"] + op["a"], "b": ops[-1]["b"] + op["b"]}
            else:
                ops.append(op)
    return ops


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
