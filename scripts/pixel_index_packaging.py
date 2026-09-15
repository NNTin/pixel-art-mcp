"""Splits a multi-clip furniture package zip into one independent zip per clip.

Shared by `scripts/generate_examples.py` (writes each clip's zip alongside the
example's other outputs and links it from the gallery) and
`scripts/publish_examples_to_pixel_index.py` (uploads each clip separately).

`imaging/asset_export.py` gives each named clip of a multi-clip furniture asset
(e.g. the `rain-barrel` example's empty/partial/full states, `thermometer`'s
cold/room/hot) its own asset id and its own `manifest.json`, all packaged
together in one `pixel-agents.zip` -- intentional, and exactly what a native
Pixel Agents install (`webview-ui/public`) expects: each clip is independently
placeable furniture, not a hidden state of one item.

pixel-index's ingestion contract has no equivalent of that: `findNamedTextEntry`
(`services/api/src/assets/zip.ts` in pixel-agents-hq/index) rejects any upload
containing more than one `manifest.json`, by design -- one upload is one catalog
entry. There is no grouped-variant concept upstream today for one catalog entry
to offer multiple selectable clips, so the bundled `pixel-agents.zip` is correct
for a native install but not directly uploadable to pixel-index.

Rather than changing either side's contract to work around that mismatch, this
module treats the two as compatible at the packaging level: a multi-clip zip
splits back into one independent zip per top-level `manifest.json`, preserving
every entry's original path so pixel-index's own manifest-relative file
resolution still works unmodified. A three-clip rain barrel becomes three
separate pixel-index catalog listings (RAIN_BARREL_EMPTY / _PARTIAL / _FULL)
instead of one -- a real, deliberate product-shape decision, not a technical
shortcut, and the right one until/unless pixel-index grows a grouped-variant
concept of its own.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from zipfile import ZipFile


@dataclass(frozen=True)
class Clip:
    asset_id: str
    name: str
    data: bytes


def split_multi_clip_zip(data: bytes) -> list[Clip]:
    """`[]` if `data` has at most one `manifest.json` (nothing to split -- it is
    already a single, directly uploadable pixel-index asset). Otherwise, one
    `Clip` per `manifest.json` found, each a standalone zip of that clip's own
    entries at their original paths."""
    with ZipFile(io.BytesIO(data)) as archive:
        manifest_paths = [name for name in archive.namelist() if name.endswith("manifest.json")]
        if len(manifest_paths) <= 1:
            return []

        # Longest dir prefix first, so an entry lands in the most specific
        # manifest's group even if manifests were ever nested (they are not,
        # today, but this stays correct if that ever changes).
        dirs = sorted((p.rsplit("/", 1)[0] + "/" for p in manifest_paths), key=len, reverse=True)
        clips = []
        for clip_dir in dirs:
            names = [n for n in archive.namelist() if n.startswith(clip_dir)]
            manifest = json.loads(archive.read(f"{clip_dir}manifest.json"))
            buffer = io.BytesIO()
            with ZipFile(buffer, "w") as clip_zip:
                for name in names:
                    clip_zip.writestr(name, archive.read(name))
            clips.append(Clip(manifest["id"], manifest["name"], buffer.getvalue()))
        return clips
