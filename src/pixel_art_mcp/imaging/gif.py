"""Animated GIF export shared by pixels.py and states.py.

Frames must already be RGBA with binary alpha (0 or 255, as `pixelate()`
produces) and restricted to the given hex `palette` -- both pixels.py and
states.py already hold such a palette from `shared_palette()`/`pixelate()`,
so no re-quantization against a freshly derived palette is needed here.
One extra palette slot (index `len(palette)`) is reserved for transparency,
which is always available since `RenderOptions.colors` is capped at 255.
"""

from pathlib import Path

from PIL import Image


def _palette_image(colors: list[str]) -> Image.Image:
    palette_image = Image.new("P", (1, 1))
    rgb = [tuple(bytes.fromhex(color[1:])) for color in colors]
    padded = rgb + [rgb[0]] * (256 - len(rgb))
    palette_image.putpalette([channel for color in padded for channel in color])
    return palette_image


def _gif_frame(
    frame: Image.Image, palette_image: Image.Image, transparent_index: int
) -> Image.Image:
    quantized = frame.convert("RGB").quantize(palette=palette_image, dither=Image.Dither.NONE)
    transparent = frame.getchannel("A").point(lambda a: 255 if a == 0 else 0)
    quantized.paste(transparent_index, mask=transparent)
    return quantized


def save_animated_gif(
    frames: list[Image.Image], palette: list[str], fps: float, path: Path
) -> None:
    """Write RGBA `frames` (binary alpha, colors drawn from `palette`) as a looping GIF."""
    transparent_index = len(palette)
    palette_image = _palette_image(palette)
    gif_frames = [_gif_frame(frame, palette_image, transparent_index) for frame in frames]
    gif_frames[0].save(
        path,
        format="GIF",
        save_all=True,
        append_images=gif_frames[1:],
        duration=1000 / fps,
        loop=0,
        disposal=2,
        transparency=transparent_index,
    )
