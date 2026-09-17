/**
 * Individual read-only checks against a live pixel-index environment. Verbatim port (control
 * flow and messages) of `contracts/pixel_index/checks.py`.
 *
 * Each check is a plain async function `(baseUrl, context, timeoutMs) -> CheckResult`
 * returning `{name, status: "pass"|"fail"|"skipped", detail}`. Checks run in order and share
 * `context` -- the `checkRoot` check's discovered commit is included in the manifest-schema
 * checks' pass detail, purely for readability.
 *
 * Nothing here calls pixel-index at runtime (this repo only produces zips for a human to upload
 * manually), and the checks themselves are heterogeneous -- a plain health-style GET, a diff
 * against our own Zod constraints, a live schema fetch, a real list call -- so a flat list of
 * functions is the honest shape instead of forcing a declarative {path, query, model} pattern.
 *
 * The manifest-schema checks fetch straight from pixel-index's own
 * `GET /api/v1/assets/schema/:kind` rather than pinning a commit or reaching across to GitHub --
 * so, like every other check here, a pass is a live claim about the environment actually being
 * hit, nothing more.
 *
 * No authenticated `POST /api/v1/assets` upload is attempted anywhere here: that route requires
 * a Bearer session or an `X-Api-Key` + `discordUserId` this project has no credentials for. A
 * pass here means "the zip shapes this repo generates should still be accepted," not "a real
 * upload would succeed."
 *
 * HTTP: Node's built-in `fetch` -- this tool fetches from an operator-trusted, explicitly
 * configured `--base-url`, not an arbitrary user-supplied one, so it doesn't need the
 * IP-pinning/SSRF hardening `packages/service`'s reference-download path requires.
 *
 * JSON Schema validation: `ajv`'s `Ajv2020` class (`ajv/dist/2020.js`) in place of Python's
 * `jsonschema.Draft202012Validator` -- pixel-index's `GET /api/v1/assets/schema/:kind` documents
 * its schemas as JSON Schema 2020-12 (see pixel-agents-hq/index#108). `strict: false` mirrors
 * `jsonschema`'s lenient default of not validating (or erroring on) the `format` keyword unless a
 * `FormatChecker` is explicitly supplied -- Ajv's strict mode would otherwise throw at compile
 * time on any `format` value it doesn't ship a built-in checker for.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  exportCharacter,
  exportPetSheet,
  exportPixelAgents,
  createImage,
  writePng,
} from "@pixel-art-mcp/imaging";
import {
  RenderOptionsSchema,
  renderOptionsFrames,
  renderOptionsRenderFrames,
} from "@pixel-art-mcp/schema";
import { Ajv2020 } from "ajv/dist/2020.js";

export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** Shared, mutable state passed to every check in order -- only `commit` is written today. */
export interface CheckContext {
  commit?: unknown;
}

export type CheckFn = (
  baseUrl: string,
  context: CheckContext,
  timeoutMs: number,
) => Promise<CheckResult>;

