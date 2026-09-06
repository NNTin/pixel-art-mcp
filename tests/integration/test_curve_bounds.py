"""Regression for Blender recycling evaluated curve-object pointers during iteration."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.blender


def test_many_translated_curves_do_not_reuse_another_objects_bounds(tmp_path):
    binary = os.environ.get("PIXEL_BLENDER_BINARY", "blender")
    if not shutil.which(binary):
        pytest.skip("A real Blender executable is required")
    runner = Path(__file__).resolve().parents[2] / "src/pixel_art_mcp/blender/runner.py"
    script = tmp_path / "bounds.py"
    script.write_text(f"""
import bpy, runpy
from mathutils import Vector
scope = runpy.run_path({str(runner)!r})
bpy.ops.wm.read_factory_settings(use_empty=True)
for i in range(12):
    curve = bpy.data.curves.new(str(i), 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = 0.02
    spline = curve.splines.new('POLY')
    spline.points.add(1)
    spline.points[0].co = (0, 0, i, 1)
    spline.points[1].co = (0.1, 0, i+0.1, 1)
    obj = bpy.data.objects.new(str(i), curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location.z = -i
bpy.context.view_layer.update()
points = scope['evaluated_corners']()
assert points
assert min(p.z for p in points) > -0.05, min(p.z for p in points)
assert max(p.z for p in points) < 0.15, max(p.z for p in points)
print('CURVE_BOUNDS_OK')
""")
    result = subprocess.run(
        [
            binary,
            "--background",
            "--factory-startup",
            "--python-exit-code",
            "1",
            "--python",
            str(script),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CURVE_BOUNDS_OK" in result.stdout
