/**
 * Full port of `Store` in `src/pixel_art_mcp/storage/store.py` (229 lines): SQLite schema,
 * path containment, transaction/reentrancy handling, and queue mechanics
 * (insert/claim/update/recover/publish). See `docs/typescript-rewrite.md`'s "Storage" section
 * for the design rationale summarized in the comments below.
 *
 * `node:sqlite` vs. `better-sqlite3`: this package uses Node's built-in `node:sqlite`
 * (`DatabaseSync`), matching the plan doc's primary recommendation. It was verified directly
 * against this repo's Node 22.23.1 toolchain (`docs/typescript-rewrite.md` targets Node 22 LTS):
 * `DatabaseSync` is fully synchronous, supports multi-statement `exec()` (used for the schema
 * script and manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`), prepared statements with
 * `.run()`/`.get()`/`.all()`, `PRAGMA` reads/writes, and throws a catchable `Error` (`code:
 * "ERR_SQLITE_ERROR"`) on constraint violations without corrupting an open transaction -- every
 * property this port needs. The only observable artifact is a one-line
 * `ExperimentalWarning: SQLite is an experimental feature and might change at any time` printed
 * to stderr on first use (the module has been unflagged/usable without `--experimental-sqlite`
 * since Node 22.5, but Node continues to label it experimental through 22 LTS). That warning is
 * cosmetic and does not affect behavior, so the documented `better-sqlite3` fallback was not
 * needed -- switching later would only mean swapping this file's `node:sqlite` import for
 * `better-sqlite3`'s equivalent synchronous API, since nothing above this module depends on
 * `node:sqlite` types directly.
 */

import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DomainError } from "@pixel-art-mcp/schema";

import { identifier, timestamp } from "./ids.js";
import {
  JobPayloadSchema,
  ProjectRowSchema,
  RecordPayloadSchema,
  type JobChanges,
  type JobPayload,
  type ProjectRow,
  type RecordPayload,
} from "./types.js";

