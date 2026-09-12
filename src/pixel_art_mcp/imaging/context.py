"""Offline, approximate webview context. No browser is required by the production server."""

import base64
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


def reference_agent() -> Image.Image:
    """Schematic scale reference, authored here (not copied from the consumer's artwork)."""
    image = Image.new("RGBA", (16, 32))
    draw = ImageDraw.Draw(image)
    for box, color in [
        ((3, 3, 12, 12), "#dbaa79"),
        ((3, 2, 12, 5), "#523b35"),
        ((2, 13, 13, 23), "#597aab"),
        ((3, 24, 6, 29), "#36455a"),
        ((9, 24, 12, 29), "#36455a"),
        ((2, 30, 6, 31), "#242732"),
        ((9, 30, 13, 31), "#242732"),
    ]:
        draw.rectangle(box, fill=color)
    return image


def context_geometry(
    kind: str, layout: dict[str, Any], category: str, angle: int
) -> dict[str, Any]:
    x, y = 48, 32
    if kind != "furniture":
        return {
            "x": 80 - layout["width"] // 2,
            "y": 96 - layout["height"],
            "agent_x": 104,
            "agent_y": 64,
            "agent_in_front": True,
        }
    seat_y = y + layout["background_tiles"] * 16 + 8
    agent_x = x + layout["width"] + 16
    agent_y = y + layout["height"] - 32
    return {
        "x": x,
        "y": y,
        "agent_x": agent_x,
        "agent_y": agent_y,
        "agent_in_front": True,
        "seat_x": x + layout["width"] // 2 - 8,
        "seat_y": seat_y + (6 if category == "chairs" else 0) - 32,
        "seat_in_front": not (category == "chairs" and angle == 180),
    }


def context_image(sprite: Image.Image, spec: dict[str, Any], layout: dict[str, Any]) -> Image.Image:
    geometry = context_geometry(spec["kind"], layout, spec["category"], layout["angle"])
    stage = Image.new(
        "RGBA", (max(160, layout["width"] + 96), max(128, layout["height"] + 80)), "#343e42"
    )
    draw = ImageDraw.Draw(stage)
    for x in range(0, stage.width, 16):
        draw.line((x, 0, x, stage.height), fill="#475153")
    for y in range(0, stage.height, 16):
        draw.line((0, y, stage.width, y), fill="#475153")
    x, y = geometry["x"], geometry["y"]
    if spec["kind"] == "furniture":
        top = y + layout["background_tiles"] * 16
        draw.rectangle(
            (x, top, x + layout["width"] - 1, y + layout["height"] - 1), outline="#ddbd63"
        )
        if spec["placement"] == "surface":
            draw.rectangle((x - 16, y - 1, x + layout["width"] + 15, y + 12), fill="#8c624b")
        if spec["placement"] == "wall":
            draw.rectangle((x - 16, y - 16, x + layout["width"] + 15, y + 12), fill="#7a818b")
    agent = reference_agent()
    if not geometry["agent_in_front"]:
        stage.alpha_composite(agent, (geometry["agent_x"], geometry["agent_y"]))
    stage.alpha_composite(sprite, (x, y))
    if geometry["agent_in_front"]:
        stage.alpha_composite(agent, (geometry["agent_x"], geometry["agent_y"]))
    return stage


def export_context(output: Path, metadata: dict[str, Any]) -> None:
    def encode(path: Path) -> str:
        return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")

    spec, layouts = metadata["asset"], metadata["layouts"]
    by_key = {(e["angle"], e["frame"]): e for e in metadata["frames"]}
    first_clip = next(iter(spec["clips"].values()))
    # Show the actual default pose for animated furniture, including extinguished lamps.
    first_frame = (
        first_clip.get("off_frame")
        if first_clip.get("off_frame") is not None
        else first_clip["frames"][0]
    )
    entry = by_key[(layouts[0]["angle"], first_frame)]
    with Image.open(output / entry["filename"]) as image:
        stage = context_image(image.convert("RGBA"), spec, layouts[0])
    stage.resize((stage.width * 4, stage.height * 4), Image.Resampling.NEAREST).save(
        output / "context.png"
    )
    agent_path = output / "comparison/reference-agent.png"
    reference_agent().save(agent_path)
    data = {
        "spec": spec,
        "playback": metadata["playback"],
        "layouts": layouts,
        "reference": encode(agent_path),
        "package": metadata["package"]["archive"],
        "geometry": {
            str(row["angle"]): context_geometry(spec["kind"], row, spec["category"], row["angle"])
            for row in layouts
        },
        "cells": [
            {**e, "image": encode(output / e["filename"]), "high": encode(output / e["source"])}
            for e in metadata["frames"]
        ],
    }
    template = Path(__file__).with_name("asset_player.html").read_text()
    (output / "preview.html").write_text(
        template.replace("__ASSET_DATA__", json.dumps(data).replace("<", "\\u003c"))
    )
