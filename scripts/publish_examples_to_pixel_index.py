"""Publish every example's real package zip to a running pixel-index instance.

Consumer-driven contract/integration test (issue #8's real-upload follow-up,
`docs/contract-testing.md`): unlike `contracts/pixel_index/`, which only checks the
*shape* of a manifest against a live schema, this actually calls
`POST /api/v1/assets` on a pixel-index this repo's own CI just stood up from
`vendor/pixel-index` (`.github/workflows/pixel-index-publish-check.yml`), so a
pass means "pixel-index's real decode/ingest logic accepted this exact zip",
not just "the manifest matches the schema".

Reads `examples/asset-specs.json`-driven output from `scripts/generate_examples.py`
(one folder per example, each holding its installable `pixel-agents.zip`,
`pixel-agents-character.zip`, or `pixel-agents-pet.zip`).

## Multi-clip furniture becomes multiple uploads

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
to offer multiple selectable clips.

Rather than changing either side's contract to work around that mismatch, this
script treats the two as compatible at the packaging level: a multi-clip zip is
split back into one independent zip per top-level `manifest.json` (preserving
every entry's original path, so pixel-index's own manifest-relative file
resolution still works unmodified) and each one is published as its own
pixel-index asset. A three-clip rain barrel becomes three separate pixel-index
catalog listings (RAIN_BARREL_EMPTY / _PARTIAL / _FULL) instead of one -- a
real, deliberate product-shape decision, not a technical shortcut, and the
right one until/unless pixel-index grows a grouped-variant concept of its own.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from zipfile import ZipFile

import httpx

PACKAGE_FILENAMES = ("pixel-agents.zip", "pixel-agents-character.zip", "pixel-agents-pet.zip")


class Unit:
    """One zip this script will actually POST -- either a package as-is, or one
    clip split out of a multi-manifest furniture package."""

    def __init__(self, label: str, data: bytes) -> None:
        self.label = label
        self.data = data


def split_units(example_key: str, package_filename: str, data: bytes) -> list[Unit]:
    with ZipFile(io.BytesIO(data)) as archive:
        manifest_paths = [name for name in archive.namelist() if name.endswith("manifest.json")]
        if len(manifest_paths) <= 1:
            return [Unit(f"{example_key}/{package_filename}", data)]

        # Multi-clip furniture: one manifest.json per clip, each with its own
        # sibling PNGs directly beside it (asset_export.py). Group every entry
        # by which manifest.json's directory it lives under, and re-zip each
        # group standalone with its original paths intact -- pixel-index finds
        # manifest.json wherever it is and resolves referenced files relative
        # to that same directory (services/api/src/assets/zip.ts), so no path
        # rewriting is needed.
        dirs = sorted((p.rsplit("/", 1)[0] + "/" for p in manifest_paths), key=len, reverse=True)
        units = []
        for clip_dir in dirs:
            names = [n for n in archive.namelist() if n.startswith(clip_dir)]
            manifest = json.loads(archive.read(f"{clip_dir}manifest.json"))
            buffer = io.BytesIO()
            with ZipFile(buffer, "w") as clip_zip:
                for name in names:
                    clip_zip.writestr(name, archive.read(name))
            units.append(
                Unit(f"{example_key}/{package_filename} [{manifest['id']}]", buffer.getvalue())
            )
        return units


def find_package(example_dir: Path) -> tuple[str, bytes] | None:
    for filename in PACKAGE_FILENAMES:
        path = example_dir / filename
        if path.is_file():
            return filename, path.read_bytes()
    return None


def publish(base_url: str, examples_dir: Path, token: str, only: list[str]) -> bool:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/zip"}

    example_dirs = sorted(p for p in examples_dir.iterdir() if p.is_dir() and p.name != "webview")
    if only:
        example_dirs = [p for p in example_dirs if p.name in only]

    all_ok = True
    total = 0
    with httpx.Client(base_url=base_url.rstrip("/"), timeout=60, headers=headers) as client:
        for example_dir in example_dirs:
            found = find_package(example_dir)
            if found is None:
                print(f"SKIP  {example_dir.name}: no installable package zip found")
                continue
            filename, data = found
            for unit in split_units(example_dir.name, filename, data):
                total += 1
                response = client.post("/api/v1/assets", content=unit.data)
                if response.status_code == 201:
                    body = response.json()
                    print(f"PASS  {unit.label}  -> 201 (assetId={body.get('assetId')})")
                else:
                    all_ok = False
                    print(f"FAIL  {unit.label}  -> {response.status_code} {response.text}")

    print(f"\n{'all' if all_ok else 'not all'} {total} upload(s) accepted", flush=True)
    return all_ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pixel-index-url", required=True)
    parser.add_argument("--examples-dir", type=Path, required=True)
    parser.add_argument("--token", required=True, help="Bearer token for the upload")
    parser.add_argument("--only", nargs="*", default=[])
    args = parser.parse_args()
    ok = publish(args.pixel_index_url, args.examples_dir, args.token, args.only)
    sys.exit(0 if ok else 1)
