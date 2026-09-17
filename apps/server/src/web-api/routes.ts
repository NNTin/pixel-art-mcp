/**
 * New, `/api`-prefixed routes for `apps/web`'s two-pane editor/render IDE -- deliberately not a
 * Python-parity surface (there is no Python web UI; see `docs/typescript-rewrite.md`'s "Web UI"
 * section). Everything here is a thin wrapper around `@pixel-art-mcp/service`'s existing public
 * `Service` methods (`submitScript`, `job`, `getProject`, `revision`, `artifactPath`, ...) plus
 * `../mcp/engine-reference.ts`'s `buildEngineReference` -- no orchestration logic is
 * reimplemented here, matching the phase brief's constraint.
 *
 * Routes:
 * - `GET  /api/projects/:project_id/script`         -- current script text (create-if-absent: an
 *   unconfigured/scriptless project reports `revision_id: null, script: ""` rather than a 404/409,
 *   so the editor always has something to show and "Save & Run" on an empty project creates the
 *   first revision, matching the plan doc's "create-if-absent then edit-in-place" file model).
 * - `POST /api/projects/:project_id/script`         -- submits a new script revision. Thin wrapper
 *   over `Service.submitScript` (same optimistic-concurrency 409 on a stale
 *   `expected_revision_id` that `execute_pixel_script` already has -- the web UI surfaces that as
 *   a conflict banner, per the plan doc, rather than inventing new locking).
 * - `GET  /api/jobs/:job_id`                         -- one-shot job poll (`Service.job`).
 * - `GET  /api/jobs/:job_id/events`                  -- Server-Sent Events progress stream. Per
 *   the plan doc ("no new data model, just a push view of existing job data") and the phase
 *   brief (no job-update event emitter exists in `packages/jobs`/`packages/storage` to subscribe
 *   to), this is a periodic poll-and-diff loop over `Service.job`, not a true event-driven
 *   pub/sub system -- a legitimate, explicitly-sanctioned simple implementation of "progressive
 *   enhancement over polling".
 * - `GET  /api/engine-reference`                     -- the same static content
 *   `get_pixel_engine_reference` (Phase 8) returns, reused as-is (not re-derived) so the
 *   in-browser TS Language Service Worker can build its virtual `@pixel-art-mcp/pixel-core`
 *   `.d.ts` files from the exact same source an MCP agent reads.
 *
 * The "save and render in one action" shape the plan doc leaves open ("your judgment on the exact
 * two-step-vs-one-step shape") is resolved here as two steps, deliberately: `POST .../script`
 * only submits the script job; the client watches it via the SSE endpoint above and, once it
 * succeeds, calls the *existing* (Phase 7) `POST /projects/:project_id/asset/renders` REST route
 * with the new `result_revision_id` to queue the render. This avoids adding a second, blocking,
 * long-running HTTP request here (a script job can legitimately take up to
 * `settings.script_timeout` seconds) and avoids duplicating `submitScript`/`renderAsset`
 * sequencing logic that `Service` doesn't itself provide as one call -- see `apps/web/src/api.ts`
 * for the client-side chaining this enables.
 */

import fs from "node:fs";

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Job } from "@pixel-art-mcp/schema";
import type { Service } from "@pixel-art-mcp/service";
import { z } from "zod";

import { buildEngineReference } from "../mcp/engine-reference.js";
import { nullableUuidParam, uuidParam } from "../mcp/params.js";

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** How often the SSE endpoint re-polls `Service.job` -- matches the plan doc's "poll-first
 * (~500ms)" cadence for the web UI's job polling. */
const SSE_POLL_INTERVAL_MS = 500;

const ScriptBody = z.object({
  script: z.string(),
  expected_revision_id: nullableUuidParam(),
});

/** Reads a project's current script off its current revision's `script_artifact_id`, or reports
 * an empty, revision-less script for a brand-new project -- the "create-if-absent" half of the
 * plan doc's one-script-per-project file model. Reuses `Service.getProject`/`Service.revision`/
 * `Service.artifactPath` rather than reading storage directly. */
function readCurrentScript(
  service: Service,
  projectId: string,
): { project_id: string; revision_id: string | null; script: string } {
  const detail = service.getProject(projectId);
  const revisionId = detail.project.current_revision_id;
  if (revisionId === null) {
    return { project_id: projectId, revision_id: null, script: "" };
  }
  const revision = service.revision(projectId, revisionId);
  const scriptArtifactId = revision["script_artifact_id"] as string | undefined;
  if (scriptArtifactId === undefined) {
    return { project_id: projectId, revision_id: revisionId, script: "" };
  }
  const filePath = service.artifactPath(scriptArtifactId);
  return {
    project_id: projectId,
    revision_id: revisionId,
    script: fs.readFileSync(filePath, "utf8"),
  };
}

export function registerWebApiRoutes(app: FastifyInstance, service: Service): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/projects/:project_id/script",
    { schema: { params: z.object({ project_id: uuidParam() }) } },
    (request) => readCurrentScript(service, request.params.project_id),
  );

  typed.post(
    "/api/projects/:project_id/script",
    {
      schema: {
        params: z.object({ project_id: uuidParam() }),
        body: ScriptBody,
      },
    },
    async (request, reply) => {
      const job = service.submitScript(
        request.params.project_id,
        request.body.script,
        request.body.expected_revision_id,
        false,
      );
      await reply.code(202).send(job);
    },
  );

  typed.get(
    "/api/jobs/:job_id",
    { schema: { params: z.object({ job_id: uuidParam() }) } },
    (request) => service.job(request.params.job_id),
  );

  typed.get("/api/engine-reference", () => buildEngineReference());

  typed.get(
    "/api/jobs/:job_id/events",
    { schema: { params: z.object({ job_id: uuidParam() }) } },
    (request, reply) => {
      const jobId = request.params.job_id;
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let lastPayload: string | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;

      const stop = (): void => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      };

      const tick = (): void => {
        let job: Job;
        try {
          job = service.job(jobId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
          stop();
          return;
        }
        const payload = JSON.stringify(job);
        if (payload !== lastPayload) {
          lastPayload = payload;
          reply.raw.write(`data: ${payload}\n\n`);
        }
        if (TERMINAL_JOB_STATUSES.has(job.status)) {
          stop();
        }
      };

      tick();
      if (!reply.raw.writableEnded) {
        timer = setInterval(tick, SSE_POLL_INTERVAL_MS);
      }
      request.raw.on("close", stop);
    },
  );
}
