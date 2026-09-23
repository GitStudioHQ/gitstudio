# Changelog

## 0.4.0 — unreleased

**Heads-up: during a rebase, Yours is now your commit, on the left.** Git calls the branch you're rebasing onto "ours". Merge Studio used to follow git, so your own commit appeared as "Theirs" on the right ([#12](https://github.com/GitStudioHQ/merge-studio/issues/12)). Now Yours is the commit being replayed from your branch and Theirs is the branch you're rebasing onto, with both names on screen. Applying a stash works the same way: your stashed changes are Yours.

### New

- **Continue, Skip and Abort** in the Conflicts dashboard, for merge, rebase, cherry-pick, revert and git am. Continue says why when it can't run yet, and asks before git drops a commit your resolution left empty.
- **Where you are**: "Rebasing test onto master · commit 2 of 3" and the commit being replayed, in the dashboard and above the merge editor.
- **Every kind of change has its own colour**, with a legend: real conflicts, edits both sides made identically, and changes only one side made.
- The wand applies both sides of a conflict whose edits don't overlap.
- `jbMerge.autoApplyNonConflicting` applies every non-conflicting change when a file opens (off unless you turn it on).
- Binary files, and files deleted or added on one side, open a panel with the choices that make sense: keep yours, keep theirs, or delete the file.
- **Stage Changes with Ticks**: stage a changed file one change at a time.
- **Merge Studio: Continue / Skip / Abort Operation** in the Command Palette.
- **Merge Studio: Restore VS Code's Merge Editor** puts back what the first-conflict question turned off.

### Changed

- Merge Studio now shares its merge editor and Conflicts dashboard with GitStudio, so a fix in one reaches both. Your `jbMerge.*` settings and commands keep working.
- With GitStudio installed, GitStudio opens conflicts automatically and Merge Studio stays quiet; Merge Studio's commands still work and open the same screens.
- The question about VS Code's own merge editor now comes at your first conflict, as a notification, and is remembered only once you answer it. It used to be asked once at install, where it was easy to miss.
- Changing the whitespace mode keeps your picks, and asks first when it can't.
- Works in git worktrees: the dashboard follows the worktree's own git directory.
- The dashboard's file list starts over at each step of a rebase.
- git am is recognised as git am, and Abort runs `git am --abort`.
- Badges name the side: "deleted in theirs (master)" rather than git's "deleted by them".
- `jbMerge.conflictResolver`'s `webview` value is now called `embedded`; a user setting is updated for you.
- `jbMerge.jetbrainsPath` can be set in user settings only, never by a workspace.
- JetBrains IDEs are found in their usual install folders on Windows and Linux too, including JetBrains Toolbox.
- The dashboard's links: Report a problem (with your Merge Studio and editor versions filled in), Rate Merge Studio, Sponsor.
- A new Get Started walkthrough.
- Requires VS Code 1.82 (August 2023) or newer. Cursor, Windsurf and VSCodium already meet this.

### Fixed

- Accept Yours / Accept Theirs no longer deletes a file when git fails for another reason, such as a locked index.
- Accepting one side of a conflict where both sides added the file no longer adds a blank line (shared with GitStudio).

Thanks to the reporter of #12.


## 0.3.4 — 2026-06-24

Security hardening and a full README/onboarding refresh — no functional changes to the editor.

- **Patched every open Dependabot and code-scanning alert.** Forced the bundled `dompurify` to 3.4.11 and added an esbuild redirect so monaco's vendored copy is swapped for the patched build at bundle time; bumped the dev-only `esbuild` to `^0.28.1`. `npm audit` is clean and there are no open security alerts.
- **Fixed an XSS sink in the Conflicts dialog.** The branch label was built with `innerHTML`, so a crafted git branch name could inject markup; it's now built from DOM text nodes, with a regression test pinning the no-`innerHTML` invariant. The rendered output is byte-for-byte identical to before.
- **Added a security policy.** A root `SECURITY.md` documents supported versions, private vulnerability reporting, and the threat model.
- **Reworked the README, badges, screenshots, and onboarding.** Repositioned around "the merge editor for VS Code and Cursor," refreshed the badge row (versions, build, no vulnerabilities, support), added new screenshots of larger conflicts, and rebuilt the Get Started sample as a real multi-pane conflict.

## 0.3.3 — 2026-06-22

Bug-fix release for conflict resolution — the previous build mishandled real-world conflicts.

