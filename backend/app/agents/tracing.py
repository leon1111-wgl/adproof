"""Span recorder for the multi-agent pipeline.

Each agent step is a span with its input, output, latency and token usage. The two review
channels run in parallel threads, so spans are buffered under a lock and written to the
database by ``flush()`` on the orchestrating thread (SQLAlchemy sessions are not
thread-safe). The pipeline flushes after every stage, which is what lets the UI show
progress while a run is still going.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from ..llm.base import ChatResult

MAX_STR = 800


def clip(value: Any, limit: int = MAX_STR) -> Any:
    """Keep traces readable: long strings are cut, structure is kept."""
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + f"…（共 {len(value)} 字）"
    if isinstance(value, dict):
        return {k: clip(v, limit) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        items = [clip(v, limit) for v in value[:50]]
        if len(value) > 50:
            items.append(f"…（共 {len(value)} 项）")
        return items
    return value


class SpanHandle:
    def __init__(self) -> None:
        self.output: dict[str, Any] = {}
        self.status = "ok"
        self.model: str | None = None
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.estimated = False

    def set(self, **output: Any) -> None:
        self.output.update(output)

    def fail(self, message: str) -> None:
        self.status = "error"
        self.output["error"] = message

    def degrade(self, message: str) -> None:
        self.status = "degraded"
        self.output["degraded"] = message

    def skip(self, message: str) -> None:
        self.status = "skipped"
        self.output["skipped"] = message

    def usage(self, result: ChatResult) -> None:
        self.model = result.model or self.model
        self.prompt_tokens += result.usage.prompt_tokens
        self.completion_tokens += result.usage.completion_tokens
        self.estimated = self.estimated or result.usage.estimated


@dataclass
class SpanRecord:
    seq: int
    agent: str
    name: str
    status: str
    input: dict
    output: dict
    started_ms: int
    latency_ms: int
    model: str | None
    prompt_tokens: int
    completion_tokens: int
    estimated: bool = False
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "seq": self.seq, "agent": self.agent, "name": self.name, "status": self.status,
            "input": self.input, "output": self.output, "started_ms": self.started_ms,
            "latency_ms": self.latency_ms, "model": self.model,
            "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens,
        }


class Tracer:
    """In-memory tracer (used by evals and as the base of the database tracer)."""

    def __init__(self) -> None:
        self.t0 = time.perf_counter()
        self.records: list[SpanRecord] = []
        self._lock = threading.Lock()
        self._seq = 0

    @contextmanager
    def span(self, agent: str, name: str, input: dict[str, Any] | None = None):
        handle = SpanHandle()
        started = time.perf_counter()
        try:
            yield handle
        except Exception as exc:
            handle.fail(f"{type(exc).__name__}: {exc}")
            raise
        finally:
            ended = time.perf_counter()
            with self._lock:
                self._seq += 1
                self.records.append(SpanRecord(
                    seq=self._seq, agent=agent, name=name, status=handle.status,
                    input=clip(input or {}), output=clip(handle.output),
                    started_ms=int((started - self.t0) * 1000), latency_ms=int((ended - started) * 1000),
                    model=handle.model, prompt_tokens=handle.prompt_tokens,
                    completion_tokens=handle.completion_tokens, estimated=handle.estimated,
                ))

    def flush(self) -> None:
        """Persist buffered spans (no-op in memory)."""

    @property
    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self.t0) * 1000)

    def totals(self) -> dict[str, Any]:
        with self._lock:
            return {
                "prompt_tokens": sum(r.prompt_tokens for r in self.records),
                "completion_tokens": sum(r.completion_tokens for r in self.records),
                "estimated": any(r.estimated for r in self.records),
                "spans": len(self.records),
            }
