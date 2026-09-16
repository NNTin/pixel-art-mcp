"""Subprocess entrypoint invoked with the app's own Python interpreter.

Runs a submitted authoring script (script operation) or builds the blank
per-frame canvases and manifest that the imaging pipeline composites authored
pixels onto (render operations). No external renderer is involved: only the
saved pixel_art definition is ever drawn.
"""

import json
import sys
import traceback
from pathlib import Path
from typing import Any

from pixel_art_mcp.engine.render import native_render
from pixel_art_mcp.pixel_art import PixelArt


def progress(stage: str, completed: int, total: int) -> None:
    print(
        "PIXEL_PROGRESS " + json.dumps({"stage": stage, "completed": completed, "total": total}),
        flush=True,
    )


def run_script(request: dict[str, Any], output: Path) -> dict[str, Any]:
    scene: dict[str, Any] = {}
    if request.get("input_state"):
        scene = json.loads(Path(request["input_state"]).read_text(encoding="utf-8"))
    script_path = Path(request["script_path"])
    scope = {
        "__name__": "__main__",
        "__file__": str(script_path),
        "scene": scene,
        "reference_images": request["references"],
    }
    exec(compile(script_path.read_text(encoding="utf-8"), str(script_path), "exec"), scope)
    if "pixel_art" in scene:
        options = request.get("authoring_options")
        if not options:
            raise ValueError("Call configure_asset before saving pixel art")
        PixelArt.load(scene).validate_target(
            options["asset_layouts"],
            options["frame_sequence"],
            options["asset"],
        )
    # A script that removes the required pixel_art definition is rejected by the
    # worker (jobs/worker.py), which owns that policy check and its error message.
    (output / "state.json").write_text(json.dumps(scene), encoding="utf-8")
    summary = {"pixel_art": PixelArt.load(scene).to_dict() if "pixel_art" in scene else None}
    return {"summary": summary}


def run_render(request: dict[str, Any], output: Path) -> dict[str, Any]:
    options = request["options"]
    if not options.get("asset"):
        raise ValueError("Use configure_asset, write_pixel_art and render_asset")
    if not request.get("pixel_art"):
        raise ValueError("Call write_pixel_art before rendering")
    art = PixelArt.from_dict(request["pixel_art"])
    art.validate_target(options["asset_layouts"], options["frame_sequence"], options["asset"])
    return native_render(options, output, art, progress)


def main() -> None:
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output = Path(request["output_dir"])
    output.mkdir(parents=True, exist_ok=True)
    if request["operation"] == "script":
        result = run_script(request, output)
    else:
        result = run_render(request, output)
    (output / "result.json").write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.exit(1)
