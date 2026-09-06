"""Condenses a job's raw stdout/stderr log for tool/human consumption.

`Job.logs` is already capped to the last `Settings.max_log_bytes` (64KB by
default) while a job streams (see `jobs/process.py::run_process`), but
that cap exists to bound *stored* size, not to make the field reasonable
for an LLM tool result. Blender's Cycles renderer logs a line per BVH-build
step per frame, so an animated `render_sprites` job's `logs` routinely
sits at the full 64KB cap on every single poll -- and `get_job` is meant to
be polled repeatedly until a job reaches a terminal state (see
`mcp/server.py`'s own tool docstrings), so those polls accumulate in one
MCP client's conversation history. A real incident: an animator agent
polling one animated render several times exceeded its LLM's context
window purely from this field.

`condense_log` keeps two things a caller actually needs -- the most recent
output (to see what's currently happening) and anything that looks like an
error (which can occur long before the log's tail, e.g. a script exception
followed by cleanup/shutdown lines) -- and drops the rest. Wired in at the
single `Service.job()` choke point every `get_job`/`submit_script`/
`submit_render`/`cancel_job` call returns through."""

from __future__ import annotations

import re

# A short log (the common case -- most jobs finish in well under this many
# lines) is returned unchanged: no point condensing what wasn't a problem.
_TAIL_LINES = 40
_MAX_ERROR_LINES = 20
_MAX_LINE_CHARS = 500
_ERROR_PATTERN = re.compile(r"error|traceback|exception", re.IGNORECASE)


def condense_log(log: str) -> str:
    if not log:
        return log
    lines = log.splitlines()
    if len(lines) <= _TAIL_LINES:
        return log

    tail_start = len(lines) - _TAIL_LINES
    tail = lines[tail_start:]
    error_lines = [line for line in lines[:tail_start] if _ERROR_PATTERN.search(line)]

    sections: list[str] = []
    if error_lines:
        shown = error_lines[-_MAX_ERROR_LINES:]
        omitted_errors = len(error_lines) - len(shown)
        if omitted_errors:
            sections.append(f"... ({omitted_errors} earlier error line(s) omitted) ...")
        sections.extend(_clip_line(line) for line in shown)
        sections.append("")
    sections.append(f"... ({tail_start} line(s) omitted) ...")
    sections.extend(_clip_line(line) for line in tail)
    return "\n".join(sections)


def _clip_line(line: str) -> str:
    if len(line) <= _MAX_LINE_CHARS:
        return line
    return line[:_MAX_LINE_CHARS] + f"... [{len(line) - _MAX_LINE_CHARS} more chars]"


__all__ = ["condense_log"]
