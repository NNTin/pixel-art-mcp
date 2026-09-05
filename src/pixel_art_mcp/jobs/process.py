import asyncio
import contextlib
import json
import os
import signal
from collections.abc import Callable
from pathlib import Path
from typing import Any


class ProcessFailure(Exception):
    pass


async def stop_process(process: asyncio.subprocess.Process) -> None:
    # Kill the entire group even if the original Blender process already exited.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except TimeoutError:
        pass
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    await process.wait()


async def run_process(
    command: list[str],
    cwd: Path,
    timeout: float,
    cancel: asyncio.Event,
    log_limit: int,
    update: Callable[[str, dict[str, Any] | None], None],
) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    log = b""
    line_buffer = b""

    async def drain() -> None:
        nonlocal log, line_buffer
        assert process.stdout is not None
        while chunk := await process.stdout.read(4096):
            log = (log + chunk)[-log_limit:]
            line_buffer += chunk
            progress = None
            while b"\n" in line_buffer:
                line, line_buffer = line_buffer.split(b"\n", 1)
                if line.startswith(b"PIXEL_PROGRESS "):
                    with contextlib.suppress(ValueError, UnicodeError):
                        payload = json.loads(line[15:])
                        if isinstance(payload, dict):
                            progress = payload
            line_buffer = line_buffer[-4096:]
            update(log.decode("utf-8", errors="replace"), progress)

    reader = asyncio.create_task(drain())
    waiter = asyncio.create_task(process.wait())
    cancelled = asyncio.create_task(cancel.wait())
    try:
        async with asyncio.timeout(timeout):
            done, _ = await asyncio.wait([waiter, cancelled], return_when=asyncio.FIRST_COMPLETED)
            if cancelled in done:
                raise asyncio.CancelledError
            # Descendants may hold stdout open; this remains covered by the timeout.
            await reader
            if process.returncode != 0:
                raise ProcessFailure(
                    f"Blender exited with code {process.returncode}; inspect job logs"
                )
    except TimeoutError as exc:
        raise ProcessFailure(f"Execution exceeded {timeout:g} seconds") from exc
    finally:
        await stop_process(process)
        for task in (reader, waiter, cancelled):
            task.cancel()
        await asyncio.gather(reader, waiter, cancelled, return_exceptions=True)
