/**
 * Unit coverage of `definitionToArt`/`validateAuthoredArt`/`buildSaveScript` -- the integration
 * gap `packages/schema`'s own `authoring.ts` doc comment flags and defers to this package (see
 * that file's top comment, and `pixel-authoring.ts`'s own).
 */

import { PixelDefinitionSchema, resolveAsset, AssetSpecSchema, type AssetLayout } from "@pixel-art-mcp/schema";
import { describe, expect, it } from "vitest";

import { buildSaveScript, definitionToArt, validateAuthoredArt } from "./pixel-authoring.js";

function furnitureLayouts(): readonly AssetLayout[] {
  const options = resolveAsset(AssetSpecSchema.parse({ kind: "furniture", name: "Chair", asset_id: "CHAIR" }));
  return options.asset_layouts as unknown as AssetLayout[];
}

describe("definitionToArt", () => {
  it("builds a real PixelArt from literal rows", () => {
    const layouts = furnitureLayouts();
    const definition = PixelDefinitionSchema.parse({
      palette: { D: "#293039", G: "#f3cf65" },
      layers: [
        {
          name: "body",
          poses: layouts.map((layout) => ({
            angle: layout.angle,
            rows: Array.from({ length: layout.height }, () => "D".repeat(layout.width)),
          })),
        },
      ],
    });
    const art = definitionToArt(definition, layouts);
    expect(art.layers[0]?.name).toBe("body");
    expect(art.layers[0]?.poses).toHaveLength(layouts.length);
    expect(art.toDict().palette).toEqual({ D: "#293039", G: "#f3cf65" });
  });

  it("builds a real PixelArt from numeric drawing commands (rect/line/stamp)", () => {
    const layouts = furnitureLayouts();
    const definition = PixelDefinitionSchema.parse({
      palette: { D: "#293039", G: "#f3cf65" },
      layers: [
        {
          name: "body",
          poses: layouts.map((layout) => ({
            angle: layout.angle,
            drawing: {
              width: layout.width,
              height: layout.height,
              commands: [
                { op: "rect", x: 0, y: 0, width: layout.width, height: layout.height, color: "D" },
                {
                  op: "line",
                  x1: 0,
                  y1: 0,
                  x2: layout.width - 1,
                  y2: layout.height - 1,
                  color: "G",
                },
              ],
            },
          })),
        },
      ],
    });
    const art = definitionToArt(definition, layouts);
    const firstPose = art.layers[0]?.poses[0];
    expect(firstPose?.rows[0]?.[0]).toBe("G"); // the line starts at (0,0), painted after the rect
  });

  it("mirrors a drawing when mirror_x is set", () => {
    const layouts = [{ angle: 0, width: 4, height: 1 }] as unknown as readonly AssetLayout[];
    const definition = PixelDefinitionSchema.parse({
      palette: { D: "#293039", G: "#f3cf65" },
      layers: [
        {
          name: "arrow",
          poses: [
            {
              angle: 0,
              drawing: {
                width: 4,
                height: 1,
                mirror_x: true,
                commands: [{ op: "rect", x: 0, y: 0, width: 2, height: 1, color: "D" }],
              },
            },
          ],
        },
      ],
    });
    const art = definitionToArt(definition, layouts);
    // Unmirrored the rect covers columns 0-1 ("DD.."); mirrored it should cover columns 2-3.
    expect(art.layers[0]?.poses[0]?.rows[0]).toBe("..DD");
  });
});

describe("validateAuthoredArt", () => {
  it("passes for a definition matching the configured canvases with visible ink", () => {
    const options = resolveAsset(AssetSpecSchema.parse({ kind: "furniture", name: "Chair", asset_id: "CHAIR" }));
    const layouts = options.asset_layouts as unknown as AssetLayout[];
    const definition = PixelDefinitionSchema.parse({
      palette: { D: "#293039", G: "#f3cf65" },
      layers: [
        {
          name: "body",
          poses: layouts.map((layout) => ({
            angle: layout.angle,
            rows: Array.from({ length: layout.height }, () => "D".repeat(layout.width)),
          })),
        },
      ],
    });
    const art = definitionToArt(definition, layouts);
    expect(() => validateAuthoredArt(art.toDict() as unknown as Record<string, unknown>, options)).not.toThrow();
  });

  it("wraps a mismatched definition in a DomainError with the Python-verbatim message prefix", () => {
    const options = resolveAsset(AssetSpecSchema.parse({ kind: "furniture", name: "Chair", asset_id: "CHAIR" }));
    expect(() =>
      validateAuthoredArt({ version: 1, palette: {}, views: {}, layers: [] }, options),
    ).toThrow(/^Invalid pixel-art definition: /);
  });
});

describe("buildSaveScript", () => {
  it("produces a script that round-trips through JSON embedding", () => {
    const data = {
      version: 1,
      palette: { D: "#293039" },
      views: { "0": [16, 16] as [number, number] },
      layers: [],
    };
    const script = buildSaveScript(data);
    expect(script).toContain('import { PixelArt } from "@pixel-art-mcp/pixel-core"');
    expect(script).toContain("export default function main(scene: Scene): void");
    expect(script).toContain("art.save(scene)");
    // The embedded literal really is valid JSON when unwrapped once.
    const match = /JSON\.parse\((".*")\)/.exec(script);
    if (!match?.[1]) throw new Error("expected script to embed a JSON.parse(\"...\") literal");
    const inner = JSON.parse(match[1]) as string;
    expect(JSON.parse(inner)).toEqual(data);
  });
});
