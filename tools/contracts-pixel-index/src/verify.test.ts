import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildResultDocument, formatReport, run, writeResultDocument } from "./verify.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

function allPassingHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === "/") {
    sendJson(res, 200, { commit: "cafef00d" });
    return;
  }
  if (req.url === "/openapi.json") {
    sendJson(res, 200, { paths: { "/api/v1/assets": { post: { parameters: [] } } } });
    return;
  }
  if (req.url?.startsWith("/api/v1/assets/schema/")) {
    sendJson(res, 404, {});
    return;
  }
  if (req.url === "/api/v1/assets?limit=1") {
    sendJson(res, 200, { assets: [], total: 0 });
    return;
  }
  sendJson(res, 404, {});
}

describe("run", () => {
  it("returns ok=true when no check fails (schema checks skipped via 404)", async () => {
    const server = await startServer(allPassingHandler);
    try {
      const { ok, results } = await run(server.baseUrl, 5);
      expect(ok).toBe(true);
      expect(results).toHaveLength(6);
      expect(results.map((r) => r.status)).toEqual([
        "pass",
        "pass",
        "skipped",
        "skipped",
        "skipped",
        "pass",
      ]);
    } finally {
      await server.close();
    }
  });

  it("returns ok=false when any check fails", async () => {
    const server = await startServer((_req, res) => {
      sendJson(res, 200, {});
    });
    try {
      const { ok, results } = await run(server.baseUrl, 5);
      expect(ok).toBe(false);
      expect(results[0]?.status).toBe("fail");
    } finally {
      await server.close();
    }
  });
});

describe("buildResultDocument", () => {
  it("counts pass/fail/skipped and builds a failed-checks summary", () => {
    const results = [
      { name: "a", status: "pass" as const, detail: "" },
      { name: "b", status: "fail" as const, detail: "bad" },
      { name: "c", status: "skipped" as const, detail: "" },
    ];
    const document = buildResultDocument("staging", "https://example.test", false, results);
    expect(document.schema_version).toBe(1);
    expect(document.environment).toBe("staging");
    expect(document.base_url).toBe("https://example.test");
    expect(document.status).toBe("fail");
    expect(document.counts).toEqual({ pass: 1, fail: 1, skipped: 1 });
    expect(document.checks).toEqual(results);
    expect(document.detail).toBe("Failed checks: b");
    expect(document.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("has an empty detail when ok", () => {
    const document = buildResultDocument("prod", "https://example.test", true, []);
    expect(document.status).toBe("pass");
    expect(document.detail).toBe("");
  });
});

describe("writeResultDocument", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomically writes the document as pretty JSON with a trailing newline", () => {
    dir = mkdtempSync(path.join(tmpdir(), "contracts-pixel-index-verify-"));
    const target = path.join(dir, "nested", "staging.json");
    const document = buildResultDocument("staging", "https://example.test", true, []);
    writeResultDocument(target, document);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.tmp`)).toBe(false);
    const written = readFileSync(target, "utf-8");
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written)).toEqual(document);
  });
});

describe("formatReport", () => {
  it("renders a markdown table with status icons", () => {
    const results = [
      { name: "root", status: "pass" as const, detail: "running commit abc" },
      { name: "assets-list", status: "fail" as const, detail: "bad | pipe" },
      { name: "manifest-schema-pet", status: "skipped" as const, detail: "" },
    ];
    const report = formatReport("staging", results);
    expect(report).toContain("## pixel-index contract check — staging");
    expect(report).toContain("| root | ✅ pass | running commit abc |");
    expect(report).toContain("| assets-list | ❌ fail | bad \\| pipe |");
    expect(report).toContain("| manifest-schema-pet | ⚠️ skipped | - |");
  });
});
