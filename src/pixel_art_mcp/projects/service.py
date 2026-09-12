import asyncio
import base64
import binascii
import importlib.metadata
import json
import mimetypes
import shutil
import time
from pathlib import Path
from typing import Any
from uuid import UUID

from pixel_art_mcp import __version__
from pixel_art_mcp.assets import get_asset_profile, normalize_asset, resolve_asset
from pixel_art_mcp.async_utils import finish_thread
from pixel_art_mcp.config import Settings
from pixel_art_mcp.jobs.log_condense import condense_log
from pixel_art_mcp.models import (
    Artifact,
    AssetSpec,
    DomainError,
    Job,
    OpenAIFile,
    Project,
    ProjectDetail,
    Reference,
    RenderOptions,
    Revision,
)
from pixel_art_mcp.projects.references import download_reference, normalize_reference
from pixel_art_mcp.storage.store import Store, identifier, timestamp


class Service:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = Store(settings.data_dir)
        self.blender_version: str | None = None
        self.worker_ready = False
        self.wake = asyncio.Event()
        self.cancel_events: dict[str, asyncio.Event] = {}

    def capabilities(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "version": __version__,
            "mcp_sdk_version": importlib.metadata.version("mcp"),
            "blender_version": self.blender_version,
            "worker_ready": self.worker_ready,
            "transport": "streamable-http",
            "authentication": "none",
            "modeling": "full Blender Python (trusted scripts)",
            "asset_workflow": [
                "get_asset_profile",
                "configure_asset",
                "render_asset",
                "inspect_asset",
            ],
            "asset_profiles": {
                kind: get_asset_profile(kind) for kind in ("furniture", "character", "pet")
            },
            "render_defaults": RenderOptions().model_dump(),
            "export_features": {
                "preview_options": "same as render_sprites; angle/frame override options",
                "animation_format": "image/apng",
                "animation_layout": "one transparent loop per direction, at export resolution",
                "offline_player": "preview.html; play/pause, scrub, zoom, background",
                "sizing": "16px tiles: 1x1 small, 1x2 tall, 2x1 wide. width/height override tiles.",
                "pixel_agents": "Optional furniture manifest + PNG package; cardinal views, 5 fps, "
                "off/on states. Animation only runs near an active agent, as supported by the app.",
                "comparison": "Source render beside highlighted game-resolution PNGs",
                "text_inspection": "Palette-index grid, color/cluster metrics, and comparison for "
                "agents without image or vision support",
                "downscaling": "crisp source-derived palette by default; legacy average palette "
                "remains selectable",
                "states": "Named states share framing/palette; one generated HTML comparison "
                "player and one pixel-agents ZIP containing separate selectable variants.",
            },
            "limits": {
                key: value
                for key, value in self.settings.model_dump().items()
                if key.startswith("max_") or key.endswith("timeout")
            },
        }

    def create_project(self, name: str) -> Project:
        name = name.strip()
        if not name or len(name) > 120:
            raise DomainError("Project name must contain 1–120 characters")
        return Project.model_validate(self.store.create_project(name))

    def list_projects(self) -> list[Project]:
        return [Project.model_validate(p) for p in self.store.projects()]

    def get_project(self, project_id: str) -> ProjectDetail:
        return ProjectDetail(
            project=Project.model_validate(self.store.project(project_id)),
            references=[
                Reference.model_validate(r) for r in self.store.records(project_id, "reference")
            ],
            revisions=[
                Revision.model_validate(r) for r in self.store.records(project_id, "revision")
            ],
            asset_configuration=self.asset_configuration(project_id),
        )

    def asset_configuration(self, project_id: str) -> dict[str, Any] | None:
        self.store.project(project_id)
        records = self.store.records(project_id, "asset_configuration")
        return max(records, key=lambda record: record["created_at"]) if records else None

    def configure_asset(self, project_id: str, specification: AssetSpec) -> dict[str, Any]:
        self.store.project(project_id)
        specification = normalize_asset(specification)
        resolved = resolve_asset(specification)
        record = {
            "id": identifier(),
            "project_id": project_id,
            "created_at": timestamp(),
            "specification": specification.model_dump(),
            "layouts": resolved.asset_layouts,
        }
        self.store.put_record("asset_configuration", record)
        return record

    def render_asset(self, project_id: str, revision_id: str | None = None) -> Job:
        configuration = self.asset_configuration(project_id)
        if configuration is None:
            raise DomainError("Call configure_asset before render_asset")
        options = resolve_asset(
            AssetSpec.model_validate(configuration["specification"]), configuration["id"]
        )
        return self.submit_render(project_id, options, revision_id)

    def export_root(self, job_id: str) -> Path:
        job = self.job(job_id)
        if job.status != "succeeded" or job.operation not in ("preview", "sprites"):
            raise DomainError("Inspection requires a succeeded render job")
        paths = [
            self.artifact_path(str(a.id)) for a in job.artifacts if a.filename == "sprites.zip"
        ]
        if not paths:
            raise DomainError("Render has no sprites.zip artifact")
        return min(paths, key=lambda path: len(path.parts)).parent

    def inspect_asset(self, job_id: str) -> dict[str, Any]:
        path = self.export_root(job_id) / "asset-report.json"
        if not path.is_file():
            raise DomainError(
                "This legacy render has no asset report; use configure_asset/render_asset"
            )
        return {"job_id": job_id, **json.loads(path.read_text())}

    def artifact_record(
        self,
        project_id: str,
        path: Path,
        kind: str,
        job_id: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> dict[str, Any]:
        relative = str(path.resolve().relative_to(self.store.root))
        checked = self.store.path(relative)
        return {
            "id": identifier(),
            "project_id": project_id,
            "job_id": job_id,
            "kind": kind,
            "filename": path.name,
            "relative_path": relative,
            "export_path": (
                path.relative_to(
                    self.store.root / "projects" / project_id / "jobs" / job_id
                ).as_posix()
                if job_id
                else path.name
            ),
            "media_type": (
                "image/apng"
                if path.suffix == ".apng"
                else mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            ),
            "size_bytes": checked.stat().st_size,
            "width": width,
            "height": height,
        }

    def artifact(self, artifact_id: str) -> Artifact:
        record = self.store.record(artifact_id, "artifact")
        record.pop("relative_path")
        record["download_url"] = f"{self.settings.base_url.rstrip('/')}/artifacts/{artifact_id}"
        return Artifact.model_validate(record)

    def artifact_path(self, artifact_id: str) -> Path:
        record = self.store.record(artifact_id, "artifact")
        path = self.store.path(record["relative_path"])
        if not path.is_file():
            raise DomainError("Artifact file is missing", 404)
        return path

    def reference(self, reference_id: str) -> Reference:
        return Reference.model_validate(self.store.record(reference_id, "reference"))

    async def add_reference(self, project_id: str, data: bytes, filename: str) -> Reference:
        self.store.project(project_id)
        reference_id = identifier()
        directory = self.store.path(f"projects/{project_id}/references/{reference_id}")
        try:
            info = await finish_thread(normalize_reference, data, directory, self.settings)
            original = self.artifact_record(
                project_id, directory / f"original.{info['extension']}", "reference"
            )
            image = self.artifact_record(
                project_id,
                directory / "image.png",
                "reference_image",
                width=info["width"],
                height=info["height"],
            )
            thumbnail = self.artifact_record(project_id, directory / "thumbnail.png", "thumbnail")
            reference = Reference(
                id=UUID(reference_id),
                project_id=UUID(project_id),
                filename=Path(filename).name[:255] or "reference.png",
                width=info["width"],
                height=info["height"],
                sha256=info["sha256"],
                original_artifact_id=original["id"],
                image_artifact_id=image["id"],
                thumbnail_artifact_id=thumbnail["id"],
                blender_path=str(directory / "image.png"),
            )
            with self.store.transaction():
                for artifact in (original, image, thumbnail):
                    self.store.put_record("artifact", artifact)
                self.store.put_record("reference", reference.model_dump(mode="json"))
            return reference
        except BaseException:
            if directory.exists():
                shutil.rmtree(directory)
            raise

    async def add_reference_input(
        self, project_id: str, data_base64: str | None, file: OpenAIFile | None, filename: str
    ) -> Reference:
        self.store.project(project_id)
        if (data_base64 is None) == (file is None):
            raise DomainError("Provide exactly one of data_base64 or file")
        if file is not None:
            data = await download_reference(file.download_url, self.settings)
            filename = file.file_name or filename
        else:
            assert data_base64 is not None
            if len(data_base64) > 4 * ((self.settings.max_upload_bytes + 2) // 3):
                raise DomainError("Reference exceeds the upload size limit", 413)
            try:
                data = base64.b64decode(data_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise DomainError("Invalid base64 image") from exc
        return await self.add_reference(project_id, data, filename)

    def revision(self, project_id: str, revision_id: str | None = None) -> dict[str, Any]:
        project = self.store.project(project_id)
        revision_id = revision_id or project["current_revision_id"]
        if revision_id is None:
            raise DomainError("Project has no scene; call execute_blender_python first", 409)
        revision = self.store.record(revision_id, "revision")
        if revision["project_id"] != project_id:
            raise DomainError("Revision does not belong to this project", 404)
        return revision

    def submit_script(self, project_id: str, script: str, expected_revision_id: str | None) -> Job:
        project = self.store.project(project_id)
        if expected_revision_id != project["current_revision_id"]:
            raise DomainError(
                "Scene revision changed; get_project and retry with its current ID", 409
            )
        if not script.strip() or len(script.encode()) > self.settings.max_script_bytes:
            raise DomainError("Script is empty or exceeds the script size limit")
        try:
            compile(script, "submitted.py", "exec")
        except SyntaxError as exc:
            raise DomainError(f"Python syntax error at line {exc.lineno}: {exc.msg}") from exc
        return self._submit(project_id, "script", expected_revision_id, {"script": script})

    def submit_render(
        self,
        project_id: str,
        options: RenderOptions,
        revision_id: str | None = None,
        preview: bool = False,
    ) -> Job:
        revision = self.revision(project_id, revision_id)
        frame_count = len(options.render_frames()) * len(options.angles)
        if frame_count > self.settings.max_render_frames:
            raise DomainError("Render exceeds the configured total frame limit")
        output_count = (
            sum(len(state.frames()) + (state.off_frame is not None) for state in options.states)
            * len(options.angles)
            if options.states
            else frame_count
        )
        if options.asset:
            output_count = sum(
                len(clip.frames) + (clip.off_frame is not None)
                for clip in options.asset.clips.values()
            ) * len(options.angles)
        pixel_count = max(frame_count, output_count) * options.width * options.height
        if pixel_count > self.settings.max_sheet_pixels:
            raise DomainError("Sprite sheet exceeds the configured pixel limit")
        if pixel_count * options.supersampling**2 > self.settings.max_sheet_pixels:
            raise DomainError(
                "High-resolution comparison exceeds the configured pixel limit; "
                "reduce dimensions, frames, angles, or supersampling"
            )
        return self._submit(
            project_id,
            "preview" if preview else "sprites",
            revision["id"],
            {"options": options.model_dump()},
        )

    def _submit(
        self, project_id: str, operation: str, revision_id: str | None, params: dict[str, Any]
    ) -> Job:
        if not self.worker_ready or not self.blender_version:
            raise DomainError("Blender worker is unavailable; check /health/ready", 503)
        job: dict[str, Any] = {
            "id": identifier(),
            "project_id": project_id,
            "operation": operation,
            "input_revision_id": revision_id,
            "status": "queued",
            "created_at": timestamp(),
            "params": params,
            "artifact_ids": [],
        }
        self.store.insert_job(job, self.settings.max_pending_jobs)
        self.wake.set()
        return self.job(job["id"])

    def job(self, job_id: str) -> Job:
        record = self.store.job(job_id)
        record.pop("params")
        record["artifacts"] = [self.artifact(i) for i in record.pop("artifact_ids")]
        record["outputs"] = {
            artifact.export_path: artifact
            for artifact in record["artifacts"]
            if artifact.export_path and "/" not in artifact.export_path
        }
        record["logs"] = condense_log(record.get("logs") or "")
        return Job.model_validate(record)

    async def wait_for_job(self, job_id: str, timeout_seconds: float | None) -> Job:
        """Blocks (yielding to the event loop between checks) until `job_id`
        reaches a terminal status or the timeout elapses, then returns the
        same shape `job()` does -- one server-side wait in place of however
        many client-side `get_job` polls a long operation would otherwise
        need. `timeout_seconds` is clamped to `settings.wait_for_job_max_timeout`
        (`None` uses that same cap) so one client can never hold this
        coroutine -- and the HTTP request waiting on it -- open longer than
        the deployment's own configured ceiling, no matter what it asks for.

        There is no per-job completion signal in `Store` to await instead
        (`jobs/worker.py`'s `wake` event only wakes the *worker* to claim
        its next queued job, not a per-job subscriber) -- this just calls
        `job()` on a short interval. Unlike a client-side poll, each of
        these costs no MCP round trip or LLM context; it's plain server-side
        CPU/IO.
        """
        cap = self.settings.wait_for_job_max_timeout
        effective = cap if timeout_seconds is None else min(max(timeout_seconds, 0), cap)
        deadline = time.monotonic() + effective
        poll_interval = self.settings.wait_for_job_poll_interval
        while True:
            result = self.job(job_id)
            if result.status in ("succeeded", "failed", "cancelled"):
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return result
            await asyncio.sleep(min(poll_interval, remaining))

    def cancel_job(self, job_id: str) -> Job:
        job = self.store.job(job_id)
        if job["status"] == "queued":
            self.store.update_job(
                job_id, status="cancelled", stage="cancelled", finished_at=timestamp()
            )
        elif job["status"] == "running":
            self.cancel_events.setdefault(job_id, asyncio.Event()).set()
            self.store.update_job(job_id, stage="cancelling")
        return self.job(job_id)
