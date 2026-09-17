/**
 * Port of `scripts/pixel_index_packaging.py`'s `split_multi_clip_zip`. Splits a multi-clip
 * furniture package zip into one independent zip per clip.
 *
 * Used by `index.ts` (writes each clip's zip alongside the example's other outputs and links it
 * from the gallery) -- the same one thing `scripts/generate_examples.py` used it for. Python's
 * sibling consumer, `scripts/publish_examples_to_pixel_index.py`, is out of scope for this port
 * (see this phase's final report).
 *
 * `imaging/asset_export.py` (`@pixel-art-mcp/imaging`'s TS port) gives each named clip of a
 * multi-clip furniture asset (e.g. the `rain-barrel` example's empty/partial/full states,
 * `thermometer`'s cold/room/hot) its own asset id and its own `manifest.json`, all packaged
 * together in one `pixel-agents.zip`. pixel-index's ingestion contract rejects any upload
 * containing more than one `manifest.json`, so a multi-clip zip splits back into one independent
 * zip per top-level `manifest.json`, preserving every entry's original path.
 *
 * Uses `fflate` (`unzipSync`/`zipSync`), matching `@pixel-art-mcp/imaging`'s `pack-zip.ts` choice
 * of zip library.
 */

import { unzipSync, zipSync, type Unzipped } from "fflate";

export interface Clip {
  readonly assetId: string;
  readonly name: string;
  readonly data: Uint8Array;
}

interface Manifest {
  readonly id: string;
  readonly name: string;
}

/** `[]` if `data` has at most one `manifest.json` (nothing to split). Otherwise, one `Clip` per
 * `manifest.json` found, each a standalone zip of that clip's own entries at their original
 * paths. */
export function splitMultiClipZip(data: Uint8Array): Clip[] {
  const archive: Unzipped = unzipSync(data);
  const names = Object.keys(archive);
  const manifestPaths = names.filter((name) => name.endsWith("manifest.json"));
  if (manifestPaths.length <= 1) return [];

  // Longest dir prefix first, so an entry lands in the most specific manifest's group even if
  // manifests were ever nested (they are not, today, but this stays correct if that ever
  // changes) -- mirrors Python's `sorted(..., key=len, reverse=True)`.
  const dirs = manifestPaths
    .map((manifestPath) => manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1))
    .sort((a, b) => b.length - a.length);

  const clips: Clip[] = [];
  for (const clipDir of dirs) {
    const entryNames = names.filter((name) => name.startsWith(clipDir));
    const manifestBytes = archive[`${clipDir}manifest.json`];
    if (!manifestBytes) continue;
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf-8")) as Manifest;
    const entries: Record<string, Uint8Array> = {};
    for (const name of entryNames) {
      const bytes = archive[name];
      if (bytes) entries[name] = bytes;
    }
    clips.push({ assetId: manifest.id, name: manifest.name, data: zipSync(entries) });
  }
  return clips;
}
