/**
 * Composite exact-size authored pixels and audit their final visibility. Verbatim port of
 * `src/pixel_art_mcp/imaging/features.py` (78 lines).
 */

import type { ResolvedPose } from "@pixel-art-mcp/pixel-core";

import { cloneImage, setPixel, type RGBAImage } from "./image.js";
import { at, defined } from "./internal.js";

/** A point is encoded as `"${x},${y}"` (not a packed number) so negative coordinates --
 * routine here, since a patch's `x`/`y` can place it partly or fully off-canvas -- work without
 * special-casing; Python's `tuple[int, int]` has no such constraint either. */
type PointKey = string;

function pointKey(x: number, y: number): PointKey {
  return `${x},${y}`;
}

function parsePoint(key: PointKey): [number, number] {
  const [x, y] = key.split(",");
  return [Number(x), Number(y)];
}

export function connectedComponents(points: ReadonlySet<PointKey>): Set<PointKey>[] {
  const remaining = new Set(points);
  const components: Set<PointKey>[] = [];
  while (remaining.size > 0) {
    const start = defined(remaining.values().next().value, "next unvisited point");
    remaining.delete(start);
    const component = new Set<PointKey>([start]);
    const pending = [start];
    while (pending.length > 0) {
      const current = defined(pending.pop(), "pending point");
      const [x, y] = parsePoint(current);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        const neighbor = pointKey(nx, ny);
        if (remaining.has(neighbor)) {
          remaining.delete(neighbor);
          component.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

export function componentCount(points: ReadonlySet<PointKey>): number {
  return connectedComponents(points).length;
}

export function largestComponentSize(points: ReadonlySet<PointKey>): number {
  let largest = 0;
  for (const component of connectedComponents(points)) {
    if (component.size > largest) largest = component.size;
  }
  return largest;
}

/** One `PixelArt.poses()` entry (or an equivalent shape) -- the "patch" `compositeFeatures`
 * composites in order. */
export type FeaturePatch = Pick<
  ResolvedPose,
  "name" | "rows" | "x" | "y" | "min_pixels" | "connected"
>;

export interface FeatureReport {
  name: string;
  authored_pixels: number;
  visible_pixels: number;
  clipped_pixels: number;
  overwritten_pixels: number;
  components: number;
  min_pixels: number;
  connected: boolean;
  issues: string[];
  bounds: [number, number, number, number];
}

/**
 * Iterates named patches **in order**; for each non-`.` cell, computes the absolute point and
 * does a last-writer-wins `putpixel` (a later patch unconditionally overwrites an earlier one at
 * the same point -- no blending, no antialiasing), tracking which patch currently owns each
 * point. Returns the composited image plus one audit report per patch.
 */
export function compositeFeatures(
  base: RGBAImage,
  patches: readonly FeaturePatch[],
  palette: Readonly<Record<string, string>>,
): { image: RGBAImage; reports: FeatureReport[] } {
  const image = cloneImage(base);
  const colors = new Map<string, [number, number, number, number]>();
  for (const [symbol, hex] of Object.entries(palette)) {
    colors.set(symbol, [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      255,
    ]);
  }
  const owner = new Map<PointKey, number>();
  const coverage: Set<PointKey>[] = [];

  patches.forEach((patch, index) => {
    const intended = new Set<PointKey>();
    patch.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        // `String.prototype.charAt` returns `string` (never `undefined`) even under
        // `noUncheckedIndexedAccess`, unlike `row[x]` -- the loop bound already guarantees
        // `x < row.length`, so this is always the real character.
        const symbol = row.charAt(x);
        if (symbol === ".") continue;
        const px = x + patch.x;
        const py = y + patch.y;
        const key = pointKey(px, py);
        intended.add(key);
        if (px >= 0 && px < image.width && py >= 0 && py < image.height) {
          const color = colors.get(symbol);
          if (!color) throw new Error(`Unknown palette symbol ${JSON.stringify(symbol)}`);
          setPixel(image, px, py, color);
          owner.set(key, index);
        }
      }
    });
    coverage.push(intended);
  });

  const visibleByPatch: Set<PointKey>[] = patches.map(() => new Set());
  for (const [key, layer] of owner) at(visibleByPatch, layer).add(key);

  const reports: FeatureReport[] = patches.map((patch, index) => {
    const intended = at(coverage, index);
    const visible = at(visibleByPatch, index);
    let clipped = 0;
    for (const key of intended) {
      const [x, y] = parsePoint(key);
      if (!(x >= 0 && x < image.width && y >= 0 && y < image.height)) clipped++;
    }
    const components = componentCount(visible);
    const issues: string[] = [];
    if (clipped) issues.push("clipped_feature");
    if (visible.size < patch.min_pixels) issues.push("feature_pixel_budget");
    if (patch.connected && components !== 1) issues.push("disconnected_feature");
    return {
      name: patch.name,
      authored_pixels: intended.size,
      visible_pixels: visible.size,
      clipped_pixels: clipped,
      overwritten_pixels: intended.size - clipped - visible.size,
      components,
      min_pixels: patch.min_pixels,
      connected: patch.connected,
      issues,
      bounds: [patch.x, patch.y, patch.rows[0]?.length ?? 0, patch.rows.length],
    };
  });

  return { image, reports };
}
