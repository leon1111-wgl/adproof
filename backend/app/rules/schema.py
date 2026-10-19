"""Schema of the YAML rule library. Validation errors are reported in Chinese because the
rule editor shows them to compliance staff, not developers."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Severity = Literal["high", "medium", "low"]


class LawRef(BaseModel):
    law: str
    article: int = Field(ge=1)
    paragraph: int | None = Field(default=None, ge=1)
    item: int | None = Field(default=None, ge=1)
    when: list[str] | None = None  # product categories; None = always

    def applies(self, product_category: str) -> bool:
        return self.when is None or product_category in self.when


class ExternalRef(BaseModel):
    """A source that is not in the local law snapshots. Always pending: nothing outside
    the verified snapshots is ever presented as checked text."""

    title: str
    issuer: str = ""
    status: Literal["pending"] = "pending"
    note: str = ""


class Sub(BaseModel):
    pattern: str
    replace: str


class RewriteSpec(BaseModel):
    strategy: Literal["replace", "delete_clause", "prefix"] = "delete_clause"
    replacements: dict[str, str] = Field(default_factory=dict)
    subs: list[Sub] = Field(default_factory=list)
    prefix_from: str | None = None
    prefix_to: str | None = None
    fallback: str | None = None
    note: str = ""


class Examples(BaseModel):
    hit: list[str] = Field(default_factory=list)
    pass_: list[str] = Field(default_factory=list, alias="pass")

    model_config = {"populate_by_name": True}


class Category(BaseModel):
    id: str
    label: str
    description: str = ""
    severity: Severity = "medium"
    priority: int = 50
    law_refs: list[LawRef] = Field(default_factory=list)
    penalty_refs: list[LawRef] = Field(default_factory=list)
    references: list[ExternalRef] = Field(default_factory=list)
    rewrite: RewriteSpec = Field(default_factory=RewriteSpec)


class Rule(BaseModel):
    id: str
    name: str
    category: str
    severity: Severity | None = None
    applies_to: list[str] = Field(default_factory=lambda: ["all"])
    patterns: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)
    negation: bool = False
    unless_sentence: str | None = None
    law_refs: list[LawRef] = Field(default_factory=list)  # added to the category's refs
    penalty_refs: list[LawRef] = Field(default_factory=list)
    references: list[ExternalRef] = Field(default_factory=list)
    reason: str = ""
    rewrite: RewriteSpec | None = None
    examples: Examples = Field(default_factory=Examples)
    enabled: bool = True

    @field_validator("id")
    @classmethod
    def _id(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Z]{3}-\d{2}", value):
            raise ValueError(f"规则编号 {value} 不符合格式（例如 ABS-01）")
        return value

    @model_validator(mode="after")
    def _has_matcher(self) -> "Rule":
        if not self.patterns and not self.keywords:
            raise ValueError(f"规则 {self.id} 至少需要一个 patterns 或 keywords")
        return self


class Disclosure(BaseModel):
    id: str
    name: str
    applies_to: list[str]
    required: str | list[str]  # any one of the phrases satisfies the requirement
    severity: Severity = "high"
    law_refs: list[LawRef] = Field(default_factory=list)
    suggestion: str = ""

    @property
    def phrases(self) -> list[str]:
        return [self.required] if isinstance(self.required, str) else list(self.required)


class RuleLibrary(BaseModel):
    version: str
    name: str
    description: str = ""
    product_categories: dict[str, str]
    categories: list[Category]
    rules: list[Rule]
    disclosures: list[Disclosure] = Field(default_factory=list)

    @model_validator(mode="after")
    def _references(self) -> "RuleLibrary":
        category_ids = {c.id for c in self.categories}
        product_ids = set(self.product_categories)
        seen: set[str] = set()
        for rule in self.rules:
            if rule.id in seen:
                raise ValueError(f"规则编号重复：{rule.id}")
            seen.add(rule.id)
            if rule.category not in category_ids:
                raise ValueError(f"规则 {rule.id} 引用了不存在的分类 {rule.category}")
            unknown = [c for c in rule.applies_to if c != "all" and c not in product_ids]
            if unknown:
                raise ValueError(f"规则 {rule.id} 的 applies_to 含未知类目：{', '.join(unknown)}")
        for category in self.categories:
            for ref in category.law_refs + category.penalty_refs:
                unknown = [c for c in ref.when or [] if c not in product_ids]
                if unknown:
                    raise ValueError(f"分类 {category.id} 的条款引用含未知类目：{', '.join(unknown)}")
        return self
