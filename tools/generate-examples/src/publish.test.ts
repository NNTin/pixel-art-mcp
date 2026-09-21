import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publish, splitUnits } from "./publish.js";

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("splitUnits", () => {
  it("returns a single unit, unsplit, when the zip has no multi-clip manifests", () => {
    const data = zipSync({
      "CANDLE/manifest.json": textBytes(JSON.stringify({ id: "CANDLE", name: "Candle" })),
      "CANDLE/sprite.png": textBytes("fake-png"),
    });
    const units = splitUnits("candle", "pixel-agents.zip", data);
    expect(units).toHaveLength(1);
    expect(units[0]?.label).toBe("candle/pixel-agents.zip");
    expect(units[0]?.data).toBe(data);
  });

  it("splits a multi-clip zip into one labeled unit per clip", () => {
    const data = zipSync({
      "RAIN_BARREL_EMPTY/manifest.json": textBytes(
        JSON.stringify({ id: "RAIN_BARREL_EMPTY", name: "Empty" }),
      ),
      "RAIN_BARREL_EMPTY/sprite.png": textBytes("empty"),
      "RAIN_BARREL_FULL/manifest.json": textBytes(
        JSON.stringify({ id: "RAIN_BARREL_FULL", name: "Full" }),
      ),
      "RAIN_BARREL_FULL/sprite.png": textBytes("full"),
    });
    const units = splitUnits("rain-barrel", "pixel-agents.zip", data);
    expect(units.map((u) => u.label).sort()).toEqual([
      "rain-barrel/pixel-agents.zip [RAIN_BARREL_EMPTY]",
      "rain-barrel/pixel-agents.zip [RAIN_BARREL_FULL]",
    ]);
  });
});

describe("publish", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-index-publish-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeExample(name: string, filename: string, data: Uint8Array): void {
    const exampleDir = path.join(dir, name);
    mkdirSync(exampleDir, { recursive: true });
    writeFileSync(path.join(exampleDir, filename), data);
  }

  it("POSTs every example's package zip and reports pass/fail per unit", async () => {
    const received: { path: string; auth: string | undefined; body: Buffer }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          body: Buffer.concat(chunks),
        });
        if (req.url === "/api/v1/assets") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ assetId: "SOME_ID" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const candleZip = zipSync({ "CANDLE/manifest.json": textBytes("{}") });
    writeExample("candle", "pixel-agents.zip", candleZip);
    // A folder with no installable package should be skipped, not fail the run.
    mkdirSync(path.join(dir, "webview"), { recursive: true });

    try {
      const ok = await publish(`http://127.0.0.1:${String(port)}`, dir, "test-token", []);
      expect(ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]?.path).toBe("/api/v1/assets");
      expect(received[0]?.auth).toBe("Bearer test-token");
      expect(received[0]?.body.equals(Buffer.from(candleZip))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("returns false when pixel-index rejects an upload", async () => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(422, { "content-type": "text/plain" });
        res.end("invalid manifest");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    writeExample("chair", "pixel-agents.zip", zipSync({ "CHAIR/manifest.json": textBytes("{}") }));

    try {
      const ok = await publish(`http://127.0.0.1:${String(port)}`, dir, "test-token", []);
      expect(ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
