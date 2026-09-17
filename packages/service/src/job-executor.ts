/**
 * Port of `Worker.execute()` in `src/pixel_art_mcp/jobs/worker.py` (lines 77-236): the real
 * `JobExecutor` that fills `packages/jobs`' `Worker` seam from Phase 4. This is the load-bearing
 * integration of the whole phase -- for each claimed job it builds scratch directories, writes
 * `packages/engine`'s `request.json` contract, spawns the compiled engine subprocess via
 * `packages/jobs`' `runProcess`, reads back `result.json`, hands a render job's manifest to
 * `packages/imaging`'s `exportSheet`, walks the staged output into artifact records, and commits
 * everything through `packages/storage`'s `Store.publish` -- all inside one `try/catch/finally`
 * that must never let an exception escape (see `packages/jobs/src/worker.ts`'s own doc comment on
 * exactly why that guarantee matters: an escaped exception halts the *entire* worker loop, not
 * just this one job).
 *
 * **Resolving the engine subprocess entrypoint.** `@pixel-art-mcp/engine`'s `package.json` only
 * publishes `.` (`dist/index.js`) -- there is no dedicated export for `dist/runner.js`, the actual
 * CLI entrypoint `packages/jobs`' `runProcess` needs a real filesystem path to spawn. This resolves
 * `@pixel-art-mcp/engine`'s real `dist/index.js` location through normal Node module resolution
 * (so it works identically whether this package is running from `src/` under a test runner or
 * from an installed `dist/`), then takes `runner.js` as a sibling file in that same `dist/`
 * directory -- mirroring exactly how `packages/engine`'s own `runner.e2e.test.ts` locates its
 * compiled CLI (see that file's `RUNNER_JS` constant), just resolved across a package boundary
 * instead of within the same package. Uses `createRequire(import.meta.url).resolve(...)` rather
 * than `import.meta.resolve` -- the latter is a real, synchronous, unflagged Node 20.6+ API under
 * plain `node`, but this package's own test suite runs under vitest/vite-node, whose `import.meta`
 * shim does not implement `.resolve` (confirmed empirically: `__vite_ssr_import_meta__.resolve is
 * not a function`); `createRequire` is a genuine Node core API vite-node doesn't intercept, so it
 * behaves identically in both the test runner and a real compiled deployment.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { EngineOperation, EngineRequest } from "@pixel-art-mcp/engine";
import { exportSheet, angleWidths, type RenderManifestLike } from "@pixel-art-mcp/imaging";
import { ProcessCancelled, ProcessFailure, runProcess, type JobExecutor } from "@pixel-art-mcp/jobs";
import { DomainError, RenderOptionsSchema } from "@pixel-art-mcp/schema";
import { identifier, timestamp, type JobChanges, type JobPayload, type RecordPayload } from "@pixel-art-mcp/storage";

import { readImageDimensions } from "./media-type.js";
import { validateAuthoredArt } from "./pixel-authoring.js";
import type { Service } from "./service.js";

/** Thrown internally to route a mid-job cancellation (observed via `cancel.aborted` after
 * `runProcess` resolves successfully, or before the final publish) through the same catch/finally
 * handling as `ProcessCancelled` -- mirroring Python's `raise asyncio.CancelledError` at the same
 * two checkpoints in `Worker.execute()`. */
class JobCancelledError extends Error {
  constructor() {
    super("Job was cancelled");
    this.name = "JobCancelledError";
  }
}

const requireFromHere = createRequire(import.meta.url);

function resolveEngineRunnerPath(): string {
  const indexPath = requireFromHere.resolve("@pixel-art-mcp/engine");
  return path.join(path.dirname(indexPath), "runner.js");
}

let cachedRunnerPath: string | null = null;
function engineRunnerPath(): string {
  cachedRunnerPath ??= resolveEngineRunnerPath();
  return cachedRunnerPath;
}

interface ScriptResultShape {
  summary: { pixel_art: Record<string, unknown> | null };
}

