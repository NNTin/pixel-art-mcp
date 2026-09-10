#!/usr/bin/env python3
"""Verify pixel-art-mcp's understanding of pixel-index's custom-asset upload contract
against a live environment.

Consumer-driven, read-only (see checks.py's module docstring for why no authenticated
upload is attempted). A pass means "the zips this repo generates should still be
shape-compatible with what this environment's decode logic expects" — not "this
environment's full API is unchanged."

Run:
  PYTHONPATH=src python -m contracts.pixel_index.verify \\
      --base-url https://pixel-index-api-staging.nntin.xyz
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests

from contracts.pixel_index.checks import CHECKS, CheckResult


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def run(base_url: str, timeout: float) -> tuple[bool, list[CheckResult]]:
    session = requests.Session()
    context: dict[str, Any] = {}
    results = [check(base_url, session, context, timeout) for check in CHECKS]
    overall_ok = not any(result["status"] == "fail" for result in results)
    return overall_ok, results


def build_result_document(
    env_name: str, base_url: str, ok: bool, results: list[CheckResult]
) -> dict[str, Any]:
    """The stable, machine-readable result consumed by generate_status_site.py."""
    counts = {
        status: sum(result["status"] == status for result in results)
        for status in ("pass", "fail", "skipped")
    }
    failed = [result["name"] for result in results if result["status"] == "fail"]
    return {
        "schema_version": 1,
        "environment": env_name,
        "base_url": base_url,
        "status": "pass" if ok else "fail",
        "checked_at": _utc_now(),
        "counts": counts,
        "checks": results,
        "detail": "" if ok else f"Failed checks: {', '.join(failed)}",
    }


def write_result_document(path: str, document: dict[str, Any]) -> None:
    """Atomically replace a placeholder result with the completed result."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp")
    temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    temporary.replace(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        required=True,
        help="pixel-index API base URL, e.g. https://pixel-index-api.nntin.xyz",
    )
    parser.add_argument("--env-name", default=None, help="Label for output, defaults to --base-url")
    parser.add_argument(
        "--output-json",
        default=None,
        help="Write a structured result for the status site.",
    )
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()

    env_name = args.env_name or args.base_url
    ok, results = run(args.base_url, args.timeout)
    document = build_result_document(env_name, args.base_url, ok, results)

    if args.output_json:
        write_result_document(args.output_json, document)

    lines = [
        f"## pixel-index contract check — {env_name}",
        "",
        "| Check | Result | Detail |",
        "|---|---|---|",
    ]
    icon = {"pass": "✅", "fail": "❌", "skipped": "⚠️"}
    for result in results:
        detail = result["detail"].replace("|", "\\|") or "-"
        status = result["status"]
        lines.append(f"| {result['name']} | {icon[status]} {status} | {detail} |")
    report = "\n".join(lines)

    print(report)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(report + "\n\n")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
