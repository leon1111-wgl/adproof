"""Record the static demo that GitHub Pages serves.

Runs the real FastAPI app in-process with the offline mock model on the SYNTHETIC demo data
(no network, no model weights), and saves what the console reads:

    frontend/public/demo/index.json        accounts (no password), model, rule set, recording time
    frontend/public/demo/reviews.json      the seeded reviews, as the API returns them
    frontend/public/demo/templates/*.json  one finished review per workbench input the demo accepts:
                                           each sample script and every generate option, with and
                                           without the hallucination switch (named by template_name)
    frontend/public/demo/rechecks.json     sign-off re-checks of each unedited rewrite
    frontend/public/demo/rules-test.json   rule-engine dry runs of the default text, per category
    frontend/public/demo/api/...json       other GET responses, one file per API path
    frontend/src/specimen.json             one annotated review + the offline eval summary (landing page)

The console built with `pnpm build:demo` reads these files instead of calling the API; verdicts
and sign-offs are applied in page memory with the same rules as review_service.py.

    cd backend && python ../scripts/record_demo.py
"""

from __future__ import annotations

import json
import random
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from app import models  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.security import rate_limiter  # noqa: E402
from app.seed import DEMO_PASSWORD, DEMO_USERS  # noqa: E402

OUT = ROOT / "frontend" / "public" / "demo"
SPECIMEN = ROOT / "frontend" / "src" / "specimen.json"
SAMPLES = json.loads((ROOT / "frontend" / "src" / "samples.json").read_text(encoding="utf-8"))
RULE_TEST_TEXT = "这款精华是全网最好用的！98%的姐妹都回购了，别家都是智商税。本品不能代替药物。"  # RulesPage default
SPECIMEN_TITLE = "Mia植萃精华 · 口播脚本 v1"


def save(name: str, data: Any) -> None:
    target = OUT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def template_name(req: dict) -> str:
    """MIA-SERUM.review.0 / NOAH-OAT.generate.live.aggressive.1 (mirrored by frontend/src/demo.ts)."""
    options = [] if req["mode"] == "review" else [req["style"], req["tone"]]
    return ".".join([req["sku"], req["mode"], *options, str(int(req["inject_hallucination"]))])


def file_for(path: str) -> str:
    """/api/runs?limit=200 -> api/runs@limit=200.json (mirrored by frontend/src/demo.ts)."""
    return path.lstrip("/").replace("?", "@") + ".json"


def seed_ids(seed: int = 20261019) -> None:
    """Make run IDs reproducible across recordings (models.new_id uses uuid4)."""
    rng = random.Random(seed)
    models.uuid = type("SeededUUID", (), {"uuid4": staticmethod(lambda: uuid.UUID(int=rng.getrandbits(128)))})


