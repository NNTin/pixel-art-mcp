/**
 * The one true end-to-end test for this package: runs the *compiled* CLI
 * (`dist/runner.js`, built by `tsc -b` -- see this repo's finishing checklist, which always
 * builds before testing) as a real `node` subprocess against a real `request.json` on disk,
 * proving the CLI wiring itself (argv parsing, `main()`'s try/catch, exit codes, stdout
 * `PIXEL_PROGRESS` lines) actually works -- not just the exported functions
 * `runner.test.ts` exercises directly, in-process.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Canvas, PixelArt, type PixelArtDict } from "@pixel-art-mcp/pixel-core";
import type { AssetLayout } from "@pixel-art-mcp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineRequest } from "./runner.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_JS = path.join(ENGINE_ROOT, "dist", "runner.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-engine-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function layout(angle: number): AssetLayout {
  return {
    angle,
    width: 4,
    height: 4,
    footprint_w: 1,
    footprint_h: 1,
    ground_width: 1,
    ground_depth: 1,
    background_tiles: 0,
    margin: 1,
    bottom: 3,
    content_height: 2,
  };
}

function baseRequest(overrides: Partial<EngineRequest>): EngineRequest {
  return {
    schema_version: 1,
    operation: "script",
    input_state: null,
    pixel_art: null,
    output_dir: path.join(dir, "out"),
    script_path: null,
    references: {},
    options: null,
    authoring_options: null,
    pixel_art_required: false,
    ...overrides,
  };
}

function runCli(request: EngineRequest): { stdout: string } {
  const requestPath = path.join(dir, "request.json");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const stdout = execFileSync(process.execPath, [RUNNER_JS, requestPath], {
    encoding: "utf8",
  });
  return { stdout };
}

describe("runner.js CLI (real subprocess)", () => {
  it("is a built artifact this test can actually run", () => {
    expect(existsSync(RUNNER_JS)).toBe(true);
  });

  it("runs a script operation end to end: compiles the submitted script, writes state.json and result.json", () => {
    const scriptPath = path.join(dir, "submitted.ts");
    writeFileSync(
      scriptPath,
      `
        import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";
        export default function main(scene: Scene, referenceImages: ReferenceImages): void {
          const art = new PixelArt({ D: "#101010", G: "#efefef" }, { 0: [4, 4] });
          art.layer("body", 0, Canvas.fromRows(["DDDD", "DGGD", "DGGD", "DDDD"]));
          art.save(scene);
          scene["refs"] = Object.keys(referenceImages);
        }
      `,
      "utf8",
    );
    const request = baseRequest({
      script_path: scriptPath,
      references: { ref1: "/tmp/does-not-matter.png" },
      authoring_options: {
        asset: { outline: false, colors: 16, palette: null },
        asset_layouts: [layout(0)],
        frame_sequence: [1],
      },
    });
    runCli(request);

    const outputDir = request.output_dir;
    const result = JSON.parse(readFileSync(path.join(outputDir, "result.json"), "utf8")) as {
      summary: { pixel_art: { layers: { name: string }[] } };
    };
    expect(result.summary.pixel_art.layers[0]?.name).toBe("body");
    const state = JSON.parse(readFileSync(path.join(outputDir, "state.json"), "utf8")) as {
      refs: string[];
      pixel_art: string;
    };
    expect(state.refs).toEqual(["ref1"]);
    expect(JSON.parse(state.pixel_art)).toEqual(result.summary.pixel_art);
  });

  it("runs a render operation end to end: emits PIXEL_PROGRESS lines and writes a manifest + PNGs", () => {
    const art = new PixelArt({ D: "#101010", G: "#efefef" }, { 0: [4, 4] });
    art.layer("body", 0, Canvas.fromRows(["DDDD", "DGGD", "DGGD", "DDDD"]));
    const artDict: PixelArtDict = art.toDict();

    const request = baseRequest({
      operation: "sprites",
      pixel_art: artDict,
      options: {
        asset: { outline: false, colors: 16, palette: null },
        asset_layouts: [layout(0)],
        frame_sequence: [1, 2],
        supersampling: 1,
      },
    });
    const { stdout } = runCli(request);

    expect(stdout).toContain('PIXEL_PROGRESS {"stage":"rendering","completed":1,"total":2}');
    expect(stdout).toContain('PIXEL_PROGRESS {"stage":"rendering","completed":2,"total":2}');

    const outputDir = request.output_dir;
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "result.json"), "utf8")) as {
      frames: { filename: string }[];
    };
    expect(manifest.frames.map((f) => f.filename)).toEqual([
      "view_00_frame_000001.png",
      "view_00_frame_000002.png",
    ]);
    expect(existsSync(path.join(outputDir, "view_00_frame_000001.png"))).toBe(true);
  });

  it("exits non-zero and prints a stack trace when the operation throws", () => {
    const request = baseRequest({ operation: "sprites", options: {} });
    const requestPath = path.join(dir, "request.json");
    writeFileSync(requestPath, JSON.stringify(request), "utf8");
    expect(() =>
      execFileSync(process.execPath, [RUNNER_JS, requestPath], { stdio: "pipe" }),
    ).toThrow();
  });
});
