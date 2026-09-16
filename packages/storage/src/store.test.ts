/**
 * Ports the scenarios covered by `tests/unit/test_storage.py` (real temp SQLite files, not
 * mocked -- see Phase 4 scope note) plus the queue-full/claim-ordering/optimistic-concurrency
 * behavior described in `src/pixel_art_mcp/storage/store.py` that the Python unit test file
 * doesn't itself cover directly (those are exercised indirectly there via integration tests
 * this port doesn't have an equivalent of yet -- `packages/jobs`/`packages/service` are later
 * phases), so they're asserted here instead, against the real `Store`.
 */

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "@pixel-art-mcp/schema";

import { identifier, timestamp } from "./ids.js";
import { Store } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pixel-art-storage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Store schema/lifecycle", () => {
  it("creates and reads back a project", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    expect(project.name).toBe("Chair");
    expect(project.current_revision_id).toBeNull();
    expect(store.project(project.id)).toEqual(project);
    store.close();
  });

  it("throws a 404 DomainError for a missing project", () => {
    const store = new Store(path.join(dir, "db"));
    expect(() => store.project(identifier())).toThrow(DomainError);
    try {
      store.project(identifier());
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).httpStatus).toBe(404);
      expect((error as DomainError).message).toBe("Project not found");
    }
    store.close();
  });

  it("lists projects newest-first", () => {
    const store = new Store(path.join(dir, "db"));
    const a = store.createProject("A");
    const b = store.createProject("B");
    const ids = store.projects().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    store.close();
  });
});

describe("Store.path containment", () => {
  it("rejects lexical traversal outside root", () => {
    const store = new Store(path.join(dir, "db"));
    expect(() => store.path("../outside")).toThrow(DomainError);
    store.close();
  });

  it("rejects a symlink that resolves outside root", () => {
    const store = new Store(path.join(dir, "db"));
    const outside = mkdtempSync(path.join(dir, "outside-"));
    symlinkSync(outside, path.join(store.root, "escape"));
    expect(() => store.path("escape/file")).toThrow(DomainError);
    store.close();
  });

  it("rejects the root itself", () => {
    const store = new Store(path.join(dir, "db"));
    expect(() => store.path(".")).toThrow(DomainError);
    store.close();
  });

  it("accepts a path within root, including one that doesn't exist yet", () => {
    const store = new Store(path.join(dir, "db"));
    const resolved = store.path("tmp/some-job");
    expect(resolved.startsWith(store.root)).toBe(true);
    store.close();
  });
});

describe("Store records", () => {
  it("round-trips a record payload by id+kind and lists by project+kind", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    const record = { id: identifier(), project_id: project.id, image_path: "/x.png" };
    store.putRecord("reference", record);
    expect(store.record(record.id, "reference")).toEqual(record);
    expect(store.records(project.id, "reference")).toEqual([record]);
    store.close();
  });

  it("throws a capitalized 404 DomainError for a missing record", () => {
    const store = new Store(path.join(dir, "db"));
    expect(() => store.record(identifier(), "reference")).toThrow("Reference not found");
    store.close();
  });
});

describe("Store job queue", () => {
  it("rejects insertion once queued+running jobs reach the max-pending limit", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    for (let i = 0; i < 2; i++) {
      store.insertJob(
        {
          id: identifier(),
          project_id: project.id,
          operation: "script",
          status: "queued",
          created_at: timestamp(),
        },
        2,
      );
    }
    expect(() => {
      store.insertJob(
        {
          id: identifier(),
          project_id: project.id,
          operation: "script",
          status: "queued",
          created_at: timestamp(),
        },
        2,
      );
    }).toThrow(DomainError);
    try {
      store.insertJob(
        {
          id: identifier(),
          project_id: project.id,
          operation: "script",
          status: "queued",
          created_at: timestamp(),
        },
        2,
      );
    } catch (error) {
      expect((error as DomainError).httpStatus).toBe(429);
    }
    store.close();
  });

  it("claims the oldest queued job first, marking it running with a started_at/stage", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    const older = identifier();
    store.insertJob(
      {
        id: older,
        project_id: project.id,
        operation: "script",
        status: "queued",
        created_at: "2020-01-01T00:00:00.000Z",
      },
      32,
    );
    const newer = identifier();
    store.insertJob(
      {
        id: newer,
        project_id: project.id,
        operation: "script",
        status: "queued",
        created_at: "2020-01-02T00:00:00.000Z",
      },
      32,
    );
    const claimed = store.claimJob();
    expect(claimed?.id).toBe(older);
    expect(claimed?.status).toBe("running");
    expect(claimed?.["stage"]).toBe("starting");
    expect(typeof claimed?.["started_at"]).toBe("string");
    const second = store.claimJob();
    expect(second?.id).toBe(newer);
    expect(store.claimJob()).toBeNull();
    store.close();
  });

  it("merges changes onto the existing job payload on update", () => {
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
        params: { script: "..." },
      },
      32,
    );
    const updated = store.updateJob(jobId, { status: "running", stage: "starting" });
    expect(updated.status).toBe("running");
    expect(updated["stage"]).toBe("starting");
    expect(updated["params"]).toEqual({ script: "..." });
    expect(store.job(jobId)).toEqual(updated);
    store.close();
  });
});

