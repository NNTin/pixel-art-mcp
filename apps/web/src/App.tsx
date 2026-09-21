/**
 * Top-level two-pane layout: CodeMirror editor (left, `components/Editor.tsx`) bound to a single
 * project's script, rendered result (right, `components/RenderPane.tsx`) -- the original ask this
 * phase exists for. Per the plan doc's file model (one script per project, create-if-absent,
 * resolved in Phase 8) there is no file tree/project picker: the project is named by a `?project=
 * <uuid>` URL query parameter, matching the phase brief's "open one project (by ID, e.g. via a
 * URL param)" scope -- no project-creation/asset-configuration UI is in scope here (that already
 * exists via the MCP tools/REST routes; an operator configures a project there first, then opens
 * this URL to iterate on its script).
 *
 * Save & Run is two chained steps against the backend (see `apps/server/src/web-api/routes.ts`'s
 * top comment): submit the script, watch it via SSE, and once it succeeds, submit a render for
 * the new revision and watch that too. A 409 from the script submission (a stale
 * `expected_revision_id` -- someone else, human or MCP agent, published a newer revision first)
 * shows `ConflictBanner` instead of silently overwriting.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import {
  ApiError,
  getEngineReference,
  getScript,
  renderAsset,
  saveScript,
  subscribeJobEvents,
  type Job,
} from "./api.js";
import { ConflictBanner } from "./components/ConflictBanner.js";
import { Editor } from "./components/Editor.js";
import { RenderPane } from "./components/RenderPane.js";
import { pickPreviewArtifact } from "./lib/job-output.js";
import { TsWorkerClient } from "./ts-worker/client.js";

function projectIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("project");
}

export function App(): JSX.Element {
  const projectId = useMemo(() => projectIdFromUrl(), []);
  const tsClient = useMemo(() => new TsWorkerClient(), []);

  const [script, setScript] = useState("");
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [scriptJob, setScriptJob] = useState<Job | null>(null);
  const [renderJob, setRenderJob] = useState<Job | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      tsClient.dispose();
    };
  }, [tsClient]);

  useEffect(() => {
    getEngineReference()
      .then((reference) => {
        tsClient.init(reference.type_declarations);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the pixel engine reference for live diagnostics", error);
      });
  }, [tsClient]);

  const loadScript = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const state = await getScript(projectId);
    setScript(state.script);
    setRevisionId(state.revision_id);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setLoadError("No project selected. Open this page with ?project=<project-id> in the URL.");
      return;
    }
    loadScript()
      .then(() => {
        setReady(true);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [projectId, loadScript]);

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
    },
    [],
  );

  const startRender = useCallback(
    (newRevisionId: string) => {
      if (!projectId) return;
      renderAsset(projectId, newRevisionId)
        .then((job) => {
          setRenderJob(job);
          unsubscribeRef.current = subscribeJobEvents(job.id, (updated) => {
            setRenderJob(updated);
            if (updated.status === "succeeded") {
              setImageUrl(pickPreviewArtifact(updated)?.download_url ?? null);
              setStatusMessage(null);
              setBusy(false);
            } else if (updated.status === "failed" || updated.status === "cancelled") {
              setRunError(updated.error ?? "Render did not succeed.");
              setBusy(false);
            }
          });
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 409) {
            // No asset configured yet (or the project moved on again mid-flight) -- the script
            // itself still saved successfully.
            setStatusMessage(
              "Script saved. Configure an asset for this project (e.g. via an MCP client's " +
                "configure_asset) to enable rendering.",
            );
          } else {
            setRunError(error instanceof Error ? error.message : String(error));
          }
          setBusy(false);
        });
    },
    [projectId],
  );

  const handleSaveAndRun = useCallback(() => {
    if (!projectId || busy) return;
    setBusy(true);
    setRunError(null);
    setStatusMessage(null);
    setImageUrl(null);
    setRenderJob(null);
    unsubscribeRef.current?.();

    saveScript(projectId, script, revisionId)
      .then((job) => {
        setScriptJob(job);
        unsubscribeRef.current = subscribeJobEvents(job.id, (updated) => {
          setScriptJob(updated);
          if (updated.status === "succeeded" && updated.result_revision_id) {
            setRevisionId(updated.result_revision_id);
            startRender(updated.result_revision_id);
          } else if (updated.status === "failed" || updated.status === "cancelled") {
            setRunError(updated.error ?? "Script did not run successfully.");
            setBusy(false);
          }
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 409) {
          setConflict(true);
        } else {
          setRunError(error instanceof Error ? error.message : String(error));
        }
        setBusy(false);
      });
  }, [projectId, busy, script, revisionId, startRender]);

  const handleReload = useCallback(() => {
    setConflict(false);
    loadScript().catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [loadScript]);

  if (!projectId || loadError) {
    return (
      <div className="app-shell">
        <div className="load-error">{loadError ?? "No project selected."}</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Pixel Art MCP</h1>
        <span className="project-id">project: {projectId}</span>
        <button type="button" disabled={!ready || busy} onClick={handleSaveAndRun}>
          {busy ? "Running…" : "Save & Run"}
        </button>
      </header>
      {conflict && <ConflictBanner onReload={handleReload} />}
      <main className="two-pane">
        <section className="pane pane-editor">
          <Editor value={script} onChange={setScript} tsClient={tsClient} />
        </section>
        <section className="pane pane-render">
          <RenderPane
            scriptJob={scriptJob}
            renderJob={renderJob}
            imageUrl={imageUrl}
            statusMessage={statusMessage}
            errorMessage={runError}
          />
        </section>
      </main>
    </div>
  );
}
