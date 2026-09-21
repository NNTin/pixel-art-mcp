/**
 * TypeScript Compiler API sandbox for submitted authoring scripts (see
 * `docs/typescript-rewrite.md`, "Core design decisions" -> "Script sandboxing", and this
 * package's final report for the specific execution-model choice made here).
 *
 * Python's engine (`engine/runner.py::run_script`) `exec()`s the submitted script directly in
 * the same OS process the worker already spawned, injecting `scene`/`reference_images` as bare
 * module-level globals the script reads/writes without declaring or importing them. TypeScript
 * has no `exec()` equivalent -- a submitted script must be compiled to real JS before Node can run
 * it -- so this module instead:
 *
 * 1. Writes the submitted source to a scratch `.mts` file *inside this package's own directory
 *    tree* (`<packages/engine>/.script-scratch/<uuid>/script.mts`), so Node's ordinary
 *    `node_modules` directory walk-up finds `@pixel-art-mcp/pixel-core` the exact same way any
 *    other file in this package would -- no custom module resolver needed, and it works
 *    identically in dev (running from `src/`) and in a built/installed deployment (running from
 *    `dist/`), since both are direct children of this package's own root.
 * 2. Type-checks/compiles it with `strict: true` via `ts.createProgram`, alongside a small
 *    ambient `.d.ts` (`Scene`/`ReferenceImages` type aliases only -- no DOM lib, no Node ambient
 *    globals; the only *importable* module besides the standard library is
 *    `@pixel-art-mcp/pixel-core`, resolved by the same real Node module resolution described
 *    above). Compile errors become a `ScriptCompileError` carrying every diagnostic.
 * 3. On a clean compile, dynamically `import()`s the emitted `.mjs` module *in this same
 *    process* -- see `runner.ts`'s top comment for why this package does not spawn a second
 *    nested `node` subprocess for this step -- and calls its required default export.
 *
 * **Execution-model deviation from Python, called out explicitly per this phase's brief:**
 * Python's bare-global `scene`/`reference_images` injection has no clean TypeScript equivalent
 * that stays type-checked end to end (a `declare global { const scene: ... }` ambient only fakes
 * the *type*; actually binding a real runtime value to a bare module-scope name from outside the
 * module requires either mutating `globalThis` -- untyped and fragile at the call site -- or a
 * `vm`-context trick the design doc's "Script sandboxing" section explicitly rejects in favor of
 * OS-process isolation). Per `docs/typescript-rewrite.md`'s own "Flow" paragraph ("...runs the
 * compiled ES module, which must itself import Canvas/PixelArt and export a `(scene,
 * referenceImages) => void` function"), the compiled module instead exports a plain function of
 * that shape, and this module calls it with the real values as ordinary arguments. This is
 * idiomatic ESM, stays fully type-checked, and is behaviorally equivalent to Python's model for
 * every real use (the script reads/mutates the very same `scene` object either way, since it's
 * passed by reference) -- it just makes the binding explicit (a parameter) instead of implicit
 * (a global), which is the only part of the doc's "ambient values" phrasing this module doesn't
 * implement literally. Flagged here rather than silently guessed.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

/** One compiler diagnostic, reduced to what job log output needs. */
export interface CompileDiagnostic {
  message: string;
  line: number | null;
  column: number | null;
}

/** Thrown when the submitted script fails to type-check or emit. Carries every error diagnostic
 * -- distinct from `ScriptRuntimeError` so a caller (a later phase's worker wiring) can surface a
 * clear diagnostic list instead of a generic crash. */
export class ScriptCompileError extends Error {
  readonly diagnostics: readonly CompileDiagnostic[];

  constructor(diagnostics: readonly CompileDiagnostic[]) {
    super(`Script failed to compile:\n${diagnostics.map(formatDiagnostic).join("\n")}`);
    this.name = "ScriptCompileError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Thrown once a script has compiled cleanly but fails at run time -- either it doesn't satisfy
 * the required `export default (scene, referenceImages) => void | Promise<void>` shape, or its
 * body itself threw/rejected. `cause` carries the original thrown value, if any.
 */
export class ScriptRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScriptRuntimeError";
  }
}

