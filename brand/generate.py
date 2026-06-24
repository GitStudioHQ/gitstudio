#!/usr/bin/env python3
"""Regenerate the GitStudio mark assets (icon, mark, mono, alt G-monogram).

These SVGs are the source of truth for the *mark*. The wordmark lockups
(gitstudio-wordmark-*.svg) embed the "GitStudio" text outlined from
Inter SemiBold (SIL OFL); their embedded mark is kept in sync with the
cube below but the text paths are not rebuilt here.

Usage:  pip install cairosvg   # optional, only needed for PNG export
        python3 generate.py    # writes SVGs (+ PNGs if cairosvg is present)

Everything is plain geometry in a 512x512 box — tweak coordinates below to
iterate on the mark. The primary mark is the **commit cube**: an isometric
cube whose three front seams are a merge-Y (two branches converging into one)
and whose corners are commit nodes. Git's branch/merge graph, built into one
solid object — the unified GitStudio platform. The alternate is a "G" monogram
carrying a commit node.
"""
import os, math

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
# cube face shading: top (light), left (deep purple), right (magenta)
FACES = ('<linearGradient id="fTop" x1="0.1" y1="0" x2="0.7" y2="1">'
  '<stop offset="0%" stop-color="#C3B5FF"/><stop offset="100%" stop-color="#9079F4"/></linearGradient>'
  '<linearGradient id="fLeft" x1="0" y1="0" x2="0" y2="1">'
  '<stop offset="0%" stop-color="#6B57E6"/><stop offset="100%" stop-color="#4A38BE"/></linearGradient>'
  '<linearGradient id="fRight" x1="0" y1="0" x2="0.4" y2="1">'
  '<stop offset="0%" stop-color="#B45EF0"/><stop offset="100%" stop-color="#8E2ECC"/></linearGradient>')
BG = ('<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">'
  f'<stop offset="0%" stop-color="{BG_TOP}"/><stop offset="100%" stop-color="{BG_BOT}"/></linearGradient>'
  '<radialGradient id="bgglow" cx="0.30" cy="0.20" r="0.95">'
  '<stop offset="0%" stop-color="#534B82" stop-opacity="0.55"/>'
  '<stop offset="60%" stop-color="#2A2D3A" stop-opacity="0"/></radialGradient>')
GLOW = ('<filter id="glow" x="-60%" y="-60%" width="220%" height="220%">'
  '<feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/>'
  '<feMergeNode in="SourceGraphic"/></feMerge></filter>')

def squircle():
    return ('<rect width="512" height="512" rx="116" fill="url(#bg)"/>'
            '<rect width="512" height="512" rx="116" fill="url(#bgglow)"/>'
            '<rect x="2" y="2" width="508" height="508" rx="114" fill="none"'
            ' stroke="#fff" stroke-opacity="0.06" stroke-width="3"/>')

def _node(cx, cy, r, f, core=PAPER, glow=False):
    g = ' filter="url(#glow)"' if glow else ''
    return (f'<g{g}><circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="{f}"/>'
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r*0.42:.1f}" fill="{core}"/></g>')

def _cube_pts(cx, cy, R):
    """Isometric cube vertices. E=top, F=upper-right, B=lower-right,
    D=bottom, C=lower-left, G=upper-left, O=front-center (where 3 faces meet)."""
    a = math.cos(math.radians(30))
    return dict(E=(cx, cy-R), F=(cx+a*R, cy-0.5*R), B=(cx+a*R, cy+0.5*R),
                D=(cx, cy+R), C=(cx-a*R, cy+0.5*R), G=(cx-a*R, cy-0.5*R), O=(cx, cy))

def _p(pt): return f"{pt[0]:.1f},{pt[1]:.1f}"