function result(name: string, status: CheckStatus, detail = ""): CheckResult {
  return { name, status, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray`'s TS signature narrows to `any[]`; this keeps the result honestly `unknown[]`
 * so every element still has to be narrowed before use (matching this file's `noImplicitAny`-
 * adjacent discipline for untrusted JSON). */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stringifies an untrusted JSON value for a human-readable detail message without ever relying
 * on an `unknown`-typed value's own (possibly default-Object) `toString`. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "<unrepresentable>";
  }
}

class HttpStatusError extends Error {
  constructor(status: number, statusText: string) {
    super(`${String(status)} ${statusText}`);
  }
}

/** `base_url.rstrip("/") + suffix` -- `suffix` includes its own leading `/`. */
function joinUrl(baseUrl: string, suffix: string): string {
  return baseUrl.replace(/\/+$/, "") + suffix;
}

/** Python's `sorted(x)` printed as a list literal, e.g. `['a', 'b']`, for verbatim error text. */
function pyListRepr(values: readonly string[]): string {
  return `[${[...values]
    .sort()
    .map((v) => `'${v}'`)
    .join(", ")}]`;
}

export async function checkRoot(
  baseUrl: string,
  context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  let body: unknown;
  try {
    const response = await fetch(joinUrl(baseUrl, "/"), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new HttpStatusError(response.status, response.statusText);
    body = await response.json();
  } catch (error) {
    return result("root", "fail", `GET / failed: ${describeError(error)}`);
  }
  const commit = isRecord(body) ? body["commit"] : undefined;
  if (!commit) {
    return result("root", "fail", "GET / response has no 'commit' field");
  }
  context.commit = commit;
  return result("root", "pass", `running commit ${describeValue(commit)}`);
}

export async function checkOpenapiQueryShape(
  baseUrl: string,
  _context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  let spec: unknown;
  try {
    const response = await fetch(joinUrl(baseUrl, "/openapi.json"), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new HttpStatusError(response.status, response.statusText);
    spec = await response.json();
  } catch (error) {
    return result(
      "openapi-query-shape",
      "fail",
      `GET /openapi.json failed: ${describeError(error)}`,
    );
  }

  const paths = asRecord(asRecord(spec)["paths"]);
  const assetsPath = paths["/api/v1/assets"];
  const post = isRecord(assetsPath) ? assetsPath["post"] : undefined;
  if (post === undefined || !isRecord(post)) {
    return result(
      "openapi-query-shape",
      "skipped",
      "POST /api/v1/assets is not deployed to this environment yet",
    );
  }

  const parameters = asArray(post["parameters"]);
  const paramNames = new Set(
    parameters
      .filter(isRecord)
      .map((p) => p["name"])
      .filter((n): n is string => typeof n === "string"),
  );
  const stale = ["assetKind", "category", "name"].filter((name) => paramNames.has(name));
  if (stale.length > 0) {
    return result(
      "openapi-query-shape",
      "fail",
      `POST /api/v1/assets still declares ${pyListRepr(stale)} as query params -- ` +
        "this repo's zips no longer supply them (#105 follow-up)",
    );
  }
  return result("openapi-query-shape", "pass", "no assetKind/category/name query params");
}

/** Builds one manifest the same way `imaging/pixel-agents.ts` actually builds it, so the
 * contract check exercises the real code path instead of a hand-duplicated JSON fixture that
 * could silently drift from what this repo really generates. */
function buildFurnitureManifestFixture(): Record<string, unknown> {
  const options = RenderOptionsSchema.parse({
    width: 16,
    height: 16,
    angles: [0],
    pixel_agents: { asset_id: "CONTRACT_CHECK_FIXTURE", name: "Contract check fixture" },
  });
  const frame = createImage(16, 16);
  const outputDir = mkdtempSync(path.join(tmpdir(), "pixel-index-contract-furniture-"));
  try {
    exportPixelAgents(outputDir, options, [frame], null);
    const target = options.pixel_agents;
    if (!target) throw new Error("unreachable: fixture always sets options.pixel_agents");
    const manifestPath = path.join(
      outputDir,
      "pixel-agents",
      "assets",
      "furniture",
      target.asset_id,
      "manifest.json",
    );
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

/** Builds one manifest the same way `imaging/character.ts` actually builds it, so the contract
 * check exercises the real code path (#105 follow-up: characters now carry a manifest.json too,
 * mirroring pets) instead of a hand-duplicated fixture. */
function buildCharacterManifestFixture(): Record<string, unknown> {
  const options = RenderOptionsSchema.parse({
    tile_width: 1,
    tile_height: 2,
    angles: [0, 90, 180],
    frame_start: 0,
    frame_end: 6,
    character: { asset_id: "CONTRACT_CHECK_FIXTURE", name: "Contract check fixture" },
  });
  const columns = renderOptionsFrames(options).length;
  const frame = createImage(16, 32);
  const frames = Array.from({ length: options.angles.length * columns }, () => frame);
  const outputDir = mkdtempSync(path.join(tmpdir(), "pixel-index-contract-character-"));
  try {
    exportCharacter(outputDir, options, frames);
    const manifestPath = path.join(outputDir, "pixel-agents-character", "manifest.json");
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

/** Builds one manifest the same way `imaging/pet.ts` actually builds it (a full round trip
 * through `exportPetSheet` with synthetic raw frames standing in for the rendered ones), for the
 * same reason as the furniture fixture above. */
function buildPetManifestFixture(): Record<string, unknown> {
  const options = RenderOptionsSchema.parse({
    tile_width: 1,
    tile_height: 2,
    angles: [0, 90, 180],
    states: [
      { id: "walk", name: "Walk", frame_start: 0, frame_end: 2 },
      { id: "idle", name: "Idle", frame_start: 10, frame_end: 12 },
    ],
    pet: { asset_id: "CONTRACT_CHECK_FIXTURE", name: "Contract check fixture" },
    supersampling: 1,
  });
  const target = options.pet;
  if (!target) throw new Error("unreachable: fixture always sets options.pet");

  const tmp = mkdtempSync(path.join(tmpdir(), "pixel-index-contract-pet-"));
  try {
    const rawDir = path.join(tmp, "raw");
    const outputDir = path.join(tmp, "out");
    const entries: { filename: string; angle: number; frame: number; pivot: [number, number] }[] =
      [];
    const renderFrames = renderOptionsRenderFrames(options);
    options.angles.forEach((angle, row) => {
      const width = angle === 90 ? 32 : 16;
      for (const frame of renderFrames) {
        const image = createImage(width, 32);
        const name = `${String(row)}_${String(frame)}.png`;
        writePng(path.join(rawDir, name), image);
        entries.push({ filename: name, angle, frame, pivot: [0, 0] });
      }
    });
    exportPetSheet(rawDir, outputDir, { frames: entries, camera: {} }, options, "p", "r");
    const manifestPath = path.join(outputDir, "pixel-agents-pet", target.asset_id, "manifest.json");
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** JSON Pointer (RFC 6901, what Ajv's `instancePath` uses) -> the dot-joined path
 * `jsonschema`'s `error.path` deque would print, e.g. `/frames/0/angle` -> `frames.0.angle`. */
function pointerToDotPath(pointer: string): string {
  if (!pointer) return "<root>";
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function validateAgainstSchema(schema: unknown, manifest: unknown): string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema as Record<string, unknown>);
  if (validate(manifest)) return [];
  return (validate.errors ?? []).map(
    (error) => `${pointerToDotPath(error.instancePath)}: ${error.message ?? "is invalid"}`,
  );
}

async function checkManifestSchema(
  name: string,
  kind: string,
  buildFixture: () => Record<string, unknown>,
  baseUrl: string,
  context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  const url = joinUrl(baseUrl, `/api/v1/assets/schema/${kind}`);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return result(name, "fail", `fetching ${url} failed: ${describeError(error)}`);
  }
  if (response.status === 404) {
    // This environment predates pixel-agents-hq/index#108 (no schema endpoint at all yet) or
    // #105's character-manifest follow-up (character 404s on an older instance that still
    // treats it as manifest-less).
    return result(name, "skipped", `no schema available at ${url}`);
  }
  let schema: unknown;
  try {
    if (!response.ok) throw new HttpStatusError(response.status, response.statusText);
    schema = await response.json();
  } catch (error) {
    return result(name, "fail", `invalid schema response from ${url}: ${describeError(error)}`);
  }

  const manifest = buildFixture();
  const errors = validateAgainstSchema(schema, manifest);
  if (errors.length > 0) {
    return result(name, "fail", errors.join("; "));
  }
  const commit = context.commit !== undefined ? describeValue(context.commit) : "unknown";
  return result(name, "pass", `validated live schema (commit ${commit})`);
}

export async function checkManifestSchemaFurniture(
  baseUrl: string,
  context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  return checkManifestSchema(
    "manifest-schema-furniture",
    "furniture",
    buildFurnitureManifestFixture,
    baseUrl,
    context,
    timeoutMs,
  );
}

export async function checkManifestSchemaCharacter(
  baseUrl: string,
  context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  return checkManifestSchema(
    "manifest-schema-character",
    "character",
    buildCharacterManifestFixture,
    baseUrl,
    context,
    timeoutMs,
  );
}

export async function checkManifestSchemaPet(
  baseUrl: string,
  context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  return checkManifestSchema(
    "manifest-schema-pet",
    "pet",
    buildPetManifestFixture,
    baseUrl,
    context,
    timeoutMs,
  );
}

/** `GET /api/v1/assets?limit=1` -- read-only, real data: exercises a real response rather than
 * only the schema. */
export async function checkAssetsList(
  baseUrl: string,
  _context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult> {
  const url = new URL(joinUrl(baseUrl, "/api/v1/assets"));
  url.searchParams.set("limit", "1");
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return result("assets-list", "fail", `GET /api/v1/assets failed: ${describeError(error)}`);
  }
  if (response.status === 404) {
    return result(
      "assets-list",
      "skipped",
      "GET /api/v1/assets is not deployed to this environment yet",
    );
  }
  let body: unknown;
  try {
    if (!response.ok) throw new HttpStatusError(response.status, response.statusText);
    body = await response.json();
  } catch (error) {
    return result("assets-list", "fail", `invalid response: ${describeError(error)}`);
  }

  const assets = isRecord(body) ? asArray(body["assets"]) : [];
  const allowedKinds = new Set(["furniture", "character", "pet"]);
  const kinds = new Set(
    assets
      .filter(isRecord)
      .map((asset) => asset["assetKind"])
      .filter((kind): kind is string => typeof kind === "string"),
  );
  const unexpected = [...kinds].filter((kind) => !allowedKinds.has(kind));
  if (unexpected.length > 0) {
    return result("assets-list", "fail", `unexpected assetKind: ${pyListRepr(unexpected)}`);
  }
  const total = isRecord(body) && "total" in body ? body["total"] : "?";
  return result(
    "assets-list",
    "pass",
    `${String(assets.length)} asset(s) checked, of ${String(total)} total`,
  );
}

export const CHECKS: readonly CheckFn[] = [
  checkRoot,
  checkOpenapiQueryShape,
  checkManifestSchemaFurniture,
  checkManifestSchemaCharacter,
  checkManifestSchemaPet,
  checkAssetsList,
];