function jobErrorMessage(error: unknown): string {
  if (error instanceof DomainError || error instanceof ProcessFailure) {
    return error.message;
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `${name}: job output could not be processed; inspect logs`;
}

/**
 * Reads `signal.aborted` through an opaque function call rather than inline. `cancel` can be
 * aborted at any time by a concurrent call from outside this async function (`Worker.cancel()`/
 * `Worker.stop()`, see `packages/jobs/src/worker.ts`) -- real, externally-driven mutation
 * TypeScript's control-flow narrowing has no way to see, so without this indirection strict-mode
 * lint (`@typescript-eslint/no-unnecessary-condition`) wrongly concludes a second `cancel.aborted`
 * check later in the same function is statically always-false, having "seen" an earlier
 * `if (cancel.aborted) throw ...` with no visible intervening write. Both checkpoints are real:
 * Python's `Worker.execute()` likewise re-checks `cancel.is_set()` at both the same two points
 * (right after the subprocess exits, and right before the final publish-directory rename).
 */
function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function walkFilesSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  out.sort();
  return out;
}

/**
 * Builds the real `JobExecutor` `packages/jobs`' `Worker` runs. Takes the owning `Service` so it
 * can reuse `revision`/`artifactPath`/`artifactRecord` (avoiding reimplementing project/revision
 * lookups or the artifact-record shape a second time) and `workerReady` (to distinguish "this
 * specific job was cancelled" from "the whole worker is stopping" -- see the cancellation
 * handling below).
 */
