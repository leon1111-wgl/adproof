"""FastAPI application factory.

    uvicorn app.main:app --reload --port 8000

If ``frontend/dist`` exists (``pnpm build``), the console is served from the same
process, so one container is enough for a demo deployment.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .api import auth, catalog, evals, reviews, rules, traces
from .config import Settings, get_settings, set_settings
from .db import create_all, init_engine, new_session
from .models import EvalRun
from .seed import seed_demo_reviews, seed_users_and_products
from .services import Services, set_services

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    set_settings(settings)
    init_engine(settings.database_url)
    create_all()
    services = Services(settings)
    set_services(services)
    if settings.seed_demo:
        with new_session() as db:
            created = seed_users_and_products(db)
            if created and services.provider.name == "mock":
                seed_demo_reviews(db)
                if db.execute(select(EvalRun).limit(1)).scalar_one_or_none() is None:
                    evals.run_and_store(db, "启动时自动运行")

    app = FastAPI(
        title="AdProof API",
        version="1.0.0",
        description="带货素材合规审查 Multi-Agent：每条违规都能追溯到原文片段和法条原文",
    )
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
        allow_methods=["*"], allow_headers=["*"],
    )
    for module in (auth, catalog, reviews, rules, evals, traces):
        app.include_router(module.router)

    @app.get("/api/health", tags=["meta"])
    def health() -> dict:
        return {
            "status": "ok",
            "provider": services.provider.name,
            "model": services.provider.model,
            "ruleset": {"version": services.ruleset.version, "hash": services.ruleset.hash},
            "laws": [law.title for law in services.laws.laws.values()],
            "database": settings.database_url.split(":", 1)[0],
        }

    if FRONTEND_DIST.exists():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = FRONTEND_DIST / path
            if path and candidate.is_file() and FRONTEND_DIST in candidate.resolve().parents:
                return FileResponse(candidate)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


_app: FastAPI | None = None


def __getattr__(name: str):
    """Build ``app`` on first access so importing this module has no side effects
    (tests call ``create_app`` with their own settings)."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
