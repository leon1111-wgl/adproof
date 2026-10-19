"""Provider-neutral chat types.

Agents talk to models only through ``LLMProvider.chat`` with OpenAI-style messages and a
``task`` tag. Real providers ignore the tag; the offline model uses it to pick a
deterministic handler, so every agent runs the same code path with or without a key.
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    estimated: bool = False


@dataclass
class ChatResult:
    content: str
    usage: Usage = field(default_factory=Usage)
    model: str = ""
    raw: Any = None


class LLMError(Exception):
    """Non-retryable provider failure (bad request, auth, unknown model, bad JSON)."""


class LLMRetryableError(LLMError):
    """Rate limit, timeout, 5xx, connection reset."""


class LLMProvider(ABC):
    name: str = "base"
    model: str = ""

    @abstractmethod
    def chat(self, messages: list[dict[str, str]], *, task: str, json_mode: bool = True,
             temperature: float | None = None) -> ChatResult: ...


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_json_object(text: str) -> dict[str, Any]:
    """Accept a bare object, a fenced block, or an object embedded in prose."""
    candidates = [text.strip()]
    candidates += [m.group(1).strip() for m in _FENCE.finditer(text)]
    first, last = text.find("{"), text.rfind("}")
    if 0 <= first < last:
        candidates.append(text[first : last + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(value, dict):
            return value
    raise LLMError(f"模型输出不是合法的 JSON 对象：{text[:200]}")


def complete_json(provider: LLMProvider, messages: list[dict[str, str]], *, task: str,
                  temperature: float | None = None) -> tuple[dict[str, Any], ChatResult]:
    """Call the model and parse a JSON object; on a parse failure, ask once more."""
    result = provider.chat(messages, task=task, json_mode=True, temperature=temperature)
    try:
        return parse_json_object(result.content), result
    except LLMError:
        retry = messages + [
            {"role": "assistant", "content": result.content},
            {"role": "user", "content": "上一次的输出不是合法的 JSON。请只输出一个 JSON 对象，不要任何解释。"},
        ]
        second = provider.chat(retry, task=task, json_mode=True, temperature=temperature)
        second.usage.prompt_tokens += result.usage.prompt_tokens
        second.usage.completion_tokens += result.usage.completion_tokens
        return parse_json_object(second.content), second


def payload_message(instruction: str, payload: dict[str, Any]) -> str:
    """User message = short instruction + the data as a fenced JSON block."""
    return f"{instruction}\n\n```json\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n```"


def extract_payload(content: str) -> dict[str, Any]:
    match = _FENCE.search(content)
    return json.loads(match.group(1)) if match else {}
