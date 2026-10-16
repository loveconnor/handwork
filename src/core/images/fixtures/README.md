# Codec test fixtures

These original synthetic images contain a 17 × 13 RGBA gradient. They contain no downloaded artwork or personal data. `generate.py` records the pixel formula, format settings, and independent encoder/decoder used to make them.

The checked-in files were generated with Pillow 11.3.0, libjpeg API version 6.2, and libwebp 1.5.0. Each `.rgba` file contains the corresponding image decoded by Pillow as row-major RGBA8 pixels. Tests consume the checked-in bytes and do not require Python or Pillow.

Run `python3 src/core/images/fixtures/generate.py` to regenerate them in an environment with Pillow installed. Encoder/library version changes can change compressed bytes and reference pixels; review regenerated files before accepting them.

The reference comparison requires exact pixels for lossless formats. For JPEG and lossy WebP, it allows a mean absolute channel difference of 3 and a maximum difference of 16 to cover rounding and chroma interpolation differences. Separate tests inject every allocation failure and exercise 512 seeded mutations and truncations with small dimension and pixel limits.
