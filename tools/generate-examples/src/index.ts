#!/usr/bin/env node
/**
 * Port of `scripts/generate_examples.py`: generate every example through real MCP calls and
 * download complete export artifacts.
 *
 * Drives the *running MCP service* over Streamable HTTP, using the official
 * `@modelcontextprotocol/sdk` client (the same package `apps/server` uses for its server side --
 * see `apps/server/src/app.ts`/`apps/server/src/mcp/server.ts`), through the full
 * example-generation pipeline (`get_asset_profile` -> `create_project` -> `configure_asset` ->
 * `write_pixel_art`/`execute_pixel_script`/`edit_pixel_art` -> `wait_for_job` -> `render_asset`
 * -> `inspect_asset`/`inspect_sprite` -> `get_asset_preview` -> `get_artifact`) for every entry
 * in `examples/asset-specs.json`, downloads artifacts, and writes a static HTML gallery.
 *
 * **Known gap vs. the Python original** (flagged in this port's introducing phase's report):
 * 7 of the 9 entries in `examples/asset-specs.json` (every one with a non-empty `"scripts"`
 * list -- candle/chair/modify-chair/oil-lamp/rain-barrel/street-lamp/character/pet all use
 * `.py` files under `examples/`) drive `execute_pixel_script` with *Python* source. The TS
 * rewrite's `execute_pixel_script` compiles submitted source as strict TypeScript against
 * `@pixel-art-mcp/pixel-core` (see `docs/typescript-rewrite.md`'s "Script sandboxing" section) --
 * it cannot run Python. Running this script against those examples will fail exactly the way
 * `wait()` below is written to fail: a real job failure surfaced as a thrown error, not a silent
 * skip. Only `thermometer` and `cat-tree` (both pure `"definition"` JSON, no `"scripts"`) work
 * end to end with this port today. Porting `examples/*.py` to TypeScript is out of scope for
 * this port (those files are pixel-art *drawing programs*, not thin config -- 625 lines total
 * across 8 files -- and were left untouched per this phase's explicit constraints); a real gap
 * the orchestrating session needs before deleting the Python source tree.
 *
 * Run:
 *   node dist/index.js --base-url http://localhost:8000 --output tmp/asset-workflow
 *   node dist/index.js --only thermometer cat-tree
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { unzipSync } from "fflate";

import { clipLinksHtml, exampleCardHtml, galleryIndexHtml } from "./gallery.js";
import { splitMultiClipZip } from "./pixel-index-packaging.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");

type JsonRecord = Record<string, unknown>;

interface ExampleSpec {
  readonly scripts?: readonly string[];
  readonly definition?: string;
  readonly incremental?: boolean;
  readonly specification: JsonRecord;
}

interface ArtifactRef {
  readonly id: string;
  readonly filename: string;
  readonly size_bytes: number;
  readonly [key: string]: unknown;
}

/** Thin wrapper around the SDK client: unwraps `structuredContent`, throwing on `isError` the
 * same way Python's `call()` closure raised `RuntimeError`. */
async function callTool(client: Client, name: string, args: JsonRecord): Promise<JsonRecord> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  }
  return (result.structuredContent as JsonRecord | undefined) ?? {};
}

/** Port of Python's `wait()` closure: polls `wait_for_job` until the job reaches a terminal
 * status, throwing (with the full job payload) if it didn't succeed. */
