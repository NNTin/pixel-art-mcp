/**
 * Port of `Worker.start()`/`Worker.stop()`'s single-instance guard in
 * `src/pixel_art_mcp/jobs/worker.py`: Python takes an exclusive, non-blocking `fcntl.flock` on
 * `<data-dir>/worker.lock` so at most one API worker process ever runs against a given data
 * directory (the lock protects the non-DB scratch-dir wipe-on-startup race described in
 * `docs/typescript-rewrite.md`'s "Storage" section -- SQLite's own `BEGIN IMMEDIATE` already
 * serializes the database itself).
 *
 * `fcntl.flock` has no direct Node equivalent (Node ships no built-in advisory file-locking
 * primitive), so this uses the `proper-lockfile` package instead, per the plan doc's stack
 * table: it's mkdir-based (atomic directory creation is the actual locking primitive, portable
 * across POSIX and Windows) with mtime-based staleness detection, which is the closest pure-JS
 * approximation of `flock`'s crash-safety property -- a lock left behind by a process that was
 * SIGKILLed is eventually recognized as stale (default: 10s without a refresh) rather than
 * wedging the data directory forever, the same practical guarantee `flock` gives for free when
 * the holding process dies (the kernel releases the lock automatically).
 */

import { openSync, closeSync } from "node:fs";
import path from "node:path";

import { lock as acquireLock, type LockOptions } from "proper-lockfile";

export class WorkerLockError extends Error {
  constructor() {
    // Verbatim port of Python's `RuntimeError("Data directory already in use; run exactly one
    // API worker")`.
    super("Data directory already in use; run exactly one API worker");
    this.name = "WorkerLockError";
  }
}

export interface WorkerLock {
  release: () => Promise<void>;
}

/**
 * Acquires the single-instance worker lock at `<root>/worker.lock`, creating the file first if
 * absent (matching Python's `open(..., "a+b")`, which creates-if-missing) -- `proper-lockfile`
 * requires its target file to already exist. Rejects with `WorkerLockError` if another process
 * already holds it (default `retries: 0`, matching `fcntl.LOCK_EX | fcntl.LOCK_NB`'s
 * non-blocking, fail-immediately semantics).
 */
export async function acquireWorkerLock(root: string): Promise<WorkerLock> {
  const lockFile = path.join(root, "worker.lock");
  closeSync(openSync(lockFile, "a"));

  const options: LockOptions = { retries: 0 };
  let release: () => Promise<void>;
  try {
    release = await acquireLock(lockFile, options);
  } catch {
    throw new WorkerLockError();
  }
  return { release };
}
