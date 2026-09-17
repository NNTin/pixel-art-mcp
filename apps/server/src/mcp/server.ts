/**
 * Port of `create_mcp` in `src/pixel_art_mcp/mcp/server.py` (513 lines): all 22 MCP tools, wired
 * to the same `Service` (`@pixel-art-mcp/service`) that `apps/server`'s REST surface
 * (`../rest/routes.ts`) also calls into -- an MCP agent and a plain HTTP client share identical
 * project/job/revision state, exactly like the Python app.
 *
 * **Verbatim prompt text.** `INSTRUCTIONS` and every tool's `description` come from
 * `./instructions.ts`, generated from a real `create_mcp(service)` + `await mcp.list_tools()`
 * probe against the actual Python source (see that file's doc comment for why a naive
 * docstring-dedent transcription would have been subtly wrong). Do not edit description strings
 * here -- change `./instructions.ts` (regenerated from Python) instead.
 *
 * **Schema reuse -- input position only.** Whole-model *parameters* (`AssetSpec`,
 * `PixelDefinition`, `PixelEdits`, `OpenAIFile`) reuse `@pixel-art-mcp/schema`'s Zod schemas
 * directly, so their `.describe(...)` text (itself verbatim-ported prompt content, per that
 * package's own doc comments) flows straight into each tool's advertised `inputSchema` through
 * the SDK's Zod-to-JSON-Schema conversion -- confirmed end-to-end in `server.test.ts`, with one
 * real, verified limit flagged there and in this phase's final report: a reused schema's own
 * *immediate* field descriptions survive (e.g. `PixelDefinition.layers`'s), but anything nested
 * a level deeper through an `arrayField`/`recordField`-wrapped list/map (e.g. an individual
 * `PixelPose` field's own description, reached via `layers[].poses[]`) does not -- those helpers
 * wrap their element type in a `.transform()` for Pydantic-verbatim `extra="forbid"` parity, and
 * zod v4's `toJSONSchema` cannot describe a nested transform's element type even in `io: "input"`
 * mode, collapsing it to an undifferentiated `additionalProperties: {}`. This is a real gap
 * against Python (whose Pydantic schemas have no such asymmetry), not something this port could
 * route around without duplicating every reused schema in a parallel, non-transform form -- see
 * the final report for why that trade wasn't taken. Scalar params with no existing model (plain
 * UUIDs, `get_asset_profile`'s bounded tile counts, `get_artifact_chunk`'s offset/length) get
 * small local schemas from `./params.ts`.
 *
 * **No `outputSchema` anywhere, and why.** Every `@pixel-art-mcp/schema` `Model`-based schema
 * (`Job`, `Project`, `ProjectDetail`, `Reference`, `PixelArtSource`, ...) is built through
 * `modelObject`/`modelSchema`, which -- per that package's own `errors.ts` doc comment --
 * necessarily uses `.loose().superRefine().transform()` to get Pydantic-verbatim `extra="forbid"`
 * error wording. That makes each of them a Zod *transform pipeline*, not a plain object schema,
 * and empirically (confirmed by direct probes against the installed
 * `@modelcontextprotocol/sdk@1.30.0` during this port):
 *   1. `normalizeObjectSchema` only recognizes a schema as "object-shaped" by inspecting its own
 *      top-level `_zod.def` for `type === "object"`/a `shape`; a transform-wrapped schema's
 *      top-level type is the pipe/transform itself, so passing one straight as `outputSchema`
 *      makes the SDK treat it as *no schema at all* (`get_project`, `create_project`, etc. would
 *      appear to have no advertised output shape) -- fine on its own, except:
 *   2. Nested inside a plain wrapper object (e.g. `z.object({ result: z.array(ProjectSchema) })`
 *      for `list_projects`), the wrapper itself *is* recognized, and both `tools/list`'s JSON
 *      Schema generation (`io: "output"`) and `fastify-type-provider-zod`'s response
 *      *serialization* (`safeEncode`, the schema's untested inverse direction) throw
 *      `"Transforms cannot be represented in JSON Schema"` the moment they recurse into that
 *      nested transform -- and because `tools/list` builds every tool's schema in one pass, *one*
 *      such tool poisons the entire listing for every client, not just that tool's own call.
 * `inputSchema` position is safe (`io: "input"`/`safeParseAsync`'s decode direction is exactly a
 * transform pipeline's designed direction -- confirmed working throughout this file), so the
 * fix is narrow: never put a `Model`-based schema in *output* position (`outputSchema` here,
 * `response` in `rest/routes.ts`). Every tool below instead returns its already-correct plain
 * object through `jsonResult`/`imageResult` without SDK-side output validation -- a deliberate,
 * flagged gap versus Python (whose Pydantic-based schemas have no such asymmetry) rather than a
 * silently "simplified" one. `ArtifactChunkOutputSchema` (`./artifact-chunk-schema.ts`) is the
 * one `outputSchema` in this file, precisely because it's a plain, non-transform `z.object(...)`.
 */

