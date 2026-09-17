/**
 * Offline, approximate webview context. No browser is required by the production server. Port
 * of `src/pixel_art_mcp/imaging/context.py` (132 lines).
 */

import fs from "node:fs";
import path from "node:path";

import type { AssetSpec } from "@pixel-art-mcp/schema";

import {
  createImage,
  pasteFull,
  readPng,
  resizeNearest,
  setPixel,
  writePng,
  type Rgba,
  type RGBAImage,
} from "./image.js";
import { defined } from "./internal.js";
import { ASSET_PLAYER_HTML_TEMPLATE } from "./templates.js";

/** The webview's actual floor tile is close to this; used both to paint the approximate preview
 * stage and to judge whether a sprite blends into it. */
export const BACKGROUND_COLOR: readonly [number, number, number] = [0x34, 0x3e, 0x42];

export function luma([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgba(hex: string): Rgba {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

function fillRect(
  image: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgba,
): void {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let y = Math.max(0, top); y <= Math.min(image.height - 1, bottom); y++) {
    for (let x = Math.max(0, left); x <= Math.min(image.width - 1, right); x++) {
      setPixel(image, x, y, color);
    }
  }
}

function strokeRect(
  image: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgba,
): void {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let x = left; x <= right; x++) {
    if (top >= 0 && top < image.height && x >= 0 && x < image.width) setPixel(image, x, top, color);
    if (bottom >= 0 && bottom < image.height && x >= 0 && x < image.width) {
      setPixel(image, x, bottom, color);
    }
  }
  for (let y = top; y <= bottom; y++) {
    if (left >= 0 && left < image.width && y >= 0 && y < image.height) setPixel(image, left, y, color);
    if (right >= 0 && right < image.width && y >= 0 && y < image.height) {
      setPixel(image, right, y, color);
    }
  }
}

/** Schematic scale reference, authored here (not copied from the consumer's artwork). */
export function referenceAgent(): RGBAImage {
  const image = createImage(16, 32);
  const boxes: [number, number, number, number, string][] = [
    [3, 3, 12, 12, "#dbaa79"],
    [3, 2, 12, 5, "#523b35"],
    [2, 13, 13, 23, "#597aab"],
    [3, 24, 6, 29, "#36455a"],
    [9, 24, 12, 29, "#36455a"],
    [2, 30, 6, 31, "#242732"],
    [9, 30, 13, 31, "#242732"],
  ];
  // PIL's `ImageDraw.rectangle((x0, y0, x1, y1))` fills the inclusive box x0..x1, y0..y1.
  for (const [x0, y0, x1, y1, hex] of boxes) fillRect(image, x0, y0, x1, y1, hexToRgba(hex));
  return image;
}

/** The subset of a real asset layout `contextGeometry`/`contextImage` read -- the richer,
 * asset-packaging-specific layout shape (`asset_export.py`'s own dict) is Phase 5b-ii's concern;
 * this is a local structural type for exactly what these two functions need. */
export interface ContextLayout {
  angle: number;
  width: number;
  height: number;
  background_tiles: number;
}

export interface ContextGeometry {
  x: number;
  y: number;
  agent_x: number;
  agent_y: number;
  agent_in_front: boolean;
  seat_x?: number;
  seat_y?: number;
  seat_in_front?: boolean;
}

export function contextGeometry(
  kind: AssetSpec["kind"],
  layout: ContextLayout,
  category: string,
  angle: number,
): ContextGeometry {
  const x = 48;
  const y = 32;
  if (kind !== "furniture") {
    return {
      x: 80 - Math.floor(layout.width / 2),
      y: 96 - layout.height,
      agent_x: 104,
      agent_y: 64,
      agent_in_front: true,
    };
  }
  const seatY = y + layout.background_tiles * 16 + 8;
  const agentX = x + layout.width + 16;
  const agentY = y + layout.height - 32;
  return {
    x,
    y,
    agent_x: agentX,
    agent_y: agentY,
    agent_in_front: true,
    seat_x: x + Math.floor(layout.width / 2) - 8,
    seat_y: seatY + (category === "chairs" ? 6 : 0) - 32,
    seat_in_front: !(category === "chairs" && angle === 180),
  };
}

export function contextImage(
  sprite: RGBAImage,
  spec: Pick<AssetSpec, "kind" | "category" | "placement">,
  layout: ContextLayout,
): RGBAImage {
  const geometry = contextGeometry(spec.kind, layout, spec.category, layout.angle);
  const stage = createImage(Math.max(160, layout.width + 96), Math.max(128, layout.height + 80));
  const backgroundColor: Rgba = [...BACKGROUND_COLOR, 255];
  fillRect(stage, 0, 0, stage.width - 1, stage.height - 1, backgroundColor);
  const gridColor: Rgba = [0x47, 0x51, 0x53, 255];
  for (let x = 0; x < stage.width; x += 16) {
    for (let y = 0; y < stage.height; y++) setPixel(stage, x, y, gridColor);
  }
  for (let y = 0; y < stage.height; y += 16) {
    for (let x = 0; x < stage.width; x++) setPixel(stage, x, y, gridColor);
  }

  const { x, y } = geometry;
  if (spec.kind === "furniture") {
    const top = y + layout.background_tiles * 16;
    strokeRect(stage, x, top, x + layout.width - 1, y + layout.height - 1, [0xdd, 0xbd, 0x63, 255]);
    if (spec.placement === "surface") {
      fillRect(stage, x - 16, y - 1, x + layout.width + 15, y + 12, [0x8c, 0x62, 0x4b, 255]);
    }
    if (spec.placement === "wall") {
      fillRect(stage, x - 16, y - 16, x + layout.width + 15, y + 12, [0x7a, 0x81, 0x8b, 255]);
    }
  }

  const agent = referenceAgent();
  if (!geometry.agent_in_front) pasteFull(stage, agent, geometry.agent_x, geometry.agent_y);
  pasteFull(stage, sprite, x, y);
  if (geometry.agent_in_front) pasteFull(stage, agent, geometry.agent_x, geometry.agent_y);
  return stage;
}

/** One `asset-export.ts::exportAsset`-produced `spritesheet.json` frame entry -- the subset
 * `exportContext` reads (the low-res exported PNG plus its high-resolution comparison source). */
export interface ContextFrameEntry {
  angle: number;
  frame: number;
  filename: string;
  source: string;
  [key: string]: unknown;
}

/** The subset of `asset-export.ts::exportAsset`'s written `spritesheet.json` shape
 * `exportContext` reads. */
export interface ExportContextMetadata {
  asset: AssetSpec;
  layouts: readonly ContextLayout[];
  frames: readonly ContextFrameEntry[];
  playback: Record<string, unknown>;
  package: { archive: string; [key: string]: unknown };
}

/** Port of `export_context`: the offline approximate placement-context preview
 * (`context.png`, `comparison/reference-agent.png`, `preview.html`). */
export function exportContext(outputDir: string, metadata: ExportContextMetadata): void {
  function encode(filePath: string): string {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
  }

  const spec = metadata.asset;
  const layouts = metadata.layouts;
  const byKey = new Map<string, ContextFrameEntry>();
  for (const entry of metadata.frames) byKey.set(`${String(entry.angle)}:${String(entry.frame)}`, entry);
  const firstClip = defined(Object.values(spec.clips)[0], "first clip");
  // Show the actual default pose for animated furniture, including extinguished lamps.
  const firstFrame = firstClip.off_frame ?? defined(firstClip.frames[0], "first clip frame");
  const firstLayout = defined(layouts[0], "first layout");
  const entry = defined(
    byKey.get(`${String(firstLayout.angle)}:${String(firstFrame)}`),
    "context preview frame entry",
  );
  const image = readPng(path.join(outputDir, entry.filename));
  const stage = contextImage(image, spec, firstLayout);
  writePng(path.join(outputDir, "context.png"), resizeNearest(stage, stage.width * 4, stage.height * 4));

  const agentPath = path.join(outputDir, "comparison", "reference-agent.png");
  writePng(agentPath, referenceAgent());

  const data = {
    spec,
    playback: metadata.playback,
    layouts,
    reference: encode(agentPath),
    package: metadata.package.archive,
    geometry: Object.fromEntries(
      layouts.map((row) => [String(row.angle), contextGeometry(spec.kind, row, spec.category, row.angle)]),
    ),
    cells: metadata.frames.map((e) => ({
      ...e,
      image: encode(path.join(outputDir, e.filename)),
      high: encode(path.join(outputDir, e.source)),
    })),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  fs.writeFileSync(
    path.join(outputDir, "preview.html"),
    ASSET_PLAYER_HTML_TEMPLATE.replace("__ASSET_DATA__", json),
    "utf-8",
  );
}