function formatDiagnostic(d: CompileDiagnostic): string {
  const at = d.line !== null && d.column !== null ? `${String(d.line)}:${String(d.column)}: ` : "";
  return `  ${at}${d.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ambient `.d.ts` the compile sandbox includes alongside the script: no DOM lib, no Node ambient
 * globals, just convenience type aliases the script's required exported function can name its
 * parameters with, without an import (see this file's top comment for how this reconciles with
 * the design doc's "ambient values" wording).
 */
const AMBIENT_ENV_DTS = `declare global {
  /** The mutable per-project render scene passed to the script's default export. */
  type Scene = Record<string, unknown>;
  /** Reference id -> local file path, passed to the script's default export. */
  type ReferenceImages = Record<string, string>;
}
export {};
`;

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH_ROOT = path.join(ENGINE_ROOT, ".script-scratch");

function toCompileDiagnostic(diagnostic: ts.Diagnostic): CompileDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return { message, line: line + 1, column: character + 1 };
  }
  return { message, line: null, column: null };
}

/**
 * Compiles `scriptPath` (plus the ambient env declarations at `envPath`) with `strict: true`.
 * Throws `ScriptCompileError` on any compiler error (type-check or emit). Returns the emitted
 * module's absolute file path.
 */
function compile(scratchDir: string, scriptPath: string, envPath: string): string {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    outDir: scratchDir,
    rootDir: scratchDir,
    types: [],
    isolatedModules: true,
  };
  const host = ts.createCompilerHost(options);
  const program = ts.createProgram({ rootNames: [scriptPath, envPath], options, host });
  const preEmitErrors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (preEmitErrors.length > 0) {
    throw new ScriptCompileError(preEmitErrors.map(toCompileDiagnostic));
  }

  const emitResult = program.emit();
  const emitErrors = emitResult.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (emitErrors.length > 0) {
    throw new ScriptCompileError(emitErrors.map(toCompileDiagnostic));
  }
  // `module: NodeNext` gives a `.mts` source file unconditional ESM output: `.mjs` at the same
  // relative path under `outDir` -- here equal to `rootDir`, so directly alongside the source,
  // with no other transformation of the path. Deterministic given TS's Node16/NodeNext emit
  // rules, so no need to track the exact written path through a custom compiler host.
  return scriptPath.replace(/\.mts$/, ".mjs");
}

/** Imports the compiled module and calls its required default export. */
async function runCompiled(
  jsPath: string,
  scene: Record<string, unknown>,
  referenceImages: Record<string, string>,
): Promise<void> {
  let moduleExports: unknown;
  try {
    moduleExports = (await import(pathToFileURL(jsPath).href)) as unknown;
  } catch (error) {
    throw new ScriptRuntimeError(`Script threw while loading: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const fn = (moduleExports as { default?: unknown }).default;
  if (typeof fn !== "function") {
    throw new ScriptRuntimeError(
      "Script must have a default export of shape (scene, referenceImages) => void | Promise<void>",
    );
  }
  try {
    await (
      fn as (
        scene: Record<string, unknown>,
        referenceImages: Record<string, string>,
      ) => void | Promise<void>
    )(scene, referenceImages);
  } catch (error) {
    throw new ScriptRuntimeError(`Script threw: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Compiles and runs a submitted authoring script against `scene`/`referenceImages`, mutating
 * `scene` in place (objects are passed by reference, the same effective contract as Python's
 * `exec()`-injected globals -- see this file's top comment). Always cleans up its scratch
 * directory, on success or failure.
 */
export async function executeScript(
  source: string,
  scene: Record<string, unknown>,
  referenceImages: Record<string, string>,
): Promise<void> {
  const scratchDir = path.join(SCRATCH_ROOT, randomUUID());
  mkdirSync(scratchDir, { recursive: true });
  try {
    const envPath = path.join(scratchDir, "pixel-script-env.d.ts");
    writeFileSync(envPath, AMBIENT_ENV_DTS, "utf8");
    const scriptPath = path.join(scratchDir, "script.mts");
    writeFileSync(scriptPath, source, "utf8");
    const jsPath = compile(scratchDir, scriptPath, envPath);
    await runCompiled(jsPath, scene, referenceImages);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
