/**
 * Port of `src/pixel_art_mcp/imaging/inspection.py` (341 lines): maps every opaque pixel of an
 * exported sprite frame back to a declared palette index (hard-failing if any opaque color isn't
 * an exact match -- the correctness guarantee the whole pipeline depends on: a composited PNG
 * must be provably palette-clean), then reports connectivity/run-length/contrast diagnostics.
 */

import fs from "node:fs";
import path from "node:path";

import { DomainError } from "@pixel-art-mcp/schema";

import { isWithinDirectory, readPng } from "./image.js";
import { at, defined } from "./internal.js";
import { hexToRgb, rgbToHex, type Rgb } from "./quantize.js";

// ---------------------------------------------------------------------------------------------
// _color_name
// ---------------------------------------------------------------------------------------------

/** Standard RGB->HSV (mathematically equivalent to Python's `colorsys.rgb_to_hsv`, which uses a
 * different but equivalent derivation -- see this package's final report). */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const value = max;
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, saturation, value];
}

function colorName([r, g, b]: Rgb): string {
  const [hue, saturation, value] = rgbToHsv(r / 255, g / 255, b / 255);
  let lightness: string;
  if (value < 0.2) lightness = "very dark";
  else if (value < 0.42) lightness = "dark";
  else if (value > 0.82) lightness = "light";
  else lightness = "medium";

  let family: string;
  if (saturation < 0.12) {
    family = "gray";
  } else {
    const degrees = hue * 360;
    if (degrees < 15 || degrees >= 345) family = "red";
    else if (degrees < 45) family = "orange";
    else if (degrees < 70) family = "yellow";
    else if (degrees < 165) family = "green";
    else if (degrees < 200) family = "cyan";
    else if (degrees < 260) family = "blue";
    else if (degrees < 300) family = "purple";
    else family = "magenta";
  }
  return `${lightness} ${family}`;
}

// ---------------------------------------------------------------------------------------------
// _components / _longest_runs
// ---------------------------------------------------------------------------------------------

/** Four-neighbor connected-component sizes, grouped by value; `null` cells (transparent, or "no
 * color" when called with a binary opaque/not-opaque map) are skipped entirely. */
function components(
  indices: readonly (number | null)[],
  width: number,
  height: number,
): Map<number, number[]> {
  const seen = new Set<number>();
  const sizes = new Map<number, number[]>();
  for (let start = 0; start < indices.length; start++) {
    const color = indices[start] ?? null;
    if (color === null || seen.has(start)) continue;
    seen.add(start);
    const pending = [start];
    let head = 0;
    let size = 0;
    while (head < pending.length) {
      const current = at(pending, head++);
      size += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (!seen.has(neighbor) && indices[neighbor] === color) {
          seen.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    const list = sizes.get(color) ?? [];
    list.push(size);
    sizes.set(color, list);
  }
  return sizes;
}

function longestRuns(
  indices: readonly (number | null)[],
  width: number,
  height: number,
  color: number,
): [number, number] {
  let horizontal = 0;
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      run = indices[y * width + x] === color ? run + 1 : 0;
      if (run > horizontal) horizontal = run;
    }
  }
  let vertical = 0;
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      run = indices[y * width + x] === color ? run + 1 : 0;
      if (run > vertical) vertical = run;
    }
  }
  return [horizontal, vertical];
}

// ---------------------------------------------------------------------------------------------
// _selection
// ---------------------------------------------------------------------------------------------

function pyReprStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function pyModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Python's `{value:g}` format: shortest representation, up to 6 significant digits. */
function formatG(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(parseFloat(value.toPrecision(6)));
}

export interface SpritesheetFrameEntry {
  filename: string;
  angle: number;
  frame: number;
  pivot: [number, number];
  pixel_features?: unknown[];
  [key: string]: unknown;
}

interface SpritesheetDirection {
  angle: number;
}

/** The `spritesheet.json` shapes `_selection` dispatches on: an asset export (`asset`/`clips`)
 * or a states export (`states`), both Phase 5b-ii's territory and not yet produced by anything
 * in this package -- or the generic shape `packSprites` (this phase) actually writes. Typed
 * loosely here (matching Python's own `dict[str, Any]` duck typing), since none of those richer
 * shapes have a canonical TS type yet. */
export interface SpritesheetMetadata {
  frames: SpritesheetFrameEntry[];
  directions: SpritesheetDirection[];
  palette: string[];
  settings?: { downscale_mode?: string; [key: string]: unknown };
  asset?: {
    clips: Record<string, { frames: number[]; name?: string | null; off_frame?: number | null }>;
  };
  states?: { id: string; name: string; metadata: string }[];
  [key: string]: unknown;
}

