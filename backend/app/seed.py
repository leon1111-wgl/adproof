"""Demo data (SYNTHETIC): reviewers, products and a few reviews in different states.

Everything here is fictional. Demo reviews are only generated with the offline model, so
a deployment configured with a paid API key does not spend tokens on startup.
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Product, Review, User
from .security import hash_password

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
DEMO_PASSWORD = "adproof-demo"

DEMO_USERS = [
    {"email": "leon@adproof.demo", "name": "Leon", "title": "合规负责人", "role": "admin"},
    {"email": "mia@adproof.demo", "name": "Mia", "title": "合规审核", "role": "reviewer"},
    {"email": "emma@adproof.demo", "name": "Emma", "title": "内容运营", "role": "operator"},
    {"email": "jack@adproof.demo", "name": "Jack", "title": "直播运营", "role": "operator"},
]

DEMO_REVIEWS = [
    {
        "key": "serum", "title": "Mia植萃精华 · 口播脚本 v1", "sku": "MIA-SERUM", "by": "emma@adproof.demo",
        "input_type": "text",
        "content": "家人们，这款精华是全网最好用的，含30%烟酰胺，还能消炎祛痘！98%的姐妹都回购了，"
                   "别家卖的都是智商税。用了一个星期痘印都淡了。今天到手价99元，全网最低价。",
    },
    {
        "key": "earbuds", "title": "Jack数码耳机 · 直播字幕", "sku": "JACK-EARBUDS", "by": "jack@adproof.demo",
        "input_type": "srt",
        "content": "1\n00:00:00,000 --> 00:00:03,200\n家人们，Jack降噪耳机今天上车了\n\n"
                   "2\n00:00:03,200 --> 00:00:06,800\n降噪深度35dB，同价位吊打所有竞品\n\n"
                   "3\n00:00:06,800 --> 00:00:10,000\n单次续航12小时，性价比天花板\n\n"
                   "4\n00:00:10,000 --> 00:00:13,000\n到手价299元，点小黄车下单",
        "decision": {"by": "mia@adproof.demo", "decision": "approve", "version": "rewrite",
                     "note": "采用改写稿：续航按商品资料改为 8 小时，删除贬低竞品的表述。"},
    },
    {
        "key": "oat", "title": "Noah代餐粉 · 生成脚本（激进风格演示）", "sku": "NOAH-OAT", "by": "emma@adproof.demo",
        "mode": "generate", "tone": "aggressive",
    },
    {
        "key": "franchise", "title": "Leon优选加盟 · 招商口播", "sku": "LEON-FRANCHISE", "by": "jack@adproof.demo",
        "input_type": "text",
        "content": "想创业的朋友看过来，Leon优选社区零食店，加盟费29800元，稳赚不赔，3个月就能回本，月入过万不是问题。",
        "decision": {"by": "mia@adproof.demo", "decision": "reject",
                     "note": "招商脚本整体以收益承诺为卖点，且没有风险提示，退回重写。"},
    },
    {
        "key": "vc", "title": "Iris维C咀嚼片 · 口播脚本", "sku": "IRIS-VC", "by": "emma@adproof.demo",
        "input_type": "text",
        "content": "Iris维生素C咀嚼片，补充维生素C，每日1片，咀嚼食用。60片一瓶，到手价89元。本品不能代替药物。",
        "decision": {"by": "leon@adproof.demo", "decision": "approve", "version": "original", "note": "未发现问题，原稿通过。"},
    },
]


def load_products() -> list[dict]:
    return json.loads((SEED_DIR / "products.json").read_text(encoding="utf-8"))


def seed_users_and_products(db: Session) -> bool:
    """Idempotent. Returns True when this call created the demo data."""
    if db.execute(select(User).limit(1)).scalar_one_or_none() is not None:
        return False
    for u in DEMO_USERS:
        db.add(User(email=u["email"], name=u["name"], title=u["title"], role=u["role"],
                    password_hash=hash_password(DEMO_PASSWORD)))
    for p in load_products():
        db.add(Product(sku=p["sku"], name=p["name"], brand=p["brand"], category=p["category"],
                       description=p.get("description", ""), facts=p["facts"]))
    db.commit()
    return True


def seed_demo_reviews(db: Session) -> None:
    from .review_service import decide, execute_review, prepare_input, product_snapshot
    from .services import get_services

    users = {u.email: u for u in db.execute(select(User)).scalars()}
    products = {p.sku: p for p in db.execute(select(Product)).scalars()}
    max_chars = get_services().settings.max_script_chars
    for spec in DEMO_REVIEWS:
        product = products[spec["sku"]]
        mode = spec.get("mode", "review")
        input_type = spec.get("input_type", "text")
        text, cues = ("", []) if mode == "generate" else prepare_input(input_type, spec["content"], max_chars)
        review = Review(
            title=spec["title"], product_id=product.id, product_snapshot=product_snapshot(product), mode=mode,
            input_type=input_type, source_raw=spec.get("content", ""), source_text=text, cues=cues,
            options={"style": "short_video", "tone": spec.get("tone", "safe")}, created_by=users[spec["by"]].id,
        )
        db.add(review)
        db.commit()
        execute_review(review.id, simulate_latency=False)
        db.refresh(review)
        decision = spec.get("decision")
        if decision and review.status == "pending":
            decide(db, review, users[decision["by"]], decision["decision"], decision.get("version"), None, decision["note"])
