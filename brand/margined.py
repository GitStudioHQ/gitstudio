#!/usr/bin/env python3
"""Put a full-bleed icon tile on Apple's macOS icon grid.

macOS app icons are drawn on a 1024 canvas with the rounded tile occupying
824px in the middle (100px transparent margin each side). A tile that fills
the whole canvas renders visibly larger than every neighbour in the Dock —
which is what the desktop app's icon did. This takes a square, edge-to-edge
tile PNG and emits the margined 1024 version used for the pre-macOS-26 .icns
(apps/desktop/build/compile-icon.sh) and the runtime Dock swap (main.ts
dockIconPath).

    python3 brand/margined.py gitstudio-icon-1024.png gitstudio-dock-1024.png

Rasterise the tile first (any renderer that honours the SVG's gradients and
masks — headless Chrome does; cairosvg does not handle the eyelet mask):
    chrome --headless --screenshot=tile.png --window-size=1024,1024 \
           --default-background-color=00000000 file://…/gitstudio-icon.svg
"""
import sys

from PIL import Image, ImageDraw

CANVAS = 1024
TILE = 824
RADIUS = int(TILE * 0.2237)  # Apple's continuous-corner radius, close enough at this size


def margined(src: str, dst: str) -> None:
    art = Image.open(src).convert("RGBA").resize((TILE, TILE), Image.LANCZOS)
    ss = 4  # supersampled mask for a clean corner
    mask = Image.new("L", (TILE * ss, TILE * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, TILE * ss - 1, TILE * ss - 1), radius=RADIUS * ss, fill=255)
    art.putalpha(mask.resize((TILE, TILE), Image.LANCZOS))
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(art, ((CANVAS - TILE) // 2, (CANVAS - TILE) // 2), art)
    out.save(dst)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    margined(sys.argv[1], sys.argv[2])