import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  AssetSpecSchema,
  getAssetProfile,
  OpenAIFileSchema,
  PixelDefinitionSchema,
  PixelEditsSchema,
} from "@pixel-art-mcp/schema";
import { MAX_INLINE_ARTIFACT_BYTES, type Service } from "@pixel-art-mcp/service";
import { assetPreview, compareInspections, inspectSprite } from "@pixel-art-mcp/imaging";
import { z } from "zod";

import { ArtifactChunkOutputSchema } from "./artifact-chunk-schema.js";
import { buildEngineReference } from "./engine-reference.js";
import { INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./instructions.js";
import { boundedInt, nullableUuidParam, uuidParam } from "./params.js";

/**
 * `get_pixel_engine_reference`'s advertised description. Unlike every other tool's description
 * (`./instructions.ts`'s `TOOL_DESCRIPTIONS`, a byte-for-byte port of the Python source's
 * docstrings), this tool has no Python counterpart to port from -- it's new functionality this
 * phase adds (see `docs/typescript-rewrite.md`, "New tools") -- so its description is hand-written
 * here, in the same terse-directive-then-prose style the ported ones use, rather than living in
 * `TOOL_DESCRIPTIONS`'s "verbatim probe dump, do not hand-edit" constant.
 */
const GET_PIXEL_ENGINE_REFERENCE_DESCRIPTION = `Read first before execute_pixel_script: the real Canvas/PixelArt API plus worked examples.

Returns type_declarations extracted directly from @pixel-art-mcp/pixel-core's own compiled
.d.ts output (never hand-transcribed prose that can drift out of sync with the real classes), a
set of complete, directly submittable execute_pixel_script example bodies, and hand-written
guidance covering palette/view/layer rules plus the frozen-prototype safety property: mutating
Canvas/PixelArt at runtime throws immediately and, even if it didn't, would affect only that one
job's own OS process. Takes no arguments -- this is a static API reference, not per-project
state.`;

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

type ContentBlock = NonNullable<CallToolResult["content"]>[number];

/** Port of Python's `image_result`: a PNG inline as MCP `ImageContent`, plus the same JSON
 * details as both `structuredContent` and a `TextContent` block (for clients that only read
 * unstructured content). */
function imageResult(data: Uint8Array, details: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: details,
    content: [
      { type: "text", text: JSON.stringify(details) },
      { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/png" },
    ],
  };
}

/** Every non-image, non-raw-`CallToolResult` tool below returns a plain JSON value: this builds
 * the same `{structuredContent, content: [text]}` shape FastMCP's own structured-output path
 * produces for a typed (or dict) return value. */
function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** File suffixes Python's `get_artifact` inlines as text alongside `text/*` media types.
 * Extended with `.ts` (this rewrite's script artifact extension, `script.ts`) alongside Python's
 * original `.py`/`.txt`/`.md`/`.log` -- a deliberate, small behavioral adaptation (not prompt
 * text) so a script artifact still inlines as readable text instead of falling through to an
 * opaque embedded-resource blob; see this phase's final report. */
const INLINE_TEXT_SUFFIXES = new Set([".py", ".ts", ".txt", ".md", ".log"]);

export function createMcpServer(service: Service): McpServer {
  const server = new McpServer(
    { name: "Pixel Art MCP", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "get_capabilities",
    { description: TOOL_DESCRIPTIONS.get_capabilities, annotations: READ },
    () => jsonResult(service.capabilities()),
  );

  server.registerTool(
    "get_pixel_engine_reference",
    { description: GET_PIXEL_ENGINE_REFERENCE_DESCRIPTION, annotations: READ },
    () => jsonResult(buildEngineReference()),
  );

  server.registerTool(
    "get_asset_profile",
    {
      description: TOOL_DESCRIPTIONS.get_asset_profile,
      annotations: READ,
      inputSchema: {
        kind: z.enum(["furniture", "character", "pet"]),
        preset: z.string().nullable().default(null),
        ground_width: boundedInt({ ge: 1, le: 16 }).nullable().default(null),
        ground_depth: boundedInt({ ge: 1, le: 16 }).nullable().default(null),
        background_tiles: boundedInt({ ge: 0, le: 31 }).nullable().default(null),
      },
    },
    (args) =>
      jsonResult(
        getAssetProfile(args.kind, args.preset, {
          groundWidth: args.ground_width ?? undefined,
          groundDepth: args.ground_depth ?? undefined,
          backgroundTiles: args.background_tiles ?? undefined,
        }),
      ),
  );

  server.registerTool(
    "configure_asset",
    {
      description: TOOL_DESCRIPTIONS.configure_asset,
      annotations: WRITE,
      inputSchema: { project_id: uuidParam(), specification: AssetSpecSchema },
    },
    (args) => jsonResult(service.configureAsset(args.project_id, args.specification)),
  );

  server.registerTool(
    "write_pixel_art",
    {
      description: TOOL_DESCRIPTIONS.write_pixel_art,
      annotations: DESTRUCTIVE,
      inputSchema: {
        project_id: uuidParam(),
        definition: PixelDefinitionSchema,
        expected_revision_id: nullableUuidParam(),
      },
    },
    (args) =>
      jsonResult(
        service.writePixelArt(args.project_id, args.definition, args.expected_revision_id),
      ),
  );

  server.registerTool(
    "get_pixel_art",
    {
      description: TOOL_DESCRIPTIONS.get_pixel_art,
      annotations: READ,
      inputSchema: { project_id: uuidParam(), revision_id: nullableUuidParam().default(null) },
    },
    (args) => jsonResult(service.getPixelArt(args.project_id, args.revision_id)),
  );

  server.registerTool(
    "edit_pixel_art",
    {
      description: TOOL_DESCRIPTIONS.edit_pixel_art,
      annotations: DESTRUCTIVE,
      inputSchema: {
        project_id: uuidParam(),
        edits: PixelEditsSchema,
        expected_revision_id: uuidParam(),
      },
    },
    (args) =>
      jsonResult(service.editPixelArt(args.project_id, args.edits, args.expected_revision_id)),
  );

  server.registerTool(
    "get_asset_preview",
    {
      description: TOOL_DESCRIPTIONS.get_asset_preview,
      annotations: READ,
      inputSchema: {
        job_id: uuidParam(),
        clip_id: z.string().nullable().default(null),
        angle: z
          .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
          .nullable()
          .default(null),
        frame: boundedInt({ ge: 0, le: 100_000 }).nullable().default(null),
        scale: boundedInt({ ge: 1, le: 8 }).default(4),
        context: z.boolean().default(true),
      },
    },
    (args) => {
      const [data, details] = assetPreview(
        service.exportRoot(args.job_id),
        args.clip_id,
        args.angle,
        args.frame,
        args.scale,
        args.context,
      );
      return imageResult(data, { job_id: args.job_id, ...details });
    },
  );

  server.registerTool(
    "render_asset",
    {
      description: TOOL_DESCRIPTIONS.render_asset,
      annotations: WRITE,
      inputSchema: { project_id: uuidParam(), revision_id: nullableUuidParam().default(null) },
    },
    (args) => jsonResult(service.renderAsset(args.project_id, args.revision_id)),
  );

  server.registerTool(
    "inspect_asset",
    {
      description: TOOL_DESCRIPTIONS.inspect_asset,
      annotations: READ,
      inputSchema: { job_id: uuidParam() },
    },
    (args) => jsonResult(service.inspectAsset(args.job_id)),
  );

  server.registerTool(
    "create_project",
    {
      description: TOOL_DESCRIPTIONS.create_project,
      annotations: WRITE,
      inputSchema: { name: z.string() },
    },
    (args) => jsonResult(service.createProject(args.name)),
  );

  server.registerTool(
    "list_projects",
    {
      description: TOOL_DESCRIPTIONS.list_projects,
      annotations: READ,
    },
    () => jsonResult({ result: service.listProjects() }),
  );

  server.registerTool(
    "get_project",
    {
      description: TOOL_DESCRIPTIONS.get_project,
      annotations: READ,
      inputSchema: { project_id: uuidParam() },
    },
    (args) => jsonResult(service.getProject(args.project_id)),
  );

  server.registerTool(
    "add_reference_image",
    {
      description: TOOL_DESCRIPTIONS.add_reference_image,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["file"] },
      inputSchema: {
        project_id: uuidParam(),
        data_base64: z.string().nullable().default(null),
        file: OpenAIFileSchema.nullable().default(null),
        filename: z.string().default("reference.png"),
      },
    },
    async (args) =>
      jsonResult(
        await service.addReferenceInput(
          args.project_id,
          args.data_base64,
          args.file,
          args.filename,
        ),
      ),
  );

  server.registerTool(
    "get_reference_image",
    {
      description: TOOL_DESCRIPTIONS.get_reference_image,
      annotations: READ,
      inputSchema: { reference_id: uuidParam() },
    },
    (args) => {
      const reference = service.reference(args.reference_id);
      const data = fs.readFileSync(service.artifactPath(reference.thumbnail_artifact_id));
      return imageResult(data, { ...reference });
    },
  );

  server.registerTool(
    "execute_pixel_script",
    {
      description: TOOL_DESCRIPTIONS.execute_pixel_script,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        project_id: uuidParam(),
        script: z.string(),
        expected_revision_id: nullableUuidParam(),
      },
    },
    (args) =>
      jsonResult(service.submitScript(args.project_id, args.script, args.expected_revision_id)),
  );

  server.registerTool(
    "inspect_scene",
    {
      description: TOOL_DESCRIPTIONS.inspect_scene,
      annotations: READ,
      inputSchema: { project_id: uuidParam(), revision_id: nullableUuidParam().default(null) },
    },
    (args) => {
      const revision = service.revision(args.project_id, args.revision_id);
      return jsonResult({ revision_id: revision.id, summary: revision["summary"] });
    },
  );

  server.registerTool(
    "get_job",
    {
      description: TOOL_DESCRIPTIONS.get_job,
      annotations: READ,
      inputSchema: { job_id: uuidParam() },
    },
    (args) => jsonResult(service.job(args.job_id)),
  );

  server.registerTool(
    "wait_for_job",
    {
      description: TOOL_DESCRIPTIONS.wait_for_job,
      annotations: READ,
      inputSchema: { job_id: uuidParam(), timeout_seconds: z.number().nullable().default(null) },
    },
    async (args) => jsonResult(await service.waitForJob(args.job_id, args.timeout_seconds)),
  );

  server.registerTool(
    "inspect_sprite",
    {
      description: TOOL_DESCRIPTIONS.inspect_sprite,
      annotations: READ,
      inputSchema: {
        job_id: uuidParam(),
        state_id: z.string().nullable().default(null),
        angle: z.number().nullable().default(null),
        frame: z.number().int().nullable().default(null),
        compare_job_id: nullableUuidParam().default(null),
      },
    },
    (args) => {
      const inspected = inspectSprite(
        service.exportRoot(args.job_id),
        args.state_id,
        args.angle,
        args.frame,
      );
      const result: Record<string, unknown> = { job_id: args.job_id, ...inspected };
      if (args.compare_job_id !== null) {
        const resolvedState = inspected.state ? inspected.state.id : null;
        const compared = inspectSprite(
          service.exportRoot(args.compare_job_id),
          resolvedState,
          inspected.angle,
          inspected.frame,
        );
        result["comparison"] = {
          job_id: args.compare_job_id,
          metrics: compareInspections(inspected, compared),
          sprite: compared,
        };
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "cancel_job",
    {
      description: TOOL_DESCRIPTIONS.cancel_job,
      annotations: DESTRUCTIVE,
      inputSchema: { job_id: uuidParam() },
    },
    (args) => jsonResult(service.cancelJob(args.job_id)),
  );

  server.registerTool(
    "get_artifact",
    {
      description: TOOL_DESCRIPTIONS.get_artifact,
      annotations: READ,
      inputSchema: { artifact_id: uuidParam() },
    },
    (args) => {
      const artifact = service.artifact(args.artifact_id);
      const details: Record<string, unknown> = { ...artifact };
      details["byte_retrieval"] = {
        tool: "get_artifact_chunk",
        arguments: { artifact_id: args.artifact_id, offset: 0, length: 65536 },
        instructions:
          "Decode each chunk separately; append raw bytes in offset order. " +
          "Repeat with next_offset until null. sha256 covers each decoded chunk. " +
          "Saving files requires client integration.",
      };
      const filePath = service.artifactPath(args.artifact_id);
      if (artifact.media_type === "image/png" && artifact.size_bytes <= MAX_INLINE_ARTIFACT_BYTES) {
        return imageResult(fs.readFileSync(filePath), details);
      }
      const content: ContentBlock[] = [];
      if (
        artifact.media_type === "application/json" &&
        artifact.size_bytes <= MAX_INLINE_ARTIFACT_BYTES
      ) {
        details["metadata"] = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      } else if (
        artifact.size_bytes <= MAX_INLINE_ARTIFACT_BYTES &&
        (artifact.media_type.startsWith("text/") ||
          INLINE_TEXT_SUFFIXES.has(path.extname(artifact.filename)))
      ) {
        details["text"] = fs.readFileSync(filePath, "utf8");
      } else if (artifact.size_bytes <= MAX_INLINE_ARTIFACT_BYTES) {
        content.push({
          type: "resource",
          resource: {
            uri: `pixel-art://artifacts/${args.artifact_id}`,
            mimeType: artifact.media_type,
            blob: fs.readFileSync(filePath).toString("base64"),
          },
        });
      }
      return {
        structuredContent: details,
        content: [{ type: "text", text: JSON.stringify(details) }, ...content],
      };
    },
  );

  server.registerTool(
    "get_artifact_chunk",
    {
      description: TOOL_DESCRIPTIONS.get_artifact_chunk,
      annotations: READ,
      inputSchema: {
        artifact_id: uuidParam(),
        // Python bounds this at 2**63-1 (an `int64`, since it's only ever compared, never used
        // to size a buffer). `Number.MAX_SAFE_INTEGER` (2**53-1) is the largest bound a JS
        // `number` can represent exactly -- `readArtifactChunk`'s own runtime check (called via
        // `service.readArtifactChunk`) is what actually rejects an out-of-range offset either way.
        offset: boundedInt({ ge: 0, le: Number.MAX_SAFE_INTEGER }).default(0),
        length: boundedInt({ ge: 1, le: 262_144 }).default(65536),
      },
      outputSchema: ArtifactChunkOutputSchema,
    },
    async (args) => {
      const chunk = await service.readArtifactChunk(args.artifact_id, args.offset, args.length);
      return jsonResult({ schema_version: 1, ...chunk });
    },
  );

  return server;
}
