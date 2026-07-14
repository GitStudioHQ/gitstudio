#!/usr/bin/env python3
"""Generate the platform app icons from the brand mark SVG.

Two shapes, because the platforms disagree:

  * icon.png      — FULL-BLEED 1024. Windows (.ico), Linux, and the VS Code
                    Marketplace all expect the artwork to fill the canvas.
  * icon-mac.png  — 1024 canvas with the art inset to 824x824 (Apple's macOS
                    icon grid: ~10% transparent margin on every side).

The margin is not decoration. macOS scales whatever it's given into the dock
slot, so a full-bleed square renders visibly LARGER than every well-behaved
app next to it. Shipping the same file to both is why GitStudio's dock icon
looked oversized.

Usage:  python3 make-app-icons.py     (needs cairosvg + pillow)
"""
import os
from io import BytesIO

import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# TWO tiles. macOS cannot carry appearance variants inside an .icns, so an
# Electron app adapts the dock icon at runtime (app.dock.setIcon) — which means
# we need a properly-tuned LIGHT mark, not just the dark one on a pale tile.
SRC_DARK = os.path.join(HERE, "gitstudio-icon.svg")
SRC_LIGHT = os.path.join(HERE, "gitstudio-icon-light.svg")

CANVAS = 1024
# Apple's macOS icon grid: the rounded-rect body is 824/1024 of the canvas.
MAC_ART = 824


def render(src: str, size: int) -> Image.Image:
    png = cairosvg.svg2png(url=src, output_width=size, output_height=size)
    return Image.open(BytesIO(png)).convert("RGBA")


def padded(src: str) -> Image.Image:
    """The art inset to Apple's grid inside a transparent 1024 canvas."""
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    art = render(src, MAC_ART)
    off = (CANVAS - MAC_ART) // 2
    canvas.paste(art, (off, off), art)
    return canvas


def main() -> None:
    full = render(SRC_DARK, CANVAS)
    mac = padded(SRC_DARK)
    mac_light = padded(SRC_LIGHT)

    targets = [
        # full-bleed: windows/linux packaged icon + marketplace icon
        (full, os.path.join(REPO, "apps/desktop/build/icon.png")),
        (full, os.path.join(REPO, "apps/extension/media/icon.png")),
        (full, os.path.join(HERE, "gitstudio-icon-1024.png")),
        # mac: padded. The .icns is baked from the dark tile; the dock swaps to
        # the light tile at runtime when the OS is in light appearance.
        (mac, os.path.join(REPO, "apps/desktop/build/icon-mac.png")),
        (mac, os.path.join(HERE, "gitstudio-icon-mac-1024.png")),
        (mac_light, os.path.join(HERE, "gitstudio-icon-light-mac-1024.png")),
    ]
    for img, path in targets:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img.save(path, "PNG")
        print(f"wrote {os.path.relpath(path, REPO)}  {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    main()
