/**
 * Exercises `executeScript` directly: a valid script that imports `@pixel-art-mcp/pixel-core`
 * and mutates `scene`/reads `referenceImages`, a script that fails to type-check (compile
 * error), a script whose default export throws at run time, and a script with no valid default
 * export.
 *
 * Note: this file deliberately does *not* assert on `.script-scratch`'s directory-entry count as
 * a cleanup proxy -- that directory is shared, global, mutable filesystem state across every
 * concurrently-running test file/worker in this package (including `runner.e2e.test.ts`'s real
 * subprocesses, which use the same scratch root), so counting its entries is inherently racy
 * under vitest's parallel test execution. `executeScript`'s `finally`-block cleanup is a simple
 * enough guarantee to read directly in `script-runtime.ts` instead.
 */

import { describe, expect, it } from "vitest";

import { executeScript, ScriptCompileError, ScriptRuntimeError } from "./script-runtime.js";

describe("executeScript", () => {
  it("compiles and runs a valid script that imports pixel-core and mutates scene", async () => {
    const source = `
      import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

      export default function main(scene: Scene, referenceImages: ReferenceImages): void {
        const art = new PixelArt({ D: "#101010", G: "#efefef" }, { 0: [2, 2] });
        art.layer("body", 0, Canvas.fromRows(["DG", "GD"]));
        art.save(scene);
        scene["referenceCount"] = Object.keys(referenceImages).length;
      }
    `;
    const scene: Record<string, unknown> = {};
    await executeScript(source, scene, { ref1: "/tmp/ref1.png", ref2: "/tmp/ref2.png" });

    expect(typeof scene["pixel_art"]).toBe("string");
    expect(scene["referenceCount"]).toBe(2);
    const data = JSON.parse(scene["pixel_art"] as string) as { layers: { name: string }[] };
    expect(data.layers[0]?.name).toBe("body");
  });

  it("supports an async default export", async () => {
    // No `setTimeout` here deliberately: the compile sandbox's `lib` is ES2022-only, with no DOM
    // and no Node ambient globals (see script-runtime.ts's top comment) -- `Promise.resolve()`
    // is enough to prove `await`ing the default export's returned promise actually works.
    const source = `
      export default async function main(scene: Scene): Promise<void> {
        await Promise.resolve();
        scene["done"] = true;
      }
    `;
    const scene: Record<string, unknown> = {};
    await executeScript(source, scene, {});
    expect(scene["done"]).toBe(true);
  });

  it("rejects with ScriptCompileError, carrying diagnostics, for a type error", async () => {
    const source = `
      export default function main(scene: Scene): void {
        const bad: number = "not a number";
        scene["x"] = bad;
      }
    `;
    const scene: Record<string, unknown> = {};
    let caught: unknown;
    try {
      await executeScript(source, scene, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptCompileError);
    const compileError = caught as ScriptCompileError;
    expect(compileError.diagnostics.length).toBeGreaterThan(0);
    expect(compileError.diagnostics[0]?.message).toMatch(/not assignable/i);
    expect(compileError.diagnostics[0]?.line).not.toBeNull();
    // Nothing was written to `scene` before the compile failure.
    expect(scene).toEqual({});
  });

  it("rejects with ScriptCompileError for an unknown import (only pixel-core is reachable)", async () => {
    const source = `
      import { readFileSync } from "node:fs";
      export default function main(scene: Scene): void {
        scene["x"] = readFileSync;
      }
    `;
    await expect(executeScript(source, {}, {})).rejects.toBeInstanceOf(ScriptCompileError);
  });

  it("rejects with ScriptRuntimeError when the script's default export throws", async () => {
    const source = `
      export default function main(): void {
        throw new Error("boom from script");
      }
    `;
    let caught: unknown;
    try {
      await executeScript(source, {}, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptRuntimeError);
    expect((caught as Error).message).toContain("boom from script");
    expect((caught as ScriptRuntimeError).cause).toBeInstanceOf(Error);
  });

  it("rejects with ScriptRuntimeError when there is no default export function", async () => {
    const source = `
      export function main(scene: Scene): void {
        scene["never"] = true;
      }
    `;
    await expect(executeScript(source, {}, {})).rejects.toThrow(
      /must have a default export/,
    );
  });
});
