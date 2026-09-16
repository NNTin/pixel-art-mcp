/**
 * Named, ordered layers with explicit per-view/per-frame pixel poses.
 *
 * Every layer draws the complete sprite through pixel helpers: these are finishing layers, not
 * depth-tested textures, so author only the visible views.
 *
 * Verbatim port of `PixelArt` in `src/pixel_art_mcp/pixel_art.py`. Every thrown `Error`'s
 * message below reproduces the source `ValueError`'s message exactly (see
 * `docs/typescript-rewrite.md`, Phase 3).
 */

import { Canvas } from "./canvas.js";
import type {
  AssetLayout,
  AssetValidationSpec,
  Layer,
  LayerOptions,
  PaletteInput,
  PixelArtDict,
  Pose,
  ResolvedPose,
  Scene,
  ViewsInput,
} from "./types.js";

const VALID_ANGLES = new Set([0, 90, 180, 270]);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Python `repr()` of a `str`, close enough for this module's use (layer names in error
 * messages): picks `'...'` unless the string holds a `'` but no `"`, and escapes `\`, quotes,
 * and the common whitespace/control characters. Real layer names are short authored identifiers
 * (see the examples in `tests/unit/test_pixel_art.py`), so this intentionally doesn't attempt
 * CPython's full non-ASCII "is this codepoint printable" logic -- flagged in this package's
 * final report as an edge case that isn't practical to reproduce byte-for-byte.
 */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0) ?? 0;
      out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
    }
  }
  return out + quote;
}

/**
 * Builds `[key, value]` pairs the way a Python dict comprehension would: first-occurrence order,
 * last-value-wins, re-assigning an existing key does *not* move its position. `Map.set` already
 * has exactly this behavior, so this is just a thin, explicitly-documented wrapper -- used
 * instead of a plain JS object because object keys that look like array indices (all of this
 * package's angle keys: "0", "90", "180", "270") get silently reordered into ascending numeric
 * order by the JS engine regardless of insertion order, which a plain `Record`-based `expected`
 * dict would have made this module's error-message ordering diverge from Python's for
 * out-of-order `layouts` input.
 */
function orderedEntries<V>(pairs: readonly (readonly [string, V])[]): [string, V][] {
  const map = new Map<string, V>();
  for (const [k, v] of pairs) map.set(k, v);
  return [...map.entries()];
}

/** Python dict-repr of `{'<angle>': [width, height], ...}`, e.g. `{'0': [16, 16], '90': [32, 8]}`. */
function pyDictRepr(entries: readonly (readonly [string, [number, number]])[]): string {
  const parts = entries.map(([k, size]) => `'${k}': [${size[0]}, ${size[1]}]`);
  return `{${parts.join(", ")}}`;
}

/** Order-independent equality between `this.views` and a `validateTarget`-computed `expected`. */
function viewsEqual(
  a: Record<string, [number, number]>,
  bEntries: readonly (readonly [string, [number, number]])[],
): boolean {
  const aEntries = Object.entries(a);
  if (aEntries.length !== bEntries.length) return false;
  const bMap = new Map(bEntries);
  return aEntries.every(([k, v]) => {
    const bv = bMap.get(k);
    return bv?.[0] === v[0] && bv[1] === v[1];
  });
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class PixelArt {
  palette: Record<string, string>;
  views: Record<string, [number, number]>;
  layers: Layer[];

  constructor(palette: PaletteInput, views: ViewsInput) {
    const paletteEntries = Object.entries(palette);
    const validPalette =
      paletteEntries.length >= 2 &&
      paletteEntries.length <= 64 &&
      paletteEntries.every(([k, v]) => k.length === 1 && k !== "." && HEX_COLOR.test(v));
    if (!validPalette) {
      throw new Error("Use 2..64 single-symbol #rrggbb palette entries; reserve '.'");
    }
    const loweredPalette = paletteEntries.map(([k, v]): [string, string] => [k, v.toLowerCase()]);
    if (new Set(loweredPalette.map(([, v]) => v)).size !== loweredPalette.length) {
      throw new Error("Palette colors must be distinct");
    }

    const viewEntries = Object.entries(views);
    const validViews =
      viewEntries.length > 0 &&
      viewEntries.every(([angleKey, size]) => {
        const angle = Number(angleKey);
        return (
          VALID_ANGLES.has(angle) &&
          size.length === 2 &&
          size.every((v) => Number.isInteger(v) && v >= 1 && v <= 512)
        );
      });
    if (!validViews) {
      throw new Error("Declare each consumer view and its native canvas");
    }

    this.palette = Object.fromEntries(loweredPalette);
    this.views = Object.fromEntries(
      viewEntries.map(([angleKey, size]): [string, [number, number]] => {
        const w = size[0];
        const h = size[1];
        if (w === undefined || h === undefined) {
          // Unreachable: `validViews` above already confirmed `size.length === 2`.
          throw new Error("Declare each consumer view and its native canvas");
        }
        return [angleKey, [w, h]];
      }),
    );
    this.layers = [];
  }

  layer(name: string, angle: number, canvas: Canvas, options: LayerOptions = {}): this {
    const { x = 0, y = 0, frame = null, min_pixels = 0, connected = false } = options;
    if (!name || name.length > 100 || !(String(angle) in this.views)) {
      throw new Error("Layer needs a name and a declared view");
    }
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(min_pixels) ||
      min_pixels < 0
    ) {
      throw new Error("Offsets and pixel budgets must be integers");
    }
    if (frame !== null && (!Number.isInteger(frame) || frame < 0 || frame > 1_000_000)) {
      throw new Error("Invalid pose frame");
    }
    for (const row of canvas.rows) {
      for (const c of row) {
        if (c !== "." && !(c in this.palette)) {
          throw new Error("Unknown palette symbol in pixel layer");
        }
      }
    }
    let layer = this.layers.find((item) => item.name === name);
    if (!layer) {
      layer = { name, poses: [] };
      this.layers.push(layer);
    }
    const pose: Pose = { angle, frame, rows: canvas.rows, x, y, min_pixels, connected };
    layer.poses = layer.poses.filter((p) => !(p.angle === angle && p.frame === frame));
    layer.poses.push(pose);
    return this;
  }

  poses(angle: number, frame: number): ResolvedPose[] {
    const selected: ResolvedPose[] = [];
    for (const layer of this.layers) {
      const choices = new Map<number | null, Pose>();
      for (const p of layer.poses) {
        if (p.angle === angle) choices.set(p.frame, p);
      }
      // Mirrors Python's `choices.get(frame, choices.get(None))`: exact-frame pose if one was
      // authored for this frame, else the layer's default (frame-less) pose, else nothing.
      const pose = choices.get(frame) ?? choices.get(null);
      if (pose) {
        selected.push({ name: layer.name, ...pose });
      }
    }
    return selected;
  }

  toDict(): PixelArtDict {
    return {
      version: 1,
      palette: { ...this.palette },
      views: { ...this.views },
      layers: this.layers.map((layer) => ({
        name: layer.name,
        poses: layer.poses.map((pose) => ({ ...pose, rows: [...pose.rows] })),
      })),
    };
  }

  validateTarget(
    layouts: readonly AssetLayout[],
    frames: readonly number[],
    spec: AssetValidationSpec,
  ): void {
    const expectedEntries = orderedEntries(
      layouts.map((v): [string, [number, number]] => [String(v.angle), [v.width, v.height]]),
    );
    if (!viewsEqual(this.views, expectedEntries)) {
      throw new Error(
        `Pixel views must match the configured canvases: ${pyDictRepr(expectedEntries)}`,
      );
    }
    if (spec.outline) {
      throw new Error("Draw outlines in pixel rows; configure_asset.outline must be false");
    }
    if (Object.keys(this.palette).length > spec.colors) {
      throw new Error("Pixel palette exceeds configure_asset.colors");
    }
    if (spec.palette && spec.palette.length > 0) {
      const specColors = new Set(spec.palette.map((c) => c.toLowerCase()));
      const ownColors = new Set(Object.values(this.palette));
      if (!setsEqual(specColors, ownColors)) {
        throw new Error("Pixel palette must match configure_asset.palette");
      }
    }
    if (this.layers.length === 0) {
      throw new Error("A pixel-art definition with named layers is required");
    }
    const hasInk = this.layers.some((layer) =>
      layer.poses.some((pose) => pose.rows.some((row) => Array.from(row).some((c) => c !== "."))),
    );
    if (!hasInk) {
      throw new Error("Pixel layers must contain authored ink");
    }
    const expected = new Map(expectedEntries);
    for (const layer of this.layers) {
      for (const pose of layer.poses) {
        const size = expected.get(String(pose.angle));
        if (!size) continue; // Unreachable: the views-equality check above guarantees a match.
        const [w, h] = size;
        const firstRow = pose.rows[0];
        if (pose.rows.length > h || (firstRow !== undefined && firstRow.length > w)) {
          throw new Error(`Patch in ${pyRepr(layer.name)} exceeds its view dimensions`);
        }
      }
    }
    for (const layout of layouts) {
      for (const frame of frames) {
        const poses = this.poses(layout.angle, frame);
        if (poses.length === 0) {
          throw new Error(
            `Missing pixel pose at angle ${layout.angle}, frame ${frame}; add a default or ` +
              "exact-frame pose",
          );
        }
        const hasInkInBounds = poses.some((p) =>
          p.rows.some((row, dy) =>
            Array.from(row).some((c, dx) => {
              if (c === ".") return false;
              const px = p.x + dx;
              const py = p.y + dy;
              return px >= 0 && px < layout.width && py >= 0 && py < layout.height;
            }),
          ),
        );
        if (!hasInkInBounds) {
          throw new Error(`Empty pose at angle ${layout.angle}, frame ${frame}`);
        }
      }
    }
  }

  /**
   * Re-validates everything by replaying every stored pose through `layer()` -- the core
   * correctness guarantee, matching Python's `from_dict` exactly. Like the Python source, this
   * trusts `data` to already have the right shape beyond the `version` check: a malformed object
   * (missing `palette`/`views`/`layers`/pose keys) fails with a generic JS `TypeError` reading an
   * undefined property, the same way Python's version fails with a generic `KeyError` -- neither
   * is a domain `ValueError`/`Error` with a curated message, so this intentionally does not add
   * extra validation beyond what the source has (see this package's final report).
   */
  static fromDict(data: PixelArtDict): PixelArt {
    if (data.version !== 1) {
      throw new Error("Unsupported pixel art version");
    }
    const views: ViewsInput = Object.fromEntries(
      Object.entries(data.views).map(([k, v]): [number, readonly number[]] => [Number(k), v]),
    );
    const art = new PixelArt(data.palette, views);
    for (const layer of data.layers) {
      for (const pose of layer.poses) {
        art.layer(layer.name, pose.angle, Canvas.fromRows(pose.rows), {
          x: pose.x,
          y: pose.y,
          frame: pose.frame,
          min_pixels: pose.min_pixels,
          connected: pose.connected,
        });
      }
    }
    return art;
  }

  save(scene: Scene): void {
    // Round-trip validation also catches accidental direct edits to the layer data.
    const data = PixelArt.fromDict(this.toDict()).toDict();
    scene["pixel_art"] = JSON.stringify(data);
  }

  static load(scene: Scene): PixelArt {
    // The one unavoidable cast in this package: `Scene` is deliberately `Record<string,
    // unknown>` (see types.ts), so extracting its one field `pixel-core` cares about needs an
    // explicit assertion to hand a `string` to `JSON.parse`. A wrong shape here fails the same
    // loose way Python's `load` does (see `fromDict`'s doc comment) -- a generic runtime error,
    // not a curated one.
    return PixelArt.fromDict(JSON.parse(scene["pixel_art"] as string) as PixelArtDict);
  }
}

// Runtime protection (see docs/typescript-rewrite.md, "Core design decisions"): an untrusted-but-
// sandboxed render script must never be able to alter PixelArt's behavior for any other job.
// Freezing the constructor and its prototype means e.g. `PixelArt.prototype.layer = () => {}`
// throws a TypeError immediately, under ESM's implicit strict mode, instead of silently
// succeeding.
Object.freeze(PixelArt);
Object.freeze(PixelArt.prototype);
