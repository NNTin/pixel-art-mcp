/**
 * Exercises `runProcess` against trivial inline Node scripts (this package cannot yet exercise
 * it against the real engine -- `packages/engine`/`packages/imaging` don't exist; see Phase 4's
 * scope note in `worker.ts`), covering: a successful run, a non-zero exit, a timeout, mid-run
 * cancellation (asserting the whole process tree -- including a grandchild -- is actually
 * killed), and `PIXEL_PROGRESS` parsing/log-capping.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProcessCancelled, ProcessFailure, runProcess, type ProgressPayload } from "./process.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-jobs-process-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeScript(name: string, content: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

function noopCancel(): AbortSignal {
  return new AbortController().signal;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("runProcess", () => {
  it("resolves on a successful run and captures stdout in the log", async () => {
    const script = writeScript("ok.cjs", "console.log('hello from script');");
    const updates: { log: string; progress: ProgressPayload | null }[] = [];
    await runProcess({
      command: [process.execPath, script],
      cwd: dir,
      timeout: 5,
      cancel: noopCancel(),
      logLimit: 4096,
      onUpdate: (log, progress) => updates.push({ log, progress }),
    });
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)?.log).toContain("hello from script");
  });

  it("rejects with ProcessFailure on a non-zero exit", async () => {
    const script = writeScript("fail.cjs", "process.exit(3);");
    await expect(
      runProcess({
        command: [process.execPath, script],
        cwd: dir,
        timeout: 5,
        cancel: noopCancel(),
        logLimit: 4096,
        onUpdate: () => {
          /* ignored */
        },
      }),
    ).rejects.toThrow(ProcessFailure);
  });

  it("rejects with ProcessFailure and the %g-formatted timeout message when the timeout elapses", async () => {
    const script = writeScript("hang.cjs", "setInterval(() => {}, 1000);");
    await expect(
      runProcess({
        command: [process.execPath, script],
        cwd: dir,
        timeout: 0.2,
        cancel: noopCancel(),
        logLimit: 4096,
        onUpdate: () => {
          /* ignored */
        },
      }),
    ).rejects.toThrow("Execution exceeded 0.2 seconds");
  });

  it("kills the whole process tree (including a grandchild) on timeout", async () => {
    const pidFile = path.join(dir, "pids.json");
    const script = writeScript(
      "tree.cjs",
      `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        detached: true,
        stdio: "ignore",
      });
      fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
      `,
    );
    const promise = runProcess({
      command: [process.execPath, script, pidFile],
      cwd: dir,
      timeout: 0.2,
      cancel: noopCancel(),
      logLimit: 4096,
      onUpdate: () => {
        /* ignored */
      },
    });
    await expect(promise).rejects.toThrow(ProcessFailure);

    const { parent, child } = JSON.parse(readFileSync(pidFile, "utf8")) as {
      parent: number;
      child: number;
    };
    await waitUntil(() => !isAlive(parent) && !isAlive(child));
  });

  it("rejects with ProcessCancelled and kills the process tree when the cancel signal fires mid-run", async () => {
    const pidFile = path.join(dir, "pids.json");
    const script = writeScript(
      "cancel-tree.cjs",
      `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        detached: true,
        stdio: "ignore",
      });
      fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
      `,
    );
    const controller = new AbortController();
    const promise = runProcess({
      command: [process.execPath, script, pidFile],
      cwd: dir,
      timeout: 30,
      cancel: controller.signal,
      logLimit: 4096,
      onUpdate: () => {
        /* ignored */
      },
    });
    // Give the script a moment to spawn its grandchild and write the pid file.
    await waitUntil(() => {
      try {
        JSON.parse(readFileSync(pidFile, "utf8"));
        return true;
      } catch {
        return false;
      }
    });
    controller.abort();
    await expect(promise).rejects.toThrow(ProcessCancelled);

    const { parent, child } = JSON.parse(readFileSync(pidFile, "utf8")) as {
      parent: number;
      child: number;
    };
    await waitUntil(() => !isAlive(parent) && !isAlive(child));
  });

  it("parses PIXEL_PROGRESS lines, keeping only the last one per drained batch", async () => {
    const script = writeScript(
      "progress.cjs",
      `
      console.log("PIXEL_PROGRESS " + JSON.stringify({ completed: 1, total: 10 }));
      console.log("PIXEL_PROGRESS " + JSON.stringify({ completed: 2, total: 10 }));
      console.log("PIXEL_PROGRESS not json");
      console.log("just a log line");
      `,
    );
    const updates: { log: string; progress: ProgressPayload | null }[] = [];
    await runProcess({
      command: [process.execPath, script],
      cwd: dir,
      timeout: 5,
      cancel: noopCancel(),
      logLimit: 4096,
      onUpdate: (log, progress) => updates.push({ log, progress }),
    });
    const progressValues = updates.map((u) => u.progress).filter((p) => p !== null);
    expect(progressValues).toEqual(
      expect.arrayContaining([expect.objectContaining({ completed: 2, total: 10 })]),
    );
    // The malformed "PIXEL_PROGRESS not json" line must never surface as a progress update.
    for (const progress of progressValues) {
      expect(progress).not.toBeNull();
      expect(typeof progress).toBe("object");
    }
  });

  it("caps the rolling log to the last logLimit bytes", async () => {
    const script = writeScript(
      "big.cjs",
      `
      for (let i = 0; i < 50; i++) {
        console.log("X".repeat(50));
      }
      `,
    );
    const logLimit = 100;
    let lastLog = "";
    await runProcess({
      command: [process.execPath, script],
      cwd: dir,
      timeout: 5,
      cancel: noopCancel(),
      logLimit,
      onUpdate: (log) => {
        lastLog = log;
      },
    });
    expect(Buffer.byteLength(lastLog, "utf8")).toBeLessThanOrEqual(logLimit);
    expect(lastLog.endsWith("X".repeat(50) + "\n") || lastLog.endsWith("X".repeat(50))).toBe(true);
  });
});
