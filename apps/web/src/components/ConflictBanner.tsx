/**
 * Surfaces `Service.submitScript`'s existing optimistic-concurrency 409 (a stale
 * `expected_revision_id`) as a plain "changed elsewhere, reload?" banner -- per the plan doc's
 * "Web UI" section, deliberately not a new locking/presence system, just a read of the same
 * conflict `execute_pixel_script` already raises for an MCP agent.
 */

import type { JSX } from "react";

export interface ConflictBannerProps {
  onReload: () => void;
}

export function ConflictBanner({ onReload }: ConflictBannerProps): JSX.Element {
  return (
    <div className="conflict-banner" role="alert">
      <span>This project's script was changed elsewhere (its revision moved on).</span>
      <button type="button" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}
