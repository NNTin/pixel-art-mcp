import colorsys
import json
import math
from collections import Counter, deque
from collections.abc import Iterable
from pathlib import Path
from typing import Any, cast

from PIL import Image

from pixel_art_mcp.models import DomainError


def _color_name(color: tuple[int, int, int]) -> str:
    red, green, blue = (channel / 255 for channel in color)
    hue, saturation, value = colorsys.rgb_to_hsv(red, green, blue)
    if value < 0.2:
        lightness = "very dark"
    elif value < 0.42:
        lightness = "dark"
    elif value > 0.82:
        lightness = "light"
    else:
        lightness = "medium"
    if saturation < 0.12:
        family = "gray"
    else:
        degrees = hue * 360
        if degrees < 15 or degrees >= 345:
            family = "red"
        elif degrees < 45:
            family = "orange"
        elif degrees < 70:
            family = "yellow"
        elif degrees < 165:
            family = "green"
        elif degrees < 200:
            family = "cyan"
        elif degrees < 260:
            family = "blue"
        elif degrees < 300:
            family = "purple"
        else:
            family = "magenta"
    return f"{lightness} {family}"


def _components(indices: list[int | None], width: int, height: int) -> dict[int, list[int]]:
    seen: set[int] = set()
    sizes: dict[int, list[int]] = {}
    for start, color in enumerate(indices):
        if color is None or start in seen:
            continue
        seen.add(start)
        pending = deque([start])
        size = 0
        while pending:
            current = pending.popleft()
            size += 1
            x, y = current % width, current // width
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                neighbor = ny * width + nx
                if (
                    0 <= nx < width
                    and 0 <= ny < height
                    and neighbor not in seen
                    and indices[neighbor] == color
                ):
                    seen.add(neighbor)
                    pending.append(neighbor)
        sizes.setdefault(color, []).append(size)
    return sizes


def _longest_runs(
    indices: list[int | None], width: int, height: int, color: int
) -> tuple[int, int]:
    horizontal = max(
        (
            len(run)
            for y in range(height)
            for run in "".join(
                "1" if indices[y * width + x] == color else " " for x in range(width)
            ).split()
        ),
        default=0,
    )
    vertical = max(
        (
            len(run)
            for x in range(width)
            for run in "".join(
                "1" if indices[y * width + x] == color else " " for y in range(height)
            ).split()
        ),
        default=0,
    )
    return horizontal, vertical