def main() -> None:
    seed_ids()
    tmp = Path(tempfile.mkdtemp(prefix="adproof-demo-"))
    settings = Settings.from_env()
    settings.database_url = f"sqlite:///{tmp / 'demo.db'}"
    settings.seed_demo = True
    settings.mock_latency_ms = 0
    if settings.llm_provider != "mock":
        sys.exit("record_demo.py records the offline mock model only; unset ADPROOF_LLM_PROVIDER")
    client = TestClient(create_app(settings))  # seeds users, products, five reviews and one eval run
    rate_limiter.check = lambda *args, **kwargs: None  # one recording submits ~60 reviews in a few seconds

    tokens: dict[str, str] = {}
    users: list[dict] = []
    for account in DEMO_USERS:
        login = client.post("/api/auth/login", json={"email": account["email"], "password": DEMO_PASSWORD}).json()
        tokens[account["email"]] = login["token"]
        users.append(login["user"])
    leon, mia, emma = (f"{u}@adproof.demo" for u in ("leon", "mia", "emma"))

    def call(method: str, path: str, email: str = leon, body: Any = None) -> Any:
        res = client.request(method, path, json=body, headers={"Authorization": f"Bearer {tokens[email]}"})
        res.raise_for_status()
        return res.json()

    if OUT.exists():
        shutil.rmtree(OUT)

    # read-only views, recorded before any demo input exists
    for path in ("/api/meta", "/api/products", "/api/laws", "/api/rules", "/api/rules/yaml", "/api/rules/history",
                 "/api/evals/runs", "/api/runs?limit=200"):
        save(file_for(path), call("GET", path))
    eval_runs = call("GET", "/api/evals/runs")
    for run in eval_runs:
        save(file_for(f"/api/evals/runs/{run['id']}"), call("GET", f"/api/evals/runs/{run['id']}"))
    seeded = [call("GET", f"/api/reviews/{r['id']}") for r in call("GET", "/api/reviews?limit=200")["items"]]
    save("reviews.json", seeded)
    run_ids = [r["run_id"] for r in seeded if r["run_id"]]

    yaml_text = call("GET", "/api/rules/yaml")["yaml"]
    save("rules-validate.json", {"yaml": yaml_text, "result": call("POST", "/api/rules/validate", body={"yaml": yaml_text})})
    categories = call("GET", "/api/rules")["product_categories"]
    save("rules-test.json", [{"text": RULE_TEST_TEXT, "product_category": c,
                              "result": call("POST", "/api/rules/test", body={"text": RULE_TEST_TEXT, "product_category": c})}
                             for c in categories])

    # every input the workbench can send in the demo: sample scripts and all generate options
    products = {p["sku"]: p for p in call("GET", "/api/products")}
    requests: list[dict] = []
    for sku, sample in SAMPLES.items():
        input_type = "srt" if "srt" in sample else "text"
        for inject in (False, True):
            requests.append({"sku": sku, "mode": "review", "input_type": input_type, "content": sample[input_type],
                             "style": "short_video", "tone": "safe", "inject_hallucination": inject})
    for sku in products:
        for style in ("short_video", "live"):
            for tone in ("safe", "aggressive"):
                for inject in (False, True):
                    requests.append({"sku": sku, "mode": "generate", "input_type": "text", "content": "",
                                     "style": style, "tone": tone, "inject_hallucination": inject})
    templates = []
    for req in requests:
        body = {k: v for k, v in req.items() if k != "sku"} | {"product_id": products[req["sku"]]["id"]}
        created = call("POST", "/api/reviews", mia if req["inject_hallucination"] else emma, body)  # runs in-process
        review = call("GET", f"/api/reviews/{created['id']}")
        templates.append({"request": req, "review": review})
        if review["run_id"]:
            run_ids.append(review["run_id"])
    rows = {row["id"]: row for row in call("GET", "/api/runs?limit=500")}
    for t in templates:
        t["run_row"] = rows.get(t["review"]["run_id"])
        save(f"templates/{template_name(t['request'])}.json", t)

    # sign-off re-checks of each unedited rewrite (the text the edit dialog opens with)
    rechecks = []
    for review in [*seeded, *(t["review"] for t in templates)]:
        if review["status"] != "pending":
            continue
        text = ((review.get("rewrite") or {}).get("text") or review.get("source_text") or "").strip()
        if text and not any(r["sku"] == review["product"]["sku"] and r["text"] == text for r in rechecks):
            rechecks.append({"sku": review["product"]["sku"], "text": text,
                             "result": call("POST", f"/api/reviews/{review['id']}/recheck", mia, {"text": text})})
    save("rechecks.json", rechecks)

    for run_id in run_ids:  # traces, after the re-checks so they are complete
        save(file_for(f"/api/runs/{run_id}"), call("GET", f"/api/runs/{run_id}"))

    meta = call("GET", "/api/meta")
    save("index.json", {"users": users, "provider": meta["provider"], "model": meta["model"],
                        "ruleset": meta["ruleset"], "recorded_at": eval_runs[0]["created_at"]})

    specimen_review = next(r for r in seeded if r["title"] == SPECIMEN_TITLE)
    detail = call("GET", f"/api/evals/runs/{eval_runs[0]['id']}")
    test = detail["metrics"]["splits"]["test"]
    dev = detail["metrics"]["splits"]["dev"]
    specimen = {
        "title": specimen_review["title"],
        "product": {k: specimen_review["product"][k] for k in ("brand", "name", "category", "facts")},
        "text": specimen_review["source_text"],
        "findings": specimen_review["findings"],
        "disclosures": specimen_review["disclosures"],
        "rewrite": {k: specimen_review["rewrite"].get(k) for k in ("text", "diff", "passed", "rounds")},
        "ruleset": meta["ruleset"],
        "model": meta["model"],
        "eval": {
            "items": {"dev": dev["items"], "test": test["items"]},
            "test": {"precision": test["span"]["micro"]["precision"], "recall": test["span"]["micro"]["recall"],
                     "f1": test["span"]["micro"]["f1"], "strict_f1": test["span_strict"]["f1"],
                     "rewrite_passed": test["rewrite"]["passed"], "rewrite_scripts": test["rewrite"]["scripts"],
                     "evidence_valid": test["evidence"]["findings_valid"], "evidence_checked": test["evidence"]["findings_checked"]},
            "dev_f1": dev["span"]["micro"]["f1"],
        },
    }
    SPECIMEN.write_text(json.dumps(specimen, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    files = list(OUT.rglob("*.json"))
    secrets = {"login token": "eyJ", "demo password": DEMO_PASSWORD, "JWT secret": settings.jwt_secret}
    for f in [*files, SPECIMEN]:
        text = f.read_text(encoding="utf-8")
        for what, needle in secrets.items():
            if needle and needle in text:
                sys.exit(f"refusing to publish: {what} found in {f.relative_to(ROOT)}")
    size = sum(f.stat().st_size for f in files)
    print(f"recorded {len(seeded)} seeded reviews, {len(templates)} workbench inputs, {len(rechecks)} re-checks, "
          f"{len(files)} files, {size / 1e6:.2f} MB -> {OUT}")
    print(f"model: {meta['provider']} · {meta['model']} · rules {meta['ruleset']['version']} ({meta['ruleset']['hash'][:7]})")
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
