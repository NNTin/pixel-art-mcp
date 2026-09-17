/**
 * Ported from the generic `records`/`jobs` JSON-blob schema described in
 * `docs/typescript-rewrite.md`'s "Storage" section: the shapes stored here are governed by
 * Zod at the *application* layer (`packages/schema`'s `AssetSpec`/`RenderOptions`/`Job`/etc.),
 * not by this package. `packages/storage` deliberately does not depend on those concrete model
 * types -- it only knows the handful of columns it needs to index/query on (`id`, `project_id`,
 * `operation`, `status`, `created_at`) plus an open-ended JSON payload it trusts callers to have
 * already validated against the real model. This is the "don't over-engineer it" boundary
 * called out in the Phase 4 scope note: adding a hard dependency on every Phase-2 model type
 * here would make `packages/storage` (which must stay usable by `packages/jobs` without pulling
 * in asset/authoring concerns) know about concepts it has no business knowing about.
 *
 * What Zod buys us here, matching the plan doc's "add `safeParse` on read/write where it makes
 * sense": corruption caught at the storage boundary (a hand-edited `state.sqlite3`, a bug in a
 * caller that wrote a malformed row) turns into a clear `DomainError`/`ZodError` at the first
 * read, instead of an `undefined`-shaped object silently propagating deeper into the app.
 */

import { z } from "zod";

export const ProjectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  current_revision_id: z.string().nullable(),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

/**
 * A `records` table payload. `kind` is intentionally not part of this shape -- exactly like
 * `Store.put_record` in the Python source, `kind` is stored as its own column, passed
 * separately by the caller, and never duplicated into the JSON payload itself.
 */
export const RecordPayloadSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
  })
  .loose();
export type RecordPayload = z.infer<typeof RecordPayloadSchema>;

/**
 * A `jobs` table payload. `status` stays a bare `string` rather than a closed enum -- the set of
 * valid statuses (`queued`/`running`/`succeeded`/`failed`/`cancelled`) is owned by
 * `packages/schema`'s `Job` model, and this package only ever compares statuses by string
 * equality (`status === "running"`, `status IN ('queued','running')`), never branches on the
 * full enum. Every other job field (`params`, `stage`, `progress`, `error`, `artifact_ids`, ...)
 * is caller-defined and passed straight through.
 */
export const JobPayloadSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    operation: z.string(),
    status: z.string(),
    created_at: z.string(),
  })
  .loose();
export type JobPayload = z.infer<typeof JobPayloadSchema>;

/** Partial changes merged onto an existing job payload by `Store.updateJob`. */
export type JobChanges = Partial<Omit<JobPayload, "id" | "project_id">> & Record<string, unknown>;
