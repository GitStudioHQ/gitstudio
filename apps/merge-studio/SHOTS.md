# Listing and walkthrough shots for Merge Studio 1.0.0

The README and the walkthrough reference these. Every one is captured from
the **1.0 build** in real VS Code, never from an intermediate build and never
copied from 0.3.4's `media/screenshots/`, which show a UI this release
replaces ("Accept Left/Right", no colours, no rebase, no Continue). Re-take a
shot whenever the surface it shows changes.

How: an isolated VS Code profile (own `--user-data-dir` and
`--extensions-dir`) with the test VSIX, driven over CDP, launched in the
background and never focused, 2× device pixels, the tab strip and activity
bar in frame. Dark shots in **Default Dark Modern**, light shots in
**Default Light Modern**. Optimise every PNG (`oxipng -o 4 --strip safe`).
Check each capture by DOM, not by eye: no "Accept Left", "Changes from
server", "Your version" or "Screenshot pending" anywhere on screen.

A hidden window paints no NEW frame, so open the window at the size the
capture emulates (the media script's `winsize` before `launch`): with a
viewport override of another size, `Page.captureScreenshot` waits forever.

Content comes from the merge matrix (`scripts/merge-e2e/fixtures.sh` in
gitstudio): `issue12.merge` and `issue12-exact.merge` (the #12 reporter's
repository), plus the product's own Open Sample Merge and Open Sample Diff.

## README (`media/screenshots/`, not shipped in the VSIX)

vsce rewrites these to GitHub URLs pinned to the release tag
(`--baseImagesUrl`, see RELEASING.md), so they must exist in the repository at
that tag. Window 1440×900.

| File | Theme | What it shows |
| --- | --- | --- |
| `media/screenshots/hero.gif` | dark | 1200 px wide, under 8 s and 3 MB. A real rebase started in VS Code's terminal: the sample's three versions of `src/authorizeRequest.ts` as `feature/session-hardening` onto `main`, stopped at commit 2 of 3. The dashboard, Merge…, **All** (the changes only one side made), the wand (the simple conflict), then an arrow and a × on each of the other two conflicts, Apply, Continue Rebase, "Rebase complete". (The wand and one arrow alone leave conflicts open, and Apply then asks first.) |
| `media/screenshots/merge-editor-dark.png` | dark | The sample merge (*Sample: authorizeRequest.ts*) with the legend in words, one entry per colour: Conflict — you choose (orange), Same on both sides — either arrow takes it (green, on both sides), One side only — safe to take (blue), Removed lines (grey). Each open change with its line numbers and its link to the result in the full colour, its lines lighter. One conflict half taken and one change settled, so the half-done look and a settled change's trace are in the shot. |
| `media/screenshots/merge-editor-light.png` | light | The same, in Light Modern (the README's colour section uses this one). |
| `media/screenshots/dashboard-rebase.png` | dark | `issue12-exact`: the dashboard mid-rebase, YOURS test → onto → THEIRS master, "commit 1 of 1", the commit card, f.txt with Accept Yours / Accept Theirs / Merge…, Continue Rebase disabled with its reason. A 1440×560 window: the dashboard fills its pane, footer pinned to the bottom, so a shorter window keeps Abort and Continue next to the list. |
| `media/screenshots/dashboard-done.png` | dark | `issue12-exact` after Accept Yours on f.txt: the step's success card ("Last commit resolved"), the row's pill ("kept yours · test") and Hold to undo, Continue Rebase enabled. 1440×560, as above. |
| `media/screenshots/legend.png` | dark | A tight crop of the legend: the four colours named in words, each with its count. |
| `media/screenshots/no-text-panel.png` | dark | `issue12.merge`, `app/greeting.py` (edited in theirs, deleted in yours): the panel with **Delete the file** and **Accept Theirs**. |
| `media/screenshots/diff.png` | dark | The side-by-side diff of the sample diff. |

## Walkthrough (`media/walkthrough/`, shipped in the VSIX)

900×560 editor areas from a 948×617 window, a dark and a light PNG per step
(`{"dark", "light", "hc", "hcLight"}` in package.json; the high-contrast
themes use the dark and light files).

| Step | Files | Capture |
| --- | --- | --- |
| Resolve a sample conflict | `sample-merge-{dark,light}.png` | The sample merge, fresh (nothing resolved), toolbar and bottom bar in frame. |
| Read the colours | `legend-{dark,light}.png` | The legend, in words, plus one block of each colour: a conflict (orange), the same change on both sides (green), a change on one side only (blue), removed lines (grey). |
| Rebase without swapping sides | `rebase-sides-{dark,light}.png` | The op strip and pane titles mid-rebase: YOURS test on the left, THEIRS master on the right. |
| Finish the whole operation from the dashboard | `dashboard-{dark,light}.png` | The dashboard's rows and footer mid-rebase: Abort Rebase, and Continue Rebase waiting until no file has conflicts. (A rebase offers no Skip at a conflicted stop; cherry-pick, revert and git am do.) |
| Choose your merge editor | `choose-editor-{dark,light}.png` | The first-conflict notification with Turn them off / Not now / Don't ask again. |
| Using GitStudio too? | `gitstudio-{dark,light}.png` | The `gitstudio.merge.autoOpen` setting. |
| Compare two files | `diff-{dark,light}.png` | Two Explorer files compared in Merge Studio's diff. |
| Optional: a JetBrains IDE | `jetbrains-{dark,light}.png` | The `jbMerge.conflictResolver` setting with its two labelled values. |

Do not reuse `media/banner.png` as walkthrough media (POLISH B7).
