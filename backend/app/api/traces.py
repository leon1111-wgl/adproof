from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Review, Run, Span, User, iso
from ..security import get_current_user

router = APIRouter(prefix="/api/runs", tags=["traces"])


def run_out(run: Run, review: Review | None, span_count: int) -> dict:
    return {
        "id": run.id, "kind": run.kind, "status": run.status, "provider": run.provider, "model": run.model,
        "latency_ms": run.latency_ms, "prompt_tokens": run.prompt_tokens, "completion_tokens": run.completion_tokens,
        "tokens_estimated": run.tokens_estimated, "error": run.error, "created_at": iso(run.created_at),
        "review": {"id": review.id, "title": review.title, "status": review.status} if review else None,
        "spans": span_count,
    }


@router.get("")
def list_runs(limit: int = Query(default=100, le=500), db: Session = Depends(get_db),
              _: User = Depends(get_current_user)) -> list[dict]:
    counts = dict(db.execute(select(Span.run_id, func.count()).group_by(Span.run_id)).all())
    rows = db.execute(select(Run, Review).join(Review, Run.review_id == Review.id, isouter=True)
                      .order_by(Run.created_at.desc()).limit(limit)).all()
    return [run_out(run, review, counts.get(run.id, 0)) for run, review in rows]


@router.get("/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "链路不存在")
    review = db.get(Review, run.review_id) if run.review_id else None
    spans = db.execute(select(Span).where(Span.run_id == run.id).order_by(Span.seq)).scalars().all()
    return {
        **run_out(run, review, len(spans)),
        "spans": [{
            "id": s.id, "seq": s.seq, "agent": s.agent, "name": s.name, "status": s.status, "input": s.input,
            "output": s.output, "started_ms": s.started_ms, "latency_ms": s.latency_ms, "model": s.model,
            "prompt_tokens": s.prompt_tokens, "completion_tokens": s.completion_tokens,
        } for s in spans],
    }
