/**
 * Port of `tests/unit/test_assets.py`'s imaging-relevant cases (the `service`-fixture-dependent
 * persistence/render-snapshot tests aren't ported here -- that's `packages/service`/`apps/server`
 * territory, later phases).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";
import {
  AssetSpecSchema,
  DomainError,
  resolveAsset,
  renderOptionsFrames,
  type AssetLayout,
  type RenderOptions,
} from "@pixel-art-mcp/schema";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assetReport, exportAsset, type AssetExportManifest, type AssetExportManifestFrame } from "./asset-export.js";
import { createImage, readPng, setPixel, writePng, type RGBAImage } from "./image.js";
import { inspectSprite } from "./inspection.js";

function fillRectInclusive(
  image: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number, number],
): void {
  for (let y = Math.max(0, y0); y <= Math.min(image.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(image.width - 1, x1); x++) setPixel(image, x, y, color);
  }
}

function fixtureExport(
  dir: string,
  kind: "furniture" | "character" | "pet" = "furniture",
  overrides: Record<string, unknown> = {},
): { out: string; options: RenderOptions; manifest: AssetExportManifest } {
  const spec = AssetSpecSchema.parse({ kind, name: "Fixture", asset_id: "FIXTURE", ...overrides });
  const options = resolveAsset(spec, "configuration-1");
  const layouts = options.asset_layouts as unknown as AssetLayout[];
  const raw = path.join(dir, "raw");
  const out = path.join(dir, "out");

  const art = new PixelArt(
    { D: "#293039", G: "#f3cf65", B: "#5285b8" },
    Object.fromEntries(layouts.map((row) => [row.angle, [row.width, row.height]])),
  );
  const entries: AssetExportManifestFrame[] = [];
  const views: Record<string, unknown>[] = [];
  const frames = renderOptionsFrames(options);
  for (const row of layouts) {
    art.layer("detail", row.angle, Canvas.fromRows(["GG", "GG"]), { x: 5, y: 5 });
    views.push({ ...row, objects: [{ name: "Body", pixel_width: 12, pixel_height: 20 }] });
    for (const frame of frames) {
      art.layer("detail", row.angle, Canvas.fromRows(["GG", "GG"]), { x: 5 + (frame % 3), y: 5, frame });
      const size: [number, number] = [row.width * options.supersampling, row.height * options.supersampling];
      const im = createImage(size[0], size[1]);
      const inset = 3 * options.supersampling;
      fillRectInclusive(im, inset, inset, size[0] - inset, size[1] - inset, [
        (40 + ((frame * 10) % 200)) & 0xff,
        (70 + Math.floor(row.angle / 2)) & 0xff,
        120,
        255,
      ]);
      const filename = `${String(row.angle)}_${String(frame)}.png`;
      writePng(path.join(raw, filename), im);
      entries.push({
        angle: row.angle,
        frame,
        filename,
        pivot: [row.width / 2, row.bottom],
        pixel_layers: art.poses(row.angle, frame),
      });
    }
  }
  const manifest: AssetExportManifest = {
    frames: entries,
    camera: { views },
    pixel_art: art.toDict() as unknown as Record<string, unknown>,
  };
  exportAsset(raw, out, manifest, options, "project", "revision");
  return { out, options, manifest };
}

describe("exportAsset", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pixel-art-imaging-asset-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["furniture", "character", "pet"] as const)(
    "produces a complete, inspectable export for kind=%s",
    (kind) => {
      const { out, options } = fixtureExport(dir, kind);
      const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
        configuration_id: string;
        frames: { filename: string }[];
        package: { archive: string };
      };
      expect(metadata.configuration_id).toBe("configuration-1");
      for (const entry of metadata.frames) {
        const image = readPng(path.join(out, entry.filename));
        for (let i = 0; i < image.width * image.height; i++) {
          const offset = i * 4;
          if (image.data[offset + 3] === 0) {
            expect([image.data[offset], image.data[offset + 1], image.data[offset + 2]]).toEqual([0, 0, 0]);
          }
        }
      }
      expect(() => readFileSync(path.join(out, metadata.package.archive))).not.toThrow();
      expect(() => readFileSync(path.join(out, "context.png"))).not.toThrow();
      const html = readFileSync(path.join(out, "preview.html"), "utf-8");
      expect(html).not.toContain("__ASSET_DATA__");
      expect(html).toContain("Approximate Pixel Agents context");
      const archive = unzipSync(readFileSync(path.join(out, "sprites.zip")));
      const names = new Set(Object.keys(archive));
      for (const required of ["asset-report.json", "context.png", "preview.html"]) {
        expect(names.has(required)).toBe(true);
      }
      const layouts = options.asset_layouts as unknown as AssetLayout[];
      for (const row of layouts) {
        const inspected = inspectSprite(out, null, row.angle);
        expect(inspected.size).toEqual([row.width, row.height]);
        expect(inspected.analysis.occupied_pixels).toBeGreaterThan(0);
      }
      if (kind === "pet") {
        expect(inspectSprite(out, "idle", 90, 4).size).toEqual([32, 32]);
      }
    },
  );

  it("packs noncontiguous/reused character clip frames into the right sheet cells", () => {
    const { out } = fixtureExport(dir, "character", {
      clips: {
        walk: { frames: [12, 2, 12] },
        typing: { frames: [8, 5] },
        reading: { frames: [1, 9] },
      },
    });
    const sheet = readPng(path.join(out, "pixel-agents-character", "character.png"));
    expect([sheet.width, sheet.height]).toEqual([112, 96]);
    const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
      frames: { angle: number; frame: number; filename: string }[];
    };
    const orderedFrames = [12, 2, 12, 8, 5, 1, 9];
    [0, 180, 90].forEach((angle, row) => {
      orderedFrames.forEach((frame, col) => {
        const entry = metadata.frames.find((e) => e.angle === angle && e.frame === frame);
        expect(entry).toBeDefined();
        if (!entry) return;
        const original = readPng(path.join(out, entry.filename));
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 16; x++) {
            const sheetOffset = ((row * 32 + y) * sheet.width + (col * 16 + x)) * 4;
            const origOffset = (y * original.width + x) * 4;
            expect(Array.from(sheet.data.slice(sheetOffset, sheetOffset + 4))).toEqual(
              Array.from(original.data.slice(origOffset, origOffset + 4)),
            );
          }
        }
      });
    });
  });

  it("packages furniture clip variants with correct per-direction sizes", () => {
    const { out } = fixtureExport(dir, "furniture", {
      preset: "desk",
      clips: {
        empty: { frames: [1] },
        full: { frames: [2, 3], off_frame: 0 },
      },
    });
    const archive = unzipSync(readFileSync(path.join(out, "pixel-agents.zip")));
    const manifestNames = Object.keys(archive).filter((n) => n.endsWith("manifest.json"));
    const manifests = manifestNames.map((n) => JSON.parse(Buffer.from(archive[n] as Uint8Array).toString("utf-8")) as Record<string, unknown>);
    expect(new Set(manifests.map((m) => m["id"]))).toEqual(new Set(["FIXTURE_EMPTY", "FIXTURE_FULL"]));
    const staticManifest = manifests.find((m) => m["id"] === "FIXTURE_EMPTY") as { backgroundTiles: number; members: { width: number; height: number }[] };
    expect(staticManifest.backgroundTiles).toBe(1);
    expect(staticManifest.members.map((m) => [m.width, m.height])).toEqual([
      [48, 32],
      [16, 64],
      [48, 32],
      [16, 64],
    ]);
    expect(inspectSprite(out, "full", 90, 0).size).toEqual([16, 64]);
  });

  it("flags a disconnected silhouette without rejecting intentional detached effects", () => {
    const { out } = fixtureExport(dir);
    const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as Record<string, unknown>;
    const original = assetReport(out, metadata as never);
    const originalFrames = original["frames"] as { opaque_connected_components: number }[];
    expect(originalFrames.every((row) => row.opaque_connected_components === 1)).toBe(true);
    const originalFindings = original["findings"] as { code: string }[];
    expect(originalFindings.some((f) => f.code === "disconnected_silhouette")).toBe(false);

    const first = (metadata["frames"] as { filename: string }[])[0];
    expect(first).toBeDefined();
    if (!first) return;
    const image = createImage(16, 16);
    fillRectInclusive(image, 2, 2, 5, 5, [0xf3, 0xcf, 0x65, 255]);
    fillRectInclusive(image, 8, 8, 11, 11, [0x52, 0x85, 0xb8, 255]);
    writePng(path.join(out, first.filename), image);
    const report = assetReport(out, metadata as never);
    const findings = report["findings"] as { code: string; components: number; suggestion: string }[];
    const finding = findings.find((f) => f.code === "disconnected_silhouette");
    expect(finding).toBeDefined();
    expect(finding?.components).toBe(2);
    expect(finding?.suggestion).toContain("intentional detached effects");
    expect(report["status"]).toBe("review");
    const reportFrames = report["frames"] as { opaque_connected_components: number }[];
    expect(reportFrames[0]?.opaque_connected_components).toBe(2);
  });

  it("flags one oversized patch blending into the preview floor, but not a shrunk one", () => {
    const { out } = fixtureExport(dir);
    const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as Record<string, unknown>;
    const first = (metadata["frames"] as { filename: string; angle: number; frame: number }[])[0];
    expect(first).toBeDefined();
    if (!first) return;

    const blended = createImage(16, 16);
    fillRectInclusive(blended, 0, 0, 15, 9, [0x29, 0x30, 0x39, 255]); // 160px, close to the floor's own luma
    fillRectInclusive(blended, 0, 10, 15, 15, [0xf3, 0xcf, 0x65, 255]); // 96px, high-contrast
    writePng(path.join(out, first.filename), blended);
    const report = assetReport(out, metadata as never);
    const findings = report["findings"] as { code: string; angle: number; frame: number }[];
    const finding = findings.find((f) => f.code === "low_context_contrast");
    expect(finding).toBeDefined();
    expect(finding?.angle).toBe(first.angle);
    expect(finding?.frame).toBe(first.frame);

    const shrunk = createImage(16, 16);
    fillRectInclusive(shrunk, 0, 0, 15, 5, [0x29, 0x30, 0x39, 255]); // 96px
    fillRectInclusive(shrunk, 0, 6, 15, 15, [0xf3, 0xcf, 0x65, 255]); // 160px
    writePng(path.join(out, first.filename), shrunk);
    const report2 = assetReport(out, metadata as never);
    const findings2 = report2["findings"] as { code: string }[];
    expect(findings2.some((f) => f.code === "low_context_contrast")).toBe(false);
  });

  it.each(["character", "pet"] as const)("matches consumer animation playback and duration for kind=%s", (kind) => {
    const { out } = fixtureExport(dir, kind, { colors: 64 });
    const metadata = JSON.parse(readFileSync(path.join(out, "spritesheet.json"), "utf-8")) as {
      playback: Record<string, { frames: number[]; duration_ms: number }>;
      palette: string[];
      frames: { filename: string }[];
    };
    expect(metadata.playback["walk"]).toEqual({
      frames: kind === "character" ? [1, 2, 3, 2] : [1, 2, 1, 3],
      duration_ms: 150,
    });
    const palette = new Set(metadata.palette.map((hex) => hex.toLowerCase()));
    for (const entry of metadata.frames) {
      const image = readPng(path.join(out, entry.filename));
      for (let i = 0; i < image.width * image.height; i++) {
        const offset = i * 4;
        const alpha = image.data[offset + 3];
        expect(alpha === 0 || alpha === 255).toBe(true);
        if (alpha) {
          const hex = `#${[0, 1, 2]
            .map((c) => (image.data[offset + c] ?? 0).toString(16).padStart(2, "0"))
            .join("")}`;
          expect(palette.has(hex)).toBe(true);
        }
      }
    }
  });

  it.each(["empty", "wrong_size", "path"] as const)(
    "rejects invalid render output source frames (%s)",
    (problem) => {
      const { out: _out, options, manifest } = fixtureExport(dir);
      const raw = path.join(dir, "raw");
      const firstEntry = manifest.frames[0];
      expect(firstEntry).toBeDefined();
      if (!firstEntry) return;
      const mutableEntry = firstEntry as { pixel_layers: unknown; filename: string };
      if (problem === "empty") {
        mutableEntry.pixel_layers = [];
      } else if (problem === "path") {
        mutableEntry.filename = "../outside.png";
      } else {
        // The only remaining parametrized case is "wrong_size": replace the source PNG with a
        // deliberately mismatched 8x8 canvas.
        const originalPath = path.join(raw, mutableEntry.filename);
        writePng(originalPath, createImage(8, 8));
      }
      const expectedMessage = { empty: /Empty sprite/, wrong_size: /canvas dimensions/, path: /image path/ }[problem];
      expect(() => { exportAsset(raw, path.join(dir, "invalid"), manifest, options, "project", "revision"); }).toThrow(
        DomainError,
      );
      expect(() => { exportAsset(raw, path.join(dir, "invalid2"), manifest, options, "project", "revision"); }).toThrow(
        expectedMessage,
      );
    },
  );
});
