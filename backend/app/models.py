"""ORM models.

A review keeps a snapshot of everything it was judged against (product facts, rule
library version and hash, model), so a decision made today can still be explained after
the rules change.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


def iso(value: datetime | None) -> str | None:
    """ISO 8601 in UTC. SQLite drops tzinfo, so naive values are treated as UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(16))  # admin | reviewer | operator
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sku: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    brand: Mapped[str] = mapped_column(String(64))
    category: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text, default="")
    facts: Mapped[list] = mapped_column(JSON, default=list)  # [{"key": "核心成分", "value": "5%烟酰胺"}]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Review(Base):
    __tablename__ = "reviews"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(128), default="")
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    product_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    mode: Mapped[str] = mapped_column(String(16), default="review")  # review | generate
    input_type: Mapped[str] = mapped_column(String(8), default="text")  # text | srt
    source_raw: Mapped[str] = mapped_column(Text, default="")  # what the user submitted (raw SRT)
    source_text: Mapped[str] = mapped_column(Text, default="")  # the script the offsets refer to
    cues: Mapped[list] = mapped_column(JSON, default=list)
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    # queued | running | pending (awaiting human) | approved | rejected | failed
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    risk_level: Mapped[str | None] = mapped_column(String(8), nullable=True)
    counts: Mapped[dict] = mapped_column(JSON, default=dict)
    selling_points: Mapped[list] = mapped_column(JSON, default=list)
    disclosures: Mapped[list] = mapped_column(JSON, default=list)
    rewrite: Mapped[dict] = mapped_column(JSON, default=dict)
    rejected: Mapped[list] = mapped_column(JSON, default=list)
    validation: Mapped[dict] = mapped_column(JSON, default=dict)
    ruleset_version: Mapped[str] = mapped_column(String(32), default="")
    ruleset_hash: Mapped[str] = mapped_column(String(16), default="")
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Final human decision
    decision: Mapped[str | None] = mapped_column(String(16), nullable=True)  # approve | revise | reject
    decision_version: Mapped[str | None] = mapped_column(String(16), nullable=True)  # original | rewrite | edited
    decision_note: Mapped[str] = mapped_column(Text, default="")
    final_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_check: Mapped[dict] = mapped_column(JSON, default=dict)
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Finding(Base):
    __tablename__ = "findings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("reviews.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(8))  # F1, F2 … stable within a review
    category: Mapped[str] = mapped_column(String(32), index=True)
    severity: Mapped[str] = mapped_column(String(8))
    start: Mapped[int] = mapped_column(Integer)
    end: Mapped[int] = mapped_column(Integer)
    quote: Mapped[str] = mapped_column(Text)
    rule_id: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    channels: Mapped[list] = mapped_column(JSON, default=list)
    data: Mapped[dict] = mapped_column(JSON, default=dict)  # citations, reason, suggestion, cue, evidence
    verdict: Mapped[str | None] = mapped_column(String(16), nullable=True)  # confirmed | false_positive
    verdict_note: Mapped[str] = mapped_column(Text, default="")
    verdict_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    verdict_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Run(Base):
    """One pipeline execution; every agent step inside it is a Span."""

    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    review_id: Mapped[int | None] = mapped_column(ForeignKey("reviews.id"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(16), default="review")  # review | recheck
    status: Mapped[str] = mapped_column(String(16), default="running")
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    tokens_estimated: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Span(Base):
    __tablename__ = "spans"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=0)
    agent: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok | error | skipped | degraded
    input: Mapped[dict] = mapped_column(JSON, default=dict)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    started_ms: Mapped[int] = mapped_column(Integer, default=0)  # offset from run start
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)


class EvalRun(Base):
    __tablename__ = "eval_runs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    triggered_by: Mapped[str] = mapped_column(String(64), default="")
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    ruleset_version: Mapped[str] = mapped_column(String(32), default="")
    ruleset_hash: Mapped[str] = mapped_column(String(16), default="")
    dataset_hash: Mapped[str] = mapped_column(String(16), default="")
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    cases: Mapped[list] = mapped_column(JSON, default=list)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(32))
    target: Mapped[str] = mapped_column(String(64), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

