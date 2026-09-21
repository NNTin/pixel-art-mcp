/**
 * Builds `get_pixel_engine_reference`'s static content (see `docs/typescript-rewrite.md`, "New
 * tools", and this phase's final report for why this is genuinely new functionality -- the
 * Python source has no equivalent tool to port from). Three parts, each sourced the way that doc
 * specifies:
 *
 * - `type_declarations`: read directly, at call time, from `@pixel-art-mcp/pixel-core`'s own
 *   *compiled* `.d.ts` output -- the TypeScript compiler's own artifact, located through real
 *   Node module resolution against the installed package (the same `createRequire(...).resolve
 *   (...)` technique `packages/service`'s `job-executor.ts` uses to find the engine subprocess's
 *   compiled entrypoint -- see that file's top comment for why this resolves identically under
 *   `vitest` and a real compiled deployment). Because this reads the exact files `pixel-core`'s
 *   own `tsc -b` produced -- including every JSDoc comment on `Canvas`/`PixelArt` and their
 *   methods -- it is structurally impossible for the returned text to drift from the real API: if
 *   a signature or doc comment changes, the next build changes these `.d.ts` files, and the next
 *   call to `get_pixel_engine_reference` (this module re-reads them lazily, on first call, not at
 *   module-import time, and caches the result for the life of the process) picks the change up
 *   automatically. There is no hand-maintained copy of the API to fall out of sync.
 * - `examples`: hand-written, reviewed TypeScript source strings. Each one is a complete,
 *   directly submittable `execute_pixel_script` body (the same `export default (scene,
 *   referenceImages) => void` shape that tool requires -- see `packages/engine/src/
 *   script-runtime.ts`), not inert prose. `engine-reference.test.ts` proves each one actually
 *   compiles under the real strict-mode sandbox (`@pixel-art-mcp/engine`'s `executeScript`, the
 *   exact function a real script submission runs through) and produces a `PixelArt`
 *   `pixel-core` itself accepts as valid -- the same "generated math + reviewed prose" pattern
 *   `packages/schema/src/assets.ts`'s `getAssetProfile` already uses for its own worked example.
 * - `guidance`: hand-written narrative prose, reviewed with the same care `./instructions.ts`'s
 *   `INSTRUCTIONS` is.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);

/**
 * `.d.ts` files that make up `pixel-core`'s full public surface, in read order. `index.d.ts` is
 * the package's actual advertised entry point (its only `exports`-mapped subpath -- see that
 * package's own `index.ts` doc comment on why nothing else is importable from outside the
 * package); the other three are the modules it re-exports from. Reading them directly by real
 * filesystem path (not a subpath `import`, which the package's `exports` map would refuse) is how
 * this module sees their class-level and method-level doc comments too, since an `export {
 * Canvas } from "./canvas.js"` re-export line in `index.d.ts` alone carries none of that.
 */
const DECLARATION_FILES = ["index.d.ts", "canvas.d.ts", "pixel-art.d.ts", "types.d.ts"];

/**
 * Strips the trailing `//# sourceMappingURL=...` comment `tsc` appends to every emitted `.d.ts`
 * file: a build artifact pointing at a `.map` file this tool never ships, not part of the actual
 * API surface an agent needs to read.
 */
