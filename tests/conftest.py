import asyncio
import io
from pathlib import Path

import pytest
from PIL import Image

from pixel_art_mcp.config import Settings
from pixel_art_mcp.projects.service import Service

# Scripts run for real (the engine is plain Python; see engine/runner.py), so tests
# that need a failing or long-running job just submit one instead of faking a process.
FAILING_SCRIPT = "raise RuntimeError('boom')\n"
SLOW_SCRIPT = "print('started', flush=True)\nimport time\ntime.sleep(60)\n"


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", _env_file=None)


@pytest.fixture
def service(settings):
    instance = Service(settings)
    yield instance
    instance.store.close()


@pytest.fixture
def png():
    stream = io.BytesIO()
    Image.new("RGB", (24, 32), "coral").save(stream, "PNG")
    return stream.getvalue()


async def wait_job(service: Service, job_id: str, timeout: float = 10):
    async with asyncio.timeout(timeout):
        while True:
            job = service.job(job_id)
            if job.status in ("succeeded", "failed", "cancelled"):
                return job
            await asyncio.sleep(0.02)


@pytest.fixture
def example_dir():
    return Path(__file__).resolve().parents[1] / "examples"