- **The 3-way merge editor showed "0 conflicts" on real conflicts.** Git index stages were read with a malformed ref (`:2:` instead of `:2`), so every stage read failed and the editor fell back to marker reconstruction. For the default (non-diff3) conflict style that left it with no common ancestor, and the editor then skipped building its model entirely — rendering three dead panes. The merge model is now built for every conflict, including ones with no base (add/add, or a baseless fallback), and the stage refs are correct so the true base is recovered.
- **Wrong conflict badge ("deleted on both") on ordinary conflicts.** The Conflicts dialog labelled files from hardcoded `vscode.git` Status-enum numbers, which shift across editor versions (a normal both-modified file showed as "deleted by both" on editors whose enum predated `TYPE_CHANGED`). Badges now come from git's own `status --porcelain=v2` codes, which are version-independent.
- **Accepting a side dropped unchanged lines in modify/delete and asymmetric conflicts.** When one side's change was smaller than the clustered conflict block (e.g. a deleted-by-us file where the other side only edited the body), accepting that side wrote just its change hunk over the whole block — silently removing the passthrough lines it never touched (such as the function's `def` line). Accepting a side now carries its full block region.
- **Conflicts dialog polish.** Uses the editor width better and is a touch denser. The two branches being merged now read clearly: colour-coded **yours** (blue) / **theirs** (lavender) pills with a branch icon, moved to their own full-width row — and a long branch name stays fully visible on one line, reflowing at its `/` path separators only if the panel is too narrow, instead of collapsing onto multiple lines.
- New regression tests: the no-common-ancestor merge model, no-base alignment, porcelain-based badge classification (both-modified → no badge, add/add → "added by both", modify/delete → "deleted by us/them"), and passthrough-preserving accept.

## 0.3.2 — 2026-06-21

- Maintenance release: first publish through the automated GitHub Actions release pipeline (token-free, triggered on a `v*.*.*` tag). No functional changes.

## 0.3.1 — 2026-06-21

- Fixed the header status badges: shields.io retired its VS Marketplace badge type (it rendered "retired badge"), so the Marketplace badge is now a static link badge. The Open VSX badge stays live.
- Restored the **Buy me a coffee** badge to the header row.

## 0.3.0 — 2026-06-13

