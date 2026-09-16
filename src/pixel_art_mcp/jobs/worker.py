import asyncio
import contextlib
import fcntl
import json
import logging
import shutil
import sys
from pathlib import Path
from typing import Any, BinaryIO

from PIL import Image

from pixel_art_mcp.async_utils import finish_thread
from pixel_art_mcp.authoring import validated_art
from pixel_art_mcp.engine import __file__ as engine_package_file
from pixel_art_mcp.imaging.pet import angle_widths
from pixel_art_mcp.imaging.pixels import export_sheet
from pixel_art_mcp.jobs.process import ProcessFailure, run_process
from pixel_art_mcp.models import DomainError, RenderOptions
from pixel_art_mcp.projects.service import Service
from pixel_art_mcp.storage.store import identifier, timestamp

logger = logging.getLogger(__name__)


class Worker:
    def __init__(self, service: Service) -> None:
        self.service = service
        self.task: asyncio.Task[None] | None = None
        self.lock_file: BinaryIO | None = None
        self.stopping = False

    async def start(self) -> None:
        service = self.service
        self.lock_file = (service.store.root / "worker.lock").open("a+b")
        try:
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.lock_file.close()
            self.lock_file = None
            raise RuntimeError("Data directory already in use; run exactly one API worker") from exc
        service.store.recover()
        # Only disposable directories belonging to jobs are cleaned on startup.
        scratch = service.store.path("tmp")
        if scratch.exists():
            shutil.rmtree(scratch)
        scratch.mkdir()
        self.task = asyncio.create_task(self.loop(), name="pixel-worker")
        service.worker_ready = True

    async def stop(self) -> None:
        self.stopping = True
        self.service.worker_ready = False
        self.service.wake.set()
        for event in self.service.cancel_events.values():
            event.set()
        if self.task:
            await self.task
        if self.lock_file:
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_UN)
            self.lock_file.close()

    async def loop(self) -> None:
        service = self.service
        try:
            while not self.stopping:
                service.wake.clear()
                job = service.store.claim_job()
                if job is None:
                    await service.wake.wait()
                    continue
                await self.execute(job)
        except Exception:
            service.worker_ready = False
            logger.exception("Pixel worker stopped unexpectedly")

    async def execute(self, job: dict[str, Any]) -> None:
        service, store = self.service, self.service.store
        job_id, project_id = job["id"], job["project_id"]
        cancel = service.cancel_events.setdefault(job_id, asyncio.Event())
        scratch = store.path(f"tmp/{job_id}")
        raw = scratch / "raw"
        staged = scratch / "publish"
        final = store.path(f"projects/{project_id}/jobs/{job_id}")
        try:
            scratch.mkdir(parents=True)
            staged.mkdir()
            revision_id = job["input_revision_id"]
            if job["operation"] == "script":
                if store.project(project_id)["current_revision_id"] != revision_id:
                    raise DomainError(
                        "Scene revision changed while queued; reload project and retry"
                    )
                script_path = scratch / "submitted.py"
                script_path.write_text(job["params"]["script"], encoding="utf-8")
                shutil.copy2(script_path, staged / "script.py")
            else:
                script_path = None
            input_state = None
            pixel_art = None
            if revision_id:
                revision = service.revision(project_id, revision_id)
                if job["operation"] == "script":
                    input_state = str(service.artifact_path(revision["state_artifact_id"]))
                else:
                    pixel_art = revision["summary"]["pixel_art"]
            references = {r["id"]: r["image_path"] for r in store.records(project_id, "reference")}
            render_options = job["params"].get("options")
            if render_options and render_options.get("pet"):
                # Pet's right-facing row renders at double width -- see
                # imaging/pet.py's module docstring and angle_widths().
                render_options = {
                    **render_options,
                    "angle_widths": angle_widths(render_options["width"], render_options["angles"]),
                }
            request = {
                "schema_version": 1,
                "operation": job["operation"],
                "input_state": input_state,
                "pixel_art": pixel_art,
                "output_dir": str(raw),
                "script_path": str(script_path) if script_path else None,
                "references": references,
                "options": render_options,
                "authoring_options": job["params"].get("authoring_options"),
                "pixel_art_required": job["params"].get("pixel_art_required", False),
            }
            request_path = scratch / "request.json"
            request_path.write_text(json.dumps(request), encoding="utf-8")
            runner = Path(str(engine_package_file)).with_name("runner.py")
            command = [sys.executable, str(runner), str(request_path)]

            def update(log: str, progress: dict[str, Any] | None) -> None:
                changes: dict[str, Any] = {"logs": log}
                if progress and not cancel.is_set():
                    try:
                        fraction = float(progress["completed"]) / max(float(progress["total"]), 1)
                        changes.update(progress=min(0.9, max(0, fraction * 0.9)), stage="rendering")
                    except (ValueError, TypeError, KeyError):
                        pass
                store.update_job(job_id, **changes)

            timeout = (
                service.settings.script_timeout
                if job["operation"] == "script"
                else service.settings.render_timeout
            )
            await run_process(
                command, scratch, timeout, cancel, service.settings.max_log_bytes, update
            )
            if cancel.is_set():
                raise asyncio.CancelledError
            result_path = raw / "result.json"
            if not result_path.is_file() or result_path.stat().st_size > 16 * 1024 * 1024:
                raise ProcessFailure("Script did not return a valid result manifest")
            result = json.loads(result_path.read_text(encoding="utf-8"))
            new_revision = None
            if job["operation"] == "script":
                data = result["summary"].get("pixel_art")
                authoring_options = job["params"].get("authoring_options")
                if data is not None:
                    if authoring_options is None:
                        raise DomainError("Call configure_asset before authoring pixel layers")
                    validated_art(data, authoring_options)
                elif job["params"].get("pixel_art_required"):
                    raise DomainError("An edit cannot remove the required pixel-art definition")
                state = raw / "state.json"
                if not state.is_file():
                    raise ProcessFailure("Script did not produce a saved scene state")
                shutil.copy2(state, staged / "state.json")
                (staged / "summary.json").write_text(
                    json.dumps(result["summary"], indent=2), encoding="utf-8"
                )
            else:
                store.update_job(job_id, stage="converting", progress=0.9)
                options = RenderOptions.model_validate(job["params"]["options"])
                await finish_thread(
                    export_sheet, raw, staged, result, options, project_id, str(revision_id)
                )
            if cancel.is_set():
                raise asyncio.CancelledError
            final.parent.mkdir(parents=True, exist_ok=True)
            staged.rename(final)
            artifacts = []
            for path in sorted(final.rglob("*")):
                if not path.is_file():
                    continue
                width = height = None
                if path.suffix in {".png", ".apng", ".gif"}:
                    with Image.open(path) as im:
                        width, height = im.size
                kind = "frame" if path.parent.name == "frames" else path.stem
                if path.parent.name == "animations":
                    kind = "animation"
                elif path.name == "preview.html":
                    kind = "player"
                artifacts.append(
                    service.artifact_record(project_id, path, kind, job_id, width, height)
                )
            if job["operation"] == "script":
                by_name = {a["filename"]: a for a in artifacts}
                new_revision = {
                    "id": identifier(),
                    "project_id": project_id,
                    "parent_id": revision_id,
                    "created_at": timestamp(),
                    "state_artifact_id": by_name["state.json"]["id"],
                    "script_artifact_id": by_name["script.py"]["id"],
                    "summary": result["summary"],
                }
            store.publish(job_id, artifacts, new_revision)
            logger.info("Job %s succeeded (%s)", job_id, job["operation"])
        except asyncio.CancelledError:
            store.update_job(
                job_id,
                status="failed" if self.stopping else "cancelled",
                stage="interrupted" if self.stopping else "cancelled",
                error="Service stopped during execution" if self.stopping else None,
                finished_at=timestamp(),
            )
        except Exception as exc:
            logger.warning("Job %s failed: %s", job_id, type(exc).__name__)
            message = (
                str(exc)
                if isinstance(exc, (DomainError, ProcessFailure))
                else (f"{type(exc).__name__}: job output could not be processed; inspect logs")
            )
            store.update_job(
                job_id, status="failed", stage="failed", error=message, finished_at=timestamp()
            )
        finally:
            service.cancel_events.pop(job_id, None)
            if store.job(job_id)["status"] != "succeeded" and final.exists():
                shutil.rmtree(final)
            with contextlib.suppress(FileNotFoundError):
                shutil.rmtree(scratch)
