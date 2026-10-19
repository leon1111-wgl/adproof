from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..evals.dataset import dataset_hash, load_dataset
from ..evals.runner import run_eval
from ..models import EvalRun, User, iso
from ..security import get_current_user, require_admin
from ..services import get_services

router = APIRouter(prefix="/api/evals", tags=["evals"])


def run_and_store(db: Session, triggered_by: str) -> EvalRun:
    services = get_services()
    started = time.perf_counter()
    result = run_eval(services.pipeline(simulate_latency=False), load_dataset())
    run = EvalRun(
        triggered_by=triggered_by, provider=services.provider.name, model=services.provider.model,
        ruleset_version=services.ruleset.version, ruleset_hash=services.ruleset.hash, dataset_hash=dataset_hash(),
        metrics={"categories": result["categories"], "splits": result["splits"]}, cases=result["cases"],
        latency_ms=int((time.perf_counter() - started) * 1000),
    )
    db.add(run)
    db.commit()
    return run


def summary(run: EvalRun) -> dict:
    test = run.metrics["splits"]["test"]
    return {
        "id": run.id, "created_at": iso(run.created_at), "triggered_by": run.triggered_by,
        "provider": run.provider, "model": run.model, "ruleset_version": run.ruleset_version,
        "ruleset_hash": run.ruleset_hash, "dataset_hash": run.dataset_hash, "latency_ms": run.latency_ms,
        "offline": run.provider == "mock", "items": sum(s["items"] for k, s in run.metrics["splits"].items() if k != "all"),
        "test_f1": test["span"]["micro"]["f1"], "test_rewrite_pass_rate": test["rewrite"]["pass_rate"],
    }


@router.get("/runs")
def list_runs(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    return [summary(r) for r in db.execute(select(EvalRun).order_by(EvalRun.id.desc()).limit(50)).scalars()]


@router.get("/runs/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    run = db.get(EvalRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "评测记录不存在")
    return {**summary(run), "metrics": run.metrics, "cases": run.cases}


@router.post("/runs", status_code=201)
def create_run(db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    return summary(run_and_store(db, f"手动 · {user.name}"))