def _selection(
    root: Path, state_id: str | None, angle: float | None, frame: int | None
) -> tuple[dict[str, Any], dict[str, Any], Path, dict[str, str] | None]:
    try:
        metadata = json.loads((root / "spritesheet.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, KeyError) as exc:
        raise DomainError("Sprite export metadata is missing or invalid") from exc
    selected_state = None
    if metadata.get("states"):
        states = metadata["states"]
        if state_id is None:
            selected_state = states[0]
        else:
            selected_state = next((state for state in states if state["id"] == state_id), None)
            if selected_state is None:
                choices = ", ".join(state["id"] for state in states)
                raise DomainError(f"Unknown state {state_id!r}; choose one of: {choices}")
        metadata_path = (root / selected_state["metadata"]).resolve()
        if not metadata_path.is_relative_to(root.resolve()) or metadata_path.suffix != ".json":
            raise DomainError("State sprite metadata has an invalid path")
        try:
            child = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DomainError("State sprite metadata is missing or invalid") from exc
        directory = metadata_path.parent
    else:
        if state_id is not None:
            raise DomainError("This sprite export has no named states")
        child, directory = metadata, root
    angles = [direction["angle"] for direction in child["directions"]]
    selected_angle = angles[0] if angle is None else round(angle % 360, 6)
    if selected_angle not in angles:
        raise DomainError(
            f"Angle {selected_angle:g} is unavailable; choose one of: "
            + ", ".join(f"{value:g}" for value in angles)
        )
    available_frames = [
        entry["frame"] for entry in child["frames"] if entry["angle"] == selected_angle
    ]
    selected_frame = available_frames[0] if frame is None else frame
    entry = next(
        (
            candidate
            for candidate in child["frames"]
            if candidate["angle"] == selected_angle and candidate["frame"] == selected_frame
        ),
        None,
    )
    if entry is None:
        raise DomainError(
            f"Frame {selected_frame} is unavailable at {selected_angle:g} degrees; choose one of: "
            + ", ".join(str(value) for value in available_frames)
        )
    path = (directory / entry["filename"]).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix != ".png":
        raise DomainError("Selected sprite frame has an invalid path")
    state = {"id": selected_state["id"], "name": selected_state["name"]} if selected_state else None
    return child, entry, path, state


def inspect_sprite(
    root: Path, state_id: str | None = None, angle: float | None = None, frame: int | None = None
) -> dict[str, Any]:
    metadata, entry, path, state = _selection(root, state_id, angle, frame)
    try:
        with Image.open(path) as opened:
            image = opened.convert("RGBA")
    except OSError as exc:
        raise DomainError("Selected sprite frame is missing or invalid") from exc
    palette = [
        cast(tuple[int, int, int], tuple(bytes.fromhex(value[1:]))) for value in metadata["palette"]
    ]
    by_color = {color: index for index, color in enumerate(palette)}
    indices: list[int | None] = []
    unknown: Counter[tuple[int, int, int]] = Counter()
    pixels = cast(Iterable[tuple[int, int, int, int]], image.get_flattened_data())
    for red, green, blue, alpha in pixels:
        if alpha == 0:
            indices.append(None)
        elif (red, green, blue) in by_color:
            indices.append(by_color[(red, green, blue)])
        else:
            indices.append(None)
            unknown[(red, green, blue)] += 1
    if unknown:
        raise DomainError("Sprite contains opaque colors outside its declared shared palette")
    width, height = image.size
    occupied = [index for index, value in enumerate(indices) if value is not None]
    if occupied:
        xs, ys = [index % width for index in occupied], [index // width for index in occupied]
        bounds = [min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1]
    else:
        bounds = None
    components = _components(indices, width, height)
    counts = Counter(value for value in indices if value is not None)
    palette_report = []
    for index, color in enumerate(palette):
        count = counts[index]
        if count == 0:
            continue
        positions = [position for position, value in enumerate(indices) if value == index]
        xs, ys = (
            [position % width for position in positions],
            [position // width for position in positions],
        )
        horizontal, vertical = _longest_runs(indices, width, height, index)
        sizes = sorted(components.get(index, []), reverse=True)
        palette_report.append(
            {
                "symbol": f"{index:02X}",
                "hex": f"#{color[0]:02x}{color[1]:02x}{color[2]:02x}",
                "description": _color_name(color),
                "pixels": count,
                "bounds": [min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1],
                "components": len(sizes),
                "singleton_components": sizes.count(1),
                "longest_horizontal_run": horizontal,
                "longest_vertical_run": vertical,
            }
        )
    adjacent: Counter[tuple[int, int]] = Counter()
    for y in range(height):
        for x in range(width):
            current = indices[y * width + x]
            for nx, ny in ((x + 1, y), (x, y + 1)):
                if nx >= width or ny >= height:
                    continue
                other = indices[ny * width + nx]
                if current is not None and other is not None and current != other:
                    pair = cast(tuple[int, int], tuple(sorted((current, other))))
                    adjacent[pair] += 1
    boundaries: list[dict[str, Any]] = []
    for (first, second), edges in adjacent.items():
        distance = math.sqrt(
            sum((palette[first][axis] - palette[second][axis]) ** 2 for axis in range(3))
        )
        boundaries.append(
            {
                "colors": [f"{first:02X}", f"{second:02X}"],
                "rgb_distance": round(distance, 1),
                "shared_edges": edges,
            }
        )
    boundaries.sort(key=lambda item: (item["rgb_distance"], -item["shared_edges"]))
    rows = [
        f"{y:02d} "
        + " ".join(
            ".." if indices[y * width + x] is None else f"{indices[y * width + x]:02X}"
            for x in range(width)
        )
        for y in range(height)
    ]
    return {
        "state": state,
        "angle": entry["angle"],
        "frame": entry["frame"],
        "filename": entry["filename"],
        "size": [width, height],
        "pivot": entry["pivot"],
        "downscale_mode": metadata["settings"].get("downscale_mode", "average"),
        "analysis": {
            "occupied_pixels": len(occupied),
            "transparent_pixels": width * height - len(occupied),
            "occupied_bounds": bounds,
            "opaque_components": sum(len(sizes) for sizes in components.values()),
            "singleton_components": sum(sizes.count(1) for sizes in components.values()),
            "lowest_contrast_boundaries": boundaries[:8],
        },
        "palette": palette_report,
        "grid": {
            "encoding": "Each two-character token is a palette symbol; '..' is transparent. "
            "Rows and coordinates are zero-based from the top-left.",
            "rows": rows,
        },
        "guidance": "Use palette bounds and longest runs to locate small features. Enlarge or "
        "increase the contrast of important Blender objects, then rerender. Crisp mode avoids "
        "palette colors created only by averaging; an explicit palette remains authoritative.",
    }


def compare_inspections(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    if first["size"] != second["size"]:
        raise DomainError("Cannot compare sprite frames with different dimensions")
    first_rows, second_rows = first["grid"]["rows"], second["grid"]["rows"]
    first_tokens = [token for row in first_rows for token in row[3:].split()]
    second_tokens = [token for row in second_rows for token in row[3:].split()]
    pairs = list(zip(first_tokens, second_tokens, strict=True))
    alpha_changes = sum((first == "..") != (second == "..") for first, second in pairs)
    first_colors = {entry["symbol"]: entry["hex"] for entry in first["palette"]}
    second_colors = {entry["symbol"]: entry["hex"] for entry in second["palette"]}
    changed = sum(first_colors.get(first) != second_colors.get(second) for first, second in pairs)
    return {
        "changed_pixels": changed,
        "changed_percent": round(changed / len(first_tokens) * 100, 2),
        "alpha_changed_pixels": alpha_changes,
        "occupied_pixel_delta": second["analysis"]["occupied_pixels"]
        - first["analysis"]["occupied_pixels"],
        "opaque_component_delta": second["analysis"]["opaque_components"]
        - first["analysis"]["opaque_components"],
        "singleton_component_delta": second["analysis"]["singleton_components"]
        - first["analysis"]["singleton_components"],
        "note": "Deltas are second job minus first job. changed_pixels compares resolved hex "
        "colors because palette symbols are local to each export.",
    }
