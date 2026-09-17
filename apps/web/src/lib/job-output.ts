/**
 * Picks the render pane's preview image out of a succeeded `sprites` job's `outputs` map. Split
 * out of `App.tsx` as a pure function so it's covered by a plain `vitest` unit test rather than a
 * component test. `Job.outputs` (`packages/service/src/service.ts`'s `job()`) is keyed by each
 * top-level artifact's `export_path` -- `preview.html`'s sibling `preview.png`
 * (`packages/imaging/src/asset-export.ts`) is the composite comparison image every `sprites`
 * render produces; `spritesheet.png` is the raw packed sheet, kept as a fallback for a render
 * whose `preview.png` step didn't run for some reason, rather than showing nothing.
 */

import type { Job } from "../api.js";

export function pickPreviewArtifact(job: Job): Job["outputs"][string] | null {
  return job.outputs["preview.png"] ?? job.outputs["spritesheet.png"] ?? null;
}
