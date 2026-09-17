/**
 * Port of `src/pixel_art_mcp/engine/render.py::native_render` (47 lines): builds the blank
 * per-view/per-frame canvases and the frame manifest that `packages/imaging` (Phase 5b, not yet
 * built -- see `docs/typescript-rewrite.md`) composites authored pixels onto. This phase
 * intentionally only writes blank *transparent* PNGs; real pixel compositing/quantization is
 * Phase 5b's job (see this package's final report for the explicit scope line).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import type { PixelArt, PixelArtDict, ResolvedPose } from "@pixel-art-mcp/pixel-core";
import type { AssetLayout } from "@pixel-art-mcp/schema";

/** Matches `progress()` in `engine/runner.py`'s call signature. */
export type ProgressFn = (stage: string, completed: number, total: number) => void;

/**
 * The subset of a resolved `RenderOptions` (`@pixel-art-mcp/schema`) that `nativeRender` reads.
 * Always produced upstream by `resolveAsset`/`RenderOptionsSchema.parse` (a later phase's
 * `packages/service` concern) -- matching Python's `render.py`, which trusts
 * `options["asset_layouts"]`/`options["frame_sequence"]`/`options["supersampling"]` are already
 * present rather than re-validating them here.
 */
export interface NativeRenderOptions {
  readonly asset_layouts: readonly AssetLayout[];
  readonly frame_sequence: readonly number[];
  readonly supersampling: number;
}

/** One `manifest.camera.views[]` entry: every field of the source layout, plus `pivot`/`objects`. */
export interface CameraView extends AssetLayout {
  pivot: [number, number];
  objects: unknown[];
}

/** One `manifest.frames[]` entry. */
export interface FrameManifestEntry {
  filename: string;
  angle: number;
  frame: number;
  pivot: [number, number];
  size: [number, number];
  pixel_layers: ResolvedPose[];
}

/** `native_render`'s return shape -- the render-job `result.json` contract. */
export interface RenderManifest {
  pixel_art: PixelArtDict;
  frames: FrameManifestEntry[];
  camera: {
    projection: "native-grid";
    views: CameraView[];
    alignment: "authored pixels";
  };
}

/** Encodes an all-transparent `width`x`height` RGBA PNG, matching PIL's
 * `Image.new("RGBA", (w, h), (0, 0, 0, 0))`. */
function blankPngBuffer(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  return PNG.sync.write(png);
}

/**
 * Port of `native_render`. For each declared view (`options.asset_layouts`, in order) and each
 * frame in `options.frame_sequence`, writes a blank `view_{row:02d}_frame_{frame:06d}.png` (`row`
 * is the view's index, zero-based, matching Python's `enumerate`) and appends its manifest entry.
 */
export function nativeRender(
  options: NativeRenderOptions,
  outputDir: string,
  art: PixelArt,
  progress: ProgressFn,
): RenderManifest {
  const manifest: RenderManifest = {
    pixel_art: art.toDict(),
    frames: [],
    camera: { projection: "native-grid", views: [], alignment: "authored pixels" },
  };
  const totalFrames = options.frame_sequence.length * options.asset_layouts.length;
  options.asset_layouts.forEach((layout, row) => {
    const pivot: [number, number] = [layout.width / 2, layout.bottom];
    manifest.camera.views.push({ ...layout, pivot, objects: [] });
    const width = layout.width * options.supersampling;
    const height = layout.height * options.supersampling;
    const blank = blankPngBuffer(width, height);
    for (const frame of options.frame_sequence) {
      const filename = `view_${String(row).padStart(2, "0")}_frame_${String(frame).padStart(6, "0")}.png`;
      writeFileSync(path.join(outputDir, filename), blank);
      manifest.frames.push({
        filename,
        angle: layout.angle,
        frame,
        pivot,
        size: [layout.width, layout.height],
        pixel_layers: art.poses(layout.angle, frame),
      });
      progress("rendering", manifest.frames.length, totalFrames);
    }
  });
  return manifest;
}
