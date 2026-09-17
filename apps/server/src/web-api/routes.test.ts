/**
 * Integration coverage for the new `/api/*` web-IDE surface (Phase 9, Part 1) and the static
 * hosting of `apps/web`'s build output, against a real running Fastify app -- the same pattern
 * `../rest/routes.test.ts` uses for the Python-parity REST surface.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime } from "../runtime.js";

let dir: string;
let runtime: Runtime;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-server-webapi-"));
  runtime = createRuntime({
    data_dir: path.join(dir, "data"),
    listen_host: "127.0.0.1",
    allowed_hosts: ["127.0.0.1", "localhost"],
    allowed_origins: [],
    script_timeout: 30,
    render_timeout: 60,
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

async function createProject(name: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await response.json()) as { id: string };
}

/** A script's `art.save(scene)` requires the project to already have an asset configuration --
 * `createJobExecutor` rejects an authored `pixel_art` with no `configure_asset` on record (see
 * `packages/service/src/job-executor.ts`) -- exactly like a real `configure_asset` MCP call
 * before `execute_pixel_script`/`write_pixel_art`. */
async function createConfiguredProject(name: string): Promise<{ id: string }> {
  const project = await createProject(name);
  const configured = await fetch(`${baseUrl}/projects/${project.id}/asset`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "furniture",
      name,
      asset_id: name.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    }),
  });
  if (configured.status !== 200) {
    throw new Error(`failed to configure asset for test project: ${String(configured.status)}`);
  }
  return project;
}

// The default furniture asset profile expects a full 16x16 canvas declared on all four angles
// (see `packages/service/src/job-executor.e2e.test.ts`'s own `furnitureScript()`, which this
// mirrors) -- `PixelArt.validateTarget` 409s a render whose declared views don't match exactly.
const FURNITURE_ROW = "DGDGDGDGDGDGDGDG";
const FURNITURE_SCRIPT = [
  'import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";',
  "",
  "export default function main(scene: Scene): void {",
  '  const art = new PixelArt({ D: "#293039", G: "#f3cf65" }, { 0: [16, 16], 90: [16, 16], 180: [16, 16], 270: [16, 16] });',
  `  const canvas = Canvas.fromRows(${JSON.stringify(Array.from({ length: 16 }, () => FURNITURE_ROW))});`,
  "  for (const angle of [0, 90, 180, 270]) {",
  '    art.layer("body", angle, canvas);',
  "  }",
  "  art.save(scene);",
  "}",
  "",
].join("\n");

async function waitForTerminal(
  jobId: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    const job = (await response.json()) as { status: string };
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach a terminal state`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("/api web-IDE surface", () => {
  it("reports an empty, revision-less script for a brand-new project", async () => {
    const project = await createProject("Fresh");
    const response = await fetch(`${baseUrl}/api/projects/${project.id}/script`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project_id: project.id,
      revision_id: null,
      script: "",
    });
  });

  it("404s reading the script of an unknown project", async () => {
    const response = await fetch(
      `${baseUrl}/api/projects/00000000-0000-0000-0000-000000000000/script`,
    );
    expect(response.status).toBe(404);
  });

  it("submits a script, and the saved script round-trips through the read endpoint", async () => {
    const project = await createConfiguredProject("Chair");
    const submit = await fetch(`${baseUrl}/api/projects/${project.id}/script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: FURNITURE_SCRIPT, expected_revision_id: null }),
    });
    expect(submit.status).toBe(202);
    const job = (await submit.json()) as { id: string; operation: string; status: string };
    expect(job.operation).toBe("script");

    const finished = await waitForTerminal(job.id);
    expect(finished["status"]).toBe("succeeded");
    expect(finished["result_revision_id"]).toBeTruthy();

    const read = await fetch(`${baseUrl}/api/projects/${project.id}/script`);
    const body = (await read.json()) as { revision_id: string; script: string };
    expect(body.revision_id).toBe(finished["result_revision_id"]);
    expect(body.script).toBe(FURNITURE_SCRIPT);
  }, 30_000);

  it("surfaces Service.submitScript's optimistic-concurrency 409 unchanged", async () => {
    const project = await createConfiguredProject("Stale");
    const first = await fetch(`${baseUrl}/api/projects/${project.id}/script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: FURNITURE_SCRIPT, expected_revision_id: null }),
    });
    expect(first.status).toBe(202);
    await waitForTerminal(((await first.json()) as { id: string }).id);

    // Submitting again with the same (now-stale) `expected_revision_id: null` must 409, exactly
    // like `execute_pixel_script`'s existing optimistic-concurrency check.
    const stale = await fetch(`${baseUrl}/api/projects/${project.id}/script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: FURNITURE_SCRIPT, expected_revision_id: null }),
    });
    expect(stale.status).toBe(409);
  }, 30_000);

  it("streams job progress over SSE and ends the stream once the job is terminal", async () => {
    const project = await createConfiguredProject("Streamed");
    const submit = await fetch(`${baseUrl}/api/projects/${project.id}/script`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: FURNITURE_SCRIPT, expected_revision_id: null }),
    });
    const job = (await submit.json()) as { id: string };

    const response = await fetch(`${baseUrl}/api/jobs/${job.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("expected a readable event stream body");

    // Node/undici's Web-standard `ReadableStream` implements `Symbol.asyncIterator` at runtime;
    // the explicit `AsyncIterable<Uint8Array>` annotation just keeps the loop below fully typed.
    const body: AsyncIterable<Uint8Array> = response.body;
    const decoder = new TextDecoder();
    let buffer = "";
    const seenStatuses: string[] = [];
    const deadline = Date.now() + 20_000;
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) {
          const parsed = JSON.parse(dataLine.slice("data: ".length)) as { status: string };
          seenStatuses.push(parsed.status);
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (Date.now() > deadline) break;
    }
    expect(seenStatuses.length).toBeGreaterThan(0);
    expect(["succeeded", "failed", "cancelled"]).toContain(seenStatuses.at(-1));
  }, 30_000);

  it("reuses get_pixel_engine_reference's exact static content", async () => {
    const response = await fetch(`${baseUrl}/api/engine-reference`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type_declarations: string; guidance: string };
    expect(body.type_declarations).toContain("class Canvas");
    expect(body.guidance).toContain("Palette:");
  });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");

  it.runIf(existsSync(webDist))(
    "serves apps/web's built index.html from the same origin",
    async () => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toContain('<div id="root">');
    },
  );
});