def commit_cube(cx=256, cy=250, R=152, mono=None, core=PAPER):
    """Primary mark: isometric cube; front seams form the merge-Y, corners are commits."""
    p = _cube_pts(cx, cy, R)
    if mono:
        faces = (f'<path d="M{_p(p["E"])} L{_p(p["F"])} L{_p(p["O"])} L{_p(p["G"])} Z" fill="{mono}" fill-opacity="0.30"/>'
                 f'<path d="M{_p(p["F"])} L{_p(p["B"])} L{_p(p["D"])} L{_p(p["O"])} Z" fill="{mono}" fill-opacity="0.62"/>'
                 f'<path d="M{_p(p["O"])} L{_p(p["D"])} L{_p(p["C"])} L{_p(p["G"])} Z" fill="{mono}" fill-opacity="0.46"/>')
        sa = sb = sm = mono; nc = mono; rim_op = 0.0
    else:
        faces = (f'<path d="M{_p(p["E"])} L{_p(p["F"])} L{_p(p["O"])} L{_p(p["G"])} Z" fill="url(#fTop)"/>'
                 f'<path d="M{_p(p["F"])} L{_p(p["B"])} L{_p(p["D"])} L{_p(p["O"])} Z" fill="url(#fRight)"/>'
                 f'<path d="M{_p(p["O"])} L{_p(p["D"])} L{_p(p["C"])} L{_p(p["G"])} Z" fill="url(#fLeft)"/>')
        sa, sb, sm = "url(#fLeft)", "url(#fRight)", "url(#brand)"; nc = core; rim_op = 0.12
    rim = (f'<path d="M{_p(p["E"])} L{_p(p["F"])} L{_p(p["B"])} L{_p(p["D"])} L{_p(p["C"])} L{_p(p["G"])} Z" '
           f'fill="none" stroke="{mono or "#FFFFFF"}" stroke-opacity="{rim_op}" stroke-width="3" stroke-linejoin="round"/>')
    sw = 16
    op = '' if mono else ' stroke-opacity="0.9"'
    spine = (f'<g filter="url(#glow)" fill="none" stroke-width="{sw}" stroke-linecap="round"{op}>'
             f'<path d="M{_p(p["O"])} L{_p(p["G"])}" stroke="{sa}"/>'
             f'<path d="M{_p(p["O"])} L{_p(p["F"])}" stroke="{sb}"/>'
             f'<path d="M{_p(p["O"])} L{_p(p["D"])}" stroke="{sm}"/></g>')
    nodes = (_node(*p["G"],19,sa,nc,glow=True) + _node(*p["F"],19,sb,nc,glow=True)
             + _node(*p["D"],19,sm,nc,glow=True) + _node(*p["O"],23,sm,nc,glow=True))
    return faces + rim + spine + nodes

def g_mark(mono=None, glow=True, core=PAPER):
    """Alternate mark: a 'G' monogram whose spur ends in a commit node."""
    cRing = mono or "url(#brand)"; cBar = mono or "url(#laneB)"; cTop = mono or "url(#laneA)"
    nc = None if mono else core
    sw = 31
    arc = f'<path d="M 366 175 A 122 122 0 1 0 366 337" fill="none" stroke="{cRing}" stroke-width="{sw}" stroke-linecap="round"/>'
    bar = f'<path d="M 366 337 L 366 268 L 286 268" fill="none" stroke="{cBar}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
    nodes = _gnode(366,175,27,cTop,nc) + _gnode(286,268,27,cBar,nc)
    g = f'<g filter="url(#glow)">{arc}{bar}</g>' if glow else f'<g>{arc}{bar}</g>'
    return g + nodes

def _gnode(cx, cy, r, f, core):
    if core is None: return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{f}"/>'
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{f}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r*0.40:.1f}" fill="{core}"/>')

def _pretty(s):
    return s.replace("><", ">\n<")

def doc(inner, defs, w=512, h=512, vb="0 0 512 512"):
    body = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="{vb}"><defs>{defs}</defs>{inner}</svg>')
    return _pretty(body) + "\n"

ICON   = doc(squircle() + commit_cube(),               LANES + FACES + BG + GLOW)
MARK   = doc(commit_cube(),                            LANES + FACES + GLOW)
MONO_W = doc(commit_cube(mono="#FFFFFF"),              LANES + FACES + GLOW)
MONO_K = doc(commit_cube(mono=INK),                   LANES + FACES + GLOW)
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
