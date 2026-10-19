"""Rule engine: YAML rules → character spans in the original script.

Patterns run on a normalized copy (full-width to half-width, lower-case, whitespace and
filter-dodging symbols removed) and every match is mapped back to original offsets, so a
script written as "最 好 用" or "ＮＯ．１" is still caught and still quoted verbatim.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from pydantic import ValidationError

from ..textutil import normalize, sentence_bounds
from .schema import Category, ExternalRef, LawRef, RewriteSpec, Rule, RuleLibrary

MACROS = {"{NB}": r"[^,。!?;\n]", "{B}": r"[,。!?;\n]"}
# A negation word shortly before a hit flips its meaning ("本品不能代替药物", "不能治疗疾病").
# "不仅/不但/非常" are not negations.
_NEGATION = re.compile(r"(?:不(?![仅但只光单过错])|非(?!常)|无法|没有|并非|禁止|杜绝|拒绝|严禁)[^,。!?;\n]{0,3}$")


class RuleLibraryError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("；".join(errors))
        self.errors = errors


def expand_macros(pattern: str) -> str:
    for macro, value in MACROS.items():
        pattern = pattern.replace(macro, value)
    return pattern


@dataclass
class RuleHit:
    rule_id: str
    rule_name: str
    category: str
    severity: str
    start: int
    end: int
    quote: str
    reason: str
    rule_ids: list[str] = field(default_factory=list)

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass
class CompiledRule:
    rule: Rule
    matchers: list[re.Pattern]
    exceptions: list[re.Pattern]
    unless: re.Pattern | None

    def applies(self, product_category: str) -> bool:
        return "all" in self.rule.applies_to or product_category in self.rule.applies_to


def _compile(rule: Rule) -> CompiledRule:
    errors: list[str] = []

    def comp(pattern: str, what: str) -> re.Pattern | None:
        try:
            return re.compile(expand_macros(pattern))
        except re.error as exc:
            errors.append(f"规则 {rule.id} 的{what}不是合法的正则：{pattern}（{exc}）")
            return None

    matchers = [m for m in (comp(p, "匹配模式") for p in rule.patterns) if m is not None]
    if rule.keywords:
        words = sorted({normalize(k).text for k in rule.keywords if k.strip()}, key=len, reverse=True)
        matchers.append(re.compile("|".join(re.escape(w) for w in words)))
    exceptions = [m for m in (comp(p, "例外模式") for p in rule.exceptions) if m is not None]
    unless = comp(rule.unless_sentence, "整句豁免条件") if rule.unless_sentence else None
    if errors:
        raise RuleLibraryError(errors)
    return CompiledRule(rule, matchers, exceptions, unless)


def _negated(norm_text: str, start: int) -> bool:
    window = norm_text[max(0, start - 6) : start]
    for boundary in ",。!?;\n":
        window = window.rsplit(boundary, 1)[-1]
    return bool(_NEGATION.search(window))


class RuleSet:
    def __init__(self, library: RuleLibrary, raw_text: str, path: Path | None = None):
        self.library = library
        self.raw_text = raw_text
        self.path = path
        self.version = library.version
        self.name = library.name
        self.hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()[:12]
        self.categories: dict[str, Category] = {c.id: c for c in library.categories}
        self.rules: dict[str, Rule] = {r.id: r for r in library.rules}
        errors: list[str] = []
        self.compiled: list[CompiledRule] = []
        for rule in library.rules:
            if not rule.enabled:
                continue
            try:
                self.compiled.append(_compile(rule))
            except RuleLibraryError as exc:
                errors.extend(exc.errors)
        if errors:
            raise RuleLibraryError(errors)
        self.disclosures = library.disclosures
        self.product_categories = library.product_categories

    # ------------------------------------------------------------------ loading
    @classmethod
    def from_text(cls, raw_text: str, path: Path | None = None) -> "RuleSet":
        try:
            data = yaml.safe_load(raw_text)
        except yaml.YAMLError as exc:
            raise RuleLibraryError([f"YAML 语法错误：{exc}"]) from exc
        if not isinstance(data, dict):
            raise RuleLibraryError(["规则库顶层必须是一个映射（version / categories / rules …）"])
        try:
            library = RuleLibrary.model_validate(data)
        except ValidationError as exc:
            messages = []
            for err in exc.errors():
                where = ".".join(str(p) for p in err["loc"])
                messages.append(f"{where}：{err['msg']}" if where else err["msg"])
            raise RuleLibraryError(messages) from exc
        return cls(library, raw_text, path)

    @classmethod
    def load(cls, path: Path) -> "RuleSet":
        return cls.from_text(Path(path).read_text(encoding="utf-8"), Path(path))

    # ------------------------------------------------------------------ matching
    def applicable(self, product_category: str) -> list[CompiledRule]:
        return [c for c in self.compiled if c.applies(product_category)]

    def scan(self, text: str, product_category: str = "general") -> list[RuleHit]:
        norm = normalize(text)
        hits: list[RuleHit] = []
        for compiled in self.applicable(product_category):
            rule = compiled.rule
            category = self.categories[rule.category]
            excepted = [m.span() for p in compiled.exceptions for m in p.finditer(norm.text)]
            for matcher in compiled.matchers:
                for match in matcher.finditer(norm.text):
                    s, e = match.span()
                    if s == e or any(a < e and s < b for a, b in excepted):
                        continue
                    if rule.negation and _negated(norm.text, s):
                        continue
                    start, end = norm.to_original(s, e)
                    if compiled.unless is not None:
                        a, b = sentence_bounds(text, start, end)
                        if compiled.unless.search(normalize(text[a:b]).text):
                            continue
                    hits.append(RuleHit(
                        rule_id=rule.id, rule_name=rule.name, category=rule.category,
                        severity=rule.severity or category.severity, start=start, end=end,
                        quote=text[start:end], reason=rule.reason or category.description, rule_ids=[rule.id],
                    ))
        return _dedupe(hits)

    def check_disclosures(self, text: str, product_category: str) -> list[dict]:
        norm = normalize(text).text
        results = []
        for disclosure in self.disclosures:
            if "all" not in disclosure.applies_to and product_category not in disclosure.applies_to:
                continue
            results.append({
                "id": disclosure.id,
                "name": disclosure.name,
                "required": "、".join(disclosure.phrases),
                "present": any(normalize(phrase).text in norm for phrase in disclosure.phrases),
                "severity": disclosure.severity,
                "suggestion": disclosure.suggestion,
            })
        return results

    # ------------------------------------------------------------------ metadata
    def refs_for(self, category_id: str, rule_id: str | None, product_category: str
                 ) -> tuple[list[LawRef], list[LawRef], list[ExternalRef]]:
        category = self.categories[category_id]
        rule = self.rules.get(rule_id) if rule_id else None
        basis = [r for r in category.law_refs if r.applies(product_category)]
        if rule:
            basis += [r for r in rule.law_refs if r.applies(product_category)]
        penalty_source = rule.penalty_refs if rule and rule.penalty_refs else category.penalty_refs
        penalty = [r for r in penalty_source if r.applies(product_category)]
        references = list(category.references) + (list(rule.references) if rule else [])
        return basis, penalty, references

    def disclosure_refs(self, disclosure_id: str) -> list[LawRef]:
        for disclosure in self.disclosures:
            if disclosure.id == disclosure_id:
                return disclosure.law_refs
        return []

    def rewrite_spec(self, category_id: str, rule_id: str | None) -> RewriteSpec:
        rule = self.rules.get(rule_id) if rule_id else None
        if rule and rule.rewrite:
            return rule.rewrite
        return self.categories[category_id].rewrite

    def severity(self, category_id: str, rule_id: str | None) -> str:
        rule = self.rules.get(rule_id) if rule_id else None
        return (rule.severity if rule and rule.severity else None) or self.categories[category_id].severity

    def all_law_refs(self) -> list[tuple[str, LawRef]]:
        refs: list[tuple[str, LawRef]] = []
        for category in self.library.categories:
            refs += [(f"分类 {category.id}", r) for r in category.law_refs + category.penalty_refs]
        for rule in self.library.rules:
            refs += [(f"规则 {rule.id}", r) for r in rule.law_refs + rule.penalty_refs]
        for disclosure in self.disclosures:
            refs += [(f"声明 {disclosure.id}", r) for r in disclosure.law_refs]
        return refs

    def example_failures(self) -> list[str]:
        """Every rule ships positive and negative examples; both must behave."""
        failures = []
        for compiled in self.compiled:
            rule = compiled.rule
            product = "general" if "all" in rule.applies_to else rule.applies_to[0]
            for sample in rule.examples.hit:
                if not any(rule.id in h.rule_ids for h in self.scan(sample, product)):
                    failures.append(f"规则 {rule.id} 的正例没有命中：{sample}")
            for sample in rule.examples.pass_:
                if any(rule.id in h.rule_ids for h in self.scan(sample, product)):
                    failures.append(f"规则 {rule.id} 的反例被误命中：{sample}")
        return failures


def _dedupe(hits: list[RuleHit]) -> list[RuleHit]:
    """Within one category, overlapping hits become one finding with the longest span."""
    hits.sort(key=lambda h: (h.start, -h.length))
    kept: list[RuleHit] = []
    for hit in hits:
        same = next((k for k in kept if k.category == hit.category and k.start < hit.end and hit.start < k.end), None)
        if same is None:
            kept.append(hit)
            continue
        if hit.length > same.length:
            ids = same.rule_ids
            same.rule_id, same.rule_name, same.start, same.end = hit.rule_id, hit.rule_name, hit.start, hit.end
            same.quote, same.reason, same.severity = hit.quote, hit.reason, hit.severity
            same.rule_ids = [hit.rule_id] + [i for i in ids if i != hit.rule_id]
        elif hit.rule_id not in same.rule_ids:
            same.rule_ids.append(hit.rule_id)
    kept.sort(key=lambda h: h.start)
    return kept
