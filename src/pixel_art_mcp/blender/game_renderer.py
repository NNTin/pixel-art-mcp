"""Blender-only target rendering; imported by runner after deterministic scene setup."""

import bpy


def native_render(scene, options, output, art, progress):
    manifest = {
        "blender_version": bpy.app.version_string,
        "pixel_art": art.to_dict(),
        "frames": [],
        "camera": {"projection": "native-grid", "views": [], "alignment": "authored pixels"},
    }
    for row, layout in enumerate(options["asset_layouts"]):
        w, h = layout["width"], layout["height"]
        pivot = [w / 2, layout["bottom"]]
        manifest["camera"]["views"].append({**layout, "pivot": pivot, "objects": []})
        image = bpy.data.images.new(
            "NativePixelBase",
            width=w * options["supersampling"],
            height=h * options["supersampling"],
            alpha=True,
        )
        image.pixels[:] = [0.0] * (len(image.pixels))
        image.file_format = "PNG"
        try:
            for frame in options["frame_sequence"]:
                filename = f"view_{row:02d}_frame_{frame:06d}.png"
                image.filepath_raw = str(output / filename)
                image.save()
                manifest["frames"].append(
                    {
                        "filename": filename,
                        "angle": layout["angle"],
                        "frame": frame,
                        "pivot": pivot,
                        "size": [w, h],
                        "pixel_layers": art.poses(layout["angle"], frame),
                    }
                )
                progress(
                    "rendering",
                    len(manifest["frames"]),
                    len(options["frame_sequence"]) * len(options["asset_layouts"]),
                )
        finally:
            bpy.data.images.remove(image)
    return manifest
