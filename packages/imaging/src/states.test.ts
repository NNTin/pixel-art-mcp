/**
 * Port of `tests/unit/test_states.py`'s export-behavior cases.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DomainError,
  RenderOptionsSchema,
  renderOptionsFrames,
  renderOptionsRenderFrames,
} from "@pixel-art-mcp/schema";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createImage, readPng, setPixel, writePng } from "./image.js";
import { exportSheet, type RenderManifestLike } from "./pixels.js";

describe("exportSheet with options.states", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-states-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stateOptions(overrides: Record<string, unknown> = {}) {
    return RenderOptionsSchema.parse({
      width: 8,
      height: 8,
      angles: [0, 90],
      supersampling: 2,
      states: [
        { id: "empty", name: "Empty", frame_start: 1, frame_end: 2, off_frame: 0 },
        { id: "full", name: "Full </script>", frame_start: 11, frame_end: 12, off_frame: 10 },
      ],
      pixel_agents: { asset_id: "BARREL", name: "Barrel", footprint_w: 1, footprint_h: 2 },
      ...overrides,
    });
  }

  it("shares a palette/layout, builds an idle player, and combines the pixel-agents package", () => {
    const options = stateOptions();
    expect(renderOptionsFrames(options)).toEqual([1, 2, 11, 12]);
    expect(renderOptionsRenderFrames(options)).toEqual([1, 2, 11, 12, 0, 10]);

    const raw = path.join(dir, "raw");
    const entries: { angle: number; frame: number; filename: string; pivot: [number, number] }[] =
      [];
    for (const angle of options.angles) {
      for (const frame of renderOptionsRenderFrames(options)) {
        const name = `${String(angle)}-${String(frame)}.png`;
        const image = createImage(16, 16);
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++)
            setPixel(image, x, y, [(frame * 20) % 256, Math.trunc(angle) % 256, 128, 255]);
        }
        writePng(path.join(raw, name), image);
        entries.push({ angle, frame, filename: name, pivot: [4, 7] });
      }
    }
    const out = path.join(dir, "out");
    const manifest: RenderManifestLike = { frames: entries, camera: { pivot: [4, 7] } };
    exportSheet(raw, out, manifest, options, "p", "r");

    const meta = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
      size: [number, number];
      states: {
        id: string;
        directions: { animation: string | null; frame_indices: number[]; row: number }[];
      }[];
      frames: { rect: [number, number, number, number]; filename: string }[];
      camera: unknown;
    };
    expect(meta.size).toEqual([16, 32]);
    expect(meta.states.map((s) => s.id)).toEqual(["empty", "full"]);
    expect(meta.frames).toHaveLength(8);
    expect(meta.frames[4]?.rect).toEqual([0, 16, 8, 8]);
    expect(meta.frames[4]?.filename).toBe("states/full/frames/direction_00_frame_000011.png");
    expect(meta.states[1]?.directions[0]?.animation?.startsWith("states/full/")).toBe(true);
    expect(meta.states[1]?.directions[0]?.frame_indices).toEqual([4, 5]);
    expect(meta.states[1]?.directions[0]?.row).toBe(2);

    const sheet = readPng(path.join(out, "spritesheet.png"));
    for (const frame of meta.frames) {
      const [x, y, w, h] = frame.rect;
      const expectedImage = readPng(path.join(out, frame.filename));
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const sheetOffset = ((y + dy) * sheet.width + (x + dx)) * 4;
          const expectedOffset = (dy * expectedImage.width + dx) * 4;
          expect(Array.from(sheet.data.slice(sheetOffset, sheetOffset + 4))).toEqual(
            Array.from(expectedImage.data.slice(expectedOffset, expectedOffset + 4)),
          );
        }
      }
    }

    for (const state of options.states ?? []) {
      const childDir = path.join(out, "states", state.id);
      const childMeta = JSON.parse(
        readFileSync(path.join(childDir, "spritesheet.json"), "utf-8"),
      ) as {
        camera: unknown;
        palette: string[];
        settings: { pixel_agents: { off_frame: number | null } };
      };
      expect(childMeta.camera).toEqual(meta.camera);
      expect(childMeta.settings.pixel_agents.off_frame).toBe(state.off_frame);
    }

    const html = readFileSync(path.join(out, "preview.html"), "utf-8");
    expect(html).not.toContain("__PLAYER_DATA__");
    expect(html).not.toContain("Full </script>");
    const afterMarker = html.split("const data=", 2)[1];
    expect(afterMarker).toBeDefined();
    const data = JSON.parse((afterMarker ?? "").split(";", 1)[0] ?? "{}") as {
      states: { name: string; image: string }[];
    };
    expect(data.states).toHaveLength(2);
    expect(data.states[1]?.name).toBe("Full </script>");
    const firstImage = data.states[0]?.image;
    expect(firstImage).toBeDefined();
    if (firstImage) {
      expect(Buffer.from(firstImage, "base64")).toEqual(
        readFileSync(path.join(out, "states/empty/spritesheet.png")),
      );
    }

    const archive = unzipSync(readFileSync(path.join(out, "pixel-agents.zip")));
    expect(Object.keys(archive)).toContain("assets/furniture/BARREL_EMPTY/manifest.json");
    expect(Object.keys(archive)).toContain("assets/furniture/BARREL_FULL/manifest.json");
    expect(Object.keys(archive).filter((n) => n.endsWith(".png"))).toHaveLength(12);

    const spritesArchive = unzipSync(readFileSync(path.join(out, "sprites.zip")));
    expect(Object.keys(spritesArchive)).toContain("preview.html");
    expect(Object.keys(spritesArchive)).toContain("pixel-agents.zip");
    expect(Object.keys(spritesArchive)).toContain("states/full/preview.html");
    expect(Object.keys(spritesArchive)).toContain("preview.gif");
    expect(Object.keys(spritesArchive)).toContain("states/full/preview.gif");

    expect(() => {
      exportSheet(
        raw,
        path.join(dir, "bad"),
        { ...manifest, frames: entries.slice(0, -1) },
        options,
        "p",
        "r",
      );
    }).toThrow(DomainError);
    expect(() => {
      exportSheet(
        raw,
        path.join(dir, "bad2"),
        { ...manifest, frames: entries.slice(0, -1) },
        options,
        "p",
        "r",
      );
    }).toThrow(/incomplete or unordered/);
  });

  it("mixes a static state with an animated state", () => {
    const options = RenderOptionsSchema.parse({
      width: 8,
      height: 8,
      angles: [0, 90],
      supersampling: 1,
      states: [
        { id: "empty", name: "Empty", frame_start: 1, frame_end: 1 },
        { id: "full", name: "Full", frame_start: 2, frame_end: 3 },
      ],
    });
    expect(renderOptionsFrames(options)).toEqual([1, 2, 3]);
    expect(renderOptionsRenderFrames(options)).toEqual([1, 2, 3]);

    const raw = path.join(dir, "raw");
    const entries: { angle: number; frame: number; filename: string; pivot: [number, number] }[] =
      [];
    for (const angle of options.angles) {
      for (const frame of renderOptionsRenderFrames(options)) {
        const name = `${String(angle)}-${String(frame)}.png`;
        const image = createImage(8, 8);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++)
            setPixel(image, x, y, [(frame * 20) % 256, Math.trunc(angle) % 256, 128, 255]);
        }
        writePng(path.join(raw, name), image);
        entries.push({ angle, frame, filename: name, pivot: [4, 7] });
      }
    }
    const out = path.join(dir, "out");
    const manifest: RenderManifestLike = { frames: entries, camera: { pivot: [4, 7] } };
    exportSheet(raw, out, manifest, options, "p", "r");

    const meta = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
      columns: number;
      states: { frames: number[] }[];
    };
    expect(meta.columns).toBe(2);
    expect(meta.states[0]?.frames).toEqual([1]);
    expect(meta.states[1]?.frames).toEqual([2, 3]);

    const html = readFileSync(path.join(out, "preview.html"), "utf-8");
    const afterMarker = html.split("const data=", 2)[1];
    const data = JSON.parse((afterMarker ?? "").split(";", 1)[0] ?? "{}") as {
      states: { columns: number }[];
    };
    expect(data.states[0]?.columns).toBe(1);
    expect(data.states[1]?.columns).toBe(2);

    const sheet = readPng(path.join(out, "spritesheet.png"));
    const w = options.width;
    const h = options.height;
    function region(x0: number, y0: number, width: number, height: number): number[] {
      const out2: number[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = ((y0 + y) * sheet.width + (x0 + x)) * 4;
          out2.push(...Array.from(sheet.data.slice(offset, offset + 4)));
        }
      }
      return out2;
    }
    const emptyCol0 = region(0, 0, w, 2 * h);
    const emptyCol1 = region(w, 0, w, 2 * h);
    expect(emptyCol0).toEqual(emptyCol1);
  });
});
