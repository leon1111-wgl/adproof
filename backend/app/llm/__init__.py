from ..config import Settings
from .base import ChatResult, LLMError, LLMProvider, LLMRetryableError, Usage, complete_json
from .mock import MockLLM
from .openai_compat import OpenAICompatProvider


def build_provider(settings: Settings) -> LLMProvider:
    if settings.llm_provider == "mock":
        return MockLLM(settings.llm_model or "adproof-offline", latency_ms=settings.mock_latency_ms)
    if settings.llm_provider == "openai_compat":
        return OpenAICompatProvider(
            settings.llm_base_url or "",
            settings.llm_api_key or "",
            settings.llm_model,
            timeout=settings.llm_timeout,
            json_mode=settings.llm_json_mode,
            temperature=settings.llm_temperature,
        )
    raise LLMError(f"未知的模型提供方：{settings.llm_provider}（可选 mock | openai_compat）")


__all__ = [
    "ChatResult", "LLMError", "LLMProvider", "LLMRetryableError", "MockLLM", "OpenAICompatProvider", "Usage",
    "build_provider", "complete_json",
]