function stripSourceMapComment(source: string): string {
  return source.replace(/\/\/# sourceMappingURL=.*$/gm, "").trimEnd();
}

/**
 * Reads `pixel-core`'s real compiled `.d.ts` output. See this file's top comment for why reading
 * these exact files -- rather than hand-transcribing prose -- is what keeps this tool's
 * advertised API text from ever drifting out of sync with the real `Canvas`/`PixelArt` classes.
 */
function readTypeDeclarations(): string {
  const entryPath = requireFromHere.resolve("@pixel-art-mcp/pixel-core");
  const distDir = path.dirname(entryPath);
  return DECLARATION_FILES.map((file) => {
    const source = stripSourceMapComment(readFileSync(path.join(distDir, file), "utf8"));
    return `// ===== ${file} =====\n${source}\n`;
  }).join("\n");
}

interface EngineReferenceExample {
  title: string;
  description: string;
  /** A complete `execute_pixel_script` submission body -- valid, directly-submittable TypeScript,
   * not a fragment. Proven to compile and run by `engine-reference.test.ts`. */
  code: string;
}

/**
 * Hand-written, reviewed worked examples. Each is a self-contained `execute_pixel_script` body
 * (`export default (scene: Scene) => void`, the exact contract `script-runtime.ts` requires) --
 * an agent can submit either one to `execute_pixel_script` unmodified and get back a valid saved
 * `pixel_art` revision. See `engine-reference.test.ts` for the proof these actually type-check
 * and run against the real `@pixel-art-mcp/pixel-core` package, not just look plausible.
 */
const EXAMPLES: EngineReferenceExample[] = [
  {
    title: "Single-view static patch",
    description:
      "The smallest valid script: one palette, one declared view, one named layer built from " +
      "Canvas.fromRows, saved with art.save(scene). Mirrors what write_pixel_art's rows field " +
      "does at the JSON layer, here as real, type-checked Canvas/PixelArt calls.",
    code: `import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

export default function main(scene: Scene): void {
  const art = new PixelArt({ D: "#293039", G: "#f3cf65" }, { 0: [8, 8] });
  const body = Canvas.fromRows([
    "DDDDDDDD",
    "DGGGGGGD",
    "DGDDDDGD",
    "DGDDDDGD",
    "DGDDDDGD",
    "DGDDDDGD",
    "DGGGGGGD",
    "DDDDDDDD",
  ]);
  art.layer("body", 0, body);
  art.save(scene);
}
`,
  },
  {
    title: "Drawing commands and a mirrored second view",
    description:
      "Builds a canvas with rect/line/stamp instead of authoring every row by hand, then " +
      "reuses it for a second declared view via Canvas.mirrored() instead of a second " +
      "hand-authored patch -- useful whenever a loop or computed pattern (the case " +
      "execute_pixel_script exists for) is clearer than static rows.",
    code: `import { Canvas, PixelArt } from "@pixel-art-mcp/pixel-core";

export default function main(scene: Scene): void {
  const art = new PixelArt({ D: "#101820", L: "#f0e5d8" }, { 0: [8, 8], 180: [8, 8] });

  const front = new Canvas(8, 8)
    .rect(0, 0, 8, 8, "D")
    .rect(1, 1, 6, 6, "L")
    .line(1, 1, 6, 6, "D")
    .stamp(3, 3, ["DD", "DD"]);
  art.layer("body", 0, front);
  // Reuse the same silhouette for the back view by mirroring it horizontally, instead of
  // hand-authoring a second patch.
  art.layer("body", 180, front.mirrored());

  art.save(scene);
}
`,
  },
];

/**
 * Hand-written narrative guidance, reviewed like `./instructions.ts`'s `INSTRUCTIONS`: the rules
 * `type_declarations`' bare signatures don't spell out (palette/view/layer semantics an agent
 * needs but that live in `Canvas`/`PixelArt`'s *runtime* checks, not their types), plus the
 * safety property this whole sandboxing design exists for.
 */
const GUIDANCE = `Canvas and PixelArt are the same server-side pixel primitives write_pixel_art's JSON
authoring format is built on -- use them here only when a loop or computed pattern (repeating a
motif across frames, procedurally generating a pattern) is clearer than static rows/drawing
commands; write_pixel_art alone is sufficient and preferred for everything else.

Palette: 2..64 entries, each a single non-'.' symbol mapped to a distinct #rrggbb hex color (case
insensitive, compared case-insensitively). '.' is reserved and always means transparent -- it is
never a palette entry and never an eraser.

Views: PixelArt's second constructor argument maps each authored angle (0, 90, 180 or 270 only)
to its native [width, height] in pixels (1..512 each). Declare only the angles the configured
asset actually uses -- get_asset_profile/configure_asset's resolved asset_layouts are the source
of truth for which angles and exact sizes a given asset needs; render_asset's validation rejects
a saved pixel_art whose views don't match those layouts exactly.

Layers: art.layer(name, angle, canvas, options?) appends pixels to a named, ordered layer (layers
composite back-to-front in the order first added). A pose with frame omitted (or null) is that
view's default, shown whenever no exact-frame pose exists for the current frame; a pose with an
explicit frame overrides the default only for that exact (angle, frame) pair. options also takes
x/y (top-left placement offset, default 0,0) and min_pixels/connected (advisory visibility
metadata inspect_asset/inspect_sprite report on, not runtime constraints layer() itself enforces).
Calling layer() again for the same (name, angle, frame) replaces that exact patch; it never merges
pixel-by-pixel with a previous call.

Canvas: new Canvas(width, height) starts fully transparent ('.' everywhere). Canvas.fromRows(rows)
builds one from an array of equal-length strings instead. rect/line/stamp mutate and return the
same Canvas (chainable); stamp treats '.' pixels in its own rows as "leave the target pixel
alone", so a stamp can add detail without covering what's already drawn underneath. mirrored()
returns a new Canvas that is a byte-for-byte horizontal flip -- useful for deriving a
left/right-symmetric view from the one you already drew instead of authoring it twice.

Persisting: only art.save(scene) writes anything -- it JSON-serializes a validated round-trip of
the current palette/views/layers onto scene.pixel_art. Nothing else on scene is read by the
render pipeline. A script that never calls save() on any PixelArt leaves the project's existing
saved pixel_art definition untouched (it is not implicitly cleared), exactly like a script that
only touches unrelated scene fields.

Safety: Canvas and PixelArt (their constructors and prototypes) are frozen at module load, so
something like \`(Canvas as any).prototype.rect = () => {}\` throws a TypeError the instant it
runs, immediately failing that one job -- it does not silently succeed. Even without that freeze,
a mutation would only ever affect the single OS subprocess running that one job: every job, script
or render alike, gets a fresh \`node\` process with its own fresh module cache, so nothing a script
does to these classes at runtime can leak into any other job, past or future.`;

let cachedReference: Record<string, unknown> | null = null;

/** Builds (and, after the first call, caches) `get_pixel_engine_reference`'s full result. */
export function buildEngineReference(): Record<string, unknown> {
  cachedReference ??= {
    type_declarations: readTypeDeclarations(),
    examples: EXAMPLES,
    guidance: GUIDANCE,
  };
  return cachedReference;
}
