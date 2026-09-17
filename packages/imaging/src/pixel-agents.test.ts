/**
 * Port of `tests/unit/test_pixel_agents.py`'s export-behavior case.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RenderOptionsSchema } from "@pixel-art-mcp/schema";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodePngBuffer, readPng, setPixel, createImage, writePng } from "./image.js";
import { exportSheet, type RenderManifestLike } from "./pixels.js";

describe("exportSheet with options.pixel_agents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-pixel-agents-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "produces an installable package with a real high-resolution comparison (animated=%s)",
    (animated) => {
      const options = RenderOptionsSchema.parse({
        tile_height: 3,
        angles: [90, 0],
        supersampling: 2,
        frame_start: 2,
        frame_end: animated ? 4 : 2,
        frame_step: 2,
        pixel_agents: {
          asset_id: "LAMP",
          name: "Lamp",
          can_place_on_surfaces: true,
          footprint_w: 1,
          footprint_h: 1,
          off_frame: animated ? 0 : null,
        },
      });
      const raw = path.join(dir, "raw");
      const out = path.join(dir, "out");
      const entries: { filename: string; angle: number; frame: number; pivot: [number, number] }[] = [];
      const originals: ReturnType<typeof createImage>[] = [];
      // `options.render_frames()`: frame_sequence-order frames (2, 4) then any off_frame not
      // already present appended at the end (0) -- matches `renderOptionsRenderFrames`.
      const renderFrames = animated ? [2, 4, 0] : [2];
      options.angles.forEach((angle, row) => {
        for (const frame of renderFrames) {
          const image = createImage(32, 96);
          for (let y = 55; y <= 90; y++) {
            for (let x = 8 + frame; x <= 24; x++) setPixel(image, x, y, [150, (80 + row * 50) % 256, 20, 255]);
          }
          if (frame) {
            // Isolated pixels survive here, but not in nearest-upscaled low-res.
            setPixel(image, 10 + frame, 20, [255, 230, 10, 255]);
          }
          const name = `${String(row)}_${String(frame)}.png`;
          writePng(path.join(raw, name), image);
          originals.push(image);
          entries.push({ filename: name, angle, frame, pivot: [8, 44] });
        }
      });
      const manifest: RenderManifestLike = { frames: entries, camera: {} };
      exportSheet(raw, out, manifest, options, "p", "r");

      const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
        settings: { fps: number };
        frames: { duration_ms: number }[];
        comparison: { image: string; off_image: string | null };
      };
      expect(metadata.settings.fps).toBe(5);
      expect(metadata.frames.every((f) => f.duration_ms === 200)).toBe(true);

      const high = readPng(path.join(out, metadata.comparison.image));
      const firstOriginal = originals[0];
      expect(firstOriginal).toBeDefined();
      if (firstOriginal) {
        // The comparison sheet pastes each (row, column) cell at (column * 32, row * 96); the
        // first raw entry (row 0, column 0) occupies that top-left 32x96 region, but the sheet
        // itself may be wider than 32px (one column per frame) -- crop by row, not a flat slice.
        const cropped: number[] = [];
        for (let y = 0; y < 96; y++) {
          const offset = (y * high.width + 0) * 4;
          cropped.push(...Array.from(high.data.slice(offset, offset + 32 * 4)));
        }
        expect(cropped).toEqual(Array.from(firstOriginal.data));
      }

      const archive = unzipSync(readFileSync(path.join(out, "pixel-agents.zip")));
      const root = "assets/furniture/LAMP/";
      const manifestBytes = archive[`${root}manifest.json`];
      expect(manifestBytes).toBeDefined();
      if (!manifestBytes) return;
      const pkgManifest = JSON.parse(Buffer.from(manifestBytes).toString("utf-8")) as {
        groupType: string;
        rotationScheme: string;
        canPlaceOnSurfaces: boolean;
        members: Record<string, unknown>[];
      };
      expect(pkgManifest.groupType).toBe("rotation");
      expect(pkgManifest.rotationScheme).toBe("4-way");
      expect(pkgManifest.canPlaceOnSurfaces).toBe(true);
      expect(pkgManifest.members.map((m) => m["orientation"])).toEqual(["right", "front"]);

      pkgManifest.members.forEach((member) => {
        let leaves: Record<string, unknown>[];
        if (animated) {
          expect(member["groupType"]).toBe("state");
          const groupMembers = member["members"] as Record<string, unknown>[];
          const off = groupMembers[0];
          expect(off).toBeDefined();
          if (!off) return;
          const on = groupMembers[1] as { groupType: string; state: string; members: Record<string, unknown>[] };
          expect(off["state"]).toBe("off");
          expect(on.groupType).toBe("animation");
          expect(on.state).toBe("on");
          expect(on.members.map((leaf) => leaf["frame"])).toEqual([0, 1]);
          leaves = [off, ...on.members];
        } else {
          expect(member["type"]).toBe("asset");
          leaves = [member];
        }
        for (const leaf of leaves) {
          expect(leaf["width"]).toBe(16);
          expect(leaf["height"]).toBe(48);
          expect(leaf["footprintW"]).toBe(1);
          expect(leaf["footprintH"]).toBe(1);
          const bytes = archive[`${root}${leaf["file"] as string}`];
          expect(bytes).toBeDefined();
          if (!bytes) continue;
          const decoded = decodePngBuffer(Buffer.from(bytes));
          expect([decoded.width, decoded.height]).toEqual([16, 48]);
        }
      });
      expect(Object.keys(archive).length).toBe(animated ? 7 : 3);

      const html = readFileSync(path.join(out, "preview.html"), "utf-8");
      const afterMarker = html.split("const data = ", 2)[1];
      expect(afterMarker).toBeDefined();
      const data = JSON.parse((afterMarker ?? "").split(";", 1)[0] ?? "{}") as {
        target: { width: number; height: number };
        comparison: { width: number; height: number; image: string };
        offImage: string | null;
      };
      expect(data.target.width).toBe(16);
      expect(data.target.height).toBe(48);
      expect(data.comparison.width).toBe(32);
      expect(data.comparison.height).toBe(96);
      expect(Buffer.from(data.comparison.image, "base64")).toEqual(
        readFileSync(path.join(out, "comparison/high-resolution.png")),
      );
      expect(Boolean(data.offImage)).toBe(animated);
      expect(html).toContain("USED BY PIXEL-AGENTS");
    },
  );
});
