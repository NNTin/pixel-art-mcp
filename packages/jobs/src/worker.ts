/**
 * Ports the *shape* of `Worker.start()`/`Worker.stop()`/`Worker.loop()` in
 * `src/pixel_art_mcp/jobs/worker.py` -- claim a job, run it, repeat; sleep until woken when the
 * queue is empty; stop gracefully by waking the loop and cancelling the in-flight job, then
 * awaiting it -- without porting `Worker.execute()`'s ~160-line body (script/render branching,
 * request-manifest construction, artifact collection, revision publishing). That method needs
 * `packages/engine`/`packages/imaging` (the render/script runner) and `packages/service`
 * (project/revision orchestration), neither of which exists yet (Phase 5/6 in
 * `docs/typescript-rewrite.md`'s phased plan). Building a fake stand-in for it now would mean
 * re-deriving and re-testing that whole method a second time once the real dependencies land.
 *
 * **This is the deliberate Phase 4 -> Phase 5/6 seam.** `Worker` takes a `JobExecutor` --
 * `(job, cancel) => Promise<void>` -- as a constructor option instead of hard-coding
 * `execute()`'s logic. A later phase supplies the real one: given a claimed `JobPayload` and an
 * `AbortSignal` this loop will fire when the job should be cancelled, it must run the job to
 * completion, calling `store.publish()`/`store.updateJob()` itself and *never letting an
 * exception escape* -- exactly the guarantee Python's real `execute()` gives via its own
 * `try/except Exception` wrapping the entire method body. That guarantee matters here: like
 * Python's `loop()`, this port's `loop()` does **not** wrap each `execute()` call in its own
 * try/catch -- an exception that escapes the injected executor halts the whole worker loop (no
 * more jobs are claimed until the process is restarted), matching Python's
 * `except Exception: worker_ready = False; logger.exception(...)` around the *entire* while
 * loop, not a per-job safety net. A future executor that wants "one bad job doesn't take down
 * the worker" must guarantee that itself, the same way Python's `execute()` does today.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";

import type { JobPayload, Store } from "@pixel-art-mcp/storage";

import { acquireWorkerLock, type WorkerLock } from "./lock.js";

/**
 * Runs one claimed job to completion. Must itself call `store.updateJob`/`store.publish` to
 * record the outcome and must not throw -- see this file's top comment for why. `cancel` fires
 * when `Worker.cancel(job.id)` is called for this job, or when `Worker.stop()` is called while
 * this job is in flight.
 */
export type JobExecutor = (job: JobPayload, cancel: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  store: Store;
  execute: JobExecutor;
  /**
   * Called if the loop halts unexpectedly (an exception escaped `execute`, or the claim/recover
   * plumbing itself failed). Mirrors Python's `logger.exception("Pixel worker stopped
   * unexpectedly")` -- this package has no logger of its own, so the caller decides how to
   * surface it.
   */
  onError?: (error: unknown) => void;
}

/** Edge-triggered wake signal: every waiter is released the next time `wake()` is called. */
class WakeSignal {
  private waiters: (() => void)[] = [];

  wake(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }

  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export class Worker {
  private readonly store: Store;
  private readonly executeJob: JobExecutor;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly wakeSignal = new WakeSignal();

  private stopping = false;
  private ready = false;
  private lock: WorkerLock | null = null;
  private loopPromise: Promise<void> | null = null;
  private currentJobId: string | null = null;
  private currentJobCancel: AbortController | null = null;

  constructor(options: WorkerOptions) {
    this.store = options.store;
    this.executeJob = options.execute;
    this.onError = options.onError;
  }

  /** Whether the loop is up and able to claim jobs (mirrors Python's `service.worker_ready`). */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Acquires the single-instance lock, recovers any jobs left `"running"` by a previous crash,
   * wipes the scratch `tmp/` directory (only disposable job-scratch content lives there -- see
   * `Store.path`), and starts the claim/execute loop. Matches `Worker.start()` in the Python
   * source line for line, other than the lock mechanism itself (see `lock.ts`).
   */
  async start(): Promise<void> {
    if (this.loopPromise) {
      throw new Error("Worker is already started");
    }
    this.lock = await acquireWorkerLock(this.store.root);
    this.store.recover();
    const scratch = this.store.path("tmp");
    if (existsSync(scratch)) {
      rmSync(scratch, { recursive: true, force: true });
    }
    mkdirSync(scratch);
    this.stopping = false;
    this.ready = true;
    this.loopPromise = this.loop();
  }

  /**
   * Signals the loop to stop (waking it if idle, cancelling the in-flight job if one is
   * running), awaits it, then releases the worker lock. Matches `Worker.stop()`.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.wakeSignal.wake();
    this.currentJobCancel?.abort();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
  }

  /** Wakes the loop immediately -- call after enqueueing a job so it doesn't wait out an idle poll. */
  wake(): void {
    this.wakeSignal.wake();
  }

  /**
   * Requests cancellation of `jobId` if it's the job currently executing. Returns whether it
   * was in fact in flight (a caller asking to cancel an already-finished or not-yet-claimed job
   * gets `false` and should handle that some other way -- e.g. deleting a still-`"queued"` job
   * outright, which is a store-level concern, not this loop's).
   */
  cancel(jobId: string): boolean {
    if (this.currentJobId === jobId && this.currentJobCancel) {
      this.currentJobCancel.abort();
      return true;
    }
    return false;
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopping) {
        const job = this.store.claimJob();
        if (job === null) {
          await this.wakeSignal.wait();
          continue;
        }
        await this.runOne(job);
      }
    } catch (error) {
      this.ready = false;
      this.onError?.(error);
    }
  }

  private async runOne(job: JobPayload): Promise<void> {
    const controller = new AbortController();
    this.currentJobId = job.id;
    this.currentJobCancel = controller;
    try {
      await this.executeJob(job, controller.signal);
    } finally {
      this.currentJobId = null;
      this.currentJobCancel = null;
    }
  }
}
