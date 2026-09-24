# Changelog

## 1.0.0 — unreleased

**Heads-up: during a rebase, Yours is now your commit, on the left.** Git calls the branch you're rebasing onto "ours". Merge Studio used to follow git, so your own commit appeared as "Theirs" on the right, and Accept Yours followed by Continue could drop your only commit ([#12](https://github.com/GitStudioHQ/merge-studio/issues/12)). Now Yours is the commit being replayed from your branch and Theirs is the branch you're rebasing onto, with both names on screen: "Rebasing test onto master · commit 2 of 3". Applying a stash works the same way: your stashed changes are Yours. A merge, a cherry-pick and a revert are unchanged.

Merge Studio 1.0 is built on the same merge editor and Conflicts dashboard as GitStudio, so a fix in one reaches both. Your `jbMerge.*` settings, commands and keybindings keep working.

### The colours

Every change is coloured by what it is, and a legend above the panes names the colours in words, with how many changes are left. Click an item to go to the next change of that kind; the question mark beside it explains every colour and line in words.

- **Conflicts**, in red: both sides changed the same lines, differently. You choose: accept one side, both, or edit the result. **Resolve simple** on the toolbar settles every conflict whose two edits touch but don't overlap, by applying both.
- **Changed** (blue), **Added** (green) or **Removed** (grey): a change that doesn't conflict, coloured by what it did. Coloured on one side only, it is a change only that side made. Safe to take.
- A change coloured on both sides is the same change, made on both sides. Either arrow takes it, and it is settled on both sides at once.

Each change is one continuous band, from its side through the gap between the panes into the result. A conflict with one side taken looks half done: the side you took goes quiet, the result turns pale, and the legend says "Yours taken, Theirs to decide". A change you have settled keeps a muted trace of what you took: the side you took stays faintly coloured and joined to the result, a side you left out keeps only its outline, and when you took both, both stay joined to it. Lines where only whitespace changed have a dotted edge, and a point where lines were added or removed is a thin line. High contrast themes add a solid edge to every change still to decide, and the colours stay apart for the common kinds of colour blindness; the words in the legend and on every control say the same thing without colour.

Every change has the two controls JetBrains IDEs use: an arrow toward the result, and a cross to leave that side out. Each says what it does ("Accept Yours (test) for this conflict"; once the other side is in, "Add Theirs (master) after Yours (test)"), works from the keyboard, and is read the same way by a screen reader.

### Continue, Skip and Abort

- **Continue, Skip and Abort for the whole operation**, for a merge, rebase, cherry-pick, revert and git am, named for it: Continue Rebase, Skip this commit, Abort Rebase. They are in the Conflicts dashboard, below the merge editor once the last file is resolved, and in the Command Palette (*Merge Studio: Continue / Skip / Abort Operation*).
- **Close** leaves the merge editor at any point without ending the operation: the file keeps its conflict markers, git stays stopped where it was, and the Conflicts dashboard opens the file again when you are ready.
- Continue stays disabled, with the reason in words, until git can continue. It asks before git drops a commit your resolution left empty.
- Skip appears only where git offers it. Skip and Abort ask first, in place.
- What happened is said in words: "Commit 2 of 3 skipped; the rest applied — rebase complete", "Last patch skipped. The series is finished, without it", "Rebase complete".
- **Where you are**: "Rebasing test onto master · commit 2 of 3" and the commit being replayed, in the dashboard and above the merge editor.
- git am is recognised as git am, and its Abort runs `git am --abort`. A range of reverts is called a revert and continues as one. When git declines to rewind an Abort (you committed part of a cherry-pick or revert range yourself), it says the branch was left where it is.

### The Conflicts dashboard

- Opens the moment a merge, rebase, cherry-pick or revert stops on conflicts, and lists every conflicted file with **Accept Yours**, **Accept Theirs** and **Merge…**.
- Badges name the side: "deleted in theirs (master)" rather than git's "deleted by them". A submodule is called a submodule and its row names the commit each side points it at; a symbolic link is called one too.
- A binary file, a file deleted or added on one side, a submodule or a symbolic link opens a panel with the choices that make sense: keep yours, keep theirs, or delete the file.
- Resolved files stay in the list, labelled with how they were settled. Hold **Undo** on one (with the mouse, or Enter or Space held down) to bring its conflict back while git is still stopped there.
- The file list starts over at each step of a rebase. Works in git worktrees.
- When everything is done it says so ("Rebase complete"), with Close as a quiet button beside Continue.
- Its links: Report a problem (with your Merge Studio and editor versions filled in) while you work; Rate Merge Studio and Sponsor only once everything is resolved.

### Your work is safe

