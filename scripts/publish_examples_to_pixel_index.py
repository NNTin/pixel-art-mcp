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

A multi-clip furniture package (e.g. `rain-barrel`'s empty/partial/full states,
`thermometer`'s cold/room/hot) is not directly uploadable to pixel-index -- see
`scripts/pixel_index_packaging.py` for why, and for the `split_multi_clip_zip()`
this script reuses (the same split that also gives each clip its own downloadable
zip in the example gallery, `scripts/generate_examples.py`) to publish each clip
as its own separate pixel-index asset instead.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx
from pixel_index_packaging import split_multi_clip_zip

PACKAGE_FILENAMES = ("pixel-agents.zip", "pixel-agents-character.zip", "pixel-agents-pet.zip")


class Unit:
    """One zip this script will actually POST -- either a package as-is, or one
    clip split out of a multi-manifest furniture package."""

    def __init__(self, label: str, data: bytes) -> None:
        self.label = label
        self.data = data


def split_units(example_key: str, package_filename: str, data: bytes) -> list[Unit]:
    clips = split_multi_clip_zip(data)
    if not clips:
        return [Unit(f"{example_key}/{package_filename}", data)]
    return [
        Unit(f"{example_key}/{package_filename} [{clip.asset_id}]", clip.data) for clip in clips
    ]


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
