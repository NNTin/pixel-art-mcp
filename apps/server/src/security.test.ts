/**
 * Port of the Host/Origin/body-size half of
 * `tests/integration/test_mcp_http.py::test_http_upload_validation_and_local_boundary` and
 * `::test_http_body_limit_before_parsing`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime } from "./runtime.js";

/** `fetch()` (undici) refuses to let a caller override the `Host` header -- it's a "forbidden
 * request header" per the Fetch spec, silently dropped rather than sent. A raw `http.request`
 * has no such restriction, so this is what actually exercises the mismatched-Host-header path. */
function requestWithHost(url: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "GET",
        headers: { Host: host },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0 });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let dir: string;
let runtime: Runtime;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-server-security-"));
  runtime = createRuntime({
    data_dir: path.join(dir, "data"),
    listen_host: "127.0.0.1",
    allowed_hosts: ["127.0.0.1", "localhost"],
    allowed_origins: ["http://localhost:8000", "http://127.0.0.1:8000"],
  });
  await runtime.start();
  await runtime.app.listen({ port: 0, host: "127.0.0.1" });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a bound TCP address");
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await runtime.app.close();
  await runtime.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("Host/Origin/body-size protection", () => {
  it("rejects a mismatched Host header with 400, ahead of routing", async () => {
    const response = await requestWithHost(`${baseUrl}/health/live`, "attacker.example");
    expect(response.status).toBe(400);
  });

  it("rejects a disallowed Origin with 403", async () => {
    const response = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://unrelated.example" },
      body: JSON.stringify({ name: "Blocked" }),
    });
    expect(response.status).toBe(403);
  });

  it("allows a request with no Origin header at all", async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
  });

  it("rejects an oversized body before it reaches any parser", async () => {
    // A second, tiny-limit runtime -- Fastify's `bodyLimit` is fixed at app construction, so
    // this test needs its own instance rather than mutating the shared one from `beforeEach`.
    const smallDir = mkdtempSync(path.join(tmpdir(), "pixel-art-server-bodylimit-"));
    const small = createRuntime({
      data_dir: path.join(smallDir, "data"),
      listen_host: "127.0.0.1",
      allowed_hosts: ["127.0.0.1"],
      allowed_origins: [],
      max_upload_bytes: 1,
      max_script_bytes: 1,
    });
    await small.start();
    await small.app.listen({ port: 0, host: "127.0.0.1" });
    const address = small.app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a bound TCP address");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(70_000),
      });
      expect(response.status).toBe(413);
    } finally {
      await small.app.close();
      await small.stop();
      rmSync(smallDir, { recursive: true, force: true });
    }
  });
});
