"""Products, law snapshots and service metadata."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..agents import AGENT_LABELS
from ..db import get_db
from ..models import Product, User
from ..security import get_current_user, require_admin
from ..services import get_services

router = APIRouter(prefix="/api", tags=["catalog"])


def product_out(p: Product) -> dict:
    return {"id": p.id, "sku": p.sku, "name": p.name, "brand": p.brand, "category": p.category,
            "description": p.description, "facts": p.facts}


class FactIn(BaseModel):
    key: str = Field(min_length=1, max_length=32)
    value: str = Field(min_length=1, max_length=200)


class ProductIn(BaseModel):
    sku: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    brand: str = Field(min_length=1, max_length=64)
    category: str
    description: str = ""
    facts: list[FactIn] = Field(default_factory=list, max_length=20)


@router.get("/products")
def list_products(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    return [product_out(p) for p in db.execute(select(Product).order_by(Product.id)).scalars()]


@router.post("/products", status_code=201)
def create_product(body: ProductIn, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    if body.category not in get_services().ruleset.product_categories:
        raise HTTPException(422, f"未知的商品类目：{body.category}")
    if db.execute(select(Product).where(Product.sku == body.sku)).scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "SKU 已存在")
    product = Product(sku=body.sku, name=body.name, brand=body.brand, category=body.category,
                      description=body.description, facts=[f.model_dump() for f in body.facts])
    db.add(product)
    db.commit()
    return product_out(product)


@router.get("/laws")
def list_laws(_: User = Depends(get_current_user)) -> list[dict]:
    return get_services().laws.catalog()


@router.get("/meta")
def meta(_: User = Depends(get_current_user)) -> dict:
    services = get_services()
    ruleset = services.ruleset
    return {
        "provider": services.provider.name,
        "model": services.provider.model,
        "offline": services.provider.name == "mock",
        "simulated_latency_ms": services.settings.mock_latency_ms if services.provider.name == "mock" else 0,
        "ruleset": {"version": ruleset.version, "hash": ruleset.hash, "name": ruleset.name},
        "product_categories": ruleset.product_categories,
        "categories": [
            {"id": c.id, "label": c.label, "severity": c.severity, "description": c.description}
            for c in ruleset.categories.values()
        ],
        "agents": AGENT_LABELS,
        "laws": [{"id": law.id, "title": law.title, "version": law.version} for law in services.laws.laws.values()],
    }
