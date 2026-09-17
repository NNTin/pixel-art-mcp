/**
 * The TS Language Service Web Worker itself (`docs/typescript-rewrite.md`'s "Editor" stack row).
 * Runs a real `ts.LanguageService` against a tiny in-memory virtual filesystem: the current
 * script (`/script.ts`), the same ambient `Scene`/`ReferenceImages` globals the real submission
 * sandbox declares (`AMBIENT_ENV_DTS` below -- copied verbatim from `packages/engine/src/
 * script-runtime.ts`'s own constant of the same name, so a script that type-checks here
 * type-checks there too), and `@pixel-art-mcp/pixel-core`'s real compiled `.d.ts` files, parsed
 * back out of the exact `type_declarations` string `GET /api/engine-reference` returns (itself a
 * verbatim passthrough of what `get_pixel_engine_reference` gives an MCP agent -- see
 * `../../../apps/server/src/mcp/engine-reference.ts`). Nothing here re-derives that content a
 * different way, per the phase brief.
 *
 * Module resolution deviates from Node's own algorithm on purpose: this worker has no real
 * `node_modules`, so `resolveModuleNameLiterals` below special-cases the bare specifier
 * `"@pixel-art-mcp/pixel-core"` to a fixed virtual path and otherwise delegates to
 * `ts.resolveModuleName` against the in-memory host (which is sufficient for the package's own
 * internal relative `"./canvas.js"`-style re-exports).
 */

import ts from "typescript";

import { DEFAULT_LIB_FILE_NAME, LIB_FILES } from "./lib-files.js";
import type { DiagnosticItem, DiagnosticsResultMessage, MainToWorkerMessage } from "./protocol.js";
import { PIXEL_CORE_DIR, splitPixelCoreDeclarations } from "./split-declarations.js";

// Verbatim copy of `packages/engine/src/script-runtime.ts`'s `AMBIENT_ENV_DTS` -- see that
// file's top comment for why a submitted script names its default export's parameters `Scene`/
// `ReferenceImages` without importing them. Kept in sync by hand (small, stable, reviewed like
// any other duplicated prompt/contract text in this codebase); a mismatch here would only ever
// make the in-browser preview diagnostics slightly wrong, never affect what the real server-side
// sandbox (the actual source of truth) accepts.
const AMBIENT_ENV_DTS = `declare global {
  /** The mutable per-project render scene passed to the script's default export. */
  type Scene = Record<string, unknown>;
  /** Reference id -> local file path, passed to the script's default export. */
  type ReferenceImages = Record<string, string>;
}
export {};
`;

const SCRIPT_PATH = "/script.ts";
const ENV_PATH = "/env.d.ts";
const PIXEL_CORE_INDEX = `${PIXEL_CORE_DIR}/index.d.ts`;

interface VirtualFile {
  content: string;
  version: number;
}

const files = new Map<string, VirtualFile>();

function setFile(path: string, content: string): void {
  const existing = files.get(path);
  files.set(path, { content, version: (existing?.version ?? 0) + 1 });
}

setFile(ENV_PATH, AMBIENT_ENV_DTS);
// Placeholder until `init` arrives -- keeps the language service constructible immediately so
// `update` requests received before `init` (shouldn't happen given `client.ts`'s ordering, but
// costs nothing to guard) don't crash on a missing root file.
setFile(SCRIPT_PATH, "");

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: [DEFAULT_LIB_FILE_NAME],
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
  types: [],
  isolatedModules: true,
  noEmit: true,
};

function readVirtualOrLib(fileName: string): string | undefined {
  const virtual = files.get(fileName);
  if (virtual) return virtual.content;
  const baseName = fileName.slice(fileName.lastIndexOf("/") + 1);
  return LIB_FILES.get(baseName);
}

const host: ts.LanguageServiceHost & ts.ModuleResolutionHost = {
  getScriptFileNames: () =>
    [SCRIPT_PATH, ENV_PATH, ...files.keys()].filter(
      (name, index, all) => all.indexOf(name) === index,
    ),
  getScriptVersion: (fileName) => String(files.get(fileName)?.version ?? 0),
  getScriptSnapshot: (fileName) => {
    const content = readVirtualOrLib(fileName);
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
  },
  getCurrentDirectory: () => "/",
  getCompilationSettings: () => COMPILER_OPTIONS,
  getDefaultLibFileName: () => DEFAULT_LIB_FILE_NAME,
  fileExists: (fileName) => readVirtualOrLib(fileName) !== undefined,
  readFile: (fileName) => readVirtualOrLib(fileName),
  directoryExists: () => true,
  resolveModuleNameLiterals: (moduleLiterals, containingFile) =>
    moduleLiterals.map((literal) => {
      if (literal.text === "@pixel-art-mcp/pixel-core") {
        return {
          resolvedModule: {
            resolvedFileName: PIXEL_CORE_INDEX,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          },
        };
      }
      return ts.resolveModuleName(literal.text, containingFile, COMPILER_OPTIONS, host);
    }),
};

const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());

function severityOf(category: ts.DiagnosticCategory): DiagnosticItem["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
  }
}

function toDiagnosticItem(diagnostic: ts.Diagnostic): DiagnosticItem | null {
  if (diagnostic.start === undefined || diagnostic.length === undefined) return null;
  return {
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    start: diagnostic.start,
    length: diagnostic.length,
    severity: severityOf(diagnostic.category),
  };
}

function computeDiagnostics(): DiagnosticItem[] {
  const raw = [
    ...languageService.getSyntacticDiagnostics(SCRIPT_PATH),
    ...languageService.getSemanticDiagnostics(SCRIPT_PATH),
  ];
  const items: DiagnosticItem[] = [];
  for (const diagnostic of raw) {
    const item = toDiagnosticItem(diagnostic);
    if (item) items.push(item);
  }
  return items;
}

/** Cast through `unknown`: `self` inside a module worker is a `DedicatedWorkerGlobalScope`, but
 * this project's tsconfig deliberately doesn't add the `"webworker"` lib globally (it would
 * collide with the `"dom"` lib the rest of `apps/web` needs for React) -- see
 * `apps/web/tsconfig.json`'s comment. This narrow, local, explicitly-typed surface is everything
 * this file actually uses. */
const worker = self as unknown as {
  postMessage: (message: WorkerToMainOutbound) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<MainToWorkerMessage>) => void,
  ) => void;
};

type WorkerToMainOutbound = DiagnosticsResultMessage;

worker.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") {
    for (const [path, content] of splitPixelCoreDeclarations(message.typeDeclarations)) {
      setFile(path, content);
    }
    return;
  }
  // `message` is narrowed to `UpdateMessage` here -- `MainToWorkerMessage` has exactly two
  // variants and the `"init"` branch above always returns.
  setFile(SCRIPT_PATH, message.code);
  worker.postMessage({
    type: "diagnostics",
    requestId: message.requestId,
    diagnostics: computeDiagnostics(),
  });
});
