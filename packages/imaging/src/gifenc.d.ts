/**
 * Minimal ambient types for `gifenc` (no upstream `.d.ts`/`@types` package -- see this package's
 * final report for why `gifenc` was chosen over `omggif`). Covers only the surface `gif.ts` uses.
 *
 * `gifenc`'s published `dist/gifenc.js` is an esbuild `--format=cjs` bundle: it sets
 * `exports.__esModule = true` and assigns every export (including a self-referential `default`
 * that's just an alias for `GIFEncoder`, not the whole module) via a dynamic `__export(exports,
 * {...})` helper rather than static `exports.x = ...`/`Object.defineProperty` calls. That helper
 * shape is invisible to Node's own ESM loader (`cjs-module-lexer` can't statically detect it), but
 * *is* detected by Vite/Vitest's bundler-level CJS interop -- so real Node and this package's own
 * `vitest` test suite disagree about what `import * as ns from "gifenc"` yields:
 *  - Real Node: only `ns.default` exists, and it *is* the whole CJS `module.exports` object
 *    (Node's fallback for an otherwise-unanalyzable CJS module) -- `ns.default.GIFEncoder`/
 *    `ns.default.applyPalette` work, `ns.GIFEncoder` does not.
 *  - Vitest: `ns.GIFEncoder`/`ns.applyPalette` exist directly on the namespace, and `ns.default`
 *    is just `GIFEncoder` itself (the package's own quirky choice, not a wrapped module object).
 * `gif.ts`'s `resolveGifenc` below checks for the Vitest shape first and falls back to `ns.default`
 * for real Node -- verified against the installed package directly under both `node file.mjs` and
 * `vitest run` (see this package's final report). Only `ns.default`'s shape is declared here;
 * the Vitest-only extra top-level properties are accessed through a loosely-typed runtime check
 * instead of being declared statically, so this ambient module stays honest about what's actually
 * guaranteed cross-environment.
 */
declare module "gifenc" {
  export type GifColor =
    | readonly [number, number, number]
    | readonly [number, number, number, number];

  export interface WriteFrameOptions {
    palette?: readonly GifColor[];
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
  }

  export interface GifEncoderInstance {
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export interface GifencModule {
    GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;
    applyPalette(
      rgba: Uint8Array | Uint8ClampedArray,
      palette: readonly GifColor[],
      format?: string,
    ): Uint8Array;
    quantize(
      rgba: Uint8Array | Uint8ClampedArray,
      maxColors: number,
      opts?: Record<string, unknown>,
    ): GifColor[];
  }

  const gifencDefault: GifencModule;
  export default gifencDefault;
}
