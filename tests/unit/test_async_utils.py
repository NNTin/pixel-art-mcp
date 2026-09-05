import asyncio
import threading

import pytest

from pixel_art_mcp.async_utils import finish_thread


async def test_cancelled_file_work_finishes_before_cleanup(tmp_path):
    started, release = threading.Event(), threading.Event()
    path = tmp_path / "thread-output"

    def write():
        started.set()
        assert release.wait(5)
        path.write_text("complete")

    task = asyncio.create_task(finish_thread(write))
    try:
        async with asyncio.timeout(3):
            while not started.is_set():
                await asyncio.sleep(0.001)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert path.read_text() == "complete"
    path.unlink()


async def test_thread_failure_propagates():
    def fail():
        raise ValueError("failed normalization")

    with pytest.raises(ValueError, match="normalization"):
        await finish_thread(fail)