- **An unfinished merge is never saved without its conflict markers.** Every change in the merge editor goes into the file's editor buffer, and autosave (or Save) wrote it: one accepted change put the original text over every conflict you had not touched yet, with no markers, so `git add` or a later Continue could commit half a merge. Every conflict still open is now written with its markers, named after the two sides, also when you type in the result beside it. Apply writes the finished result, and once it has staged the file its markers never come back.
- **A file already resolved is not overwritten.** If it has no conflict markers left (you fixed it by hand, or git rerere did), the merge editor leaves it alone, says so, and asks before Apply replaces it. A conflict you fixed by hand before opening the merge editor stays as you left it until you settle it there.
- **Edits made outside the merge editor are not written over without asking**: a second tab on the same file, a formatter, a checkout in the terminal.
- **Accept Yours and Accept Theirs no longer delete a file when git fails** for another reason, such as a locked index. Taking a side while the merge editor holds unfinished work no longer asks "Save changes?" over the side you just took.
- **Accept Theirs on a submodule conflict recorded yours.** Taking a side of a submodule now records that side's commit (the submodule's own checkout is left for you to update), and Hold Undo brings a submodule or a symbolic link conflict back.
- **The merge result keeps its line endings.** With Yours in CRLF and Theirs in LF, the editor said the result keeps CRLF but saved LF, changing every line of your file.
- **Accepting a side writes exactly that side's lines**, also at the very start and end of the file: a final newline, a blank last line and a line added after a last line with no newline were lost or doubled. The diff's copy arrow had the same fault, and is fixed with it.
- **Apply non-conflicting changes could lose one side's deletion.** Where both sides rewrote the same line and one of them also deleted the next, the change was taken as "the same on both sides", and the deletion was dropped without a word. Each side is now compared over everything it changed.
- Undo is refused once the operation it belongs to has finished, instead of putting conflict markers back into a finished merge.
- Changing the whitespace mode keeps your picks, and asks first when it can't.
- Handing a conflict to a JetBrains IDE while the merge editor holds unapplied work asks first. A file that is not UTF-8 text, or one reached through a linked folder, is not handed over.

### Also new

- `jbMerge.autoApplyNonConflicting` applies every change only one side made, and every change both sides made the same way, when a file opens (off unless you turn it on). Conflicts are never applied automatically, and Reset returns to that starting point.
- **Stage Changes with Ticks**: stage a changed file one change at a time.
- **Merge Studio: Restore VS Code's Merge Editor** puts back what the first-conflict question turned off.
- **A new sample merge** (*Merge Studio: Open Sample Merge*): a rebase stop on *Sample: authorizeRequest.ts* (commit 2 of 3 of feature/session-hardening onto main) with every kind of change the legend names, both branch names, the step and the commit. Apply says what a real Apply does; Close closes it; running it again starts it over. The sample diff gains a deleted line and a whitespace-only change.
- A new Get Started walkthrough.

### Changed since 0.3.4

- With GitStudio installed, GitStudio opens conflicts automatically and Merge Studio stays quiet, and says so the first time, with a button to let Merge Studio do it instead. Merge Studio's commands still work and open the same screens. An older GitStudio without the Conflicts dashboard changes nothing.
- The question about VS Code's own merge editor now comes at your first conflict, as a notification, and is remembered only once you answer it. It used to be asked once at install, where it was easy to miss. If Merge Studio 0.3 already asked you, you're not asked again.
- **Apply non-conflicting changes** also takes the changes both sides made the same way, and two edits that touch without overlapping are one conflict, as git and JetBrains IDEs see them, which **Resolve simple** settles.
- In Restricted Mode the Extensions view now says why Merge Studio is off: it works through VS Code's built-in Git extension, which Restricted Mode turns off. Trust the folder to use it.
- `jbMerge.conflictResolver`'s `webview` value is now called `embedded`; a user setting is updated for you.
- `jbMerge.jetbrainsPath` can be set in user settings only, never by a workspace, and it can point at the IDE's install folder as well as its launcher.
- JetBrains IDEs are found in their usual install folders on Windows and Linux too, including JetBrains Toolbox and snap installs.
- A file your `.gitattributes` marks `binary` (or `-merge`) opens as a binary conflict, as git treats it.
- Requires VS Code 1.82 (August 2023) or newer. Cursor, Windsurf and VSCodium already meet this.

### Fixed since 0.3.4

- Accepting one side of a conflict where both sides added the file no longer adds a blank line.
- With *Trim* or *Ignore whitespace*, a change that only touched whitespace was dropped, and the result kept the original bytes; it is shown as a change, with a dotted edge. A side that only changed its line endings is no longer a conflict over the whole file, and word highlights under *Ignore whitespace* are drawn at the right columns.
- No notification after Apply: it covered Apply and Continue in the editor's corner, and the editor already says "Merge applied and staged".
- Closing the dashboard keeps it closed for the rest of that stop; it used to come back on the next git event. *Merge Studio: Resolve Conflicts…* opens it again.
- A refresh of the dashboard no longer cancels a Hold Undo you are in the middle of.
- Delete and Abort buttons are readable in light themes (Light Modern's red was below the contrast they need).

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
- The Conflicts page picked up the new mark, an indigo primary action, and a subtle support line. (Correction, 1.0.0: it was shown throughout, not only once every conflict was resolved.)
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
