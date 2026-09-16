import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { identifier, Store, timestamp } from "./index.js";

// End-to-end smoke test of the package's public surface (the individual behaviors below are
// covered in depth by store.test.ts) -- this just proves the re-exports in index.ts actually
// wire a project -> job -> publish flow together the way a real caller would use them.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-storage-index-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("@pixel-art-mcp/storage public surface", () => {
  it("creates a project, queues + claims + publishes a job through the exported Store", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    const jobId = identifier();
    store.insertJob(
      {
        id: jobId,
        project_id: project.id,
        operation: "script",
        status: "queued",
        created_at: timestamp(),
        input_revision_id: null,
      },
      32,
    );
    const claimed = store.claimJob();
    expect(claimed?.id).toBe(jobId);
    store.publish(jobId, [{ id: identifier(), project_id: project.id }]);
    expect(store.job(jobId).status).toBe("succeeded");
    store.close();
  });
});
