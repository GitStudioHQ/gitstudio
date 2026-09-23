# Shots to capture for Merge Studio 1.0.0

The README and the walkthrough reference these. None of them is captured yet:
they are taken from the **final 1.0.0 build** (after the polish pass: the new
sample merge, the practice conflict, the colour defaults), never from an
intermediate one, and never copied from 0.3.4's `media/screenshots/`, which
show a UI this release replaces ("Accept Left/Right", no colours, no rebase,
no Continue).

How: an isolated VS Code profile (own `--user-data-dir` and
`--extensions-dir`) driven over CDP, window 1440×900 at 2×, the tab strip in
frame. Dark shots in **Default Dark Modern**, light shots in **Default Light
Modern**. Optimise every PNG (`oxipng -o 4 --strip safe`). Check each capture
by DOM, not by eye: no "Accept Left", "Changes from server" or "Your version"
anywhere on screen.

## README (`media/screenshots/`, not shipped in the VSIX)

vsce rewrites these to GitHub URLs pinned to the release tag
(`--baseImagesUrl`, see RELEASING.md), so they must exist in the repository at
that tag.

| File | Theme | What it shows |
| --- | --- | --- |
| `media/screenshots/hero.gif` | dark | ≤ 8 s, 1200 px wide, ≤ 3 MB. A rebase stops → the dashboard reads "Rebasing feature/session-hardening onto main · commit 2 of 3" → Merge… → the wand and one » → Apply → Continue Rebase → "Rebase complete". |
| `media/screenshots/merge-editor-dark.png` | dark | The sample merge (*Sample: authorizeRequest.ts*) with the legend visible, in words: Conflicts (red; one Resolve simple resolves), Same on both sides (violet), Changed / Added / Removed on one side (blue, green and grey). |
| `media/screenshots/merge-editor-light.png` | light | The same, in Light Modern (the README's colour section uses this one). |
| `media/screenshots/dashboard-rebase.png` | dark | The dashboard mid-rebase: YOURS test → onto → THEIRS master, "commit 1 of 1", the commit card, rows with Accept Yours / Accept Theirs / Merge…, Continue Rebase disabled with its reason. |
| `media/screenshots/dashboard-done.png` | dark | Every file resolved: the success card, pills "kept yours · test", Continue Rebase enabled. |
| `media/screenshots/legend.png` | dark | A tight crop of the legend, "Conflicts · Same on both sides · Changed Added Removed on one side" (also the walkthrough's "Read the colours" media). |
| `media/screenshots/no-text-panel.png` | dark | A modify/delete file: the panel with Keep yours / Keep theirs / Delete the file. |
| `media/screenshots/diff.png` | dark | The side-by-side diff of the sample diff. |

## Walkthrough (`media/walkthrough/`, shipped in the VSIX)

Today each step points at a placeholder SVG. Replace each `"svg": …` in
package.json with an image object — `{"dark": …, "light": …, "hc": …,
"hcLight": …}` — of 900×560 crops, and delete the placeholder.

| Step | Placeholder | Capture |
| --- | --- | --- |
| Resolve a sample conflict | `media/walkthrough/sample-merge.svg` | The sample merge, fresh (nothing resolved), toolbar and bottom bar in frame. |
| Read the colours | `media/walkthrough/legend.svg` | The legend, in words, plus one block of each colour. |
| Rebase without swapping sides | `media/walkthrough/rebase-sides.svg` | The op strip and pane titles mid-rebase: YOURS test on the left, THEIRS master on the right. |
| Finish the whole operation from the dashboard | `media/walkthrough/dashboard.svg` | The dashboard footer: Continue Rebase, Skip this commit, Abort Rebase. |
| Choose your merge editor | `media/walkthrough/choose-editor.svg` | The first-conflict notification with Turn them off / Not now / Don't ask again. |
| Using GitStudio too? | `media/walkthrough/gitstudio.svg` | GitStudio's and Merge Studio's dashboards side by side, or the `gitstudio.merge.autoOpen` setting. |
| Compare two files | `media/walkthrough/diff.svg` | Explorer with two files selected and the context menu's Compare in Merge Studio, then the diff. |
| Optional: a JetBrains IDE | `media/walkthrough/jetbrains.svg` | The `jbMerge.conflictResolver` setting with its two labelled values. |

Do not reuse `media/banner.png` as walkthrough media (POLISH B7).
