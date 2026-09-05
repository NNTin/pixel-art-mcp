import asyncio
import io
import sys
from pathlib import Path

import pytest
from PIL import Image

from pixel_art_mcp.config import Settings
from pixel_art_mcp.projects.service import Service


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", blender_binary="/missing/blender", _env_file=None)


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


@pytest.fixture
def fake_blender(tmp_path):
    """A process fixture for job lifecycle tests, not a substitute for Blender render tests."""
    path = tmp_path / "fake-blender"
    path.write_text(
        f"#!{sys.executable}\n"
        + r"""
import json
import sys
import time
from pathlib import Path
if "--version" in sys.argv:
    print("Blender TEST FIXTURE")
    raise SystemExit(0)
request = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
script = Path(request["script_path"]).read_text()
if "# fail" in script:
    print("Example Blender traceback: modeling failed", flush=True)
    raise SystemExit(1)
if "# slow" in script:
    print("started", flush=True)
    time.sleep(60)
output = Path(request["output_dir"])
output.mkdir(parents=True)
(output / "scene.blend").write_bytes(b"BLENDER-vTEST-fixture")
(output / "result.json").write_text(json.dumps({"summary": {"objects": [{"name": "Seat"}]}}))
print("saved", flush=True)
"""
    )
    path.chmod(0o755)
    return str(path)


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
