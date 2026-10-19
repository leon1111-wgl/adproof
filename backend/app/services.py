"""Process-wide singletons: model provider, law snapshots, the active rule library."""

from __future__ import annotations

import threading
from pathlib import Path

from .agents import ReviewPipeline
from .config import Settings, get_settings
from .law import LawLibrary
from .llm import LLMProvider, MockLLM, build_provider
from .rules import RuleLibraryError, RuleSet


class Services:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.provider: LLMProvider = build_provider(settings)
        self.laws = LawLibrary(settings.laws_dir)
        self.ruleset = RuleSet.load(settings.rules_path)
        self._lock = threading.Lock()

    def pipeline(self, *, simulate_latency: bool = True) -> ReviewPipeline:
        """Simulated latency (demo only) never applies to seeding or evaluation runs."""
        s = self.settings
        provider = self.provider
        if not simulate_latency and isinstance(provider, MockLLM) and provider.latency_ms:
            provider = MockLLM(provider.model)
        return ReviewPipeline(provider, self.ruleset, self.laws, s.review_channels, s.rewrite_max_rounds,
                              s.max_script_chars)

    # ------------------------------------------------------------------ rule editing
    def check_rules(self, raw_text: str) -> tuple[RuleSet | None, list[str], list[str]]:
        """Validate a candidate library. Errors block saving; warnings (citations that do
        not resolve to the verified snapshot) are allowed but shown as 待核对."""
        try:
            candidate = RuleSet.from_text(raw_text, Path(self.settings.rules_path))
        except RuleLibraryError as exc:
            return None, exc.errors, []
        errors = candidate.example_failures()
        warnings = []
        for where, ref in candidate.all_law_refs():
            citation = self.laws.resolve(ref.law, ref.article, ref.paragraph, ref.item)
            if citation.status != "verified":
                warnings.append(f"{where} 引用 {citation.label}：{citation.note}")
        return candidate, errors, warnings

    def save_rules(self, raw_text: str) -> tuple[RuleSet | None, list[str], list[str]]:
        with self._lock:
            candidate, errors, warnings = self.check_rules(raw_text)
            if candidate is None or errors:
                return None, errors, warnings
            Path(self.settings.rules_path).write_text(raw_text, encoding="utf-8")
            self.ruleset = candidate
            return candidate, [], warnings


_services: Services | None = None


def get_services() -> Services:
    global _services
    if _services is None:
        _services = Services(get_settings())
    return _services


def set_services(services: Services) -> None:
    global _services
    _services = services