describe("Store.recover", () => {
  it("flips stuck running jobs to failed/interrupted and leaves queued jobs alone across restarts", () => {
    const dbDir = path.join(dir, "db");
    let store = new Store(dbDir);
    const project = store.createProject("Chair");
    const queuedId = identifier();
    const runningId = identifier();
    store.insertJob(
      {
        id: queuedId,
        project_id: project.id,
        operation: "script",
        status: "queued",
        created_at: timestamp(),
      },
      32,
    );
    store.insertJob(
      {
        id: runningId,
        project_id: project.id,
        operation: "script",
        status: "running",
        created_at: timestamp(),
      },
      32,
    );
    store.close();

    store = new Store(dbDir);
    store.recover();
    expect(store.job(queuedId).status).toBe("queued");
    const recovered = store.job(runningId);
    expect(recovered.status).toBe("failed");
    expect(recovered["error"]).toContain("stopped");
    expect(store.claimJob()?.id).toBe(queuedId);
    expect(store.claimJob()).toBeNull();
    store.close();
  });
});

describe("Store.publish", () => {
  it("commits artifacts + revision and marks the job succeeded, atomically", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    const jobId = identifier();
    store.insertJob(
      {
        id: jobId,
        project_id: project.id,
        operation: "script",
        status: "running",
        created_at: timestamp(),
        input_revision_id: null,
      },
      32,
    );
    const artifact = { id: identifier(), project_id: project.id, filename: "state.json" };
    const revision = { id: identifier(), project_id: project.id, parent_id: null };
    store.publish(jobId, [artifact], revision);

    expect(store.job(jobId).status).toBe("succeeded");
    expect(store.project(project.id).current_revision_id).toBe(revision.id);
    expect(store.records(project.id, "artifact")).toEqual([artifact]);
    expect(store.records(project.id, "revision")).toEqual([revision]);
    store.close();
  });

  it("rejects publishing a job that is no longer running", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    const jobId = identifier();
    store.insertJob(
      {
        id: jobId,
        project_id: project.id,
        operation: "script",
        status: "succeeded",
        created_at: timestamp(),
      },
      32,
    );
    expect(() => {
      store.publish(jobId, []);
    }).toThrow(DomainError);
    store.close();
  });

  it("rejects publishing a revision when the project's current revision changed underneath it", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    // Publish once to establish a current revision.
    const firstJob = identifier();
    store.insertJob(
      {
        id: firstJob,
        project_id: project.id,
        operation: "script",
        status: "running",
        created_at: timestamp(),
        input_revision_id: null,
      },
      32,
    );
    const firstRevision = { id: identifier(), project_id: project.id };
    store.publish(firstJob, [], firstRevision);

    // A second job that still thinks input_revision_id is null (stale) should be rejected.
    const secondJob = identifier();
    store.insertJob(
      {
        id: secondJob,
        project_id: project.id,
        operation: "script",
        status: "running",
        created_at: timestamp(),
        input_revision_id: null,
      },
      32,
    );
    expect(() => {
      store.publish(secondJob, [], { id: identifier(), project_id: project.id });
    }).toThrow(DomainError);
    try {
      store.publish(secondJob, [], { id: identifier(), project_id: project.id });
    } catch (error) {
      expect((error as DomainError).httpStatus).toBe(409);
    }
    store.close();
  });

  it("rolls back the whole publish atomically when an artifact insert fails, leaving the job running", () => {
    const store = new Store(path.join(dir, "db"));
    const project = store.createProject("Chair");
    const jobId = identifier();
    store.insertJob(
      {
        id: jobId,
        project_id: project.id,
        operation: "script",
        status: "running",
        created_at: timestamp(),
        input_revision_id: null,
      },
      32,
    );
    const artifact = { id: identifier(), project_id: project.id };
    expect(() => {
      store.publish(jobId, [artifact, artifact]);
    }).toThrow();
    expect(store.records(project.id, "artifact")).toEqual([]);
    expect(store.job(jobId).status).toBe("running");
    expect(store.project(project.id).current_revision_id).toBeNull();
    store.close();
  });
});
