/**
 * Port of the plain-HTTP-surface half of `tests/integration/test_mcp_http.py` and
 * `tests/integration/test_authoring_mcp.py`: `/health/*`, asset-profiles, project CRUD, the
 * multipart reference upload, and `/artifacts/{id}` download, against a real running Fastify app.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime } from "../runtime.js";

let dir: string;
let runtime: Runtime;
let baseUrl: string;

/** A minimal valid PNG (1x1, coral-ish), enough for the reference-ingestion pipeline to accept. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-server-rest-"));
  runtime = createRuntime({
    data_dir: path.join(dir, "data"),
    listen_host: "127.0.0.1",
    allowed_hosts: ["127.0.0.1", "localhost"],
    allowed_origins: [],
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

describe("REST surface", () => {
  it("reports liveness always, readiness once the worker has started", async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { ready: boolean }).toEqual({ ready: true });
  });

  it("derives furniture layouts from ground/background query params, matching MCP's profile", async () => {
    const response = await fetch(
      `${baseUrl}/asset-profiles/furniture?ground_width=3&ground_depth=4&background_tiles=1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { layouts: { width: number; height: number }[] };
    expect(body.layouts.map((l) => [l.width, l.height])).toEqual([
      [48, 80],
      [64, 64],
      [48, 80],
      [64, 64],
    ]);

    expect((await fetch(`${baseUrl}/asset-profiles/furniture?ground_width=17`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/asset-profiles/unknown`)).status).toBe(400);
  });

  it("shares project/asset configuration state between REST and would-be MCP callers", async () => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Configured" }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };

    const configured = await fetch(`${baseUrl}/projects/${project.id}/asset`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "character", name: "Person" }),
    });
    expect(configured.status).toBe(200);

    const detail = await fetch(`${baseUrl}/projects/${project.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { asset_configuration: { id: string } | null };
    expect(detailBody.asset_configuration).not.toBeNull();

    const invalid = await fetch(`${baseUrl}/projects/${project.id}/asset`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pet", name: "No ID" }),
    });
    expect(invalid.status).toBe(422);

    // Configuration alone is insufficient: render requires an actual scene revision.
    const render = await fetch(`${baseUrl}/projects/${project.id}/asset/renders`, {
      method: "POST",
    });
    expect(render.status).toBe(409);

    const listed = await fetch(`${baseUrl}/projects`);
    expect(listed.status).toBe(200);
    const projects = (await listed.json()) as { id: string }[];
    expect(projects.some((p) => p.id === project.id)).toBe(true);
  });

  it("accepts a multipart reference upload and serves the download with a nosniff header", async () => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reference" }),
    });
    const project = (await created.json()) as { id: string };

    const png = Buffer.from(PNG_BASE64, "base64");
    const form = new FormData();
    form.set("file", new Blob([png], { type: "image/png" }), "chair.png");

    const uploaded = await fetch(`${baseUrl}/projects/${project.id}/references`, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const reference = (await uploaded.json()) as { original_artifact_id: string };

    const download = await fetch(`${baseUrl}/artifacts/${reference.original_artifact_id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    const downloaded = Buffer.from(await download.arrayBuffer());
    // PNG magic bytes: confirms real file bytes came back, not an empty/error body.
    expect(downloaded.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    expect((await fetch(`${baseUrl}/artifacts/not-a-uuid`)).status).toBe(422);
  });
});
