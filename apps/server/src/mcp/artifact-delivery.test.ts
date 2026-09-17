/**
 * Port of the bounded-chunk half of `tests/integration/test_artifact_delivery.py`: publishes a
 * synthetic artifact record directly into the store (mirroring the Python test's own
 * `service.store.put_record` shortcut, since exercising the real render pipeline isn't the point
 * of this test) and drives `get_artifact`/`get_artifact_chunk` over real JSON-RPC.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntime, type Runtime } from "../runtime.js";
import { McpTestClient } from "../test-support/mcp-client.js";

let dir: string;
let runtime: Runtime;
let baseUrl: string;
let projectId: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-server-artifacts-"));
  runtime = createRuntime({
    data_dir: path.join(dir, "data"),
    listen_host: "127.0.0.1",
    allowed_hosts: ["127.0.0.1"],
    allowed_origins: [],
  });
  await runtime.start();
  await runtime.app.listen({ port: 0, host: "127.0.0.1" });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a bound TCP address");
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  projectId = runtime.service.createProject("Delivery").id;
});

afterEach(async () => {
  await runtime.app.close();
  await runtime.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `data` under the project's scratch tree and registers it as an `artifact` record,
 * mirroring the Python test's `publish()` helper. */
function publish(filename: string, data: Buffer): string {
  const projectDir = path.join(runtime.service.store.root, "projects", projectId);
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, filename);
  writeFileSync(filePath, data);
  const record = runtime.service.artifactRecord(projectId, filePath, "test");
  runtime.service.store.putRecord("artifact", record);
  return record.id;
}

describe("get_artifact / get_artifact_chunk", () => {
  it("delivers small binary artifacts as an embedded resource, and reconstructs bytes via chunking", async () => {
    const client = new McpTestClient(baseUrl);
    await client.initialize();

    const data = Buffer.from("PK\x03\x04\x00\xff\x81binary", "binary");
    const artifactId = publish("sprites.zip", data);

    const result = await client.call("get_artifact", { artifact_id: artifactId });
    const content = result["content"] as {
      type: string;
      resource?: { blob: string; uri: string };
    }[];
    const resource = content.find((c) => c.type === "resource");
    expect(resource).toBeDefined();
    expect(Buffer.from(resource?.resource?.blob ?? "", "base64").equals(data)).toBe(true);
    expect(resource?.resource?.uri).toBe(`pixel-art://artifacts/${artifactId}`);

    let offset: number | null = 0;
    const decoded: Buffer[] = [];
    while (offset !== null) {
      const chunk = await client.data("get_artifact_chunk", {
        artifact_id: artifactId,
        offset,
        length: 5,
      });
      const raw = Buffer.from(chunk["data_base64"] as string, "base64");
      expect(chunk["offset"]).toBe(offset);
      expect(chunk["bytes_read"]).toBe(raw.length);
      expect(chunk["sha256"]).toBe(createHash("sha256").update(raw).digest("hex"));
      decoded.push(raw);
      offset = chunk["next_offset"] as number | null;
    }
    expect(Buffer.concat(decoded).equals(data)).toBe(true);
  });

  it("rejects out-of-range or wrongly-typed offset/length arguments", async () => {
    const client = new McpTestClient(baseUrl);
    await client.initialize();
    const artifactId = publish("tiny.zip", Buffer.from("abc"));

    for (const args of [{ offset: -1 }, { offset: 4 }, { length: 0 }, { length: 262_145 }]) {
      const result = await client.call(
        "get_artifact_chunk",
        { artifact_id: artifactId, ...args },
        true,
      );
      expect(result["isError"]).toBe(true);
    }
  });

  it("advertises get_artifact_chunk's bounds and capabilities' matching limits", async () => {
    const client = new McpTestClient(baseUrl);
    await client.initialize();
    const capabilities = await client.data("get_capabilities", {});
    const limits = capabilities["limits"] as Record<string, unknown>;
    expect(limits["max_artifact_chunk_bytes"]).toBe(262_144);

    const listing = await client.request("tools/list", {});
    const tools = listing["tools"] as {
      name: string;
      inputSchema: { properties: Record<string, { maximum?: number }> };
    }[];
    const chunkTool = tools.find((t) => t.name === "get_artifact_chunk");
    expect(chunkTool?.inputSchema.properties["length"]?.maximum).toBe(262_144);
  });
});
