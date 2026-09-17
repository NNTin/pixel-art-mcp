/**
 * Selected, nearest-neighbor asset previews delivered directly through MCP. Verbatim port of
 * `src/pixel_art_mcp/imaging/preview.py` (63 lines).
 */

import fs from "node:fs";
import path from "node:path";

import { DomainError, type FurnitureCategory } from "@pixel-art-mcp/schema";

import { contextImage, type ContextLayout } from "./context.js";
import { encodePngBuffer, readPng, resizeNearest, type RGBAImage } from "./image.js";
import { selectSpriteFrame } from "./inspection.js";
import { defined } from "./internal.js";

/** The subset of an asset's `spritesheet.json` `assetPreview` reads. */
export interface AssetPreviewMetadata {
  asset: {
    kind: "furniture" | "character" | "pet";
    category: FurnitureCategory;
    placement: "floor" | "surface" | "wall";
    clips: Record<string, unknown>;
  };
  layouts: readonly ContextLayout[];
  [key: string]: unknown;
}

export interface AssetPreviewResult {
  clip_id: string;
  angle: number;
  source_angle: number;
  frame: number;
  mirrored: boolean;
  native_size: [number, number];
  display_size: [number, number];
  scale: number;
  context: boolean;
  context_is_approximate: boolean;
  visual_review_required: true;
}

/** `Image.open(...).convert("RGBA")` with a horizontal mirror, matching PIL's `ImageOps.mirror`
 * (flips columns left-right; alpha carried through unchanged). */
function mirrorHorizontal(image: RGBAImage): RGBAImage {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data.length) };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const srcOffset = (y * image.width + x) * 4;
      const dstOffset = (y * image.width + (image.width - 1 - x)) * 4;
      out.data[dstOffset] = defined(image.data[srcOffset], "mirror pixel");
      out.data[dstOffset + 1] = defined(image.data[srcOffset + 1], "mirror pixel");
      out.data[dstOffset + 2] = defined(image.data[srcOffset + 2], "mirror pixel");
      out.data[dstOffset + 3] = defined(image.data[srcOffset + 3], "mirror pixel");
    }
  }
  return out;
}

export function assetPreview(
  root: string,
  clipId: string | null,
  angle: number | null,
  frame: number | null,
  scale: number,
  context: boolean,
): [Buffer, AssetPreviewResult] {
  if (!Number.isInteger(scale) || scale < 1 || scale > 8) {
    throw new DomainError("Preview scale must be an integer from 1 to 8");
  }
  const raw = JSON.parse(fs.readFileSync(path.join(root, "spritesheet.json"), "utf-8")) as AssetPreviewMetadata;
  const kind = raw.asset.kind;
  const resolvedClipId = clipId ?? defined(Object.keys(raw.asset.clips)[0], "first clip id");
  const firstLayout = defined(raw.layouts[0], "first layout");
  const requestedAngle = angle ?? firstLayout.angle;
  let sourceAngle = requestedAngle;
  let mirrored = kind !== "furniture" && requestedAngle === 270;
  if (mirrored) sourceAngle = 90;
  if (kind === "pet" && resolvedClipId === "idle" && (requestedAngle === 90 || requestedAngle === 270)) {
    sourceAngle = requestedAngle === 90 ? 0 : 180;
    mirrored = false;
  }

  const { entry, filePath } = selectSpriteFrame(root, resolvedClipId, sourceAngle, frame);
  let sprite = readPng(filePath);
  if (mirrored) sprite = mirrorHorizontal(sprite);
  const nativeSize: [number, number] = [sprite.width, sprite.height];
  const layout = defined(
    raw.layouts.find((row) => row.angle === sourceAngle),
    `layout for angle ${String(sourceAngle)}`,
  );
  let stage = sprite;
  if (context) {
    stage = contextImage(sprite, raw.asset, layout);
  }
  const size: [number, number] = [stage.width * scale, stage.height * scale];
  if (size[0] * size[1] > 4_194_304) {
    throw new DomainError("Preview exceeds 4194304 pixels; choose a smaller scale");
  }
  const resized = resizeNearest(stage, size[0], size[1]);
  const buffer = encodePngBuffer(resized);
  return [
    buffer,
    {
      clip_id: resolvedClipId,
      angle: requestedAngle,
      source_angle: sourceAngle,
      frame: entry.frame,
      mirrored,
      native_size: nativeSize,
      display_size: size,
      scale,
      context,
      context_is_approximate: context,
      visual_review_required: true,
    },
  ];
}