export interface SelectionState {
  id: string;
  name: string;
}

interface Selection {
  metadata: SpritesheetMetadata;
  entry: SpritesheetFrameEntry;
  filePath: string;
  state: SelectionState | null;
}

function selection(
  root: string,
  stateId: string | null,
  angle: number | null,
  frame: number | null,
): Selection {
  const resolvedRoot = path.resolve(root);
  let raw: SpritesheetMetadata;
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(root, "spritesheet.json"), "utf-8"),
    ) as SpritesheetMetadata;
  } catch {
    throw new DomainError("Sprite export metadata is missing or invalid");
  }

  let selectedState: SelectionState | null = null;
  let child: SpritesheetMetadata;
  let directory: string;

  if (raw.asset) {
    const clips = raw.asset.clips;
    const clipIds = Object.keys(clips);
    const key = stateId ?? clipIds[0];
    if (key === undefined || !(key in clips)) {
      throw new DomainError(
        `Unknown clip ${pyReprStr(stateId ?? "")}; choose one of: ${clipIds.join(", ")}`,
      );
    }
    const clip = defined(clips[key], `clip ${key}`);
    const allowed = [...clip.frames, ...(clip.off_frame != null ? [clip.off_frame] : [])];
    selectedState = { id: key, name: clip.name ?? key };
    child = { ...raw, frames: raw.frames.filter((entry) => allowed.includes(entry.frame)) };
    directory = root;
  } else if (raw.states) {
    const states = raw.states;
    const stateEntry = stateId === null ? at(states, 0) : states.find((s) => s.id === stateId);
    if (!stateEntry) {
      throw new DomainError(
        `Unknown state ${pyReprStr(stateId ?? "")}; choose one of: ` +
          states.map((s) => s.id).join(", "),
      );
    }
    selectedState = { id: stateEntry.id, name: stateEntry.name };
    const metadataPath = path.resolve(root, stateEntry.metadata);
    if (!isWithinDirectory(resolvedRoot, metadataPath) || path.extname(metadataPath) !== ".json") {
      throw new DomainError("State sprite metadata has an invalid path");
    }
    try {
      child = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as SpritesheetMetadata;
    } catch {
      throw new DomainError("State sprite metadata is missing or invalid");
    }
    directory = path.dirname(metadataPath);
  } else {
    if (stateId !== null) {
      throw new DomainError("This sprite export has no named states");
    }
    child = raw;
    directory = root;
  }

  const angles = child.directions.map((d) => d.angle);
  const selectedAngle = angle === null ? at(angles, 0) : round6(pyModulo(angle, 360));
  if (!angles.includes(selectedAngle)) {
    throw new DomainError(
      `Angle ${formatG(selectedAngle)} is unavailable; choose one of: ` +
        angles.map(formatG).join(", "),
    );
  }
  const availableFrames = child.frames
    .filter((entry) => entry.angle === selectedAngle)
    .map((entry) => entry.frame);
  const selectedFrame = frame ?? at(availableFrames, 0);
  const entry = child.frames.find(
    (candidate) => candidate.angle === selectedAngle && candidate.frame === selectedFrame,
  );
  if (!entry) {
    throw new DomainError(
      `Frame ${String(selectedFrame)} is unavailable at ${formatG(selectedAngle)} degrees; ` +
        `choose one of: ${availableFrames.join(", ")}`,
    );
  }
  const resolvedPath = path.resolve(directory, entry.filename);
  if (!isWithinDirectory(resolvedRoot, resolvedPath) || path.extname(resolvedPath) !== ".png") {
    throw new DomainError("Selected sprite frame has an invalid path");
  }
  return { metadata: child, entry, filePath: resolvedPath, state: selectedState };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------------------------
// inspect_sprite
// ---------------------------------------------------------------------------------------------

export interface PaletteColorReport {
  symbol: string;
  hex: string;
  description: string;
  pixels: number;
  bounds: [number, number, number, number];
  components: number;
  singleton_components: number;
  longest_horizontal_run: number;
  longest_vertical_run: number;
}

export interface ContrastBoundary {
  colors: [string, string];
  rgb_distance: number;
  shared_edges: number;
}

export interface InspectionResult {
  state: SelectionState | null;
  angle: number;
  frame: number;
  filename: string;
  pixel_features: unknown[];
  size: [number, number];
  pivot: [number, number];
  downscale_mode: string;
  analysis: {
    occupied_pixels: number;
    transparent_pixels: number;
    occupied_bounds: [number, number, number, number] | null;
    opaque_connected_components: number;
    opaque_singleton_components: number;
    color_components: number;
    color_singleton_components: number;
    lowest_contrast_boundaries: ContrastBoundary[];
  };
  palette: PaletteColorReport[];
  metric_definitions: Record<string, string>;
  grid: { encoding: string; rows: string[] };
  guidance: string;
}

