from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditEvent, Finding, User, iso
from ..rules.schema import LawRef
from ..security import get_current_user, require_admin
from ..services import get_services

router = APIRouter(prefix="/api/rules", tags=["rules"])


class YamlIn(BaseModel):
    yaml: str = Field(min_length=1, max_length=200_000)


class TestIn(BaseModel):
    text: str = Field(min_length=1, max_length=6000)
    product_category: str = "general"


def _citations(refs: list[LawRef], kind: str) -> list[dict]:
    laws = get_services().laws
    out = []
    for ref in refs:
        c = laws.resolve(ref.law, ref.article, ref.paragraph, ref.item, kind).to_dict()
        c["when"] = ref.when
        out.append(c)
    return out


def _stats(db: Session) -> dict[str, dict]:
    rows = db.execute(
        select(
            Finding.rule_id,
            func.count(),
            func.sum(case((Finding.verdict == "false_positive", 1), else_=0)),
            func.sum(case((Finding.verdict == "confirmed", 1), else_=0)),
        ).where(Finding.rule_id.is_not(None)).group_by(Finding.rule_id)
    ).all()
    stats = {}
    for rule_id, hits, fps, confirmed in rows:
        judged = (fps or 0) + (confirmed or 0)
        stats[rule_id] = {"hits": hits, "false_positives": fps or 0, "confirmed": confirmed or 0,
                          "fp_rate": round((fps or 0) / judged, 4) if judged else None}
    return stats


@router.get("")
def get_rules(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    services = get_services()
    rs = services.ruleset
    stats = _stats(db)
    _, _, warnings = services.check_rules(rs.raw_text)
    categories = [{
        "id": c.id, "label": c.label, "description": c.description, "severity": c.severity, "priority": c.priority,
        "citations": _citations(c.law_refs, "basis") + _citations(c.penalty_refs, "penalty"),
        "references": [r.model_dump() for r in c.references],
        "rewrite": c.rewrite.model_dump(),
    } for c in rs.library.categories]
    rules = [{
        "id": r.id, "name": r.name, "category": r.category, "severity": r.severity or rs.categories[r.category].severity,
        "applies_to": r.applies_to, "patterns": r.patterns, "keywords": r.keywords, "exceptions": r.exceptions,
        "negation": r.negation, "unless_sentence": r.unless_sentence, "reason": r.reason, "enabled": r.enabled,
        "rewrite": r.rewrite.model_dump() if r.rewrite else None,
        "examples": {"hit": r.examples.hit, "pass": r.examples.pass_},
        "citations": _citations(r.law_refs, "basis") + _citations(r.penalty_refs, "penalty"),
        "references": [x.model_dump() for x in r.references],
        "stats": stats.get(r.id, {"hits": 0, "false_positives": 0, "confirmed": 0, "fp_rate": None}),
    } for r in rs.library.rules]
    disclosures = [{
        "id": d.id, "name": d.name, "applies_to": d.applies_to, "required": d.phrases, "severity": d.severity,
        "suggestion": d.suggestion, "citations": _citations(d.law_refs, "basis"),
    } for d in rs.disclosures]
    return {
        "version": rs.version, "name": rs.name, "hash": rs.hash, "description": rs.library.description,
        "product_categories": rs.product_categories, "categories": categories, "rules": rules,
        "disclosures": disclosures, "warnings": warnings,
    }


@router.get("/yaml")
def get_yaml(_: User = Depends(get_current_user)) -> dict:
    rs = get_services().ruleset
    return {"yaml": rs.raw_text, "version": rs.version, "hash": rs.hash}


@router.post("/validate")
def validate_yaml(body: YamlIn, _: User = Depends(get_current_user)) -> dict:
    candidate, errors, warnings = get_services().check_rules(body.yaml)
    return {
        "ok": candidate is not None and not errors, "errors": errors, "warnings": warnings,
        "rules": len(candidate.library.rules) if candidate else 0,
        "version": candidate.version if candidate else None, "hash": candidate.hash if candidate else None,
    }


@router.put("/yaml")
def save_yaml(body: YamlIn, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    services = get_services()
    before = services.ruleset.hash
    saved, errors, warnings = services.save_rules(body.yaml)
    if saved is None:
        raise HTTPException(422, {"message": "规则库校验未通过，未保存", "errors": errors})
    db.add(AuditEvent(user_id=user.id, action="rules.save", target="rules",
                      detail={"from": before, "to": saved.hash, "version": saved.version, "warnings": len(warnings)}))
    db.commit()
    return {"ok": True, "version": saved.version, "hash": saved.hash, "warnings": warnings}


@router.post("/test")
def test_rules(body: TestIn, _: User = Depends(get_current_user)) -> dict:
    rs = get_services().ruleset
    if body.product_category not in rs.product_categories:
        raise HTTPException(422, "未知的商品类目")
    hits = rs.scan(body.text, body.product_category)
    return {
        "hits": [{"rule_id": h.rule_id, "rule_ids": h.rule_ids, "rule_name": h.rule_name, "category": h.category,
                  "category_label": rs.categories[h.category].label, "severity": h.severity,
                  "start": h.start, "end": h.end, "quote": h.quote} for h in hits],
        "disclosures": rs.check_disclosures(body.text, body.product_category),
    }


@router.get("/history")
def history(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    rows = db.execute(select(AuditEvent, User).join(User, AuditEvent.user_id == User.id, isouter=True)
                      .where(AuditEvent.action == "rules.save").order_by(AuditEvent.id.desc()).limit(20)).all()
    return [{"at": iso(e.created_at), "user": u.name if u else None, **e.detail} for e, u in rows]
