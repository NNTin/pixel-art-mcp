/**
 * Animated GIF export shared by `pixels.ts` (and, later, `states.ts`). Port of
 * `src/pixel_art_mcp/imaging/gif.py` (49 lines).
 *
 * Frames must already be RGBA with binary alpha (0 or 255, as `pixelate()` produces) and
 * restricted to the given hex `palette` -- both `pixels.ts` and (later) `states.ts` already hold
 * such a palette from `paletteFromSamples()`/`pixelate()`, so no re-quantization against a
 * freshly derived palette happens here.
 *
 * One extra palette slot (index `palette.length`) is reserved for transparency, always available
 * since `RenderOptions.colors` is capped at 255.
 *
 * Uses `gifenc` (see `gifenc.d.ts`'s doc comment and this package's final report for why, over
 * `omggif`): `applyPalette` does the fixed-palette nearest-color classification (equivalent to
 * PIL's `quantize(palette=..., dither=NONE)` -- frames are already exact palette colors here, so
 * classification always finds an exact, zero-distance match), and `writeFrame`'s `dispose: 2`
 * matches Python's `disposal=2` (restore-to-background) exactly -- deliberately different from
 * `apng.ts`'s `disposeOp: 0` (see that module's doc comment for why the two encoders disagree).
 */

import fs from "node:fs";
import path from "node:path";

import * as gifencNamespace from "gifenc";
import type { GifencModule } from "gifenc";

import type { RGBAImage } from "./image.js";
import { hexToRgb } from "./quantize.js";

/** See `gifenc.d.ts`'s doc comment: real Node and this package's own `vitest` suite disagree
 * about whether `gifenc`'s named exports live directly on the namespace object or only inside
 * `.default`. Checked once at module load via a loosely-typed runtime probe (deliberately not
 * statically typed against `gifencNamespace`'s declared shape, which only promises `.default` --
 * the extra Vitest-only properties aren't guaranteed to exist, so this can't be a compile-time
 * certainty). */
function resolveGifenc(namespace: typeof gifencNamespace): GifencModule {
  const dynamic = namespace as unknown as Record<string, unknown>;
  if (typeof dynamic["GIFEncoder"] === "function") return dynamic as unknown as GifencModule;
  return namespace.default;
}

const gifenc = resolveGifenc(gifencNamespace);

export function saveAnimatedGif(
  frames: readonly RGBAImage[],
  palette: readonly string[],
  fps: number,
  filePath: string,
): void {
  const rgbPalette = palette.map((hex) => hexToRgb(hex));
  const transparentIndex = rgbPalette.length;
  // A dummy, never-selected color fills the reserved transparency slot in the color table.
  const globalPalette = [...rgbPalette, [0, 0, 0] as const];
  const delay = 1000 / fps;

  const encoder = gifenc.GIFEncoder();
  frames.forEach((frame, index) => {
    const indexed = gifenc.applyPalette(frame.data, globalPalette);
    for (let i = 0; i < frame.width * frame.height; i++) {
      if (frame.data[i * 4 + 3] === 0) indexed[i] = transparentIndex;
    }
    encoder.writeFrame(indexed, frame.width, frame.height, {
      palette: index === 0 ? globalPalette : undefined,
      transparent: true,
      transparentIndex,
      delay,
      repeat: 0,
      dispose: 2,
    });
  });
  encoder.finish();

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encoder.bytes());
}
