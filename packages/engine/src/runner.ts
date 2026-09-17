/**
 * Subprocess entrypoint: `node dist/runner.js <request.json path>`. Port of
 * `src/pixel_art_mcp/engine/runner.py` (119 lines): reads `request.json`, dispatches on
 * `operation` ("script" -> compiles+runs a submitted script against an injected `scene`/
 * `referenceImages`; anything else -> builds the blank-canvas render manifest), and writes
 * `result.json` (plus, for "script", `state.json`) to `output_dir`.
 *
 * **One-subprocess-per-job design decision** (see this package's final report for the full
 * writeup): `packages/jobs`' `Worker`/`runProcess` (Phase 4) already spawns one OS subprocess per
 * job; this file *is* that subprocess's entrypoint. The TypeScript-compile step
 * (`script-runtime.ts`) runs in-process here, then dynamically `import()`s the compiled script
 * *in this same process* -- it does not `spawn` a second nested `node` subprocess for that step.
 * This matches Python's architecture exactly (one subprocess per job; Python's own engine
 * subprocess `exec()`s the submitted script in-process too, with no further nesting), and avoids
 * doubling process-spawn latency/complexity for no isolation benefit -- the OS process boundary
 * `runProcess` already establishes around this entire file is the actual sandbox; there is
 * nothing further inside it that separate isolation would protect against.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PixelArt, type PixelArtDict, type Scene } from "@pixel-art-mcp/pixel-core";
import type { AssetLayout, AssetSpec } from "@pixel-art-mcp/schema";

import { nativeRender, type RenderManifest } from "./render.js";
import { executeScript } from "./script-runtime.js";

export type EngineOperation = "script" | "preview" | "sprites";

/** `request.json`'s exact wire shape -- see this package's final report for the full contract
 * writeup (what a later phase's worker wiring writes, and `packages/imaging` reads `result.json`
 * back). Field names/casing match Python's `request` dict verbatim. */
export interface EngineRequest {
  schema_version: 1;
  operation: EngineOperation;
  input_state: string | null;
  pixel_art: PixelArtDict | null;
  output_dir: string;
  script_path: string | null;
  references: Record<string, string>;
  options: Record<string, unknown> | null;
  authoring_options: Record<string, unknown> | null;
  pixel_art_required: boolean;
}

/** `result.json`'s shape for `operation: "script"`. */
export interface ScriptResult {
  summary: { pixel_art: PixelArtDict | null };
}

/** Port of `progress()` in `engine/runner.py`: a `PIXEL_PROGRESS {json}` line on stdout, parsed
 * by `packages/jobs`' `runProcess` (see `packages/jobs/src/process.ts`). */
export function progress(stage: string, completed: number, total: number): void {
  process.stdout.write(`PIXEL_PROGRESS ${JSON.stringify({ stage, completed, total })}\n`);
}

/**
 * Reads the `asset_layouts`/`frame_sequence`/`asset` triple out of a resolved options dict,
 * trusting its shape the same way `PixelArt.fromDict` trusts a `PixelArtDict` (see pixel-core's
 * own doc comment on that method): this data is always produced upstream by `resolveAsset`
 * (`@pixel-art-mcp/schema`), never directly from untrusted script/tool input, so a malformed
 * shape here is an internal invariant violation, not a case worth a curated domain error.
 */
function validationTriple(options: Record<string, unknown>): {
  assetLayouts: AssetLayout[];
  frameSequence: number[];
  asset: AssetSpec;
} {
  return {
    assetLayouts: options["asset_layouts"] as AssetLayout[],
    frameSequence: options["frame_sequence"] as number[],
    asset: options["asset"] as AssetSpec,
  };
}

/** Port of `run_script`. */
export async function runScript(request: EngineRequest, outputDir: string): Promise<ScriptResult> {
  let scene: Scene = {};
  if (request.input_state) {
    scene = JSON.parse(readFileSync(request.input_state, "utf8")) as Scene;
  }
  if (!request.script_path) {
    // Python's `Path(request["script_path"])` would raise a generic TypeError for a missing
    // path; this is the TS-strictness-required equivalent (script_path is typed `string | null`
    // and must be narrowed before use) -- flagged since it's a clearer message than Python gives,
    // not a behavior difference for any well-formed request.
    throw new Error("A script operation requires script_path");
  }
  const source = readFileSync(request.script_path, "utf8");
  await executeScript(source, scene, request.references);

  if ("pixel_art" in scene) {
    const options = request.authoring_options;
    if (!options) {
      throw new Error("Call configure_asset before saving pixel art");
    }
    const { assetLayouts, frameSequence, asset } = validationTriple(options);
    PixelArt.load(scene).validateTarget(assetLayouts, frameSequence, asset);
  }
  // A script that removes the required pixel_art definition is rejected by the worker
  // (packages/jobs), which owns that policy check and its error message -- matching Python.
  writeFileSync(path.join(outputDir, "state.json"), JSON.stringify(scene), "utf8");
  const summary = { pixel_art: "pixel_art" in scene ? PixelArt.load(scene).toDict() : null };
  return { summary };
}

/** Port of `run_render`. */
export function runRender(request: EngineRequest, outputDir: string): RenderManifest {
  const options = request.options;
  if (!options?.["asset"]) {
    throw new Error("Use configure_asset, write_pixel_art and render_asset");
  }
  if (!request.pixel_art) {
    throw new Error("Call write_pixel_art before rendering");
  }
  const art = PixelArt.fromDict(request.pixel_art);
  const { assetLayouts, frameSequence, asset } = validationTriple(options);
  art.validateTarget(assetLayouts, frameSequence, asset);
  return nativeRender(
    {
      asset_layouts: assetLayouts,
      frame_sequence: frameSequence,
      supersampling: options["supersampling"] as number,
    },
    outputDir,
    art,
    progress,
  );
}

/** Port of `main()`: reads `request.json` from `requestPath`, runs the requested operation,
 * writes `result.json`. */
export async function main(requestPath: string): Promise<void> {
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as EngineRequest;
  mkdirSync(request.output_dir, { recursive: true });
  const result: ScriptResult | RenderManifest =
    request.operation === "script"
      ? await runScript(request, request.output_dir)
      : runRender(request, request.output_dir);
  writeFileSync(path.join(request.output_dir, "result.json"), JSON.stringify(result), "utf8");
}

/**
 * CLI entrypoint guard: `process.argv[1]` is this file's own path when run directly via
 * `node dist/runner.js <request.json path>` (not when this module is merely `import`ed for its
 * exported functions) -- the same purpose Python's `if __name__ == "__main__":` guard serves.
 * `sys.argv[1]` in Python (index 1, script name excluded) is `process.argv[2]` here (index 2,
 * both the node executable and this script's own path excluded).
 */
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error("Usage: node runner.js <request.json path>");
    process.exit(1);
  } else {
    main(requestPath).catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    });
  }
}