export function createJobExecutor(service: Service): JobExecutor {
  return async (job: JobPayload, cancel: AbortSignal): Promise<void> => {
    const store = service.store;
    const jobId = job.id;
    const projectId = job.project_id;
    const scratch = store.path(`tmp/${jobId}`);
    const raw = path.join(scratch, "raw");
    const staged = path.join(scratch, "publish");
    const final = store.path(`projects/${projectId}/jobs/${jobId}`);

    try {
      fs.mkdirSync(scratch, { recursive: true });
      fs.mkdirSync(staged);

      const revisionId = (job["input_revision_id"] as string | null) ?? null;
      const params = (job["params"] as Record<string, unknown> | undefined) ?? {};

      let scriptPath: string | null = null;
      if (job.operation === "script") {
        if (store.project(projectId).current_revision_id !== revisionId) {
          throw new DomainError("Scene revision changed while queued; reload project and retry");
        }
        scriptPath = path.join(scratch, "submitted.ts");
        fs.writeFileSync(scriptPath, (params["script"] as string | undefined) ?? "", "utf8");
        fs.copyFileSync(scriptPath, path.join(staged, "script.ts"));
      }

      let inputState: string | null = null;
      let pixelArt: Record<string, unknown> | null = null;
      if (revisionId) {
        const revision = service.revision(projectId, revisionId);
        if (job.operation === "script") {
          inputState = service.artifactPath(revision["state_artifact_id"] as string);
        } else {
          const summary = revision["summary"] as Record<string, unknown>;
          pixelArt = (summary["pixel_art"] as Record<string, unknown> | null) ?? null;
        }
      }

      const references: Record<string, string> = {};
      for (const reference of store.records(projectId, "reference")) {
        references[reference.id] = reference["image_path"] as string;
      }

      // Only the request-bound copy of `options` is augmented -- the copy still stored under
      // `params.options` (used below, unaugmented, for the real `exportSheet` call) is left
      // untouched, matching `worker.py`'s own local-variable shadowing exactly.
      let requestOptions = (params["options"] as Record<string, unknown> | undefined) ?? null;
      if (requestOptions?.["pet"]) {
        requestOptions = {
          ...requestOptions,
          angle_widths: angleWidths(
            requestOptions["width"] as number,
            requestOptions["angles"] as number[],
          ),
        };
      }

      const request: EngineRequest = {
        schema_version: 1,
        operation: job.operation as EngineOperation,
        input_state: inputState,
        pixel_art: pixelArt as EngineRequest["pixel_art"],
        output_dir: raw,
        script_path: scriptPath,
        references,
        options: requestOptions,
        authoring_options: (params["authoring_options"] as Record<string, unknown> | null | undefined) ?? null,
        pixel_art_required: (params["pixel_art_required"] as boolean | undefined) ?? false,
      };
      const requestPath = path.join(scratch, "request.json");
      fs.writeFileSync(requestPath, JSON.stringify(request), "utf8");

      const command = [process.execPath, engineRunnerPath(), requestPath];
      const timeout =
        job.operation === "script" ? service.settings.script_timeout : service.settings.render_timeout;

      await runProcess({
        command,
        cwd: scratch,
        timeout,
        cancel,
        logLimit: service.settings.max_log_bytes,
        onUpdate: (log: string, progress: Record<string, unknown> | null) => {
          const changes: JobChanges = { logs: log };
          if (progress && !isCancelled(cancel)) {
            const completed = Number(progress["completed"]);
            const total = Number(progress["total"]);
            if (Number.isFinite(completed) && Number.isFinite(total)) {
              const fraction = completed / Math.max(total, 1);
              changes["progress"] = Math.min(0.9, Math.max(0, fraction * 0.9));
              changes["stage"] = "rendering";
            }
          }
          store.updateJob(jobId, changes);
        },
      });

      if (isCancelled(cancel)) throw new JobCancelledError();

      const resultPath = path.join(raw, "result.json");
      if (!fs.existsSync(resultPath) || fs.statSync(resultPath).size > 16 * 1024 * 1024) {
        throw new ProcessFailure("Script did not return a valid result manifest");
      }
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;

      let newRevision: RecordPayload | undefined;
      if (job.operation === "script") {
        const scriptResult = result as unknown as ScriptResultShape;
        const data = scriptResult.summary.pixel_art;
        const authoringOptions = params["authoring_options"] as Record<string, unknown> | null | undefined;
        if (data !== null) {
          if (!authoringOptions) {
            throw new DomainError("Call configure_asset before authoring pixel layers");
          }
          validateAuthoredArt(data, RenderOptionsSchema.parse(authoringOptions));
        } else if (params["pixel_art_required"]) {
          throw new DomainError("An edit cannot remove the required pixel-art definition");
        }
        const statePath = path.join(raw, "state.json");
        if (!fs.existsSync(statePath)) {
          throw new ProcessFailure("Script did not produce a saved scene state");
        }
        fs.copyFileSync(statePath, path.join(staged, "state.json"));
        fs.writeFileSync(
          path.join(staged, "summary.json"),
          JSON.stringify(scriptResult.summary, null, 2),
          "utf8",
        );
      } else {
        store.updateJob(jobId, { stage: "converting", progress: 0.9 });
        const options = RenderOptionsSchema.parse(params["options"]);
        exportSheet(raw, staged, result as unknown as RenderManifestLike, options, projectId, String(revisionId));
      }

      if (isCancelled(cancel)) throw new JobCancelledError();

      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.renameSync(staged, final);

      const artifacts: RecordPayload[] = [];
      for (const filePath of walkFilesSorted(final)) {
        let width: number | null = null;
        let height: number | null = null;
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".png" || ext === ".apng" || ext === ".gif") {
          const dimensions = readImageDimensions(filePath);
          width = dimensions?.width ?? null;
          height = dimensions?.height ?? null;
        }
        const parentName = path.basename(path.dirname(filePath));
        let kind = parentName === "frames" ? "frame" : path.basename(filePath, path.extname(filePath));
        if (parentName === "animations") kind = "animation";
        else if (path.basename(filePath) === "preview.html") kind = "player";
        artifacts.push(service.artifactRecord(projectId, filePath, kind, jobId, width, height));
      }

      if (job.operation === "script") {
        const byName = new Map(artifacts.map((artifact) => [artifact["filename"] as string, artifact]));
        const stateArtifact = byName.get("state.json");
        const scriptArtifact = byName.get("script.ts");
        if (!stateArtifact || !scriptArtifact) {
          throw new Error("Invariant violated: expected state.json/script.ts artifacts after a script job");
        }
        newRevision = {
          id: identifier(),
          project_id: projectId,
          parent_id: revisionId,
          created_at: timestamp(),
          state_artifact_id: stateArtifact.id,
          script_artifact_id: scriptArtifact.id,
          summary: (result as unknown as ScriptResultShape).summary,
        };
      }

      store.publish(jobId, artifacts, newRevision);
    } catch (error) {
      if (error instanceof ProcessCancelled || error instanceof JobCancelledError) {
        const stopping = !service.workerReady;
        store.updateJob(jobId, {
          status: stopping ? "failed" : "cancelled",
          stage: stopping ? "interrupted" : "cancelled",
          error: stopping ? "Service stopped during execution" : null,
          finished_at: timestamp(),
        });
      } else {
        store.updateJob(jobId, {
          status: "failed",
          stage: "failed",
          error: jobErrorMessage(error),
          finished_at: timestamp(),
        });
      }
    } finally {
      try {
        if (store.job(jobId).status !== "succeeded" && fs.existsSync(final)) {
          fs.rmSync(final, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup, matching Python's `contextlib.suppress(FileNotFoundError)` scope.
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
}
