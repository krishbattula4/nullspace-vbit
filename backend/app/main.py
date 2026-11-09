"""FastAPI application entry point. Routers are registered here, one per phase."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, health, ws
from app.core.config import get_settings
from app.core.db import dispose_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("aiosqlite").setLevel(logging.WARNING)
log = logging.getLogger("nullspace")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    log.info("starting Nullspace backend (env=%s)", settings.app_env)
    yield
    await dispose_engine()
    log.info("backend stopped")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Nullspace API",
        version="0.1.0",
        description=(
            "Backend for the Nullspace verifiable end-to-end encrypted messenger. "
            "The server stores and relays ciphertext only."
        ),
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(ws.router)
    # P2: conversations router
    # P3: keys router
    return app


app = create_app()
