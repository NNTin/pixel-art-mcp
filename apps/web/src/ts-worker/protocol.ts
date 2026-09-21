/**
 * postMessage protocol between the main thread (`client.ts`) and the TS-Language-Service Web
 * Worker (`worker.ts`) -- see `docs/typescript-rewrite.md`'s "Web UI" / "Editor" stack row: "TS
 * Language Service in a Web Worker (in-memory VFS with the script + `pixel-core`'s `.d.ts`)".
 *
 * Each diagnostics request carries a `requestId` so the client can discard a stale response that
 * resolves after a newer keystroke already triggered a fresher request (CodeMirror's `linter()`
 * re-invokes its async source on every debounced doc change; without this, a slow diagnostics
 * pass for an old revision could overwrite fresher diagnostics that already arrived).
 */

export interface InitMessage {
  type: "init";
  /** The exact `type_declarations` string `GET /api/engine-reference` returns -- the same
   * content `get_pixel_engine_reference` gives an MCP agent (see `worker.ts`'s top comment for
   * how this is split back into per-file virtual modules). */
  typeDeclarations: string;
}

export interface UpdateMessage {
  type: "update";
  requestId: number;
  code: string;
}

export type MainToWorkerMessage = InitMessage | UpdateMessage;

export type DiagnosticSeverity = "error" | "warning" | "suggestion" | "message";

export interface DiagnosticItem {
  message: string;
  /** 0-based UTF-16 code unit offset into the exact `code` string the request carried --
   * directly usable as a CodeMirror `Text` offset for that same document snapshot. */
  start: number;
  length: number;
  severity: DiagnosticSeverity;
}

export interface DiagnosticsResultMessage {
  type: "diagnostics";
  requestId: number;
  diagnostics: DiagnosticItem[];
}

export interface ReadyMessage {
  type: "ready";
}

export type WorkerToMainMessage = DiagnosticsResultMessage | ReadyMessage;