async function waitForJob(client: Client, job: JsonRecord): Promise<JsonRecord> {
  let current = job;
  while (!["succeeded", "failed", "cancelled"].includes(current["status"] as string)) {
    current = await callTool(client, "wait_for_job", {
      job_id: current["id"],
      timeout_seconds: 45,
    });
  }
  if (current["status"] !== "succeeded") {
    throw new Error(JSON.stringify(current, null, 2));
  }
  return current;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/** Safely extracts a zip's entries under `destinationDir`, rejecting any entry path that would
 * escape it (mirrors Python's `is_relative_to` guard). */
function extractZip(zipPath: string, destinationDir: string): void {
  const archive = unzipSync(readFileSync(zipPath));
  const root = path.resolve(destinationDir);
  for (const name of Object.keys(archive)) {
    const resolved = path.resolve(root, name);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("Invalid archive path");
    }
  }
  for (const [name, bytes] of Object.entries(archive)) {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

export async function generate(
  baseUrl: string,
  output: string,
  only: readonly string[],
): Promise<void> {
  const examples = readJson(path.join(ROOT, "examples/asset-specs.json")) as Record<
    string,
    ExampleSpec
  >;
  mkdirSync(output, { recursive: true });

  const transport = new StreamableHTTPClientTransport(new URL(baseUrl.replace(/\/$/, "") + "/mcp"));
  const client = new Client({ name: "generate-examples", version: "1.0.0" });
  await client.connect(transport);

  try {
    for (const [key, example] of Object.entries(examples)) {
      if (only.length > 0 && !only.includes(key)) continue;
      console.log(`${key}: modeling`);

      const specification = example.specification;
      const profileArgs: JsonRecord = {
        kind: specification["kind"],
        preset: specification["preset"],
      };
      for (const field of ["ground_width", "ground_depth", "background_tiles"] as const) {
        if (field in specification) profileArgs[field] = specification[field];
      }
      const profile = await callTool(client, "get_asset_profile", profileArgs);

      const project = await callTool(client, "create_project", { name: "Game examples / " + key });
      const config = await callTool(client, "configure_asset", {
        project_id: project["id"],
        specification,
      });

      let revision: string | null = null;
      for (const filename of example.scripts ?? []) {
        const queued = await callTool(client, "execute_pixel_script", {
          project_id: project["id"],
          expected_revision_id: revision,
          script: readFileSync(path.join(ROOT, "examples", filename), "utf-8"),
        });
        const modeled = await waitForJob(client, queued);
        revision = modeled["result_revision_id"] as string;
      }

      let definition: JsonRecord;
      if (example.definition !== undefined) {
        definition = readJson(path.join(ROOT, "examples", example.definition)) as JsonRecord;
      } else {
        // Round-trip advanced examples through the public typed contract too.
        const source = await callTool(client, "get_pixel_art", { project_id: project["id"] });
        definition = source["definition"] as JsonRecord;
      }

      let writeDefinition: JsonRecord = definition;
      if (example.incremental === true) {
        const layers = definition["layers"] as unknown[];
        writeDefinition = { ...definition, layers: layers.slice(0, 1) };
      }
      let modeled = await waitForJob(
        client,
        await callTool(client, "write_pixel_art", {
          project_id: project["id"],
          definition: writeDefinition,
          expected_revision_id: revision,
        }),
      );
      revision = modeled["result_revision_id"] as string;

      if (example.incremental === true) {
        const layers = (definition["layers"] as unknown[]).slice(1);
        for (const layer of layers) {
          modeled = await waitForJob(
            client,
            await callTool(client, "edit_pixel_art", {
              project_id: project["id"],
              expected_revision_id: revision,
              edits: [{ op: "set_layer", layer }],
            }),
          );
          revision = modeled["result_revision_id"] as string;
        }
      }

      console.log(`${key}: rendering`);
      const rendered = await waitForJob(
        client,
        await callTool(client, "render_asset", {
          project_id: project["id"],
          revision_id: revision,
        }),
      );
      const report = await callTool(client, "inspect_asset", { job_id: rendered["id"] });
      const grid = await callTool(client, "inspect_sprite", { job_id: rendered["id"] });

      const folder = path.join(output, key);
      mkdirSync(folder, { recursive: true });

      const clips = (config["specification"] as JsonRecord)["clips"] as
        Record<string, unknown> | undefined;
      const clipId = clips ? Object.keys(clips).at(-1) : undefined;

      for (const context of [false, true] as const) {
        const preview = (await client.callTool(
          {
            name: "get_asset_preview",
            arguments: {
              job_id: rendered["id"],
              clip_id: clipId,
              angle: 0,
              scale: context ? 4 : 8,
              context,
            },
          },
          CallToolResultSchema,
        )) as CallToolResult;
        if (preview.isError === true) {
          throw new Error(JSON.stringify(preview.content));
        }
        const block = preview.content.find((c) => c.type === "image");
        if (!block) {
          throw new Error(`get_asset_preview returned no image content for ${key}`);
        }
        const name = context ? "mcp-context.png" : "mcp-preview.png";
        writeFileSync(path.join(folder, name), Buffer.from(block.data, "base64"));
      }

      const outputs = rendered["outputs"] as Record<string, ArtifactRef>;
      const artifacts = modeled["artifacts"] as ArtifactRef[];
      const spritesZipRef = outputs["sprites.zip"];
      if (!spritesZipRef) throw new Error(`${key}: render job produced no sprites.zip output`);
      for (const artifact of [spritesZipRef, ...artifacts]) {
        await callTool(client, "get_artifact", { artifact_id: artifact.id });
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/artifacts/${artifact.id}`);
        if (!response.ok) {
          throw new Error(`GET /artifacts/${artifact.id} failed: ${String(response.status)}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length !== artifact.size_bytes) {
          throw new Error(`${key}: downloaded ${artifact.filename} size mismatch`);
        }
        writeFileSync(path.join(folder, artifact.filename), buffer);
      }

      extractZip(path.join(folder, "sprites.zip"), folder);

      const packagePath = path.join(folder, "pixel-agents.zip");
      if (statSyncOrNull(packagePath)?.isFile() === true) {
        for (const clip of splitMultiClipZip(readFileSync(packagePath))) {
          writeFileSync(path.join(folder, `${clip.assetId}.zip`), clip.data);
        }
      }

      writeFileSync(
        path.join(folder, "generation.json"),
        JSON.stringify(
          {
            project,
            configuration: config,
            revision_id: revision,
            render_job_id: rendered["id"],
            profile,
            report,
            inspection: grid,
          },
          null,
          2,
        ),
      );

      const frames = (report["frames"] as unknown[] | undefined) ?? [];
      const findings = (report["findings"] as unknown[] | undefined) ?? [];
      console.log(
        `${key}: ${String(frames.length)} frames, ${String(findings.length)} advisory findings`,
      );
    }
  } finally {
    await client.close();
  }

  writeGalleryIndex(output);
}

function statSyncOrNull(filePath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function writeGalleryIndex(output: string): void {
  const entries = readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => statSyncOrNull(path.join(output, name, "preview.html"))?.isFile() === true);

  const cards = entries
    .map((name) => {
      const exampleDir = path.join(output, name);
      const zipNames = readdirSync(exampleDir).filter((f) => f.endsWith(".zip"));
      const animated = statSyncOrNull(path.join(exampleDir, "preview.gif"))?.isFile() === true;
      return exampleCardHtml(name, clipLinksHtml(name, zipNames), animated);
    })
    .join("");

  const hasWebview = statSyncOrNull(path.join(output, "webview/index.html"))?.isFile() === true;
  writeFileSync(path.join(output, "index.html"), galleryIndexHtml(cards, hasWebview));
}

interface Args {
  readonly baseUrl: string;
  readonly output: string;
  readonly only: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  let baseUrl = "http://localhost:8000";
  let output = path.join(ROOT, "tmp/asset-workflow");
  let only: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--base-url": {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error("Missing value for --base-url");
        baseUrl = value;
        break;
      }
      case "--output": {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error("Missing value for --output");
        output = path.resolve(value);
        break;
      }
      case "--only": {
        const rest: string[] = [];
        while (i + 1 < argv.length && !(argv[i + 1] ?? "").startsWith("--")) {
          i += 1;
          const value = argv[i];
          if (value !== undefined) rest.push(value);
        }
        only = rest;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { baseUrl, output, only };
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  generate(args.baseUrl, args.output, args.only).catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
