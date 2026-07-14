#!/usr/bin/env python3
"""Generate the GitStudio app icons (dark + light tiles) from parametric SVG.

Two hard-won rules live in this file:

1. **Rasterize with a browser, never cairosvg.** The mark punches its commit
   nodes out with an SVG `<mask>`, so the dots are true HOLES showing the tile
   through them. cairosvg silently ignores that mask, which paints the white
   node cores on top and gives every dot an ugly white centre — exactly how the
   1.0.0 dock icon regressed. Chrome renders the mask correctly.

2. **macOS needs padding; nothing else does.** macOS scales whatever it is given
   into the dock slot, so a full-bleed square renders visibly LARGER than every
   well-behaved app beside it. The mac tiles inset the art to 824 in a 1024
   canvas (Apple's icon grid); Windows/Linux/Marketplace stay full-bleed.

Usage:  python3 make-app-icons.py     (needs pillow + playwright-core + Chrome)
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

CANVAS = 1024
MAC_ART = 824  # Apple's macOS icon grid: the body is 824/1024 of the canvas.

# ── the mark, parameterised (authored in a 512 box, scaled at render time) ────
BOX = 512
CX = 256.0
# The cube is scaled UP from the original (it spanned only ~56% of the tile) so
# the mark actually carries at dock size.
TOP_Y, MID_Y, BOT_Y = 64.0, 246.0, 436.0
LEFT_X, RIGHT_X = 92.0, 420.0
UPPER_Y = 155.0
LOWER_Y = 345.0

# ── optical sizing ───────────────────────────────────────────────────────────
# One lane weight cannot serve both a 180px hero and a 48px dock slot: thin
# lanes read as elegant when large and DISAPPEAR when small; thick lanes stay
# legible when small and look clumsy when large. So the same mark ships in two
# weights, and each surface gets the one it needs.
#
#   DISPLAY — welcome hero, Marketplace listing, README. Rendered big.
#   DOCK    — the macOS dock / Windows taskbar. Rendered at 32-64px.
DISPLAY_W = dict(lane=23, node=26, hole=11.0, cnode=29, chole=12.5)
DOCK_W = dict(lane=38, node=37, hole=15.0, cnode=41, chole=17.0)

# Set by weights(); the svg() template reads these.
LANE_W = DISPLAY_W["lane"]
NODE_R = DISPLAY_W["node"]
HOLE_R = DISPLAY_W["hole"]
CENTER_NODE_R = DISPLAY_W["cnode"]
CENTER_HOLE_R = DISPLAY_W["chole"]


def weights(w: dict) -> None:
    """Select the optical weight the next svg() call renders at."""
    global LANE_W, NODE_R, HOLE_R, CENTER_NODE_R, CENTER_HOLE_R
    LANE_W, NODE_R, HOLE_R = w["lane"], w["node"], w["hole"]
    CENTER_NODE_R, CENTER_HOLE_R = w["cnode"], w["chole"]


DARK = {
    "bg_top": "#20202F", "bg_bot": "#0E0E1A",
    "glow": "#4A4480", "glow_edge": "#2A2D3A",
    "hairline": "#ffffff", "hairline_op": "0.07",
    # A lighter cube body than before: at 48px the old slate sank into the dark
    # tile and the whole mark went muddy.
    "f_top": ("#8E8CBC", "#6E6C96"),
    "f_left": ("#454373", "#33315A"),
    "f_right": ("#63608F", "#4B4974"),
    "edge_dark": "#0E0E1A", "edge_dark_op": "0.35",
    "edge_light": "#FFFFFF", "edge_light_op": "0.20",
    "lane": ("#E6DCFF", "#B79EFF"),
    "ring": "#CFBCFF", "center_ring": "#DBCBFF",
}

LIGHT = {
    "bg_top": "#E7E3F3", "bg_bot": "#D2CCE6",
    "glow": "#BFB4E4", "glow_edge": "#C9CBD9",
    "hairline": "#1B1A2E", "hairline_op": "0.14",
    "f_top": ("#7B79A6", "#5D5B82"),
    "f_left": ("#39375A", "#2A2845"),
    "f_right": ("#55527C", "#403E63"),
    "edge_dark": "#14121F", "edge_dark_op": "0.30",
    "edge_light": "#FFFFFF", "edge_light_op": "0.28",
    # Deep brand violet: it must carry on the PALE tile *and* the slate cube —
    # the corner nodes straddle that boundary, and light violet vanished on the
    # tile (that was the "white background hides the lines" complaint).
    "lane": ("#8B75F5", "#6B5BE6"),
    "ring": "#6B5BE6", "center_ring": "#7C64F2",
}


def svg(t: dict) -> str:
    nodes = [(LEFT_X, UPPER_Y), (RIGHT_X, UPPER_Y), (CX, BOT_Y)]
    holes = "".join(
        f'<circle cx="{x}" cy="{y}" r="{HOLE_R}" fill="#000"/>' for x, y in nodes
    )
    holes += f'<circle cx="{CX}" cy="{MID_Y}" r="{CENTER_HOLE_R}" fill="#000"/>'
    rings = "".join(
        f'<circle cx="{x}" cy="{y}" r="{NODE_R}" fill="{t["ring"]}"/>' for x, y in nodes
    )
    rings += (
        f'<circle cx="{CX}" cy="{MID_Y}" r="{CENTER_NODE_R}" fill="{t["center_ring"]}"/>'
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{BOX}" height="{BOX}" viewBox="0 0 {BOX} {BOX}">
<defs>
<linearGradient id="fTop" x1="0.1" y1="0" x2="0.7" y2="1">
<stop offset="0%" stop-color="{t["f_top"][0]}"/><stop offset="100%" stop-color="{t["f_top"][1]}"/>
</linearGradient>
<linearGradient id="fLeft" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="{t["f_left"][0]}"/><stop offset="100%" stop-color="{t["f_left"][1]}"/>
</linearGradient>
<linearGradient id="fRight" x1="0" y1="0" x2="0.4" y2="1">
<stop offset="0%" stop-color="{t["f_right"][0]}"/><stop offset="100%" stop-color="{t["f_right"][1]}"/>
</linearGradient>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="{t["bg_top"]}"/><stop offset="100%" stop-color="{t["bg_bot"]}"/>
</linearGradient>
<radialGradient id="bgglow" cx="0.30" cy="0.20" r="0.95">
<stop offset="0%" stop-color="{t["glow"]}" stop-opacity="0.55"/>
<stop offset="60%" stop-color="{t["glow_edge"]}" stop-opacity="0"/>
</radialGradient>
<linearGradient id="lane" gradientUnits="userSpaceOnUse" x1="{CX}" y1="{UPPER_Y}" x2="{CX}" y2="{BOT_Y}">
<stop offset="0%" stop-color="{t["lane"][0]}"/><stop offset="100%" stop-color="{t["lane"][1]}"/>
</linearGradient>
<mask id="cubeHoles" maskUnits="userSpaceOnUse" x="0" y="0" width="{BOX}" height="{BOX}">
<rect width="{BOX}" height="{BOX}" fill="#fff"/>{holes}
</mask>
</defs>
<rect width="{BOX}" height="{BOX}" rx="116" fill="url(#bg)"/>
<rect width="{BOX}" height="{BOX}" rx="116" fill="url(#bgglow)"/>
<rect x="2" y="2" width="{BOX - 4}" height="{BOX - 4}" rx="114" fill="none" stroke="{t["hairline"]}" stroke-opacity="{t["hairline_op"]}" stroke-width="3"/>
<g mask="url(#cubeHoles)">
<path d="M{CX},{TOP_Y} L{RIGHT_X},{UPPER_Y} L{CX},{MID_Y} L{LEFT_X},{UPPER_Y} Z" fill="url(#fTop)"/>
<path d="M{RIGHT_X},{UPPER_Y} L{RIGHT_X},{LOWER_Y} L{CX},{BOT_Y} L{CX},{MID_Y} Z" fill="url(#fRight)"/>
<path d="M{CX},{MID_Y} L{CX},{BOT_Y} L{LEFT_X},{LOWER_Y} L{LEFT_X},{UPPER_Y} Z" fill="url(#fLeft)"/>
<path d="M{CX},{TOP_Y} L{RIGHT_X},{UPPER_Y} L{RIGHT_X},{LOWER_Y} L{CX},{BOT_Y} L{LEFT_X},{LOWER_Y} L{LEFT_X},{UPPER_Y} Z" fill="none" stroke="{t["edge_dark"]}" stroke-opacity="{t["edge_dark_op"]}" stroke-width="3.5" stroke-linejoin="round"/>
<path d="M{CX},{TOP_Y} L{RIGHT_X},{UPPER_Y} L{CX},{MID_Y} L{LEFT_X},{UPPER_Y} Z" fill="none" stroke="{t["edge_light"]}" stroke-opacity="{t["edge_light_op"]}" stroke-width="3.5" stroke-linejoin="round"/>
<g fill="none" stroke-width="{LANE_W}" stroke-linecap="round">
<path d="M{CX},{MID_Y} L{LEFT_X},{UPPER_Y}" stroke="url(#lane)"/>
<path d="M{CX},{MID_Y} L{RIGHT_X},{UPPER_Y}" stroke="url(#lane)"/>
<path d="M{CX},{MID_Y} L{CX},{BOT_Y}" stroke="url(#lane)"/>
</g>
{rings}
</g>
</svg>'''


def rasterize(svg_text: str, size: int) -> Image.Image:
    """Render via headless Chrome — it honors <mask>; cairosvg does not."""
    with tempfile.TemporaryDirectory() as d:
        # Wrap the SVG in an HTML page: a raw .svg document isn't HTML, so
        # Playwright can't style it — and we need an exact, margin-free canvas.
        html_path = os.path.join(d, "i.html")
        png_path = os.path.join(d, "i.png")
        with open(html_path, "w") as f:
            f.write(
                "<!doctype html><meta charset='utf-8'>"
                "<style>html,body{margin:0;padding:0;background:transparent}"
                f"svg{{width:{size}px;height:{size}px;display:block}}</style>"
                + svg_text
            )
        script = f'''
const {{ chromium }} = require("playwright-core");
(async () => {{
  const b = await chromium.launch({{ channel: "chrome" }});
  const p = await b.newPage({{ viewport: {{ width: {size}, height: {size} }} }});
  await p.goto("file://{html_path}");
  await p.screenshot({{ path: "{png_path}", omitBackground: true }});
  await b.close();
}})();
'''
        subprocess.run(["node", "-e", script], check=True, cwd=REPO, capture_output=True)
        return Image.open(png_path).convert("RGBA").copy()


def padded(svg_text: str) -> Image.Image:
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    art = rasterize(svg_text, MAC_ART)
    off = (CANVAS - MAC_ART) // 2
    canvas.paste(art, (off, off), art)
    return canvas


def main() -> None:
    # DISPLAY weight: the welcome hero, the Marketplace icon, the README.
    weights(DISPLAY_W)
    dark_display, light_display = svg(DARK), svg(LIGHT)
    with open(os.path.join(HERE, "gitstudio-icon.svg"), "w") as f:
        f.write(dark_display)
    with open(os.path.join(HERE, "gitstudio-icon-light.svg"), "w") as f:
        f.write(light_display)
    full_display = rasterize(dark_display, CANVAS)

    # DOCK weight: the macOS dock and the Windows taskbar, seen at 32-64px.
    weights(DOCK_W)
    dark_dock, light_dock = svg(DARK), svg(LIGHT)
    full_dock = rasterize(dark_dock, CANVAS)
    mac, mac_light = padded(dark_dock), padded(light_dock)

    targets = [
        # DISPLAY: shown large — thin lanes read as elegant here.
        (full_display, os.path.join(REPO, "apps/extension/media/icon.png")),
        (full_display, os.path.join(HERE, "gitstudio-icon-1024.png")),
        # DOCK: shown tiny — thick lanes survive. Windows/Linux full-bleed…
        (full_dock, os.path.join(REPO, "apps/desktop/build/icon.png")),
        # …and macOS padded (Apple's icon grid), dark + the light tile the dock
        # swaps to at runtime (an .icns cannot carry appearance variants).
        (mac, os.path.join(REPO, "apps/desktop/build/icon-mac.png")),
        (mac, os.path.join(HERE, "gitstudio-icon-mac-1024.png")),
        (mac_light, os.path.join(HERE, "gitstudio-icon-light-mac-1024.png")),
    ]
    for img, path in targets:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img.save(path, "PNG")
        print(f"wrote {os.path.relpath(path, REPO)}  {img.size[0]}x{img.size[1]}")

    # Guard the bug that shipped once: the dots must be punched HOLES, never
    # white discs. If a renderer ignores the mask again, fail loudly.
    probe = rasterize(dark_dock, 512)
    core = probe.getpixel((int(CX), int(MID_Y)))[:3]
    if sum(core) > 300:
        sys.exit(f"FAIL: dark node cores rendered light {core} — mask ignored.")
    print(f"ok: dark centre node core rgb={core} (a hole, not a white disc)")


if __name__ == "__main__":
    main()
