import asyncio
import contextlib
from collections.abc import Callable


async def finish_thread[**P, T](func: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Let blocking file work finish before a cancelled caller cleans its directory.

    asyncio cancellation cannot stop an already-running thread. Without this join,
    cleanup can race writes and leave orphaned files (or delete files still in use).
    """
    task = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await task
        raise
