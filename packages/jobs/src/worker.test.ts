/**
 * Exercises the generic poll/wake loop with a fake injected `JobExecutor` -- this package has no
 * real executor yet (see this file's sibling `worker.ts`'s top comment), so these tests stand in
 * a controllable fake to prove the loop's own claim/execute/wake/stop/cancel mechanics, against
 * a real `Store` (temp SQLite file per test, not mocked).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { identifier, Store, timestamp } from "@pixel-art-mcp/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Worker, type JobExecutor } from "./worker.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-jobs-worker-"));
  store = new Store(path.join(dir, "db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function queueJob(projectId: string): string {
  const jobId = identifier();
  store.insertJob(
    {
      id: jobId,
      project_id: projectId,
      operation: "script",
      status: "queued",
      created_at: timestamp(),
    },
    32,
  );
  return jobId;
}

describe("Worker", () => {
  it("starts ready, claims a queued job, and runs the injected executor", async () => {
    const project = store.createProject("Chair");
    const jobId = queueJob(project.id);

    const seen: string[] = [];
    const execute: JobExecutor = async (job) => {
      seen.push(job.id);
      store.updateJob(job.id, { status: "succeeded" });
      await Promise.resolve();
    };
    const worker = new Worker({ store, execute });
    await worker.start();
    expect(worker.isReady).toBe(true);
    await waitUntil(() => seen.includes(jobId));
    expect(store.job(jobId).status).toBe("succeeded");
    await worker.stop();
    expect(worker.isReady).toBe(false);
  });

  it("wakes immediately on wake() instead of waiting out an idle poll", async () => {
    const project = store.createProject("Chair");
    const seen: string[] = [];
    const execute: JobExecutor = async (job) => {
      seen.push(job.id);
      store.updateJob(job.id, { status: "succeeded" });
      await Promise.resolve();
    };
    const worker = new Worker({ store, execute });
    await worker.start();
    // Queue is empty at start, so the loop is parked on wakeSignal.wait().
    const jobId = queueJob(project.id);
    worker.wake();
    await waitUntil(() => seen.includes(jobId));
    await worker.stop();
  });

  it("passes an AbortSignal to the executor and cancel(jobId) aborts it", async () => {
    const project = store.createProject("Chair");
    const jobId = queueJob(project.id);

    let receivedSignal: AbortSignal | null = null;
    let aborted = false;
    const executorStarted = deferredVoid();
    const execute: JobExecutor = (job, cancel) =>
      new Promise((resolve) => {
        receivedSignal = cancel;
        cancel.addEventListener("abort", () => {
          aborted = true;
          store.updateJob(job.id, { status: "cancelled" });
          resolve();
        });
        executorStarted.resolve();
      });
    const worker = new Worker({ store, execute });
    await worker.start();
    await executorStarted.promise;
    expect(receivedSignal).not.toBeNull();
    expect(worker.cancel(jobId)).toBe(true);
    await waitUntil(() => aborted);
    expect(store.job(jobId).status).toBe("cancelled");
    // A job id that isn't currently in flight is reported as not cancellable.
    expect(worker.cancel("not-a-real-job")).toBe(false);
    await worker.stop();
  });

  it("stop() aborts the in-flight job and waits for it to finish before resolving", async () => {
    const project = store.createProject("Chair");
    const jobId = queueJob(project.id);

    let finished = false;
    const executorStarted = deferredVoid();
    const execute: JobExecutor = (job, cancel) =>
      new Promise((resolve) => {
        cancel.addEventListener("abort", () => {
          setTimeout(() => {
            store.updateJob(job.id, { status: "failed" });
            finished = true;
            resolve();
          }, 20);
        });
        executorStarted.resolve();
      });
    const worker = new Worker({ store, execute });
    await worker.start();
    await executorStarted.promise;

    const stopPromise = worker.stop();
    expect(worker.isReady).toBe(false);
    await stopPromise;
    expect(finished).toBe(true);
    expect(store.job(jobId).status).toBe("failed");
  });

  it("halts the loop (isReady=false, onError called) if the injected executor throws, and claims no further jobs", async () => {
    const project = store.createProject("Chair");
    const firstJobId = queueJob(project.id);
    const secondJobId = queueJob(project.id);

    const errors: unknown[] = [];
    const execute: JobExecutor = () => {
      throw new Error("executor bug");
    };
    const worker = new Worker({ store, execute, onError: (error) => errors.push(error) });
    await worker.start();
    await waitUntil(() => errors.length > 0);
    expect(worker.isReady).toBe(false);
    // The first job was claimed (now "running", never updated by the buggy executor); the
    // second was never even claimed, matching Python's "the whole worker halts" behavior.
    expect(store.job(firstJobId).status).toBe("running");
    expect(store.job(secondJobId).status).toBe("queued");
  });

  it("rejects starting a second worker against the same store root while the first is running", async () => {
    const execute: JobExecutor = async () => {
      /* never called in this test */
    };
    const worker = new Worker({ store, execute });
    await worker.start();
    const other = new Worker({ store, execute });
    await expect(other.start()).rejects.toThrow("Data directory already in use");
    await worker.stop();
  });
});

/** A promise + its own resolver, for signalling "the fake executor has started" from within it. */
function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
