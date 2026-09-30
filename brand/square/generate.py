#!/usr/bin/env python3
"""Square, full-bleed versions of the GitStudio mark — for avatars (the GitHub
organisation, social profiles) that crop to a circle or a rounded square
themselves and want no transparent corners or baked-in squircle.

Built from gitstudio-icon.svg / gitstudio-mark-mono-white.svg, so the cube and
graph are exactly the app icon's. Render with ../rasterise.sh (Chrome):
  for f in square/*.svg; do ./rasterise.sh "$f" "${f%.svg}-1024.png" 1024; done
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
icon = (HERE.parent / "gitstudio-icon.svg").read_text()
mono = (HERE.parent / "gitstudio-mark-mono-white.svg").read_text()

defs = re.search(r"<defs>(.*?)</defs>", icon, re.S).group(1)
# The icon's cube + graph: the <g> after the tile's two <rect>s.
cube = icon[icon.index("<g>", icon.index("<rect")): icon.rindex("</svg>")].strip()
mono_mask = re.search(r"<mask.*?</mask>", mono, re.S).group(0)
mono_cube = mono[mono.index('<g mask="url(#cubeHoles)">'): mono.rindex("</svg>")].strip()

# The icon's cube spans 54.5..457.5 x 29..483 with its nodes; centre (256, 256).
def placed(inner: str, scale: float, dy: float = 0.0) -> str:
    t = 256 * (1 - scale)
    return f'<g transform="translate({t:.2f},{t + dy:.2f}) scale({scale})">{inner}</g>'

def svg(body: str, extra_defs: str = "") -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
        f"<defs>{defs}{extra_defs}</defs>{body}</svg>\n"
    )

GLOW = (
    '<radialGradient id="glow" cx="50%" cy="47%" r="48%">'
    '<stop offset="0%" stop-color="#7C5CF0" stop-opacity="0.34"/>'
    '<stop offset="100%" stop-color="#7C5CF0" stop-opacity="0"/></radialGradient>'
)
TILE = (
    '<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0%" stop-color="#1B1B27"/><stop offset="100%" stop-color="#0C0C16"/></linearGradient>'
)
VIOLET = (
    '<linearGradient id="violet" x1="0.1" y1="0" x2="0.9" y2="1">'
    '<stop offset="0%" stop-color="#9B82FF"/><stop offset="55%" stop-color="#7457F0"/>'
    '<stop offset="100%" stop-color="#5A36D8"/></linearGradient>'
)
LIGHT = (
    '<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0%" stop-color="#F7F7FB"/><stop offset="100%" stop-color="#E9E8F3"/></linearGradient>'
)

variants = {
    # The app icon's own tile, full-bleed, with a soft violet light behind the cube.
    "gitstudio-square-dark": svg(
        '<rect width="512" height="512" fill="url(#tile)"/>'
        '<rect width="512" height="512" fill="url(#glow)"/>' + placed(cube, 0.70),
        TILE + GLOW,
    ),
    # Same, the mark larger — for a rounded-square crop (GitHub organisations).
    "gitstudio-square-dark-large": svg(
        '<rect width="512" height="512" fill="url(#tile)"/>'
        '<rect width="512" height="512" fill="url(#glow)"/>' + placed(cube, 0.84),
        TILE + GLOW,
    ),
    # The dark tile with no glow behind the cube.
    "gitstudio-square-dark-flat": svg(
        '<rect width="512" height="512" fill="url(#tile)"/>' + placed(cube, 0.70),
        TILE,
    ),
    "gitstudio-square-dark-flat-large": svg(
        '<rect width="512" height="512" fill="url(#tile)"/>' + placed(cube, 0.84),
        TILE,
    ),
    # Plain black, no glow: the crispest at 40px next to other avatars.
    "gitstudio-square-black": svg('<rect width="512" height="512" fill="#000"/>' + placed(cube, 0.74)),
    # The white mark on the brand violet — the loudest, for a profile that should stand out.
    "gitstudio-square-violet": svg(
        '<rect width="512" height="512" fill="url(#violet)"/>' + mono_mask + placed(mono_cube, 0.80, 6),
        VIOLET,
    ),
    # The icon's cube on a light ground.
    "gitstudio-square-light": svg('<rect width="512" height="512" fill="url(#paper)"/>' + placed(cube, 0.74), LIGHT),
}
for name, body in variants.items():
    (HERE / f"{name}.svg").write_text(body)
    print(name)
