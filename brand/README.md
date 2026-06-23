<p align="center">
  <img alt="GitStudio" src="gitstudio-icon.svg" width="128">
</p>

<h1 align="center">GitStudio brand kit</h1>

The visual identity for **GitStudio** — a free, open-source, JetBrains-grade Git
experience for VS Code & Cursor. These are the official logo assets; please use
them as-is rather than redrawing or recoloring the mark.

## The mark

Two branches converging into one commit — a **merge**. It stands for the brand's
core promise: the best of every Git tool brought together into one unified,
open project. The lanes are two-toned (purple → magenta) as a nod to the colored
commit graphs that make GitKraken/GitLens history *legible* — the exact
experience GitStudio brings to everyone for free. Just three nodes, every one a
real commit: two sources and the merge.

It builds on **Merge Studio**'s dark-squircle-and-purple identity but sits one
level up as the umbrella brand. An alternate **G monogram**
([`alt/gitstudio-icon-g.svg`](alt/gitstudio-icon-g.svg)) — a bold "G" carrying a
commit node — is available for contexts that want a pure lettermark.

## Colors

| Token | Hex | Use |
|---|---|---|
| Purple (primary) | `#6B5BE6` | brand anchor, gradient start |
| Magenta (secondary) | `#C160EF` | gradient end |
| Gradient | `#9A86FF → #7C64F2 → #C95CEF` | mark lanes, "Studio" wordmark |
| Ink | `#1B1F2A` | one-color mark on light; "Git" on light |
| Paper | `#F5F3FF` | commit-node cores |
| Tile gradient | `#363D4C → #171B23` | the squircle background |

## Typeface

**Inter SemiBold** ([SIL OFL](https://github.com/rsms/inter)), tracking `-1` —
"Git" in ink/white, "Studio" in the brand gradient. (The wordmark lockups embed
text outlined to paths, so they render without Inter installed.)

## What's here

| File | What it is |
|---|---|
| `gitstudio-icon.svg` | **Master mark** — the app icon (dark squircle). Source of truth. |
| `gitstudio-favicon.svg` | Same mark, for favicon use. |
| `gitstudio-mark.svg` | Mark only, transparent background — for dark surfaces. |
| `gitstudio-mark-mono-white.svg` / `-ink.svg` | One-color mark (white on dark, ink on light). |
| `gitstudio-wordmark-dark.svg` / `-light.svg` | Horizontal lockup (mark + GitStudio); dark = light text, light = dark text. |
| `alt/gitstudio-icon-g.svg` | Alternate **G** monogram mark. |
| `generate.py` | Rebuilds every SVG above (and exports PNGs). |

### Generating PNGs

```bash
pip install cairosvg      # for PNG export
python3 generate.py
```

This writes the icon at 1024/512/256/128 px, a 1024 px **org-avatar** export
(upload that as the GitHub organization avatar), `mark-512`, and favicons at
32/16 px. Edit the coordinates in [`generate.py`](generate.py) to iterate on the
mark — it's plain geometry in a 512×512 box. (The wordmark lockups embed outlined
Inter SemiBold and are not rebuilt by that script.)

## Usage

- **Do** keep clear space around the mark of at least one commit-node diameter.
- **Do** use the gradient mark on dark surfaces and `mark-mono-ink` on light ones.
- **Don't** recolor, stretch, or add effects to the mark, and don't rebuild the
  wordmark in another font. Minimum legible size for the mark is ~20 px.

## License

These brand assets are released under the same license as the project. The
**GitStudio** name and logo identify the project; when redistributing or forking,
don't use them in a way that implies official endorsement.
