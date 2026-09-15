"""Composite exact-size authored pixels and audit their final visibility."""

from typing import Any

from PIL import Image


def connected_components(points: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    remaining = points.copy()
    components = []
    while remaining:
        pending = [remaining.pop()]
        component = set(pending)
        while pending:
            x, y = pending.pop()
            for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    component.add(neighbor)
                    pending.append(neighbor)
        components.append(component)
    return components


def component_count(points: set[tuple[int, int]]) -> int:
    return len(connected_components(points))


def largest_component_size(points: set[tuple[int, int]]) -> int:
    return max((len(component) for component in connected_components(points)), default=0)


def composite_features(
    base: Image.Image, patches: list[dict[str, Any]], palette: dict[str, str]
) -> tuple[Image.Image, list[dict[str, Any]]]:
    image = base.copy()
    colors = {key: (*bytes.fromhex(value[1:]), 255) for key, value in palette.items()}
    owner: dict[tuple[int, int], int] = {}
    coverage = []
    for index, patch in enumerate(patches):
        intended = set()
        for y, row in enumerate(patch["rows"]):
            for x, symbol in enumerate(row):
                if symbol == ".":
                    continue
                point = (x + patch["x"], y + patch["y"])
                intended.add(point)
                if 0 <= point[0] < image.width and 0 <= point[1] < image.height:
                    image.putpixel(point, colors[symbol])
                    owner[point] = index
        coverage.append(intended)
    reports = []
    for index, (patch, intended) in enumerate(zip(patches, coverage, strict=True)):
        visible = {point for point, layer in owner.items() if layer == index}
        clipped = sum(not (0 <= x < image.width and 0 <= y < image.height) for x, y in intended)
        components = component_count(visible)
        issues = []
        if clipped:
            issues.append("clipped_feature")
        if len(visible) < patch["min_pixels"]:
            issues.append("feature_pixel_budget")
        if patch["connected"] and components != 1:
            issues.append("disconnected_feature")
        reports.append(
            {
                "name": patch["name"],
                "authored_pixels": len(intended),
                "visible_pixels": len(visible),
                "clipped_pixels": clipped,
                "overwritten_pixels": len(intended) - clipped - len(visible),
                "components": components,
                "min_pixels": patch["min_pixels"],
                "connected": patch["connected"],
                "issues": issues,
                "bounds": [patch["x"], patch["y"], len(patch["rows"][0]), len(patch["rows"])],
            }
        )
    return image, reports
