/**
 * Fixed-palette classification (`Image.quantize(palette=..., dither=NONE)`) and palette
 * derivation from samples (`Image.quantize(colors=N, method=MEDIANCUT, dither=NONE)`), used by
 * `pixels.ts`.
 *
 * There is no PIL in the TypeScript stack, so `medianCutPalette` below is our own median-cut
 * implementation rather than a port of PIL's C `MEDIANCUT` quantizer. None of the ported Python
 * tests assert byte-identical output against PIL's specific quantizer (see this package's final
 * report) -- they only assert invariants this implementation satisfies by construction:
 * determinism (repeated calls on identical input return identical output, load-bearing for
 * `pixels.ts`'s "stationary pixels don't flicker between frames" guarantee), and exact color
 * preservation when the number of distinct sampled colors is already <= the requested count
 * (each such color becomes its own single-color box, so its weighted-average representative is
 * the color itself, unrounded).
 */

import { at } from "./internal.js";

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const channel = (v: number): string => v.toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Nearest color in `palette` by squared Euclidean RGB distance; ties keep the lowest index
 * (first strictly-smaller distance wins, matching `pixels.ts::cellVote`'s documented tie-break
 * discipline -- deterministic, never dependent on frame content or iteration order). */
export function nearestPaletteIndex(rgb: Rgb, palette: readonly Rgb[]): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const candidate = at(palette, i);
    const dr = rgb[0] - candidate[0];
    const dg = rgb[1] - candidate[1];
    const db = rgb[2] - candidate[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

interface ColorBucket {
  rgb: [number, number, number];
  count: number;
}

function distinctColors(samples: readonly Rgb[]): ColorBucket[] {
  const buckets = new Map<number, ColorBucket>();
  for (const [r, g, b] of samples) {
    const key = (r << 16) | (g << 8) | b;
    const existing = buckets.get(key);
    if (existing) existing.count += 1;
    else buckets.set(key, { rgb: [r, g, b], count: 1 });
  }
  return [...buckets.values()];
}

function channelRange(box: readonly ColorBucket[], channel: 0 | 1 | 2): number {
  let min = 255;
  let max = 0;
  for (const { rgb } of box) {
    const v = rgb[channel];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

function weightedAverage(box: readonly ColorBucket[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (const bucket of box) {
    r += bucket.rgb[0] * bucket.count;
    g += bucket.rgb[1] * bucket.count;
    b += bucket.rgb[2] * bucket.count;
    total += bucket.count;
  }
  if (total === 0) return [0, 0, 0];
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

/** Derives at most `targetCount` representative colors from `samples` (median-cut over sample
 * frequency, weighted by occurrence count). Returns `[[0, 0, 0]]` for an empty input. */
export function medianCutPalette(samples: readonly Rgb[], targetCount: number): Rgb[] {
  const distinct = distinctColors(samples);
  if (distinct.length === 0) return [[0, 0, 0]];
  if (distinct.length <= targetCount) return distinct.map((bucket) => bucket.rgb);

  const boxes: ColorBucket[][] = [distinct];
  while (boxes.length < targetCount) {
    let splitIndex = -1;
    let splitPopulation = -1;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      const population = box.reduce((sum, bucket) => sum + bucket.count, 0);
      if (population > splitPopulation) {
        splitPopulation = population;
        splitIndex = index;
      }
    });
    if (splitIndex === -1) break; // Every remaining box already holds one distinct color.

    const box = at(boxes, splitIndex);
    let widestChannel: 0 | 1 | 2 = 0;
    let widestRange = -1;
    ([0, 1, 2] as const).forEach((channel) => {
      const range = channelRange(box, channel);
      if (range > widestRange) {
        widestRange = range;
        widestChannel = channel;
      }
    });
    const sorted = [...box].sort((a, b) => a.rgb[widestChannel] - b.rgb[widestChannel]);
    const total = sorted.reduce((sum, bucket) => sum + bucket.count, 0);
    let cumulative = 0;
    let splitAt = sorted.length - 2; // Fallback keeps both halves non-empty.
    for (let i = 0; i < sorted.length; i++) {
      cumulative += at(sorted, i).count;
      if (cumulative * 2 >= total) {
        splitAt = Math.min(i, sorted.length - 2);
        break;
      }
    }
    boxes[splitIndex] = sorted.slice(0, splitAt + 1);
    boxes.push(sorted.slice(splitAt + 1));
  }
  return boxes.map(weightedAverage);
}
