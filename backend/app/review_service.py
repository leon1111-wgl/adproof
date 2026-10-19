"""Review lifecycle: create → run the agents → human verdicts → final decision.

The pipeline itself is pure (no database); this module persists its output, writes the
trace, and enforces the sign-off rules:
- a submitter cannot sign off their own script (four-eyes);
- the original script can only be approved if every blocking finding was marked a
  false positive by a reviewer;
- an edited script is re-checked by the same agents before it can be approved.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .agents import PipelineInput, Tracer, summarize
from .agents.pipeline import BLOCKING
from .db import new_session
from .models import AuditEvent, Finding, Product, Review, Run, Span, User, iso, new_id
from .services import get_services
from .textutil import SRTError, parse_srt


class DBTracer(Tracer):
    """Writes spans to the database whenever the orchestrator flushes."""

    def __init__(self, db: Session, run: Run):
        super().__init__()
        self.db = db
        self.run = run
        self._written = 0

    def flush(self) -> None:
        with self._lock:
            pending = self.records[self._written:]
            self._written = len(self.records)
        for r in sorted(pending, key=lambda r: r.seq):
            self.db.add(Span(
                run_id=self.run.id, seq=r.seq, agent=r.agent, name=r.name, status=r.status, input=r.input,
                output=r.output, started_ms=r.started_ms, latency_ms=r.latency_ms, model=r.model,
                prompt_tokens=r.prompt_tokens, completion_tokens=r.completion_tokens,
            ))
        if pending:
            self.db.commit()


def user_brief(user: User | None) -> dict | None:
    return {"id": user.id, "name": user.name, "role": user.role, "title": user.title} if user else None


def product_snapshot(product: Product) -> dict:
    return {
        "id": product.id, "sku": product.sku, "name": product.name, "brand": product.brand,
        "category": product.category, "description": product.description, "facts": product.facts,
    }


def audit(db: Session, user: User | None, action: str, target: str, **detail) -> None:
    db.add(AuditEvent(user_id=user.id if user else None, action=action, target=target, detail=detail))


# ---------------------------------------------------------------------- create & run
def prepare_input(input_type: str, content: str, max_chars: int) -> tuple[str, list[dict]]:
    if input_type == "srt":
        try:
            text, cues = parse_srt(content)
        except SRTError as exc:
            raise HTTPException(422, f"字幕文件解析失败：{exc}") from exc
        cue_dicts = [c.to_dict() for c in cues]
    else:
        text, cue_dicts = content.replace("\r\n", "\n").strip(), []
    if not text.strip():
        raise HTTPException(422, "脚本内容为空")
    if len(text) > max_chars:
        raise HTTPException(422, f"脚本超过 {max_chars} 字，请分段提交")
    return text, cue_dicts


def execute_review(review_id: int, *, simulate_latency: bool = True) -> None:
    """Run the agents for one review in its own session (called as a background task)."""
    services = get_services()
    with new_session() as db:
        review = db.get(Review, review_id)
        if review is None or review.status not in ("queued", "failed"):
            return
        run = Run(id=new_id(), review_id=review.id, kind="review", provider=services.provider.name,
                  model=services.provider.model)
        db.add(run)
        review.status, review.run_id = "running", run.id
        review.ruleset_version, review.ruleset_hash = services.ruleset.version, services.ruleset.hash
        review.provider, review.model = services.provider.name, services.provider.model
        db.commit()
        tracer = DBTracer(db, run)
        options = review.options or {}
        try:
            out = services.pipeline(simulate_latency=simulate_latency).run(PipelineInput(
                product=review.product_snapshot,
                mode=review.mode,
                script=review.source_text,
                cues=review.cues or [],
                style=options.get("style", "short_video"),
                tone=options.get("tone", "safe"),
                inject_hallucination=bool(options.get("inject_hallucination")),
            ), tracer)
        except Exception as exc:  # noqa: BLE001 - recorded on the review and the run
            tracer.flush()
            review.status, review.error = "failed", f"{type(exc).__name__}: {exc}"
            run.status, run.error = "failed", review.error
            run.latency_ms = tracer.elapsed_ms
            db.commit()
            return
        tracer.flush()
        review.source_text = out["script"]
        review.selling_points = out["selling_points"]
        review.disclosures = out["disclosures"]
        review.rewrite = out["rewrite"] or {}
        review.rejected = out["rejected"]
        review.validation = out["validation"]
        review.counts, review.risk_level = out["counts"], out["risk_level"]
        for f in out["findings"]:
            db.add(Finding(
                review_id=review.id, key=f["key"], category=f["category"], severity=f["severity"],
                start=f["start"], end=f["end"], quote=f["quote"], rule_id=f["rule_id"], channels=f["channels"],
                data={k: v for k, v in f.items() if k not in (
                    "key", "category", "severity", "start", "end", "quote", "rule_id", "channels")},
            ))
        review.status = "pending"
        totals = tracer.totals()
        run.status = "completed"
        run.latency_ms = tracer.elapsed_ms
        run.prompt_tokens, run.completion_tokens = totals["prompt_tokens"], totals["completion_tokens"]
        run.tokens_estimated = totals["estimated"]
        db.commit()


# ---------------------------------------------------------------------- views
def serialize_finding(f: Finding, users: dict[int, User]) -> dict:
    return {
        "id": f.id, "key": f.key, "category": f.category, "severity": f.severity, "start": f.start, "end": f.end,
        "quote": f.quote, "rule_id": f.rule_id, "channels": f.channels, **(f.data or {}),
        "verdict": f.verdict, "verdict_note": f.verdict_note,
        "verdict_by": user_brief(users.get(f.verdict_by)) if f.verdict_by else None,
        "verdict_at": iso(f.verdict_at),
    }


def permissions(review: Review, viewer: User) -> dict:
    is_decider = viewer.role in ("admin", "reviewer")
    own = review.created_by == viewer.id
    open_ = review.status == "pending"
    reason = ""
    if not is_decider:
        reason = "只有审核员和管理员可以终审"
    elif own:
        reason = "提交人不能终审自己的脚本（四眼原则）"
    elif not open_:
        reason = "该脚本已完成终审" if review.decision else "流水线尚未完成"
    return {"can_verdict": is_decider and open_, "can_decide": is_decider and open_ and not own, "reason": reason}


def serialize_review(db: Session, review: Review, viewer: User, *, detail: bool = True) -> dict:
    users = {u.id: u for u in db.execute(select(User)).scalars()}
    data = {
        "id": review.id, "title": review.title, "status": review.status, "mode": review.mode,
        "input_type": review.input_type, "product_id": review.product_id, "product": review.product_snapshot,
        "risk_level": review.risk_level, "counts": review.counts,
        "ruleset_version": review.ruleset_version, "ruleset_hash": review.ruleset_hash,
        "provider": review.provider, "model": review.model, "run_id": review.run_id, "error": review.error,
        "created_by": user_brief(users.get(review.created_by)), "created_at": iso(review.created_at),
        "decision": review.decision, "decision_version": review.decision_version, "decision_note": review.decision_note,
        "decided_by": user_brief(users.get(review.decided_by)) if review.decided_by else None,
        "decided_at": iso(review.decided_at),
    }
    if not detail:
        return data
    findings = db.execute(select(Finding).where(Finding.review_id == review.id).order_by(Finding.start, Finding.id)).scalars()
    spans = []
    if review.run_id:
        spans = [
            {"agent": s.agent, "name": s.name, "status": s.status, "started_ms": s.started_ms, "latency_ms": s.latency_ms}
            for s in db.execute(select(Span).where(Span.run_id == review.run_id).order_by(Span.seq)).scalars()
        ]
    data.update({
        "source_text": review.source_text, "source_raw": review.source_raw if review.input_type == "srt" else None,
        "cues": review.cues, "options": review.options, "selling_points": review.selling_points,
        "findings": [serialize_finding(f, users) for f in findings], "disclosures": review.disclosures,
        "rewrite": review.rewrite, "rejected": review.rejected, "validation": review.validation,
        "final_text": review.final_text, "final_check": review.final_check,
        "permissions": permissions(review, viewer), "agents": spans,
    })
    return data


# ---------------------------------------------------------------------- human steps
def recheck(db: Session, review: Review, text: str, user: User) -> dict:
    """Run both review channels on an edited script. Nothing is rewritten automatically."""
    services = get_services()
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise HTTPException(422, "脚本内容为空")
    run = Run(id=new_id(), review_id=review.id, kind="recheck", provider=services.provider.name,
              model=services.provider.model)
    db.add(run)
    db.commit()
    tracer = DBTracer(db, run)
    result = services.pipeline().review(text, review.product_snapshot, tracer, stage="终审复检")
    tracer.flush()
    counts, risk = summarize(result.findings, result.disclosures)
    run.status, run.latency_ms = "completed", tracer.elapsed_ms
    db.commit()
    return {
        "text": text, "findings": result.findings, "disclosures": result.disclosures, "counts": counts,
        "risk_level": risk, "passed": result.passed(), "validation": result.validation, "run_id": run.id,
    }


def decide(db: Session, review: Review, user: User, decision: str, version: str | None,
           final_text: str | None, note: str) -> Review:
    if review.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "该脚本不在待终审状态")
    if review.created_by == user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "提交人不能终审自己的脚本（四眼原则）")
    findings = db.execute(select(Finding).where(Finding.review_id == review.id)).scalars().all()
    check: dict = {}
    if decision == "reject":
        if len(note.strip()) < 2:
            raise HTTPException(422, "驳回时请写明原因")
        review.status, review.final_text, version = "rejected", None, None
    elif decision == "approve" and version == "original":
        open_items = [f.key for f in findings if f.severity in BLOCKING and f.verdict != "false_positive"]
        missing = [d["id"] for d in review.disclosures or [] if not d.get("present")]
        if open_items or missing:
            raise HTTPException(status.HTTP_409_CONFLICT, {
                "message": "原稿仍有未标记为误报的问题，不能直接通过",
                "findings": open_items, "missing_disclosures": missing,
            })
        review.status, review.final_text = "approved", review.source_text
    elif decision == "approve" and version == "rewrite":
        rewrite = review.rewrite or {}
        if not rewrite.get("passed"):
            raise HTTPException(status.HTTP_409_CONFLICT, {"message": "改写稿没有通过复审，请修改后再提交"})
        review.status, review.final_text = "approved", rewrite.get("text") or review.source_text
    elif decision == "revise":
        if not final_text or not final_text.strip():
            raise HTTPException(422, "请提供修改后的脚本")
        check = recheck(db, review, final_text, user)
        if not check["passed"]:
            raise HTTPException(status.HTTP_409_CONFLICT, {
                "message": "修改稿复检仍有问题，请继续修改",
                "findings": [{"quote": f["quote"], "category_label": f["category_label"]} for f in check["findings"]
                             if f["severity"] in BLOCKING],
                "missing_disclosures": [d["id"] for d in check["disclosures"] if not d["present"]],
            })
        review.status, review.final_text, version = "approved", check["text"], "edited"
        review.final_check = {k: check[k] for k in ("counts", "risk_level", "passed", "validation", "run_id")}
    else:
        raise HTTPException(422, "未知的终审决定")

    now = datetime.now(timezone.utc)
    review.decision, review.decision_version, review.decision_note = decision, version, note.strip()
    review.decided_by, review.decided_at = user.id, now
    run = db.get(Run, review.run_id) if review.run_id else None
    if run is not None:
        created = run.created_at if run.created_at.tzinfo else run.created_at.replace(tzinfo=timezone.utc)
        last_seq = max([s.seq for s in db.execute(select(Span).where(Span.run_id == run.id)).scalars()] or [0])
        db.add(Span(
            run_id=run.id, seq=last_seq + 1, agent="human_review", name="人工终审",
            status="ok" if review.status == "approved" else "rejected",
            input={"reviewer": user.name, "open_findings": [f.key for f in findings if f.verdict is None]},
            output={"decision": decision, "version": version, "note": note.strip()},
            started_ms=int((now - created).total_seconds() * 1000), latency_ms=0,
        ))
    audit(db, user, f"review.{decision}", f"review:{review.id}", version=version, note=note.strip())
    db.commit()
    return review


def set_verdict(db: Session, review: Review, finding: Finding, user: User, verdict: str | None, note: str) -> Finding:
    if review.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "终审完成后不能再修改判定")
    if verdict == "false_positive" and len(note.strip()) < 2:
        raise HTTPException(422, "标记误报时请写明理由，方便规则维护")
    finding.verdict = verdict
    finding.verdict_note = note.strip()
    finding.verdict_by = user.id if verdict else None
    finding.verdict_at = datetime.now(timezone.utc) if verdict else None
    audit(db, user, "finding.verdict", f"review:{review.id}/{finding.key}", verdict=verdict, rule=finding.rule_id)
    db.commit()
    return finding
