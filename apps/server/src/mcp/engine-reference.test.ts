/**
 * Proves `get_pixel_engine_reference`'s content is real, not a stub:
 *
 * 1. `type_declarations` actually comes from `@pixel-art-mcp/pixel-core`'s compiled `.d.ts`
 *    output (asserted by looking for real class signatures and a doc-comment sentence that only
 *    exists in the source, never hand-transcribed here).
 * 2. Every hand-written `examples[].code` string is run through the *real* strict-mode
 *    compile-and-execute sandbox (`@pixel-art-mcp/engine`'s `executeScript` -- the exact function
 *    a real `execute_pixel_script` submission runs through, see `packages/engine/src/
 *    script-runtime.ts`), proving it actually type-checks against the real `pixel-core` package
 *    and produces a `PixelArt` that package itself accepts as valid (round-tripped through
 *    `PixelArt.load`).
 */

import { executeScript } from "@pixel-art-mcp/engine";
import { PixelArt } from "@pixel-art-mcp/pixel-core";
import { describe, expect, it } from "vitest";

import { buildEngineReference } from "./engine-reference.js";

describe("get_pixel_engine_reference content", () => {
  const reference = buildEngineReference();

  it("extracts real compiled .d.ts content, not hand-transcribed prose", () => {
    const typeDeclarations = reference["type_declarations"];
    expect(typeof typeDeclarations).toBe("string");
    const text = typeDeclarations as string;
    expect(text).toContain("export declare class Canvas");
    expect(text).toContain("export declare class PixelArt");
    expect(text).toContain("static fromRows(rows: readonly string[]): Canvas;");
    expect(text).toContain(
      "validateTarget(layouts: readonly AssetLayout[], frames: readonly number[], spec: AssetValidationSpec): void;",
    );
    // A doc-comment sentence that lives only in canvas.ts's source -- present here only because
    // this reads the compiled artifact, not because it was copied by hand into this file.
    expect(text).toContain(
      "Integer pixels, top-left origin. A dot (`.`) is transparent, never an eraser.",
    );
    // The build's own source-map comment is stripped -- it points at a .map file this tool
    // never ships and isn't part of the API surface.
    expect(text).not.toContain("sourceMappingURL");
  });

  it("caches the built reference across calls instead of re-reading the filesystem every time", () => {
    expect(buildEngineReference()).toBe(reference);
  });

  it("every hand-written example is real TypeScript that type-checks and produces a valid PixelArt", async () => {
    const examples = reference["examples"] as { title: string; code: string }[];
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) {
      const scene: Record<string, unknown> = {};
      // Real strict-mode compile + execute against the real pixel-core package -- exactly what
      // execute_pixel_script itself runs a submission through.
      await executeScript(example.code, scene, {});
      expect(typeof scene["pixel_art"]).toBe("string");
      const art = PixelArt.load(scene);
      expect(art.layers.length).toBeGreaterThan(0);
      expect(art.layers.some((layer) => layer.poses.length > 0)).toBe(true);
    }
  });

  it("includes reviewed narrative guidance covering the frozen-prototype safety property", () => {
    const guidance = reference["guidance"];
    expect(typeof guidance).toBe("string");
    const text = guidance as string;
    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain("frozen");
    expect(text).toContain("fresh");
  });
});
