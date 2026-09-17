/**
 * In-memory copy of every `lib.*.d.ts` file TypeScript's own npm package ships (`node_modules/
 * typescript/lib/lib.*.d.ts`), bundled into the TS worker's chunk at build time via Vite's
 * `import.meta.glob(..., { query: "?raw" })`.
 *
 * Why the whole set, not a hand-picked subset: `worker.ts` sets `compilerOptions.lib =
 * ["lib.es2022.d.ts"]` -- the exact same single entry `packages/engine/src/script-runtime.ts`'s
 * real compile sandbox uses (see that file's `AMBIENT_ENV_DTS`/`compile()`). That one file pulls
 * in the rest of the ES2022 lib chain itself via `/// <reference lib="es2021" />`-style
 * directives (`lib.es2022.d.ts` -> `lib.es2021.d.ts` -> ... -> `lib.es5.d.ts`, plus every
 * `es20XX.<feature>.d.ts` split file along the way -- confirmed by grepping the installed
 * `typescript` package's own reference chain during this port). Hand-enumerating that ~50-file
 * transitive closure would be brittle against a future TypeScript upgrade; globbing the whole
 * `lib.*.d.ts` directory (no DOM/WebWorker/scripthost variants are on that reference chain, so
 * this stays consistent with the real sandbox's non-DOM environment) is simpler and self-updates
 * with whatever `typescript` version this workspace installs.
 */

const rawLibFiles = import.meta.glob("../../node_modules/typescript/lib/lib.*.d.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** `lib.es2022.d.ts` -> its source text, keyed by bare filename (matching how TypeScript's own
 * lib-reference resolution looks these up, regardless of virtual directory). */
export const LIB_FILES: ReadonlyMap<string, string> = new Map(
  Object.entries(rawLibFiles).map(([filePath, content]) => [
    filePath.slice(filePath.lastIndexOf("/") + 1),
    content,
  ]),
);

/** The entry point `worker.ts` puts in `compilerOptions.lib` -- matches
 * `script-runtime.ts`'s real sandbox exactly (`target: ES2022`, `lib: ["lib.es2022.d.ts"]`). */
export const DEFAULT_LIB_FILE_NAME = "lib.es2022.d.ts";
