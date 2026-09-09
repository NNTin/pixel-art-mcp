"""Individual read-only checks against a live pixel-index environment.

Each check is a plain function `(base_url, session, context, timeout) -> result`
returning `{"name", "status": "pass"|"fail"|"skipped", "detail"}`. Checks run in
order and share `context` — the `root` check's discovered commit feeds the
manifest-schema checks. pixel-agents-cogs' own contract checker
(https://github.com/pixel-agents-hq/pixel-agents-cogs, contracts/pixel_index/)
expresses its checks as a declarative list of {path, query, model} entries because
every one of them is the same shape: GET a path, validate the JSON body against a
pydantic model reused from its runtime HTTP client. Nothing here calls pixel-index at
runtime (this repo only produces zips for a human to upload manually), and the checks
themselves are heterogeneous — a plain health-style GET, a diff against our own
Pydantic constraints, a cross-repo schema fetch, a real list call — so a flat list of
functions is the honest shape instead of forcing that declarative pattern.

No authenticated POST /api/v1/assets upload is attempted anywhere here: that route
requires a Bearer session or an X-Api-Key + discordUserId this project has no
credentials for (see services/api/src/assets/submit.ts in pixel-agents-hq/index), and
issue #8 leaves a real upload check as an explicitly open question. A pass here means
"the zip shapes this repo generates should still be accepted," not "a real upload
would succeed."
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, get_args

import requests
from jsonschema import Draft202012Validator
from PIL import Image

from pixel_art_mcp.imaging.pet import export_pet_sheet
from pixel_art_mcp.imaging.pixel_agents import export_pixel_agents
from pixel_art_mcp.models import (
    PIXEL_AGENTS_NAME_MAX_LENGTH,
    PixelAgentsOptions,
    PixelAgentsPetOptions,
    RenderOptions,
)

# The real repo is pixel-agents-hq/index (confirmed via `git remote -v` on a checkout).
# A live environment's own `GET /`  "repository" field says pixel-agents-hq/pixel-index
# instead — a stale string in that response, not the actual location of the schema
# files — so this is hardcoded rather than trusted from the API response.
SCHEMA_REPO = "pixel-agents-hq/index"
SCHEMA_URL_TEMPLATE = (
    "https://raw.githubusercontent.com/{repo}/{commit}/"
    "packages/layout-core/schema/custom-asset-{kind}-manifest.schema.json"
)

CheckContext = dict[str, Any]
CheckResult = dict[str, str]


def _result(name: str, status: str, detail: str = "") -> CheckResult:
    return {"name": name, "status": status, "detail": detail}


def check_root(
    base_url: str, session: requests.Session, context: CheckContext, timeout: float
) -> CheckResult:
    """GET / — pixel-index self-reports the exact commit it's running. Everything
    else in this module keys off that instead of a pinned/vendored commit."""
    try:
        response = session.get(base_url.rstrip("/") + "/", timeout=timeout)
        response.raise_for_status()
        body = response.json()
    except (requests.RequestException, ValueError) as exc:
        return _result("root", "fail", f"GET / failed: {exc}")
    commit = body.get("commit")
    if not commit:
        return _result("root", "fail", "GET / response has no 'commit' field")
    context["commit"] = commit
    return _result("root", "pass", f"running commit {commit}")


def check_openapi_query_shape(
    base_url: str, session: requests.Session, context: CheckContext, timeout: float
) -> CheckResult:
    """Cross-checks POST /api/v1/assets's documented query constraints (assetKind,
    category, name) against what this repo's own models assume."""
    try:
        response = session.get(base_url.rstrip("/") + "/openapi.json", timeout=timeout)
        response.raise_for_status()
        spec = response.json()
    except (requests.RequestException, ValueError) as exc:
        return _result("openapi-query-shape", "fail", f"GET /openapi.json failed: {exc}")

    post = spec.get("paths", {}).get("/api/v1/assets", {}).get("post")
    if post is None:
        return _result(
            "openapi-query-shape",
            "skipped",
            "POST /api/v1/assets is not deployed to this environment yet",
        )

    params = {p["name"]: p.get("schema", {}) for p in post.get("parameters", [])}
    errors: list[str] = []

    asset_kind_enum = set(params.get("assetKind", {}).get("enum") or [])
    expected_kinds = {"furniture", "character", "pet"}
    if asset_kind_enum != expected_kinds:
        errors.append(
            f"assetKind enum is {sorted(asset_kind_enum)}, expected {sorted(expected_kinds)}"
        )

    category_enum = set(params.get("category", {}).get("enum") or [])
    expected_categories = set(get_args(PixelAgentsOptions.model_fields["category"].annotation))
    if category_enum != expected_categories:
        errors.append(
            f"category enum is {sorted(category_enum)}, expected {sorted(expected_categories)}"
        )

    name_max = params.get("name", {}).get("maxLength")
    if name_max != PIXEL_AGENTS_NAME_MAX_LENGTH:
        errors.append(
            f"name maxLength is {name_max!r}, expected {PIXEL_AGENTS_NAME_MAX_LENGTH} "
            "(update PIXEL_AGENTS_NAME_MAX_LENGTH in src/pixel_art_mcp/models.py)"
        )

    if errors:
        return _result("openapi-query-shape", "fail", "; ".join(errors))
    return _result("openapi-query-shape", "pass", "assetKind/category/name constraints match")


