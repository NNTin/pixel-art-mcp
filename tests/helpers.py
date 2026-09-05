import asyncio
import time


class MCPClient:
    """Exercise the JSON-RPC wire contract, not direct Python tool handlers."""

    def __init__(self, http):
        self.http = http
        self.sequence = 0

    async def request(self, method, params):
        self.sequence += 1
        response = await self.http.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params},
            headers={
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2025-11-25",
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert "error" not in payload, payload
        return payload["result"]

    async def initialize(self):
        return await self.request(
            "initialize",
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        )

    async def call(self, name, arguments, allow_error=False):
        result = await self.request("tools/call", {"name": name, "arguments": arguments})
        if not allow_error:
            assert not result.get("isError"), result
        return result

    async def data(self, name, arguments):
        result = await self.call(name, arguments)
        return result["structuredContent"]

    async def wait(self, job_id, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = await self.data("get_job", {"job_id": job_id})
            if job["status"] in ("succeeded", "failed", "cancelled"):
                assert job["status"] == "succeeded", job
                return job
            await asyncio.sleep(0.2)
        raise AssertionError(f"Job {job_id} did not finish within {timeout}s")
