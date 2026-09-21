import { describe, expect, it } from "vitest";

import { PIXEL_CORE_DIR, splitPixelCoreDeclarations } from "./split-declarations.js";

/** A small stand-in for `get_pixel_engine_reference`'s real `type_declarations` string, in the
 * exact shape `apps/server/src/mcp/engine-reference.ts`'s `readTypeDeclarations` produces (one
 * `// ===== file =====` marker per section, files joined by a blank line). */
function fixture(): string {
  return [
    "// ===== index.d.ts =====",
    'export { Canvas } from "./canvas.js";',
    "",
    "// ===== canvas.d.ts =====",
    "export declare class Canvas {",
    "  width: number;",
    "}",
    "",
  ].join("\n");
}

describe("splitPixelCoreDeclarations", () => {
  it("splits the concatenated type_declarations string back into per-file virtual modules", () => {
    const files = splitPixelCoreDeclarations(fixture());
    expect([...files.keys()]).toEqual([
      `${PIXEL_CORE_DIR}/index.d.ts`,
      `${PIXEL_CORE_DIR}/canvas.d.ts`,
    ]);
    expect(files.get(`${PIXEL_CORE_DIR}/index.d.ts`)).toBe('export { Canvas } from "./canvas.js";');
    expect(files.get(`${PIXEL_CORE_DIR}/canvas.d.ts`)).toBe(
      "export declare class Canvas {\n  width: number;\n}",
    );
  });

  it("returns an empty map for a string with no markers", () => {
    expect(splitPixelCoreDeclarations("not a real reference dump").size).toBe(0);
  });
});
