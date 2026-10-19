"""OpenAI-compatible chat adapter for Doubao (Volcengine Ark), Hunyuan and DeepSeek.

Agents need structured output, so requests ask for ``response_format: json_object``.
Some models reject that field with HTTP 400; the adapter then retries once without it
and relies on prompt instructions plus ``parse_json_object``.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from ..textutil import estimate_tokens
from .base import ChatResult, LLMError, LLMProvider, LLMRetryableError, Usage

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class OpenAICompatProvider(LLMProvider):
    name = "openai_compat"

    def __init__(self, base_url: str, api_key: str, model: str, *, timeout: float = 60.0,
                 json_mode: bool = True, temperature: float = 0.2, max_retries: int = 2,
                 transport: httpx.BaseTransport | None = None):
        if not base_url or not api_key or not model:
            raise LLMError(
                "openai_compat 需要 ADPROOF_LLM_BASE_URL（或 ADPROOF_LLM_PRESET）、ADPROOF_LLM_API_KEY 和 ADPROOF_LLM_MODEL"
            )
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.json_mode = json_mode
        self.temperature = temperature
        self.max_retries = max_retries
        self.client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={"Authorization": f"Bearer {api_key}"},
            transport=transport,
        )

    def _post(self, payload: dict[str, Any]) -> httpx.Response:
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            try:
                response = self.client.post(f"{self.base_url}/chat/completions", json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt == self.max_retries:
                    raise LLMRetryableError(f"网络错误：{exc}") from exc
            else:
                if response.status_code < 400:
                    return response
                if response.status_code not in RETRYABLE_STATUS:
                    return response  # caller decides (400 may mean "no json mode")
                if attempt == self.max_retries:
                    raise LLMRetryableError(f"HTTP {response.status_code}: {response.text[:300]}")
            time.sleep(delay)
            delay *= 2
        raise LLMRetryableError("unreachable")

    def chat(self, messages, *, task, json_mode=True, temperature=None) -> ChatResult:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
        }
        if json_mode and self.json_mode:
            payload["response_format"] = {"type": "json_object"}
        response = self._post(payload)
        if response.status_code == 400 and "response_format" in payload:
            payload.pop("response_format")
            response = self._post(payload)
        if response.status_code >= 400:
            raise LLMError(f"HTTP {response.status_code}: {response.text[:300]}")
        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"响应中没有 choices：{str(data)[:300]}")
        content = (choices[0].get("message") or {}).get("content") or ""
        usage_data = data.get("usage") or {}
        if usage_data:
            usage = Usage(usage_data.get("prompt_tokens", 0), usage_data.get("completion_tokens", 0))
        else:
            prompt_text = "".join(m.get("content", "") for m in messages)
            usage = Usage(estimate_tokens(prompt_text), estimate_tokens(content), estimated=True)
        return ChatResult(content=content, usage=usage, model=data.get("model") or self.model, raw=None)
