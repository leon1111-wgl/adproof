import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agents import ReviewPipeline
from app.config import BACKEND_DIR, Settings
from app.law import LawLibrary
from app.llm import MockLLM
from app.main import create_app
from app.rules import RuleSet
from app.security import rate_limiter
from app.seed import DEMO_PASSWORD

RULES = BACKEND_DIR / "rules" / "adproof_rules.yaml"
LAWS = BACKEND_DIR / "laws"

SERUM = {
    "sku": "MIA-SERUM", "name": "烟酰胺焕亮精华 30ml", "brand": "Mia植萃", "category": "cosmetics",
    "description": "以 5% 烟酰胺为主要成分的日常提亮精华。",
    "facts": [{"key": "核心成分", "value": "5%烟酰胺"}, {"key": "规格", "value": "30ml"},
              {"key": "价格", "value": "到手价 129 元"}],
}


@pytest.fixture(scope="session")
def ruleset() -> RuleSet:
    return RuleSet.load(RULES)


@pytest.fixture(scope="session")
def laws() -> LawLibrary:
    return LawLibrary(LAWS)


@pytest.fixture()
def pipeline(ruleset, laws) -> ReviewPipeline:
    return ReviewPipeline(MockLLM(), ruleset, laws)


@pytest.fixture()
def settings(tmp_path) -> Settings:
    s = Settings()
    s.database_url = f"sqlite:///{tmp_path / 'test.db'}"
    s.jwt_secret = "test-secret-with-at-least-32-bytes!!"
    # The rule editor writes to disk: work on a copy, never on the repository file.
    s.rules_path = Path(shutil.copy(RULES, tmp_path / "rules.yaml"))
    return s


@pytest.fixture()
def client(settings):
    rate_limiter._hits.clear()
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def login(client):
    def _login(email: str) -> dict:
        r = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['token']}"}

    return _login


@pytest.fixture()
def product_id(client, login):
    rows = client.get("/api/products", headers=login("emma@adproof.demo")).json()
    return {p["sku"]: p["id"] for p in rows}