def _build_furniture_manifest_fixture() -> dict[str, Any]:
    """Builds one manifest the same way imaging/pixel_agents.py actually builds it,
    so the contract check exercises the real code path instead of a hand-duplicated
    JSON fixture that could silently drift from what this repo really generates."""
    options = RenderOptions(
        width=16,
        height=16,
        angles=[0],
        pixel_agents=PixelAgentsOptions(
            asset_id="CONTRACT_CHECK_FIXTURE", name="Contract check fixture"
        ),
    )
    frame = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    with tempfile.TemporaryDirectory() as tmp:
        output_dir = Path(tmp)
        export_pixel_agents(output_dir, options, [frame], None)
        assert options.pixel_agents is not None
        manifest_path = (
            output_dir
            / "pixel-agents"
            / "assets"
            / "furniture"
            / options.pixel_agents.asset_id
            / "manifest.json"
        )
        manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest


def _build_pet_manifest_fixture() -> dict[str, Any]:
    """Builds one manifest the same way imaging/pet.py actually builds it (a full
    round trip through export_pet_sheet with synthetic raw frames standing in for
    Blender's renders), for the same reason as the furniture fixture above."""
    options = RenderOptions(
        tile_width=1,
        tile_height=2,
        angles=[0, 90, 180],
        states=[
            {"id": "walk", "name": "Walk", "frame_start": 0, "frame_end": 2},
            {"id": "idle", "name": "Idle", "frame_start": 10, "frame_end": 12},
        ],
        pet=PixelAgentsPetOptions(asset_id="CONTRACT_CHECK_FIXTURE", name="Contract check fixture"),
        supersampling=1,
    )
    with tempfile.TemporaryDirectory() as tmp:
        raw_dir, output_dir = Path(tmp) / "raw", Path(tmp) / "out"
        raw_dir.mkdir()
        entries = []
        for row, angle in enumerate(options.angles):
            width = 32 if angle == 90 else 16
            for frame in options.render_frames():
                image = Image.new("RGBA", (width, 32), (10, 20, 30, 255))
                name = f"{row}_{frame}.png"
                image.save(raw_dir / name)
                entries.append({"filename": name, "angle": angle, "frame": frame, "pivot": [0, 0]})
        export_pet_sheet(
            raw_dir,
            output_dir,
            {"frames": entries, "camera": {}, "blender_version": "test"},
            options,
            "p",
            "r",
        )
        assert options.pet is not None
        manifest_path = output_dir / "pixel-agents-pet" / options.pet.asset_id / "manifest.json"
        manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest


def _check_manifest_schema(
    name: str,
    kind: str,
    build_fixture: Callable[[], dict[str, Any]],
    base_url: str,
    session: requests.Session,
    context: CheckContext,
    timeout: float,
) -> CheckResult:
    commit = context.get("commit")
    if not commit:
        return _result(name, "skipped", "no commit discovered by the root check")
    url = SCHEMA_URL_TEMPLATE.format(repo=SCHEMA_REPO, commit=commit, kind=kind)
    try:
        response = session.get(url, timeout=timeout)
    except requests.RequestException as exc:
        return _result(name, "fail", f"fetching {url} failed: {exc}")
    if response.status_code == 404:
        return _result(name, "skipped", f"no schema published at commit {commit}: {url}")
    try:
        response.raise_for_status()
        schema = response.json()
    except (requests.RequestException, ValueError) as exc:
        return _result(name, "fail", f"invalid schema response from {url}: {exc}")

    manifest = build_fixture()
    validator = Draft202012Validator(schema)
    errors = [
        f"{'.'.join(str(part) for part in error.path) or '<root>'}: {error.message}"
        for error in validator.iter_errors(manifest)
    ]
    if errors:
        return _result(name, "fail", "; ".join(errors))
    return _result(name, "pass", f"validated against commit {commit}")


def check_manifest_schema_furniture(
    base_url: str, session: requests.Session, context: CheckContext, timeout: float
) -> CheckResult:
    return _check_manifest_schema(
        "manifest-schema-furniture",
        "furniture",
        _build_furniture_manifest_fixture,
        base_url,
        session,
        context,
        timeout,
    )


def check_manifest_schema_pet(
    base_url: str, session: requests.Session, context: CheckContext, timeout: float
) -> CheckResult:
    return _check_manifest_schema(
        "manifest-schema-pet",
        "pet",
        _build_pet_manifest_fixture,
        base_url,
        session,
        context,
        timeout,
    )


def check_assets_list(
    base_url: str, session: requests.Session, context: CheckContext, timeout: float
) -> CheckResult:
    """GET /api/v1/assets?limit=1 — read-only, real data, mirrors pixel-agents-cogs'
    own list_layouts check: exercises a real response rather than only the schema."""
    try:
        response = session.get(
            base_url.rstrip("/") + "/api/v1/assets", params={"limit": 1}, timeout=timeout
        )
    except requests.RequestException as exc:
        return _result("assets-list", "fail", f"GET /api/v1/assets failed: {exc}")
    if response.status_code == 404:
        return _result(
            "assets-list", "skipped", "GET /api/v1/assets is not deployed to this environment yet"
        )
    try:
        response.raise_for_status()
        body = response.json()
    except (requests.RequestException, ValueError) as exc:
        return _result("assets-list", "fail", f"invalid response: {exc}")

    assets = body.get("assets", [])
    unexpected = {asset.get("assetKind") for asset in assets} - {"furniture", "character", "pet"}
    if unexpected:
        return _result("assets-list", "fail", f"unexpected assetKind: {sorted(unexpected)}")
    total = body.get("total", "?")
    return _result("assets-list", "pass", f"{len(assets)} asset(s) checked, of {total} total")


# character has no manifest schema to check at all -- see
# docs/custom-asset-zip-contract.md, it's a manifest-less PNG.
CHECKS = [
    check_root,
    check_openapi_query_shape,
    check_manifest_schema_furniture,
    check_manifest_schema_pet,
    check_assets_list,
]