function symbolOf(index: number): string {
  return index.toString(16).toUpperCase().padStart(2, "0");
}

export function inspectSprite(
  root: string,
  stateId: string | null = null,
  angle: number | null = null,
  frame: number | null = null,
): InspectionResult {
  const { metadata, entry, filePath, state } = selection(root, stateId, angle, frame);
  let image;
  try {
    image = readPng(filePath);
  } catch {
    throw new DomainError("Selected sprite frame is missing or invalid");
  }

  const palette: Rgb[] = metadata.palette.map((hex) => hexToRgb(hex));
  const byColor = new Map<string, number>();
  palette.forEach((color, index) => byColor.set(color.join(","), index));

  const { width, height } = image;
  const total = width * height;
  const indices: (number | null)[] = new Array<number | null>(total).fill(null);
  const unknown = new Set<string>();
  for (let i = 0; i < total; i++) {
    const offset = i * 4;
    if (image.data[offset + 3] === 0) {
      indices[i] = null;
      continue;
    }
    const key = `${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`;
    const found = byColor.get(key);
    if (found !== undefined) {
      indices[i] = found;
    } else {
      indices[i] = null;
      unknown.add(key);
    }
  }
  if (unknown.size > 0) {
    throw new DomainError("Sprite contains opaque colors outside its declared shared palette");
  }

  // `noUncheckedIndexedAccess` widens `indices[i]` to `number | null | undefined`; every index
  // 0..total-1 is always assigned above, so `?? null` collapses the impossible `undefined` case
  // back to this array's real element type without a non-null assertion at every read site.
  const indexAt = (i: number): number | null => indices[i] ?? null;

  const occupied: number[] = [];
  for (let i = 0; i < total; i++) if (indexAt(i) !== null) occupied.push(i);
  let bounds: [number, number, number, number] | null = null;
  if (occupied.length > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const i of occupied) {
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    bounds = [minX, minY, maxX - minX + 1, maxY - minY + 1];
  }

  const colorComponents = components(indices, width, height);
  const opaqueMap: (number | null)[] = indices.map((v) => (v !== null ? 0 : null));
  const opaqueSizes = components(opaqueMap, width, height).get(0) ?? [];

  const counts = new Map<number, number>();
  for (const v of indices) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);

  const paletteReport: PaletteColorReport[] = [];
  palette.forEach((color, index) => {
    const count = counts.get(index) ?? 0;
    if (count === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < total; i++) {
      if (indexAt(i) !== index) continue;
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const [horizontal, vertical] = longestRuns(indices, width, height, index);
    const sizes = [...(colorComponents.get(index) ?? [])].sort((a, b) => b - a);
    paletteReport.push({
      symbol: symbolOf(index),
      hex: rgbToHex(color),
      description: colorName(color),
      pixels: count,
      bounds: [minX, minY, maxX - minX + 1, maxY - minY + 1],
      components: sizes.length,
      singleton_components: sizes.filter((s) => s === 1).length,
      longest_horizontal_run: horizontal,
      longest_vertical_run: vertical,
    });
  });

  const adjacent = new Map<string, { pair: [number, number]; edges: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const current = indexAt(y * width + x);
      for (const [nx, ny] of [
        [x + 1, y],
        [x, y + 1],
      ] as const) {
        if (nx >= width || ny >= height) continue;
        const other = indexAt(ny * width + nx);
        if (current !== null && other !== null && current !== other) {
          const pair: [number, number] = current < other ? [current, other] : [other, current];
          const key = `${String(pair[0])},${String(pair[1])}`;
          const existing = adjacent.get(key);
          if (existing) existing.edges += 1;
          else adjacent.set(key, { pair, edges: 1 });
        }
      }
    }
  }
  const boundaries: ContrastBoundary[] = [...adjacent.values()].map(({ pair, edges }) => {
    const [first, second] = pair;
    const a = at(palette, first);
    const b = at(palette, second);
    const distance = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    return {
      colors: [symbolOf(first), symbolOf(second)],
      rgb_distance: Math.round(distance * 10) / 10,
      shared_edges: edges,
    };
  });
  boundaries.sort((x, y) => x.rgb_distance - y.rgb_distance || y.shared_edges - x.shared_edges);

  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const tokens: string[] = [];
    for (let x = 0; x < width; x++) {
      const v = indexAt(y * width + x);
      tokens.push(v === null ? ".." : symbolOf(v));
    }
    rows.push(`${y.toString().padStart(2, "0")} ${tokens.join(" ")}`);
  }

  return {
    state,
    angle: entry.angle,
    frame: entry.frame,
    filename: entry.filename,
    pixel_features: entry.pixel_features ?? [],
    size: [width, height],
    pivot: entry.pivot,
    downscale_mode: metadata.settings?.downscale_mode ?? "crisp",
    analysis: {
      occupied_pixels: occupied.length,
      transparent_pixels: total - occupied.length,
      occupied_bounds: bounds,
      opaque_connected_components: opaqueSizes.length,
      opaque_singleton_components: opaqueSizes.filter((s) => s === 1).length,
      color_components: [...colorComponents.values()].reduce((sum, s) => sum + s.length, 0),
      color_singleton_components: [...colorComponents.values()].reduce(
        (sum, s) => sum + s.filter((v) => v === 1).length,
        0,
      ),
      lowest_contrast_boundaries: boundaries.slice(0, 8),
    },
    palette: paletteReport,
    metric_definitions: {
      connectivity: "Four-neighbor (edge sharing), not diagonal.",
      opaque_connected_components: "Connected nontransparent regions, ignoring color.",
      opaque_singleton_components:
        "Isolated one-pixel nontransparent regions, ignoring color.",
      color_components:
        "Sum of connected regions of each palette color; highlights and ticks can add " +
        "regions within one solid object.",
      color_singleton_components:
        "One-pixel same-color regions, not necessarily detached pixels or defects.",
      palette_components:
        "Per-color components and singleton_components use same-color connectivity.",
    },
    grid: {
      encoding:
        "Each two-character token is a palette symbol; '..' is transparent. Rows and " +
        "coordinates are zero-based from the top-left.",
      rows,
    },
    guidance:
      "Design identifying shapes on the final grid. Edit named PixelArt layers in the saved " +
      "scene revision; reserve connected pixel clusters and a separating gap for each " +
      "important feature. Review every view and pose at native scale. Feature budgets detect " +
      "loss, not whether a drawing looks good.",
  };
}

