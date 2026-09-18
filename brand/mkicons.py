#!/usr/bin/env python3
"""Emit the two brand icon SVGs — the dark tile and a REAL light tile.

Replaces the relevant half of generate.py, which is stale (its geometry is two
revisions behind every shipped asset) and destructive (running it reverts the
mark and strips the node cores). Do not run generate.py; edit this instead.

Two things this fixes, both reported by the owner:

1. THE NODE CIRCLES WERE HOLES. The mark punched `<mask id="holes">` straight
   through the artwork — faces, edges, lanes and discs alike — so each node was
   an eyelet showing whatever sat behind the icon. On a dark tile that reads as
   a dark centre and looks deliberate. On anything lighter the ground comes
   through and the logo changes character: "the light mode lets the gray
   through". The cores are painted now, in the cube's own deepest tone, so the
   mark is self-contained and identical on any ground.

2. THE "LIGHT" VARIANT WAS NOT LIGHT. gitstudio-icon-light.svg was
   byte-identical to the dark one except the tile fill — #17171E against
   #08080C, fifteen values out of 255 — so Settings' Auto / Light / Dark all
   showed the same near-black square. A light tile needs its edges re-inked
   too: white hairlines at 8–42% vanish on a pale ground, so they flip to the
   ink colour at matching weights.

    python3 brand/mkicons.py            # rewrite the two SVGs
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# Geometry, shared by both variants. These weights are the "bold" step: the
# owner asked for bolder lines and circles, and they were chosen by rendering
# the compiled icon at 64 / 96 / 128px and looking, not by taste at 512.
LANE = 33.0          # was 28.5
R_END = 37.0         # was 33.8
R_HUB = 41.5         # was 38.0
CORE = 17.0          # the eyelet, painted rather than punched
CORE_HUB = 19.0
EDGE = 4.6           # cube hairlines; was 3.8
CORE_FILL = "#2A2845"  # the fLeft gradient's bottom stop — "from the cube"

ENDS = [(91.5, 161.0), (420.5, 161.0), (256.0, 446.0)]
HUB = (256.0, 256.0)

DEFS = """<defs>
<linearGradient id="fTop" x1="0.1" y1="0" x2="0.7" y2="1">
<stop offset="0%" stop-color="#7B79A6"/>
<stop offset="100%" stop-color="#5D5B82"/>
</linearGradient>
<linearGradient id="fLeft" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#39375A"/>
<stop offset="100%" stop-color="#2A2845"/>
</linearGradient>
<linearGradient id="fRight" x1="0" y1="0" x2="0.4" y2="1">
<stop offset="0%" stop-color="#55527C"/>
<stop offset="100%" stop-color="#403E63"/>
</linearGradient>
<linearGradient id="lane" gradientUnits="userSpaceOnUse" x1="256.0" y1="66.0" x2="256.0" y2="446.0">
<stop offset="0%" stop-color="#C4ADFF"/>
<stop offset="100%" stop-color="#9A78FF"/>
</linearGradient>
</defs>"""


def mark(edge_ink, edge_op_top, edge_op_hull):
    """The cube and its graph — no tile, no mask."""
    discs = "".join(
        f'<circle cx="{x}" cy="{y}" r="{R_END}" fill="#B49BFF"/>' for x, y in ENDS
    )
    discs += f'<circle cx="{HUB[0]}" cy="{HUB[1]}" r="{R_HUB}" fill="#C2ABFF"/>'
    cores = "".join(
        f'<circle cx="{x}" cy="{y}" r="{CORE}" fill="{CORE_FILL}"/>' for x, y in ENDS
    )
    cores += f'<circle cx="{HUB[0]}" cy="{HUB[1]}" r="{CORE_HUB}" fill="{CORE_FILL}"/>'
    return f"""<g>
<path d="M256.0,66.0 L420.5,161.0 L256.0,256.0 L91.5,161.0 Z" fill="url(#fTop)"/>
<path d="M420.5,161.0 L420.5,351.0 L256.0,446.0 L256.0,256.0 Z" fill="url(#fRight)"/>
<path d="M91.5,161.0 L256.0,256.0 L256.0,446.0 L91.5,351.0 Z" fill="url(#fLeft)"/>
<path d="M256.0,66.0 L420.5,161.0 L256.0,256.0 L91.5,161.0 Z" fill="none" stroke="{edge_ink}" stroke-opacity="{edge_op_top}" stroke-width="{EDGE}" stroke-linejoin="round"/>
<path d="M256.0,66.0 L420.5,161.0 L420.5,351.0 L256.0,446.0 L91.5,351.0 L91.5,161.0 Z" fill="none" stroke="{edge_ink}" stroke-opacity="{edge_op_hull}" stroke-width="{EDGE}" stroke-linejoin="round"/>
<g fill="none" stroke-width="{LANE}" stroke-linecap="round">
<path d="M256.0,256.0 L91.5,161.0" stroke="url(#lane)"/>
<path d="M256.0,256.0 L420.5,161.0" stroke="url(#lane)"/>
<path d="M256.0,256.0 L256.0,446.0" stroke="url(#lane)"/>
</g>
{discs}{cores}
</g>"""


def tile(fill, ring_ink, ring_op):
    return (
        f'<rect width="512" height="512" rx="114" fill="{fill}"/>'
        f'<rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" '
        f'stroke="{ring_ink}" stroke-opacity="{ring_op}" stroke-width="3"/>'
    )


def svg(body):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" '
        f'viewBox="0 0 512 512">{DEFS}{body}</svg>'
    )


VARIANTS = {
    # Dark: white hairlines on a near-black tile, as before but bolder.
    "gitstudio-icon.svg": svg(
        tile("#08080C", "#FFFFFF", 0.08) + mark("#FFFFFF", 0.42, 0.26)
    ),
    # Light: a genuinely light tile. The cube keeps its own violet — it is the
    # brand — but the hairlines flip to ink, because white on #EDEAF7 is
    # invisible, and the tile ring darkens for the same reason.
    "gitstudio-icon-light.svg": svg(
        tile("#EDEAF7", "#1B1F2A", 0.14) + mark("#1B1F2A", 0.26, 0.16)
    ),
}

if __name__ == "__main__":
    for name, content in VARIANTS.items():
        path = os.path.join(HERE, name)
        with open(path, "w") as fh:
            fh.write(content.replace("><", ">\n<"))
        print("wrote", name)