const SCHEMA_SCRIPT = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
    current_revision_id TEXT
  );
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_project ON records(project_id, kind);
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    operation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
`;

const SUPPORTED_SCHEMA_VERSIONS = new Set([0, 1]);

interface JobRow {
  id: string;
}

/** Short transactions; only the service process owns the database. */
export class Store {
  readonly root: string;
  private readonly db: DatabaseSync;
  /**
   * Python's `Store` needs a `threading.RLock` because it's genuinely accessed from multiple
   * threads (`check_same_thread=False`). `node:sqlite`'s `DatabaseSync` is fully synchronous and
   * Node is single-threaded, so there is no concurrent access to guard against -- the only thing
   * that can "nest" a transaction is this same call stack re-entering `transaction()` (e.g.
   * `publish()` calling `job()`/`project()`, which themselves don't open transactions, or a
   * future caller composing store methods). This depth counter preserves exactly that
   * reentrancy guard (only the outermost call opens/closes a real `BEGIN`/`COMMIT`) without the
   * mutex, which would be dead weight in a single-threaded runtime.
   */
  private transactionDepth = 0;

  constructor(root: string) {
    this.root = resolveRealish(root);
    mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, "state.sqlite3"));
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA journal_mode=WAL");
    const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (!SUPPORTED_SCHEMA_VERSIONS.has(versionRow.user_version)) {
      throw new Error(`Unsupported database schema ${String(versionRow.user_version)}`);
    }
    this.db.exec(SCHEMA_SCRIPT);
    this.db.exec("PRAGMA user_version=1");
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `fn` inside a transaction, matching Python's `Store.transaction()` context manager:
   * the outermost call opens `BEGIN IMMEDIATE` and commits/rolls back; nested calls just run
   * `fn` inline. See the `transactionDepth` field doc for why no lock is needed here.
   */
  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    const outer = this.transactionDepth === 0;
    if (outer) this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = fn(this.db);
      if (outer) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (outer) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  /**
   * Public transaction wrapper (Phase 6b integration-boundary addition): `packages/service`'s
   * `addReference` needs to atomically write multiple records (three artifacts plus one
   * reference) together, exactly like Python's `Store.transaction()` context manager does when
   * `projects/service.py` calls it directly. The private `transaction()` above already has all
   * the reentrancy-guard behavior this needs -- this just gives an outside caller a way to reach
   * it via a callback instead of a context manager, without exposing the raw `DatabaseSync`.
   */
  runInTransaction<T>(fn: () => T): T {
    return this.transaction(() => fn());
  }

  /**
   * Resolves `relative` against `root` and rejects anything that would escape it (traversal, or
   * a symlink whose target resolves outside `root`) with the same `DomainError` Python raises.
   */
  path(relative: string): string {
    const resolved = resolveRealish(path.join(this.root, relative));
    const rel = path.relative(this.root, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new DomainError("Invalid storage path");
    }
    return resolved;
  }

  project(projectId: string): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
    if (row === undefined) throw new DomainError("Project not found", 404);
    return ProjectRowSchema.parse(row);
  }

  createProject(name: string): ProjectRow {
    const projectId = identifier();
    this.transaction((db) => {
      db.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL)").run(projectId, name, timestamp());
    });
    return this.project(projectId);
  }

  projects(): ProjectRow[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
    return rows.map((row) => ProjectRowSchema.parse(row));
  }

  putRecord(kind: string, record: RecordPayload): void {
    const parsed = RecordPayloadSchema.parse(record);
    this.transaction((db) => {
      db.prepare("INSERT INTO records VALUES (?, ?, ?, ?)").run(
        parsed.id,
        parsed.project_id,
        kind,
        JSON.stringify(parsed),
      );
    });
  }

  record(recordId: string, kind: string): RecordPayload {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE id=? AND kind=?")
      .get(recordId, kind) as { payload: string } | undefined;
    if (row === undefined) {
      const label =
        kind.length > 0 ? kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase() : kind;
      throw new DomainError(`${label} not found`, 404);
    }
    return RecordPayloadSchema.parse(JSON.parse(row.payload));
  }

  records(projectId: string, kind: string): RecordPayload[] {
    const rows = this.db
      .prepare("SELECT payload FROM records WHERE project_id=? AND kind=? ORDER BY rowid")
      .all(projectId, kind) as { payload: string }[];
    return rows.map((row) => RecordPayloadSchema.parse(JSON.parse(row.payload)));
  }

  insertJob(job: JobPayload, maxPending: number): void {
    const parsed = JobPayloadSchema.parse(job);
    this.transaction((db) => {
      const pendingRow = db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')")
        .get() as { n: number };
      if (pendingRow.n >= maxPending) {
        throw new DomainError("Job queue is full; wait for a job to finish", 429);
      }
      db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)").run(
        parsed.id,
        parsed.project_id,
        parsed.operation,
        parsed.status,
        parsed.created_at,
        JSON.stringify(parsed),
      );
    });
  }

  job(jobId: string): JobPayload {
    const row = this.db.prepare("SELECT payload FROM jobs WHERE id=?").get(jobId) as
      { payload: string } | undefined;
    if (row === undefined) throw new DomainError("Job not found", 404);
    return JobPayloadSchema.parse(JSON.parse(row.payload));
  }

  updateJob(jobId: string, changes: JobChanges): JobPayload {
    return this.transaction((db) => {
      const job = { ...this.job(jobId), ...changes };
      const parsed = JobPayloadSchema.parse(job);
      db.prepare("UPDATE jobs SET status=?, payload=? WHERE id=?").run(
        parsed.status,
        JSON.stringify(parsed),
        jobId,
      );
      return parsed;
    });
  }

  claimJob(): JobPayload | null {
    return this.transaction((db) => {
      const row = db
        .prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1")
        .get() as JobRow | undefined;
      if (row === undefined) return null;
      return this.updateJob(row.id, {
        status: "running",
        stage: "starting",
        started_at: timestamp(),
      });
    });
  }

  /** On startup, flips any job left `"running"` by a crashed/killed process to `"failed"`. */
  recover(): void {
    this.transaction((db) => {
      const rows = db
        .prepare("SELECT id FROM jobs WHERE status='running'")
        .all() as unknown as JobRow[];
      for (const row of rows) {
        this.updateJob(row.id, {
          status: "failed",
          stage: "interrupted",
          error: "Service stopped during execution; submit a new job to retry",
          finished_at: timestamp(),
        });
      }
    });
  }

  /**
   * Atomically commits a job's result: guards the job is still `"running"`, optionally
   * re-checks optimistic concurrency against the project's current revision, inserts artifact
   * (and, for a script job, revision) records, and marks the job succeeded -- all in one
   * transaction, matching `Store.publish` in the Python source exactly (including that a
   * mid-transaction failure, e.g. a duplicate artifact id, rolls back the whole publish and
   * leaves the job `"running"`; see this package's `store.test.ts` for that exact scenario).
   */
  publish(jobId: string, artifacts: RecordPayload[], revision?: RecordPayload): void {
    this.transaction((db) => {
      const job = this.job(jobId);
      if (job.status !== "running") {
        throw new DomainError("Job is no longer running", 409);
      }
      if (revision !== undefined) {
        const current = this.project(job.project_id).current_revision_id;
        if (current !== job["input_revision_id"]) {
          throw new DomainError("Scene revision changed; reload the project and retry", 409);
        }
      }
      for (const artifact of artifacts) {
        const parsed = RecordPayloadSchema.parse(artifact);
        db.prepare("INSERT INTO records VALUES (?, ?, 'artifact', ?)").run(
          parsed.id,
          parsed.project_id,
          JSON.stringify(parsed),
        );
      }
      if (revision !== undefined) {
        const parsedRevision = RecordPayloadSchema.parse(revision);
        db.prepare("INSERT INTO records VALUES (?, ?, 'revision', ?)").run(
          parsedRevision.id,
          parsedRevision.project_id,
          JSON.stringify(parsedRevision),
        );
        db.prepare("UPDATE projects SET current_revision_id=? WHERE id=?").run(
          parsedRevision.id,
          job.project_id,
        );
      }
      // One commit publishes the revision, artifacts, and successful job together.
      const updatedJob = {
        ...job,
        status: "succeeded",
        stage: "complete",
        progress: 1.0,
        finished_at: timestamp(),
        artifact_ids: artifacts.map((a) => a.id),
        result_revision_id: revision ? revision.id : null,
      };
      db.prepare("UPDATE jobs SET status='succeeded', payload=? WHERE id=?").run(
        JSON.stringify(updatedJob),
        jobId,
      );
    });
  }
}

/**
 * Approximates Python's `Path.resolve(strict=False)`: fully resolve symlinks for however much of
 * the path already exists on disk, then lexically normalize the remaining (not-yet-existing)
 * segments on top of that. Node's `fs.realpathSync` requires the full path to exist, and
 * `path.resolve` never follows symlinks at all -- neither alone reproduces Python's behavior of
 * "resolve symlinks where possible, so a symlinked ancestor directory can't be used to smuggle a
 * path outside `root`, even for a path (e.g. a future job's scratch directory) that doesn't
 * exist yet." This walks up to the nearest existing ancestor, realpaths that, and rejoins.
 */
function resolveRealish(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    const realParent = resolveRealish(parent);
    return path.join(realParent, path.basename(absolute));
  }
}
