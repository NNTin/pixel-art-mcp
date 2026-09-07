import base64
import json
import zipfile

import pytest
from PIL import Image
from pydantic import ValidationError

from pixel_art_mcp.imaging.pixels import export_sheet
from pixel_art_mcp.models import DomainError, RenderOptions


def state_options(**updates):
    return RenderOptions.model_validate(
        {
            "width": 8,
            "height": 8,
            "angles": [0, 90],
            "supersampling": 2,
            "states": [
                {"id": "empty", "name": "Empty", "frame_start": 1, "frame_end": 2, "off_frame": 0},
                {
                    "id": "full",
                    "name": "Full </script>",
                    "frame_start": 11,
                    "frame_end": 12,
                    "off_frame": 10,
                },
            ],
            "pixel_agents": {
                "asset_id": "BARREL",
                "name": "Barrel",
                "footprint_w": 1,
                "footprint_h": 2,
            },
            **updates,
        }
    )


def test_state_export_shared_palette_layout_idle_player_and_combined_package(tmp_path):
    options = state_options()
    assert options.frames() == [1, 2, 11, 12]
    assert options.render_frames() == [1, 2, 11, 12, 0, 10]
    raw = tmp_path / "raw"
    raw.mkdir()
    entries = []
    for angle in options.angles:
        for frame in options.render_frames():
            name = f"{angle}-{frame}.png"
            im = Image.new("RGBA", (16, 16), (frame * 20, int(angle), 128, 255))
            im.save(raw / name)
            entries.append({"angle": angle, "frame": frame, "filename": name, "pivot": [4, 7]})
    out = tmp_path / "out"
    manifest = {"frames": entries, "camera": {"pivot": [4, 7]}, "blender_version": "fixture"}
    export_sheet(raw, out, manifest, options, "p", "r")
    meta = json.loads((out / "spritesheet.json").read_text())
    assert meta["size"] == [16, 32]
    assert [s["id"] for s in meta["states"]] == ["empty", "full"]
    assert len(meta["frames"]) == 8
    assert meta["frames"][4]["rect"] == [0, 16, 8, 8]
    assert meta["frames"][4]["filename"] == "states/full/frames/direction_00_frame_000011.png"
    assert meta["states"][1]["directions"][0]["animation"].startswith("states/full/")
    assert meta["states"][1]["directions"][0]["frame_indices"] == [4, 5]
    assert meta["states"][1]["directions"][0]["row"] == 2
    with Image.open(out / "spritesheet.png") as sheet:
        for frame in meta["frames"]:
            x, y, w, h = frame["rect"]
            with Image.open(out / frame["filename"]) as expected:
                assert sheet.crop((x, y, x + w, y + h)).tobytes() == expected.tobytes()
    for state in options.states:
        child = out / "states" / state.id
        child_meta = json.loads((child / "spritesheet.json").read_text())
        assert child_meta["camera"] == meta["camera"]
        assert child_meta["palette"] == meta["palette"]
        assert child_meta["settings"]["pixel_agents"]["off_frame"] == state.off_frame
        with Image.open(child / "animations/direction_00.apng") as animation:
            assert animation.n_frames == 2
            assert animation.info["duration"] == 200
    html = (out / "preview.html").read_text()
    assert "__PLAYER_DATA__" not in html
    assert "Full </script>" not in html
    data = json.loads(html.split("const data=", 1)[1].split(";", 1)[0])
    assert len(data["states"]) == 2
    assert data["states"][1]["name"] == "Full </script>"
    assert (
        base64.b64decode(data["states"][0]["image"])
        == (out / "states/empty/spritesheet.png").read_bytes()
    )
    assert (
        base64.b64decode(data["states"][1]["highOffImage"])
        == (out / "states/full/comparison/off-high-resolution.png").read_bytes()
    )
    with zipfile.ZipFile(out / "pixel-agents.zip") as archive:
        assert "assets/furniture/BARREL_EMPTY/manifest.json" in archive.namelist()
        assert "assets/furniture/BARREL_FULL/manifest.json" in archive.namelist()
        assert len([n for n in archive.namelist() if n.endswith(".png")]) == 12
    with zipfile.ZipFile(out / "sprites.zip") as archive:
        assert "preview.html" in archive.namelist()
        assert "pixel-agents.zip" in archive.namelist()
        assert "states/full/preview.html" in archive.namelist()
        assert "preview.gif" in archive.namelist()
        assert "states/full/preview.gif" in archive.namelist()
    with Image.open(out / "preview.gif") as gif:
        assert gif.n_frames == len(options.states[0].frames())
        assert gif.info["loop"] == 0
    with Image.open(out / "states/full/preview.gif") as gif:
        assert gif.n_frames == len(options.states[1].frames())
    with pytest.raises(DomainError, match="incomplete or unordered"):
        export_sheet(raw, tmp_path / "bad", {**manifest, "frames": entries[:-1]}, options, "p", "r")


@pytest.mark.parametrize(
    "change",
    [
        {"id": "../escape"},
        {"id": "empty"},
        {"off_frame": None},
        {"frame_end": 13},
        {"frame_end": 8},
    ],
)
def test_invalid_states_rejected_before_render(change):
    values = state_options().model_dump()
    values["states"][1].update(change)
    with pytest.raises(ValidationError):
        RenderOptions.model_validate(values)


def test_overlapping_source_ranges_count_full_output_for_limits(service, monkeypatch):
    options = state_options(
        states=[
            {"id": f"s{i}", "name": f"State {i}", "frame_start": 1, "frame_end": 2, "off_frame": 0}
            for i in range(16)
        ]
    )
    monkeypatch.setattr(service, "revision", lambda *_: {"id": "r"})
    service.settings.max_sheet_pixels = 4000
    with pytest.raises(DomainError, match="pixel limit"):
        service.submit_render("p", options)


def test_generic_static_monochrome_states(tmp_path):
    options = RenderOptions(
        width=8,
        height=8,
        angles=[45],
        supersampling=1,
        states=[
            {"id": "a", "name": "A", "frame_start": 1, "frame_end": 1},
            {"id": "b", "name": "B", "frame_start": 2, "frame_end": 2},
        ],
    )
    raw = tmp_path / "raw"
    raw.mkdir()
    entries = []
    for frame in (1, 2):
        filename = f"{frame}.png"
        Image.new("RGBA", (8, 8), "black").save(raw / filename)
        entries.append({"angle": 45, "frame": frame, "filename": filename, "pivot": [4, 7]})
    export_sheet(
        raw,
        tmp_path / "out",
        {"frames": entries, "camera": {}, "blender_version": "fixture"},
        options,
        "p",
        "r",
    )
    meta = json.loads((tmp_path / "out/spritesheet.json").read_text())
    assert meta["pixel_agents"] is None
    assert meta["columns"] == 1
    assert meta["states"][0]["directions"][0]["animation"] is None
    assert not (tmp_path / "out/pixel-agents.zip").exists()
    assert not (tmp_path / "out/preview.gif").exists()
