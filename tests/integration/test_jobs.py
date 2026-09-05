import asyncio
import sys

import pytest
from conftest import wait_job

from pixel_art_mcp.jobs.process import ProcessFailure, run_process
from pixel_art_mcp.jobs.worker import Worker
from pixel_art_mcp.models import DomainError, RenderOptions


async def test_scene_revisions_conflicts_and_failed_edit(service, fake_blender):
    service.settings.blender_binary = fake_blender
    worker = Worker(service)
    await worker.start()
    try:
        project_id = str(service.create_project("Chair").id)
        first = service.submit_script(project_id, "print('create chair')", None)
        stale = service.submit_script(project_id, "print('stale edit')", None)
        completed = await wait_job(service, str(first.id))
        assert completed.status == "succeeded"
        assert (
            service.get_project(project_id).project.current_revision_id
            == completed.result_revision_id
        )
        assert (await wait_job(service, str(stale.id))).status == "failed"
        with pytest.raises(DomainError, match="revision"):
            service.submit_script(project_id, "print('edit')", None)
        failed = service.submit_script(
            project_id, "# fail\nprint('bad')", str(completed.result_revision_id)
        )
        assert (await wait_job(service, str(failed.id))).status == "failed"
        assert "traceback" in service.job(str(failed.id)).logs
        assert (
            service.get_project(project_id).project.current_revision_id
            == completed.result_revision_id
        )
        second = service.submit_script(
            project_id, "print('modify chair')", str(completed.result_revision_id)
        )
        edited = await wait_job(service, str(second.id))
        assert edited.status == "succeeded"
        assert edited.result_revision_id != completed.result_revision_id
        assert len(service.get_project(project_id).revisions) == 2
        with pytest.raises(DomainError, match="frame limit"):
            service.submit_render(project_id, RenderOptions(frame_end=1000))
    finally:
        await worker.stop()
    assert list((service.store.root / "tmp").iterdir()) == []


async def test_cancel_running_and_queued_work(service, fake_blender):
    service.settings.blender_binary = fake_blender
    worker = Worker(service)
    await worker.start()
    try:
        project_id = str(service.create_project("Chair").id)
        first = service.submit_script(project_id, "# slow\nprint('create')", None)
        second = service.submit_script(project_id, "print('queued')", None)
        assert service.cancel_job(str(second.id)).status == "cancelled"
        async with asyncio.timeout(5):
            while "started" not in service.job(str(first.id)).logs:
                await asyncio.sleep(0.02)
        service.cancel_job(str(first.id))
        assert (await wait_job(service, str(first.id))).status == "cancelled"
        assert service.get_project(project_id).project.current_revision_id is None
    finally:
        await worker.stop()


async def test_timeout_and_log_flood_are_bounded(tmp_path):
    logs = []
    with pytest.raises(ProcessFailure, match="exceeded"):
        await run_process(
            [
                sys.executable,
                "-c",
                "import sys,time;sys.stdout.write('x'*200000);sys.stdout.flush();time.sleep(60)",
            ],
            tmp_path,
            0.2,
            asyncio.Event(),
            2048,
            lambda log, progress: logs.append(log),
        )
    assert logs and max(len(log.encode()) for log in logs) <= 2048


async def test_cancellation_kills_descendants(tmp_path):

    child_pid = tmp_path / "child.pid"
    script = (
        "import subprocess,time,pathlib; "
        f"p=subprocess.Popen([{sys.executable!r}, '-c', 'import time;time.sleep(60)']); "
        f"pathlib.Path({str(child_pid)!r}).write_text(str(p.pid)); time.sleep(60)"
    )
    cancel = asyncio.Event()
    task = asyncio.create_task(
        run_process(
            [sys.executable, "-c", script], tmp_path, 5, cancel, 2048, lambda log, progress: None
        )
    )
    async with asyncio.timeout(3):
        while not child_pid.exists():
            await asyncio.sleep(0.02)
    cancel.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    pid = int(child_pid.read_text())
    # A terminated child may remain a zombie until the system/container init reaps it.
    stat = tmp_path.__class__(f"/proc/{pid}/stat")
    assert not stat.exists() or stat.read_text().split()[2] == "Z"


async def test_worker_lock_prevents_two_owners(service, fake_blender):
    service.settings.blender_binary = fake_blender
    first, second = Worker(service), Worker(service)
    await first.start()
    try:
        with pytest.raises(RuntimeError, match="exactly one"):
            await second.start()
    finally:
        await first.stop()


async def test_empty_version_output_is_not_a_ready_renderer(service):
    service.settings.blender_binary = "/bin/true"
    worker = Worker(service)
    await worker.start()
    try:
        assert service.blender_version is None
        project_id = str(service.create_project("Chair").id)
        with pytest.raises(DomainError, match="unavailable"):
            service.submit_script(project_id, "print('chair')", None)
    finally:
        await worker.stop()
