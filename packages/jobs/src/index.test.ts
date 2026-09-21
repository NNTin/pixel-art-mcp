import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { identifier, Store, timestamp } from "@pixel-art-mcp/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProcess, Worker, type JobExecutor } from "./index.js";

// End-to-end smoke test of the package's public surface: a real Store + Worker, with an
// executor that itself shells out through the exported runProcess -- proving the two halves of
// this package (Part 1: process spawn/cancel; Part 2: the pluggable worker loop) compose the way
// a real Phase 5/6 executor will use them, without hard-coding any engine-specific logic here.

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-jobs-index-"));
  store = new Store(path.join(dir, "db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("@pixel-art-mcp/jobs public surface", () => {
  it("runs a queued job's executor through runProcess and records success on the Store", async () => {
    const project = store.createProject("Chair");
    const jobId = identifier();
    store.insertJob(
      {
        id: jobId,
        project_id: project.id,
        operation: "script",
        status: "queued",
        created_at: timestamp(),
      },
      32,
    );
    const script = path.join(dir, "script.cjs");
    writeFileSync(script, "console.log('ran')", "utf8");

    const execute: JobExecutor = async (job, cancel) => {
      await runProcess({
        command: [process.execPath, script],
        cwd: dir,
        timeout: 5,
        cancel,
        logLimit: 4096,
        onUpdate: () => {
          /* ignored */
        },
      });
      store.updateJob(job.id, { status: "succeeded" });
    };
    const worker = new Worker({ store, execute });
    await worker.start();
    const start = Date.now();
    while (store.job(jobId).status !== "succeeded") {
      if (Date.now() - start > 3000) throw new Error("timed out waiting for job");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await worker.stop();
    expect(store.job(jobId).status).toBe("succeeded");
  });
});
