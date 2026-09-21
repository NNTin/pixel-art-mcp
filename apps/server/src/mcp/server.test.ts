/**
 * Port of `tests/integration/test_mcp_http.py` and `tests/integration/test_authoring_mcp.py`:
 * drives the real Fastify app (real HTTP, real `Worker` + engine subprocess + imaging export) over
 * the actual JSON-RPC wire contract, not the tool handlers directly -- see `McpTestClient`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime } from "../runtime.js";
import { McpTestClient } from "../test-support/mcp-client.js";

let dir: string;
let runtime: Runtime;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-server-mcp-"));
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

describe("MCP Streamable HTTP transport", () => {
  it("advertises verbatim instructions, all 23 tools, and their exact annotations/schemas", async () => {
    const client = new McpTestClient(baseUrl);
    const initialized = await client.initialize();
    expect(initialized["instructions"]).toContain("execute_pixel_script");
    expect(initialized["instructions"]).toContain("get_pixel_engine_reference");

    const listing = await client.request("tools/list", {});
    const tools = listing["tools"] as { name: string; annotations?: Record<string, unknown> }[];
    const byName = new Map(tools.map((t) => [t.name, t]));

    const expectedNames = [
      "get_capabilities",
      "get_pixel_engine_reference",
      "get_asset_profile",
      "configure_asset",
      "write_pixel_art",
      "get_pixel_art",
      "edit_pixel_art",
      "get_asset_preview",
      "render_asset",
      "inspect_asset",
      "create_project",
      "list_projects",
      "get_project",
      "add_reference_image",
      "get_reference_image",
      "execute_pixel_script",
      "inspect_scene",
      "get_job",
      "wait_for_job",
      "inspect_sprite",
      "cancel_job",
      "get_artifact",
      "get_artifact_chunk",
    ];
    expect([...byName.keys()].sort()).toEqual([...expectedNames].sort());

    expect(byName.get("execute_pixel_script")?.annotations?.["readOnlyHint"]).toBe(false);
    expect(byName.get("execute_pixel_script")?.annotations?.["destructiveHint"]).toBe(true);
    expect(byName.get("execute_pixel_script")?.annotations?.["openWorldHint"]).toBe(true);
    expect(byName.get("get_pixel_engine_reference")?.annotations?.["readOnlyHint"]).toBe(true);
    expect(byName.get("get_pixel_engine_reference")?.annotations?.["destructiveHint"]).toBe(false);
    expect(byName.get("get_pixel_engine_reference")?.annotations?.["openWorldHint"]).toBe(false);
    expect(byName.get("inspect_scene")?.annotations?.["readOnlyHint"]).toBe(true);
    expect(byName.get("wait_for_job")?.annotations?.["readOnlyHint"]).toBe(true);
    expect(byName.get("write_pixel_art")?.annotations?.["destructiveHint"]).toBe(true);
    expect(byName.get("cancel_job")?.annotations?.["destructiveHint"]).toBe(true);
    expect(byName.get("add_reference_image")?.annotations?.["openWorldHint"]).toBe(true);

    // A nontrivial nested reused schema: `write_pixel_art`'s `definition` param is the whole
    // `PixelDefinitionSchema` from `@pixel-art-mcp/schema`. Confirmed end to end: its own
    // immediate field `.describe()` text (verbatim-ported prompt content) reaches the advertised
    // JSON Schema through the SDK's Zod-to-JSON-Schema conversion. What does NOT survive that
    // conversion -- confirmed by direct probe during this port, documented in `server.ts`'s top
    // comment -- is anything nested a level deeper than that (e.g. `PixelPose.rows`'s own
    // description, reached via `PixelDefinition.layers[].poses[]`): `packages/schema`'s
    // `arrayField`/`recordField` helpers wrap every list/map field in a `.transform()` for
    // Pydantic-verbatim `extra="forbid"` parity, and zod v4's `toJSONSchema` cannot describe a
    // nested transform's element type even in `io: "input"` mode, collapsing it to an
    // undifferentiated `additionalProperties: {}` alongside the one description string that does
    // survive. This is a real, verified gap between this port and Python (whose Pydantic schemas
    // have no such asymmetry) -- see this phase's final report.
    const writeSchema = byName.get("write_pixel_art") as unknown as {
      inputSchema: {
        properties: {
          definition: { properties: Record<string, { description?: string }> };
        };
      };
    };
    expect(
      writeSchema.inputSchema.properties.definition.properties["layers"]?.description,
    ).toContain("Complete ordered layer list");

    const chunkTool = byName.get("get_artifact_chunk") as unknown as {
      inputSchema: { properties: Record<string, { maximum?: number }> };
    };
    expect(chunkTool.inputSchema.properties["length"]?.maximum).toBe(262_144);
  });

  it("get_pixel_engine_reference returns the real compiled pixel-core API over real JSON-RPC", async () => {
    const client = new McpTestClient(baseUrl);
    await client.initialize();
    const reference = await client.data("get_pixel_engine_reference", {});
    expect(reference["type_declarations"]).toContain("export declare class Canvas");
    expect(reference["type_declarations"]).toContain("export declare class PixelArt");
    expect(Array.isArray(reference["examples"])).toBe(true);
    expect((reference["examples"] as unknown[]).length).toBeGreaterThan(0);
    expect(typeof reference["guidance"]).toBe("string");
  });

  it("rejects a malformed tool call with isError instead of a transport-level failure", async () => {
    const client = new McpTestClient(baseUrl);
    await client.initialize();
    const bad = await client.call("get_project", { project_id: "not-a-uuid" }, true);
    expect(bad["isError"]).toBe(true);
  });

  it("runs the full authoring -> render -> inspect workflow through real JSON-RPC calls", async () => {
    const client = new McpTestClient(baseUrl);
    await client.initialize();

    const project = await client.data("create_project", { name: "Chair" });
    const profile = await client.data("get_asset_profile", { kind: "furniture" });
    await client.data("configure_asset", {
      project_id: project["id"],
      specification: profile["specification"],
    });

    const writeJob = await client.data("write_pixel_art", {
      project_id: project["id"],
      definition: (profile["pixel_authoring"] as Record<string, unknown>)["example_definition"],
      expected_revision_id: null,
    });
    const written = await client.wait(writeJob["id"] as string);

    const source = await client.data("get_pixel_art", { project_id: project["id"] });
    expect(source["revision_id"]).toBe(written["result_revision_id"]);

    const renderJob = await client.data("render_asset", { project_id: project["id"] });
    const rendered = await client.wait(renderJob["id"] as string, 60_000);

    const inspected = await client.data("inspect_asset", { job_id: rendered["id"] });
    expect(inspected["job_id"]).toBe(rendered["id"]);

    const sprite = await client.data("inspect_sprite", { job_id: rendered["id"] });
    expect(sprite["job_id"]).toBe(rendered["id"]);

    const preview = await client.call("get_asset_preview", { job_id: rendered["id"] });
    expect(preview["content"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  }, 60_000);
});
