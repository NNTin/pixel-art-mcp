/**
 * Fetch wrappers for the backend surface `App.tsx` drives: the new `/api/*` web-IDE routes
 * (`apps/server/src/web-api/routes.ts`) plus the one existing (Phase 7) REST route this reuses
 * unchanged -- `POST /projects/:id/asset/renders` -- for the render half of "Save & Run" (see
 * that routes file's top comment for why triggering a render is a second, client-driven step
 * instead of something the script-submission endpoint does itself).
 *
 * All requests are same-origin (`apps/web`'s build output is served from the same Fastify app,
 * per the plan doc's "Web UI" section), so no base URL configuration is needed.
 */

export interface Artifact {
  id: string;
  filename: string;
  media_type: string;
  download_url: string;
  [key: string]: unknown;
}

export interface Job {
  id: string;
  project_id: string;
  operation: "script" | "preview" | "sprites";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  stage: string;
  logs: string;
  error: string | null;
  result_revision_id: string | null;
  artifacts: Artifact[];
  outputs: Record<string, Artifact>;
}

export interface ScriptState {
  project_id: string;
  revision_id: string | null;
  script: string;
}

export interface EngineReference {
  type_declarations: string;
  examples: { title: string; description: string; code: string }[];
  guidance: string;
}

/** Thrown for any non-2xx response; carries the HTTP status so callers can special-case 409
 * (the optimistic-concurrency conflict `Service.submitScript`/`Service.renderAsset` already
 * raise) without string-matching an error message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body -- fall back to statusText.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export function getScript(projectId: string): Promise<ScriptState> {
  return fetch(`/api/projects/${projectId}/script`).then((r) => asJson<ScriptState>(r));
}

export function saveScript(
  projectId: string,
  script: string,
  expectedRevisionId: string | null,
): Promise<Job> {
  return fetch(`/api/projects/${projectId}/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, expected_revision_id: expectedRevisionId }),
  }).then((r) => asJson<Job>(r));
}

export function getJob(jobId: string): Promise<Job> {
  return fetch(`/api/jobs/${jobId}`).then((r) => asJson<Job>(r));
}

/** Reuses the existing (Phase 7) REST render route unchanged -- see this file's top comment. */
export function renderAsset(projectId: string, revisionId: string): Promise<Job> {
  return fetch(
    `/projects/${projectId}/asset/renders?revision_id=${encodeURIComponent(revisionId)}`,
    { method: "POST" },
  ).then((r) => asJson<Job>(r));
}

export function getEngineReference(): Promise<EngineReference> {
  return fetch(`/api/engine-reference`).then((r) => asJson<EngineReference>(r));
}

/**
 * Subscribes to `GET /api/jobs/:id/events` (SSE). `onUpdate` fires for every job snapshot the
 * server pushes; the subscription closes itself (both the `EventSource` and, per `onUpdate`'s own
 * return contract, the caller's interest) the moment a terminal status arrives -- matching the
 * server's own "poll-and-diff, stop at a terminal status" contract (see that route's doc
 * comment). Returns an unsubscribe function for early cleanup (e.g. the component unmounting).
 */
export function subscribeJobEvents(jobId: string, onUpdate: (job: Job) => void): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
  source.onmessage = (event: MessageEvent<string>) => {
    const job = JSON.parse(event.data) as Job;
    onUpdate(job);
    if (TERMINAL.has(job.status)) {
      source.close();
    }
  };
  source.onerror = () => {
    // A network hiccup or the server ending the stream after its own final frame; either way
    // there is nothing meaningful to retry into (a fresh EventSource would just replay the poll
    // loop for a job that's already terminal in the common case), so just stop listening instead
    // of letting the browser's default auto-reconnect spin against a finished job.
    source.close();
  };
  return () => {
    source.close();
  };
}
