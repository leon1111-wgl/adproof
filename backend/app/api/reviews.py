from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Finding, Product, Review, User
from ..review_service import (
    decide, execute_review, prepare_input, product_snapshot, recheck, serialize_review, set_verdict,
)
from ..security import get_current_user, rate_limiter, require_decider
from ..services import get_services

router = APIRouter(prefix="/api/reviews", tags=["reviews"])


class ReviewIn(BaseModel):
    product_id: int
    mode: Literal["review", "generate"] = "review"
    input_type: Literal["text", "srt"] = "text"
    content: str = Field(default="", max_length=30000)
    title: str = Field(default="", max_length=128)
    style: Literal["short_video", "live"] = "short_video"
    tone: Literal["safe", "aggressive"] = "safe"
    inject_hallucination: bool = False


class VerdictIn(BaseModel):
    verdict: Literal["confirmed", "false_positive"] | None
    note: str = Field(default="", max_length=500)


class RecheckIn(BaseModel):
    text: str = Field(min_length=1, max_length=30000)


class DecisionIn(BaseModel):
    decision: Literal["approve", "revise", "reject"]
    version: Literal["original", "rewrite"] | None = None
    final_text: str | None = Field(default=None, max_length=30000)
    note: str = Field(default="", max_length=1000)


def _get_review(db: Session, review_id: int) -> Review:
    review = db.get(Review, review_id)
    if review is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "审查记录不存在")
    return review


@router.post("", status_code=201)
def create_review(body: ReviewIn, background: BackgroundTasks, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)) -> dict:
    rate_limiter.check(f"review:{user.id}", 30)
    product = db.get(Product, body.product_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "商品不存在")
    settings = get_services().settings
    if body.mode == "review":
        text, cues = prepare_input(body.input_type, body.content, settings.max_script_chars)
    else:
        text, cues = "", []
    if body.inject_hallucination and user.role == "operator":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "演示开关仅对审核员和管理员开放")
    title = body.title.strip() or f"{product.brand}{product.name} · {'生成脚本' if body.mode == 'generate' else '审查'}"
    review = Review(
        title=title, product_id=product.id, product_snapshot=product_snapshot(product), mode=body.mode,
        input_type=body.input_type if body.mode == "review" else "text",
        source_raw=body.content if body.mode == "review" else "", source_text=text, cues=cues,
        options={"style": body.style, "tone": body.tone, "inject_hallucination": body.inject_hallucination},
        created_by=user.id,
    )
    db.add(review)
    db.commit()
    background.add_task(execute_review, review.id)
    return serialize_review(db, review, user, detail=False)


@router.get("")
def list_reviews(status_filter: str | None = Query(default=None, alias="status"), limit: int = Query(default=100, le=500),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    query = select(Review).order_by(Review.id.desc()).limit(limit)
    if status_filter:
        query = query.where(Review.status == status_filter)
    reviews = db.execute(query).scalars().all()
    counts = dict(db.execute(select(Review.status, func.count()).group_by(Review.status)).all())
    return {"items": [serialize_review(db, r, user, detail=False) for r in reviews], "status_counts": counts}


@router.get("/{review_id}")
def get_review(review_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return serialize_review(db, _get_review(db, review_id), user)


@router.post("/{review_id}/findings/{key}/verdict")
def verdict(review_id: int, key: str, body: VerdictIn, db: Session = Depends(get_db),
            user: User = Depends(require_decider)) -> dict:
    review = _get_review(db, review_id)
    finding = db.execute(select(Finding).where(Finding.review_id == review.id, Finding.key == key)).scalar_one_or_none()
    if finding is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "该条结果不存在")
    set_verdict(db, review, finding, user, body.verdict, body.note)
    return serialize_review(db, review, user)


@router.post("/{review_id}/recheck")
def recheck_review(review_id: int, body: RecheckIn, db: Session = Depends(get_db),
                   user: User = Depends(require_decider)) -> dict:
    review = _get_review(db, review_id)
    if review.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "该脚本不在待终审状态")
    return recheck(db, review, body.text, user)


@router.post("/{review_id}/decision")
def decision(review_id: int, body: DecisionIn, db: Session = Depends(get_db),
             user: User = Depends(require_decider)) -> dict:
    review = _get_review(db, review_id)
    if body.decision == "approve" and body.version is None:
        raise HTTPException(422, "请选择通过原稿还是改写稿")
    decide(db, review, user, body.decision, body.version, body.final_text, body.note)
    return serialize_review(db, review, user)
