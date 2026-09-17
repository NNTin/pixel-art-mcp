/**
 * Exercises `runScript`/`runRender`/`main` directly (fast, no subprocess) -- see
 * `runner.e2e.test.ts` for the one true end-to-end test that runs the compiled CLI as a real
 * `node` subprocess.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Canvas, PixelArt, type PixelArtDict } from "@pixel-art-mcp/pixel-core";
import type { AssetLayout } from "@pixel-art-mcp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main, runRender, runScript, type EngineRequest } from "./runner.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-engine-runner-"));
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

const AUTHORING_OPTIONS = {
  asset: { outline: false, colors: 16, palette: null },
  asset_layouts: [layout(0)],
  frame_sequence: [1],
};

function baseRequest(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    schema_version: 1,
    operation: "script",
    input_state: null,
    pixel_art: null,
    output_dir: dir,
    script_path: null,
    references: {},
    options: null,
    authoring_options: null,
    pixel_art_required: false,
    ...overrides,
  };
}

const VALID_ART_SCRIPT = `
  import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";
  export default function main(scene: Scene): void {
    const art = new PixelArt({ D: "#101010", G: "#efefef" }, { 0: [4, 4] });
    art.layer("body", 0, Canvas.fromRows(["DDDD", "DGGD", "DGGD", "DDDD"]));
    art.save(scene);
  }
`;

function writeScript(source: string): string {
  const scriptPath = path.join(dir, "submitted.ts");
  writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

describe("runScript", () => {
  it("writes state.json and returns a null summary for a script that doesn't touch pixel_art", async () => {
    const scriptPath = writeScript(`
      export default function main(scene: Scene): void {
        scene["note"] = "hello";
      }
    `);
    const result = await runScript(baseRequest({ script_path: scriptPath }), dir);
    expect(result).toEqual({ summary: { pixel_art: null } });
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(state).toEqual({ note: "hello" });
  });

  it("validates and returns pixel_art in the summary when the script saves one that matches authoring_options", async () => {
    const scriptPath = writeScript(VALID_ART_SCRIPT);
    const result = await runScript(
      baseRequest({ script_path: scriptPath, authoring_options: AUTHORING_OPTIONS }),
      dir,
    );
    expect(result.summary.pixel_art).not.toBeNull();
    expect(result.summary.pixel_art?.layers[0]?.name).toBe("body");
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as {
      pixel_art: string;
    };
    expect(JSON.parse(state.pixel_art)).toEqual(result.summary.pixel_art);
  });

  it("rejects when pixel_art is saved without authoring_options configured", async () => {
    const scriptPath = writeScript(VALID_ART_SCRIPT);
    await expect(runScript(baseRequest({ script_path: scriptPath }), dir)).rejects.toThrow(
      "Call configure_asset before saving pixel art",
    );
  });

  it("rejects when the saved pixel_art doesn't match the configured views", async () => {
    const scriptPath = writeScript(`
      import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";
      export default function main(scene: Scene): void {
        const art = new PixelArt({ D: "#101010", G: "#efefef" }, { 0: [8, 8] });
        art.layer("body", 0, Canvas.fromRows(new Array(8).fill("DDDDDDDD")));
        art.save(scene);
      }
    `);
    await expect(
      runScript(
        baseRequest({ script_path: scriptPath, authoring_options: AUTHORING_OPTIONS }),
        dir,
      ),
    ).rejects.toThrow("Pixel views must match the configured canvases");
  });

  it("loads scene from input_state and preserves prior keys alongside new ones", async () => {
    const statePath = path.join(dir, "previous-state.json");
    writeFileSync(statePath, JSON.stringify({ existing: "value" }), "utf8");
    const scriptPath = writeScript(`
      export default function main(scene: Scene): void {
        scene["added"] = true;
      }
    `);
    const result = await runScript(
      baseRequest({ script_path: scriptPath, input_state: statePath }),
      dir,
    );
    expect(result).toEqual({ summary: { pixel_art: null } });
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(state).toEqual({ existing: "value", added: true });
  });

  it("rejects when script_path is missing", async () => {
    await expect(runScript(baseRequest(), dir)).rejects.toThrow("requires script_path");
  });
});

function artDict(): PixelArtDict {
  const art = new PixelArt({ D: "#101010", G: "#efefef" }, { 0: [4, 4] });
  art.layer("body", 0, Canvas.fromRows(["DDDD", "DGGD", "DGGD", "DDDD"]));
  return art.toDict();
}

describe("runRender", () => {
  it("rejects when options.asset is missing", () => {
    expect(() => runRender(baseRequest({ operation: "sprites", options: {} }), dir)).toThrow(
      "Use configure_asset, write_pixel_art and render_asset",
    );
  });

  it("rejects when pixel_art is missing", () => {
    expect(() =>
      runRender(
        baseRequest({
          operation: "sprites",
          options: { asset: { outline: false, colors: 16, palette: null } },
        }),
        dir,
      ),
    ).toThrow("Call write_pixel_art before rendering");
  });

  it("validates and renders a manifest for a well-formed request", () => {
    const manifest = runRender(
      baseRequest({
        operation: "sprites",
        pixel_art: artDict(),
        options: {
          asset: { outline: false, colors: 16, palette: null },
          asset_layouts: [layout(0)],
          frame_sequence: [1, 2],
          supersampling: 1,
        },
      }),
      dir,
    );
    expect(manifest.frames).toHaveLength(2);
    expect(manifest.camera.views).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual([
      "view_00_frame_000001.png",
      "view_00_frame_000002.png",
    ]);
  });
});

describe("main", () => {
  it("reads request.json, runs the render operation, and writes result.json", async () => {
    const requestPath = path.join(dir, "request.json");
    const outputDir = path.join(dir, "out");
    const request = baseRequest({
      operation: "sprites",
      output_dir: outputDir,
      pixel_art: artDict(),
      options: {
        asset: { outline: false, colors: 16, palette: null },
        asset_layouts: [layout(0)],
        frame_sequence: [1],
        supersampling: 1,
      },
    });
    writeFileSync(requestPath, JSON.stringify(request), "utf8");
    await main(requestPath);
    const result = JSON.parse(readFileSync(path.join(outputDir, "result.json"), "utf8")) as {
      frames: unknown[];
    };
    expect(result.frames).toHaveLength(1);
    expect(readdirSync(outputDir)).toContain("view_00_frame_000001.png");
  });

  it("reads request.json, runs the script operation, and writes state.json + result.json", async () => {
    const requestPath = path.join(dir, "request.json");
    const outputDir = path.join(dir, "out");
    const scriptPath = writeScript(`
      export default function main(scene: Scene): void {
        scene["ok"] = true;
      }
    `);
    const request = baseRequest({ output_dir: outputDir, script_path: scriptPath });
    writeFileSync(requestPath, JSON.stringify(request), "utf8");
    await main(requestPath);
    const result = JSON.parse(readFileSync(path.join(outputDir, "result.json"), "utf8")) as {
      summary: { pixel_art: unknown };
    };
    expect(result).toEqual({ summary: { pixel_art: null } });
    const state = JSON.parse(readFileSync(path.join(outputDir, "state.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(state).toEqual({ ok: true });
  });
});
