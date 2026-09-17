/**
 * Export the existing pixel-agents furniture contract without changing that app. Verbatim port
 * of `src/pixel_art_mcp/imaging/pixel_agents.py` (120 lines).
 */

import fs from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";
import { renderOptionsFrames, type RenderOptions } from "@pixel-art-mcp/schema";

import { writePng, type RGBAImage } from "./image.js";
import { at } from "./internal.js";

export const ORIENTATIONS: Record<number, string> = {
  0: "front",
  90: "right",
  180: "back",
  270: "left",
};

export const ACTIVATION =
  "pixel-agents plays on-state furniture at 5 fps only when activated by a nearby working agent. " +
  "Otherwise it shows the off pose. Always-on furniture animation is not supported by that app.";

/** The subset of an asset layout row `exportPixelAgents` reads for a footprint override.
 * `asset_export.ts`'s `packageAsset` passes the real, richer `AssetLayout` rows; the generic
 * `pixels.ts::packSprites` path never has layouts, matching Python's `layouts: list[...] | None
 * = None` default. */
export interface PixelAgentsLayout {
  angle: number;
  footprint_w?: number | null;
  footprint_h?: number | null;
}

function orientationName(angle: number): string {
  const name = ORIENTATIONS[Math.trunc(angle)];
  if (!name) throw new Error(`Unsupported pixel-agents orientation angle ${String(angle)}`);
  return name;
}

/** Zips only `directory`'s own direct files (never recursive, never sibling variant
 * directories), entries named relative to `packageRoot` -- reproducing Python's
 * `for path in sorted(directory.iterdir()): archive.write(path, path.relative_to(package_root))`
 * exactly, including its "overwritten by the caller's own later full zip" behavior (see
 * `asset-export.ts::packageAsset`'s furniture branch, which re-zips the whole `pixel-agents`
 * tree after every clip variant has been exported this way). */
function zipOwnVariant(directory: string, packageRoot: string, destination: string): void {
  const entries: Record<string, Uint8Array> = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const filePath = path.join(directory, name);
    if (fs.statSync(filePath).isFile()) {
      entries[path.relative(packageRoot, filePath).split(path.sep).join("/")] =
        fs.readFileSync(filePath);
    }
  }
  fs.writeFileSync(destination, zipSync(entries, { level: 6 }));
}

export function exportPixelAgents(
  outputDir: string,
  options: RenderOptions,
  frames: readonly RGBAImage[],
  offFrames: readonly RGBAImage[] | null,
  layouts: readonly PixelAgentsLayout[] | null = null,
): Record<string, unknown> | null {
  const target = options.pixel_agents;
  if (!target) return null;

  const directory = path.join(outputDir, "pixel-agents", "assets", "furniture", target.asset_id);
  fs.mkdirSync(directory, { recursive: true });
  const columns = renderOptionsFrames(options).length;
  const animated = columns > 1;
  if (animated && offFrames?.length !== options.angles.length) {
    throw new Error("Missing pixel-agents off-state renders");
  }

  // An arrow-function const (not a nested function declaration) so TypeScript's control-flow
  // analysis carries the `target !== null` narrowing above into this closure.
  const asset = (
    im: RGBAImage,
    orientation: string,
    suffix = "",
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const assetId = `${target.asset_id}_${orientation.toUpperCase()}${suffix}`;
    const filename = `${assetId}.png`;
    writePng(path.join(directory, filename), im);
    const layout = (layouts ?? []).find((row) => orientationName(row.angle) === orientation);
    return {
      type: "asset",
      id: assetId,
      file: filename,
      width: im.width,
      height: im.height,
      footprintW: layout?.footprint_w ?? target.footprint_w ?? Math.ceil(im.width / 16),
      footprintH: layout?.footprint_h ?? target.footprint_h ?? Math.ceil(im.height / 16),
      orientation,
      ...extra,
    };
  };

  const members: Record<string, unknown>[] = [];
  options.angles.forEach((angle, row) => {
    const orientation = orientationName(angle);
    if (animated) {
      if (!offFrames) throw new Error("Missing pixel-agents off-state renders");
      const offImage = at(offFrames, row);
      // OFF goes first, then ON frames in ascending order. This matches the PC manifest and
      // gives the app an off->on state transition through which animation is applied.
      members.push({
        type: "group",
        groupType: "state",
        orientation,
        members: [
          asset(offImage, orientation, "_OFF", { state: "off" }),
          {
            type: "group",
            groupType: "animation",
            state: "on",
            members: Array.from({ length: columns }, (_unused, column) =>
              asset(at(frames, row * columns + column), orientation, `_ON_${String(column + 1)}`, {
                frame: column,
              }),
            ),
          },
        ],
      });
    } else {
      members.push(asset(at(frames, row * columns), orientation));
    }
  });

  const manifest = {
    id: target.asset_id,
    name: target.name,
    category: target.category,
    canPlaceOnWalls: target.can_place_on_walls,
    canPlaceOnSurfaces: target.can_place_on_surfaces,
    backgroundTiles: target.background_tiles,
    type: "group",
    groupType: "rotation",
    rotationScheme: "4-way",
    members,
  };
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const packageRoot = path.join(outputDir, "pixel-agents");
  zipOwnVariant(directory, packageRoot, path.join(outputDir, "pixel-agents.zip"));

  return {
    manifest: path.relative(outputDir, manifestPath).split(path.sep).join("/"),
    archive: "pixel-agents.zip",
    asset_id: target.asset_id,
    width: options.width,
    height: options.height,
    fps: 5,
    activation: animated ? ACTIVATION : "Static furniture",
    install: "Extract pixel-agents.zip into webview-ui/public, then reload/rebuild assets.",
  };
}