- New brand identity: a three-column "conflict resolver" logo, an indigo (#6B5BE6) accent, and a cover banner — applied across the marketplace icon, the Conflicts page header, and the README.
- First-run **Get Started** walkthrough with working, zero-setup demos: open a sample 3-way merge or a sample side-by-side diff straight from the checklist (`Merge Studio: Open Sample Merge` / `Open Sample Diff`).
- The Conflicts page picked up the new mark, an indigo primary action, and a subtle support line. (Correction, 0.4.0: it was shown throughout, not only once every conflict was resolved.)
- Refreshed screenshots (merge editor, side-by-side diff, Conflicts page) rendered from the real UI.
- Support the project: ❤️ GitHub Sponsors or ☕ a one-off tip via Revolut.
- Now published under the **GitStudio** publisher (extension id `gitstudio.merge-studio`) on both the VS Code Marketplace and Open VSX.

## 0.2.4 — 2026-06-13

- The branch context pills (yours ⟵ theirs) moved into the header, beside the operation chip — one glanceable line.

## 0.2.3 — 2026-06-13

- Hold-to-undo trimmed to 0.75s — still deliberate, no longer a wait.
- The "merge in progress" chip and the instruction line disappear once every conflict is resolved; the green confirmation owns that state.
- Restricted Mode (untrusted workspaces) is now supported in limited mode: everything works, but the workspace cannot override the JetBrains IDE launcher path.
- Publisher id is now `antonarnaudov` (extension id `antonarnaudov.merge-studio`).

## 0.2.2 — 2026-06-13

- Pre-publish sweep: workspace-trust and virtual-workspace capabilities declared, `extensionKind: ["workspace"]`, Q&A routed to GitHub issues, slimmer vsix (test/CI files excluded), bundled libraries moved to devDependencies.
- README: marketplace screenshots, install/requirements section, and the conflicts-dialog docs caught up with 0.2.x behavior.
- New regression tests: rebase/cherry-pick operation detection, the `git reset --merge` fallback for stash-pop conflicts, MERGE_MSG parsing variants (octopus merges, custom messages), and Conflicts-dialog HTML invariants (CSP nonces, the hidden-attribute fix, the undo hold duration).

## 0.2.1 — 2026-06-13

- Hold-to-undo trimmed to 1.5 seconds.
- Conflicts are detected (and the dialog opens) near-instantly: the extension watches the `.git` operation-state files (MERGE_HEAD, rebase dirs, …) and pokes vscode.git for a re-scan the moment one appears, instead of waiting for its slower watcher.
- The dialog no longer auto-closes when everything is resolved: an animated green check confirmation appears above the (still revertable) file list, with a Close button when you're ready. Committing or aborting the merge still closes it automatically.

## 0.2.0 — 2026-06-13

- Resolved files now STAY in the Conflicts dialog — green-tinted, check-marked, and labeled with how they were settled ("kept yours", "kept theirs", or "merged" for merge-editor/external resolutions).
- Hold-to-undo: every resolved row has an Undo button that must be held for 3 seconds (a fill sweeps the button) before it fires — `git checkout -m` then restores the original conflict, including resolutions made in the merge editor. Covered by new round-trip tests.
- Accept Yours/Theirs is much faster: one fewer git subprocess per accept, the in-progress-operation probe is cached between refreshes, rows update optimistically instead of waiting for VS Code's git watcher, and the extension pokes git for an immediate re-scan.
- When everything is resolved, the dialog keeps the green list around for review/undo and closes itself after a few seconds.

## 0.1.9 — 2026-06-13

- The Accept Left / Accept Right button that settled the merge now shows a green confirmation (check mark + green outline), so it is obvious which side was chosen. Undo and reset revoke it.

## 0.1.8 — 2026-06-13

- Resolution buttons deactivate when they have nothing left to do: Accept Left / Accept Right disable once every change is processed, and the Apply-non-conflicting toolbar actions disable when no non-conflicting changes remain. They re-enable on undo or reset.

## 0.1.7 — 2026-06-13

- Conflict frame edges are now one single path spanning every covered column (left pane, gutter A, result, gutter B, right pane). Previously the line was split per gutter, leaving the bend at the gutter-A/result junction on a path endpoint — which cannot be rounded — so the left side showed sharp corners while the right side was smooth. All bends are interior vertices now, all rounded, verified in the browser harness at retina scale.

## 0.1.6 — 2026-06-13

- Fixed the ribbon stage rendering at its intrinsic 300×150px size: SVG is a replaced element, so `left/right` insets alone don't stretch it — everything beyond ~300px (gutter bands, frame lines over the result and right panes) was silently clipped. The stage now gets explicit width/height. Verified end-to-end in a real-browser harness (`test-harness/`): continuous frame lines across all five columns, band fills, scrolled states, and retina rendering, with path geometry checked numerically.

## 0.1.5 — 2026-06-13

- Bands and conflict frame lines now draw on a single full-width SVG stage spanning all five columns (panes + gutters), in absolute coordinates. The previous per-gutter overlays needed their strokes to escape the gutter box, which browser clipping kept eating — on the stage nothing leaves the viewport, so the frame lines finally render across the editors and their line numbers too.

## 0.1.4 — 2026-06-13

- Restored the frame lines across the editor panes: CSS `clip-path: inset()` clamps negative (expanding) values, so the previous release accidentally clipped the extended lines at the gutter edge. The vertical-only clip now lives inside the SVG, where the clip rect can be arbitrarily wide.
- Rounded the bends of the frame lines and band corners (quadratic joins, 7px radius) for a smoother look; flush corners against the pane highlights stay sharp.
- Gutter buttons trimmed to 16px tall with a 2px radius — clear of the frame lines above and below.

## 0.1.3 — 2026-06-12

- Conflict frame lines are now each a single continuous SVG polyline spanning panes and gutters (drawn by the gutter overlays, extended across the neighboring panes). Previously the pane segments were CSS borders and the gutter segments SVG strokes — two renderers that could land a pixel apart at fractional scroll offsets or display scalings. One path cannot mismatch itself.

## 0.1.2 — 2026-06-12

- Gutter action buttons no longer overflow the band frame: 18px tall (fits a code line) with the wider 20px hit area kept, clamped below the band's top border.
- Disabled scroll animation in all panes — smooth scrolling let the panes and gutter overlays animate through transiently different offsets, visibly detaching bands and frame lines mid-scroll.
- Faster re-alignment after result edits (120ms debounce).

## 0.1.1 — 2026-06-12

- Gutter accept/ignore icons now live inside a straight, rectangular segment of the change band that hugs the side pane (the slant to the result pane starts after it, as in IntelliJ) and are anchored to that pane's rows — they no longer drift out of the color while scrolling.
- Bigger gutter action buttons (20px, 15px icons) and wider merge gutters to fit the icon strip.
- The 2-way diff's transfer arrow gets the same strip treatment.
- Accept-button hover color fixed for light themes.

## 0.1.0 — 2026-06-11 — first release under the Merge Studio name

Renamed to **Merge Studio** (formerly "JetBrains-style Merge & Diff").

- **Conflicts dialog**: auto-opens when any git operation produces conflicts; Accept Yours / Accept Theirs / Merge per file; branch context and live progress; Cancel Merge restores the repository (merge, rebase, cherry-pick, revert); ⚠ status-bar button while conflicts remain.
- **3-way merge editor**: JetBrains-faithful 3-pane layout with curved gutter ribbons, glassy two-intensity highlighting, per-side apply/append/ignore, bulk non-conflicting actions, magic-wand resolution, F7 navigation, whitespace modes.
- **Undo/redo with action history**: ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux), toolbar buttons, and a history dropdown; snapshots cover text, block state, and tracked spans together.
- **Side-by-side diff**: two files or working tree vs HEAD, live re-diff while editing.
- **Real JetBrains IDE integration**: optionally shell out to an installed WebStorm/PyCharm/IntelliJ merge window, auto-detected.
- Embedded editor's Cancel asks: exit the viewer, or cancel the whole merge request.
- Pixel-aligned solid conflict frames across panes and gutters; full-bleed marketplace icon.
