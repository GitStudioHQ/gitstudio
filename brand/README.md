<p align="center">
  <img alt="GitStudio" src="gitstudio-icon.svg" width="128">
</p>

<h1 align="center">GitStudio brand kit</h1>

The visual identity for **GitStudio** — a free, open-source, JetBrains-grade Git
experience for VS Code & Cursor. These are the official logo assets; please use
them as-is rather than redrawing or recoloring the mark.

## The mark

An **isometric cube built from a commit graph**. The cube is a **slate** solid —
the unified GitStudio platform — and across its three front faces runs a single
flat **violet merge-Y**: two branches converging into one commit, with a commit
node at every corner. Slate body, violet lines: the branch/merge graph and its
commits stay unmistakably *git* and clearly legible against the body, while the
whole thing still reads as one solid object — every Git tool *merged* into one
platform, a **studio**, not a single feature.

Every line and node is **one violet tone** (`#A98CFF`) on purpose — it reads as a
real commit graph, the colored-history view that makes GitKraken/GitLens *legible*,
which is the experience GitStudio brings to everyone for free.

It builds on **Merge Studio**'s dark-squircle-and-purple identity but sits one level
up as the umbrella brand — the merge that started it all, now a whole structure. An
alternate **G monogram**
([`alt/gitstudio-icon-g.svg`](alt/gitstudio-icon-g.svg)) — a bold "G" carrying a
commit node — is available for contexts that want a pure lettermark.

## Colors

| Token | Hex | Use |
|---|---|---|
| Violet (lines) | `#A98CFF` | **every merge-Y line + commit node** — the one git tone |
| Slate body | `#4E4C6A → #1C1A30` | the three cube faces (light / deep / mid) |
| Node eyelet | *(body shows through)* | each commit node is a big, blunt disc punched with a clean hole — no painted core, no glow |
| Wordmark gradient | `#A98CFF → #8E78F6 → #C36BF0` | "Studio" in the wordmark |
| Ink | `#1B1F2A` | one-color mark on light; "Git" on light |
| Tile gradient | `#1B1B27 → #0C0C16` | the squircle background |

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
