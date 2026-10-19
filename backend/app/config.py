"""Runtime configuration.

Every setting comes from an environment variable prefixed with ``ADPROOF_`` so the same
image runs in dev, CI and production. Without any variable the app runs fully offline:
SQLite, the deterministic offline model, and the bundled rule library.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

# Base URLs of OpenAI-compatible chat endpoints. Model IDs change often, so they are
# never hard-coded: copy the model (or endpoint) ID from the vendor console into
# ADPROOF_LLM_MODEL.
PROVIDER_PRESETS: dict[str, str] = {
    "doubao": "https://ark.cn-beijing.volces.com/api/v3",  # 字节 · 火山方舟
    "hunyuan": "https://api.hunyuan.cloud.tencent.com/v1",  # 腾讯 · 混元
    "deepseek": "https://api.deepseek.com/v1",
}


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(f"ADPROOF_{name}")
    return value if value not in (None, "") else default


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = _env(name)
    return int(value) if value is not None else default


def _env_float(name: str, default: float) -> float:
    value = _env(name)
    return float(value) if value is not None else default


@dataclass
class Settings:
    database_url: str = "sqlite:///./adproof.db"
    jwt_secret: str = "dev-only-insecure-secret-change-me-in-prod"
    jwt_expire_minutes: int = 720
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])
    seed_demo: bool = True

    # Model: mock (deterministic, offline) | openai_compat
    llm_provider: str = "mock"
    llm_preset: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "adproof-offline"
    llm_timeout: float = 60.0
    llm_json_mode: bool = True  # send response_format={"type": "json_object"}
    llm_temperature: float = 0.2
    mock_latency_ms: int = 0  # demo only: simulated model latency of the offline model (0 in tests and CI)

    # Pipeline
    rules_path: Path = BACKEND_DIR / "rules" / "adproof_rules.yaml"
    laws_dir: Path = BACKEND_DIR / "laws"
    review_channels: tuple[str, ...] = ("rule", "llm")
    rewrite_max_rounds: int = 2
    max_script_chars: int = 6000

    @classmethod
    def from_env(cls) -> "Settings":
        s = cls()
        s.database_url = _env("DATABASE_URL", s.database_url)
        s.jwt_secret = _env("JWT_SECRET", s.jwt_secret)
        s.jwt_expire_minutes = _env_int("JWT_EXPIRE_MINUTES", s.jwt_expire_minutes)
        origins = _env("CORS_ORIGINS")
        if origins:
            s.cors_origins = [o.strip() for o in origins.split(",") if o.strip()]
        s.seed_demo = _env_bool("SEED_DEMO", s.seed_demo)

        s.llm_provider = _env("LLM_PROVIDER", s.llm_provider)
        s.llm_preset = _env("LLM_PRESET")
        s.llm_base_url = _env("LLM_BASE_URL") or PROVIDER_PRESETS.get(s.llm_preset or "")
        s.llm_api_key = _env("LLM_API_KEY")
        s.llm_model = _env("LLM_MODEL", s.llm_model if s.llm_provider == "mock" else "")
        s.llm_timeout = _env_float("LLM_TIMEOUT", s.llm_timeout)
        s.llm_json_mode = _env_bool("LLM_JSON_MODE", s.llm_json_mode)
        s.llm_temperature = _env_float("LLM_TEMPERATURE", s.llm_temperature)
        s.mock_latency_ms = _env_int("MOCK_LATENCY_MS", s.mock_latency_ms)

        rules = _env("RULES_PATH")
        if rules:
            s.rules_path = Path(rules)
        laws = _env("LAWS_DIR")
        if laws:
            s.laws_dir = Path(laws)
        channels = _env("REVIEW_CHANNELS")
        if channels:
            s.review_channels = tuple(c.strip() for c in channels.split(",") if c.strip())
        s.rewrite_max_rounds = _env_int("REWRITE_MAX_ROUNDS", s.rewrite_max_rounds)
        s.max_script_chars = _env_int("MAX_SCRIPT_CHARS", s.max_script_chars)
        return s


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings


def set_settings(settings: Settings) -> None:
    """Swap the process-wide settings (used by the app factory and tests)."""
    global _settings
    _settings = settings
