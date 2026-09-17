/**
 * Main-thread wrapper around `worker.ts`: owns the one `Worker` instance, sends `init` once (the
 * `pixel-core` type declarations, fetched once via `../api.ts`'s `getEngineReference`), and turns
 * `update` requests into promises the CodeMirror `linter()` extension (`../components/Editor.tsx`)
 * can `await`. Only the newest in-flight request's promise is ever resolved with a real result;
 * older ones resolve with `[]` immediately so a slow response for stale text can never overwrite
 * fresher diagnostics (see `protocol.ts`'s top comment for why `requestId` exists at all).
 */

import type {
  DiagnosticItem,
  DiagnosticsResultMessage,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from "./protocol.js";

export class TsWorkerClient {
  private readonly worker: Worker;
  private nextRequestId = 0;
  private latestRequestId = -1;
  private pending = new Map<number, (diagnostics: DiagnosticItem[]) => void>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
      const message = event.data;
      if (message.type === "diagnostics") {
        this.handleDiagnostics(message);
      }
    });
  }

  private handleDiagnostics(message: DiagnosticsResultMessage): void {
    const resolve = this.pending.get(message.requestId);
    this.pending.delete(message.requestId);
    resolve?.(message.diagnostics);
  }

  private post(message: MainToWorkerMessage): void {
    this.worker.postMessage(message);
  }

  /** Sends `pixel-core`'s type declarations once, before the first `checkScript` call. */
  init(typeDeclarations: string): void {
    this.post({ type: "init", typeDeclarations });
  }

  /** Requests diagnostics for `code`, resolving with `[]` if a newer request supersedes this one
   * before the worker replies. */
  checkScript(code: string): Promise<DiagnosticItem[]> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.latestRequestId = requestId;
    this.post({ type: "update", requestId, code });
    return new Promise((resolve) => {
      this.pending.set(requestId, (diagnostics) => {
        resolve(requestId === this.latestRequestId ? diagnostics : []);
      });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