// ---------------------------------------------------------------------------------------------
// compare_inspections
// ---------------------------------------------------------------------------------------------

export interface ComparisonResult {
  changed_pixels: number;
  changed_percent: number;
  alpha_changed_pixels: number;
  occupied_pixel_delta: number;
  opaque_connected_component_delta: number;
  opaque_singleton_component_delta: number;
  color_component_delta: number;
  color_singleton_component_delta: number;
  note: string;
}

export function compareInspections(
  first: InspectionResult,
  second: InspectionResult,
): ComparisonResult {
  if (first.size[0] !== second.size[0] || first.size[1] !== second.size[1]) {
    throw new DomainError("Cannot compare sprite frames with different dimensions");
  }
  const firstTokens = first.grid.rows.flatMap((row) => row.slice(3).split(" "));
  const secondTokens = second.grid.rows.flatMap((row) => row.slice(3).split(" "));

  let alphaChanges = 0;
  for (let i = 0; i < firstTokens.length; i++) {
    if ((firstTokens[i] === "..") !== (secondTokens[i] === "..")) alphaChanges += 1;
  }
  const firstColors = new Map(first.palette.map((entry) => [entry.symbol, entry.hex]));
  const secondColors = new Map(second.palette.map((entry) => [entry.symbol, entry.hex]));
  let changed = 0;
  for (let i = 0; i < firstTokens.length; i++) {
    if (firstColors.get(at(firstTokens, i)) !== secondColors.get(at(secondTokens, i))) {
      changed += 1;
    }
  }

  return {
    changed_pixels: changed,
    changed_percent: Math.round((changed / firstTokens.length) * 100 * 100) / 100,
    alpha_changed_pixels: alphaChanges,
    occupied_pixel_delta: second.analysis.occupied_pixels - first.analysis.occupied_pixels,
    opaque_connected_component_delta:
      second.analysis.opaque_connected_components - first.analysis.opaque_connected_components,
    opaque_singleton_component_delta:
      second.analysis.opaque_singleton_components - first.analysis.opaque_singleton_components,
    color_component_delta: second.analysis.color_components - first.analysis.color_components,
    color_singleton_component_delta:
      second.analysis.color_singleton_components - first.analysis.color_singleton_components,
    note:
      "Deltas are second job minus first job. changed_pixels compares resolved hex colors " +
      "because palette symbols are local to each export.",
  };
}
