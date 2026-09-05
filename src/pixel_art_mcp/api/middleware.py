from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestBoundary:
    """Reject cross-origin requests and oversized bodies before multipart/JSON parsing."""

    def __init__(self, app: ASGIApp, max_bytes: int, origins: list[str]) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.origins = set(origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin")
        if origin is not None and origin.decode(errors="replace") not in self.origins:
            await JSONResponse({"error": "Origin not allowed"}, 403)(scope, receive, send)
            return
        if scope["method"] not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await JSONResponse({"error": "Request body too large"}, 413)(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)
