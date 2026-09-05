import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from pixel_art_mcp import __version__
from pixel_art_mcp.api.middleware import RequestBoundary
from pixel_art_mcp.api.routes import routes
from pixel_art_mcp.config import Settings
from pixel_art_mcp.jobs.worker import Worker
from pixel_art_mcp.mcp.server import create_mcp
from pixel_art_mcp.models import DomainError
from pixel_art_mcp.projects.service import Service


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    service = Service(settings)
    worker = Worker(service)
    mcp = create_mcp(service)
    mcp_app = mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await worker.start()
            async with mcp.session_manager.run():
                yield
        finally:
            await worker.stop()
            service.store.close()

    app = FastAPI(title="Pixel Art MCP", version=__version__, lifespan=lifespan)
    app.state.service = service
    app.state.worker = worker
    app.state.mcp = mcp

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse({"error": str(exc)}, status_code=exc.status)

    app.include_router(routes(service))
    app.mount("/", mcp_app)
    app.add_middleware(
        RequestBoundary,
        max_bytes=4 * ((settings.max_upload_bytes + 2) // 3) + settings.max_script_bytes + 65536,
        origins=settings.allowed_origins,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings()
    # Native development is loopback-only; Docker overrides the container bind address.
    uvicorn.run(
        create_app(settings), host=settings.listen_host, port=8000, workers=1, proxy_headers=False
    )


if __name__ == "__main__":
    main()
