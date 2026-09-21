/**
 * The right pane: the current job's status while it runs, and the rendered image once a render
 * job succeeds -- the other half of the two-pane ask (`docs/typescript-rewrite.md`'s "Web UI"
 * section). Renders whichever of `scriptJob`/`renderJob` is currently active; a simple progress
 * bar plus the condensed log tail is enough per the phase brief ("doesn't need to be fancy").
 */

import type { JSX } from "react";

import type { Job } from "../api.js";

export interface RenderPaneProps {
  scriptJob: Job | null;
  renderJob: Job | null;
  imageUrl: string | null;
  statusMessage: string | null;
  errorMessage: string | null;
}

function StatusRow({ label, job }: { label: string; job: Job }): JSX.Element {
  return (
    <div className="status-row">
      <div className="status-row-header">
        <span className="status-label">{label}</span>
        <span className={`status-badge status-${job.status}`}>{job.status}</span>
      </div>
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${String(Math.round(job.progress * 100))}%` }}
        />
      </div>
      <div className="status-stage">{job.stage}</div>
      {job.logs && <pre className="job-logs">{job.logs}</pre>}
      {job.error && <div className="job-error">{job.error}</div>}
    </div>
  );
}

export function RenderPane({
  scriptJob,
  renderJob,
  imageUrl,
  statusMessage,
  errorMessage,
}: RenderPaneProps): JSX.Element {
  return (
    <div className="render-pane">
      {statusMessage && <div className="info-banner">{statusMessage}</div>}
      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      {scriptJob && <StatusRow label="Script" job={scriptJob} />}
      {renderJob && <StatusRow label="Render" job={renderJob} />}
      <div className="image-frame">
        {imageUrl ? (
          <img src={imageUrl} alt="Rendered asset preview" className="rendered-image" />
        ) : (
          <div className="image-placeholder">No render yet -- click "Save &amp; Run".</div>
        )}
      </div>
    </div>
  );
}
