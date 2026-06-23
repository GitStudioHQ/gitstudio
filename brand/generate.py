#!/usr/bin/env python3
"""Regenerate the GitStudio mark assets (icon, mark, mono, alt G-monogram).

These SVGs are the source of truth for the *mark*. The wordmark lockups
(gitstudio-wordmark-*.svg) embed the "GitStudio" text outlined from
Inter SemiBold (SIL OFL) and are not rebuilt here.

Usage:  pip install cairosvg   # optional, only needed for PNG export
        python3 generate.py    # writes SVGs (+ PNGs if cairosvg is present)

Everything is plain geometry in a 512x512 box — tweak coordinates below to
iterate on the mark. The primary mark is a "merge": two branches converging
into one commit (the unified GitStudio), two-toned to echo a commit graph's
colored lanes. The alternate is a "G" monogram carrying a commit node.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# --- brand palette ---
PURPLE  = "#6B5BE6"   # primary
MAGENTA = "#C160EF"   # secondary
INK     = "#1B1F2A"   # dark / one-color on light
PAPER   = "#F5F3FF"   # node cores
BG_TOP, BG_BOT = "#363D4C", "#171B23"

LANES = ('<linearGradient id="brand" x1="0.05" y1="0" x2="0.95" y2="1">'
  '<stop offset="0%" stop-color="#9A86FF"/><stop offset="52%" stop-color="#7C64F2"/>'
  '<stop offset="100%" stop-color="#C95CEF"/></linearGradient>'
  '<linearGradient id="laneA" x1="0" y1="0" x2="0" y2="1">'
  '<stop offset="0%" stop-color="#A493FF"/><stop offset="100%" stop-color="#6F5AF0"/></linearGradient>'
  '<linearGradient id="laneB" x1="0" y1="0" x2="0" y2="1">'
  '<stop offset="0%" stop-color="#8E76F4"/><stop offset="100%" stop-color="#C95CEF"/></linearGradient>')
BG = ('<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">'
  f'<stop offset="0%" stop-color="{BG_TOP}"/><stop offset="100%" stop-color="{BG_BOT}"/></linearGradient>'
  '<radialGradient id="bgglow" cx="0.30" cy="0.20" r="0.95">'
  '<stop offset="0%" stop-color="#534B82" stop-opacity="0.55"/>'
  '<stop offset="60%" stop-color="#2A2D3A" stop-opacity="0"/></radialGradient>')
GLOW = ('<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">'
  '<feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/>'
  '<feMergeNode in="SourceGraphic"/></feMerge></filter>')

def squircle():
    return ('<rect width="512" height="512" rx="116" fill="url(#bg)"/>'
            '<rect width="512" height="512" rx="116" fill="url(#bgglow)"/>'
            '<rect x="2" y="2" width="508" height="508" rx="114" fill="none"'
            ' stroke="#fff" stroke-opacity="0.06" stroke-width="3"/>')

def _node(cx, cy, r, f, core=PAPER):
    if core is None: return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{f}"/>'
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{f}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r*0.40:.1f}" fill="{core}"/>')

def merge_mark(mono=None, glow=True, core=PAPER):
    """Primary mark: two branches converging into one merge commit."""
    cA = mono or "url(#laneA)"; cB = mono or "url(#laneB)"; cM = mono or "url(#brand)"
    nc = None if mono else core
    sw = 30
    b1 = f'<path d="M 168,168 C 168,252 256,246 256,320" fill="none" stroke="{cA}" stroke-width="{sw}" stroke-linecap="round"/>'
    b2 = f'<path d="M 344,168 C 344,252 256,246 256,320" fill="none" stroke="{cB}" stroke-width="{sw}" stroke-linecap="round"/>'
    nodes = _node(168,168,27,cA,nc) + _node(344,168,27,cB,nc) + _node(256,330,34,cM,nc)
    g = f'<g filter="url(#glow)">{b1}{b2}</g>' if glow else f'<g>{b1}{b2}</g>'
    return g + nodes

def g_mark(mono=None, glow=True, core=PAPER):
    """Alternate mark: a 'G' monogram whose spur ends in a commit node."""
    cRing = mono or "url(#brand)"; cBar = mono or "url(#laneB)"; cTop = mono or "url(#laneA)"
    nc = None if mono else core
    sw = 31
    arc = f'<path d="M 366 175 A 122 122 0 1 0 366 337" fill="none" stroke="{cRing}" stroke-width="{sw}" stroke-linecap="round"/>'
    bar = f'<path d="M 366 337 L 366 268 L 286 268" fill="none" stroke="{cBar}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
    nodes = _node(366,175,27,cTop,nc) + _node(286,268,27,cBar,nc)
    g = f'<g filter="url(#glow)">{arc}{bar}</g>' if glow else f'<g>{arc}{bar}</g>'
    return g + nodes

def _pretty(s):
    return s.replace("><", ">\n<")

def doc(inner, defs, w=512, h=512, vb="0 0 512 512"):
    body = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="{vb}"><defs>{defs}</defs>{inner}</svg>')
    return _pretty(body) + "\n"

ICON   = doc(squircle() + merge_mark(),               LANES + BG + GLOW)
MARK   = doc(merge_mark(),                            LANES + GLOW)
MONO_W = doc(merge_mark(mono="#FFFFFF", glow=False),  LANES)
MONO_K = doc(merge_mark(mono=INK,       glow=False),  LANES)
ALT    = doc(squircle() + g_mark(),                   LANES + BG + GLOW)

OUT = {
    "gitstudio-icon.svg": ICON, "gitstudio-favicon.svg": ICON,
    "gitstudio-mark.svg": MARK,
    "gitstudio-mark-mono-white.svg": MONO_W, "gitstudio-mark-mono-ink.svg": MONO_K,
    "alt/gitstudio-icon-g.svg": ALT,
}
PNGS = {
    "gitstudio-icon-1024.png": (ICON,1024), "gitstudio-avatar-1024.png": (ICON,1024),
    "gitstudio-icon-512.png": (ICON,512), "gitstudio-icon-256.png": (ICON,256),
    "gitstudio-icon-128.png": (ICON,128), "gitstudio-favicon-32.png": (ICON,32),
    "gitstudio-favicon-16.png": (ICON,16), "gitstudio-mark-512.png": (MARK,512),
    "alt/gitstudio-icon-g-512.png": (ALT,512),
}

if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "alt"), exist_ok=True)
    for name, svg in OUT.items():
        open(os.path.join(HERE, name), "w").write(svg)
    try:
        import cairosvg
        for name, (svg, sz) in PNGS.items():
            cairosvg.svg2png(bytestring=svg.encode(), write_to=os.path.join(HERE, name),
                             output_width=sz, output_height=sz)
        print("Wrote SVGs + PNGs.")
    except ImportError:
        print("Wrote SVGs. (pip install cairosvg to also export PNGs.)")
