/**
 * Public surface of `@pixel-art-mcp/jobs`: the generic, engine-agnostic subprocess-execution
 * primitive and pluggable single-consumer worker loop (see `docs/typescript-rewrite.md`, Phase
 * 4). `worker.ts`'s top comment documents exactly where this package's scope ends and Phase
 * 5/6's real per-job `JobExecutor` picks up.
 */

export { acquireWorkerLock, WorkerLockError, type WorkerLock } from "./lock.js";
export {
  ProcessCancelled,
  ProcessFailure,
  runProcess,
  stopProcess,
  type ProgressPayload,
  type RunProcessOptions,
} from "./process.js";
export { Worker, type JobExecutor, type WorkerOptions } from "./worker.js";
