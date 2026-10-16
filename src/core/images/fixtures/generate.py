"""Regenerate original synthetic codec fixtures and Pillow reference RGBA pixels.

Requires Pillow 11.3.0. Not used when running the Zig test suite.
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent
image = Image.new("RGBA", (17, 13))
image.putdata([
    (30 + x * 8, 20 + y * 10, 40 + x * 3 + y * 4, 64 + ((x + y) % 4) * 63)
    for y in range(13) for x in range(17)
])
formats = [
    ("rgba.png", image, {}),
    ("palette.gif", image.convert("RGB"), {}),
    ("baseline.jpg", image.convert("RGB"), {"quality": 90, "subsampling": 0}),
    ("progressive.jpg", image.convert("RGB"), {"quality": 90, "subsampling": 0, "progressive": True}),
    ("gray.jpg", image.convert("L"), {"quality": 90, "progressive": True}),
    ("cmyk.jpg", image.convert("CMYK"), {"quality": 90}),
    ("lossless.webp", image, {"lossless": True}),
    ("lossy.webp", image, {"quality": 85}),
]
for name, source, options in formats:
    path = root / name
    source.save(path, **options)
    with Image.open(path) as reference:
        (root / (name + ".rgba")).write_bytes(reference.convert("RGBA").tobytes())
