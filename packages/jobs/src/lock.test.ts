import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireWorkerLock, WorkerLockError } from "./lock.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-jobs-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireWorkerLock", () => {
  it("acquires the lock, creating worker.lock if absent", async () => {
    const lock = await acquireWorkerLock(dir);
    await lock.release();
  });

  it("rejects a second acquisition attempt with WorkerLockError while the first is held", async () => {
    const first = await acquireWorkerLock(dir);
    await expect(acquireWorkerLock(dir)).rejects.toThrow(WorkerLockError);
    await first.release();
  });

  it("lets a new acquisition succeed after the first is released", async () => {
    const first = await acquireWorkerLock(dir);
    await first.release();
    const second = await acquireWorkerLock(dir);
    await second.release();
  });
});
