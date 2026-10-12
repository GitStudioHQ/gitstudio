# GitStudio 1.19.0 — staging from any diff, and Files changed as a tree

## Stage part of a file from a diff

In a diff — including the one a file in the Changes list opens — right-click ▸
**GitStudio** has **Stage Selected Lines**, **Unstage Selected Lines**, **Stage
Hunk** and **Unstage Hunk** again, and right-clicking a line number (or the
staging mark beside it) offers **Stage or Unstage the Change at This Line**.
They had gone missing from diffs, and all five are in the Command Palette now
too (#87).

**Stage Selected Lines stages the lines you selected**: in an inserted block,
or a block of edited lines that kept its line count, only those lines — the
rule VS Code's own *Stage Selected Ranges* follows. Unstage Selected Lines does
the same in reverse.

A modified file opened from the Changes list now opens on VS Code's own Git
URIs, so VS Code's **+** in the diff gutter and *Stage Selected Ranges* work
there as well. The staging marks keep up with changes staged anywhere else,
and the "scm/inputBox is a proposed menu identifier" error at every start is
gone.

## Files changed as a tree

The commit details pane's **Files changed** header has VS Code's **View as
Tree** / **View as List** toggle. The tree groups a commit's files by folder,
compacts single-child folders, shows each folder's lines added and removed,
and still opens a file's diff on a click. The choice is shared by the
editor-tab and bottom-panel graphs, and both modes work from the keyboard
(#81, thanks to @PanAndy for the idea).

## Open diffs in GitStudio's comparison

A new setting, `gitstudio.merge.useAsDefaultDiffViewer` (off by default),
opens VS Code's diffs of files and Git revisions — Source Control, Compare with
Selected, Compare with Saved, history — in GitStudio's side-by-side
comparison. Diffs GitStudio opens itself, other tools' diffs (pull request
reviews, AI edit reviews) and binary files keep VS Code's diff editor. A
community contribution — thank you, [@billdwhite](https://github.com/billdwhite)
(#83, #86).

## Fixed

- **Pull requests load for a sign-in that can't see teams.** With VS Code's
  GitHub sign-in, the Pull Requests view could say "Couldn't load pull
  requests" and point at token settings on github.com. It loads now; a team
  asked to review shows as "A team" (#82).
- **Copy, cut and paste work in the merge editor's Result** and in the
  editable side of the comparison, and Escape closes the merge editor again.
  Thanks to @billdwhite for the fix (#84, #85).
- **Staging a blank line at the end of a file stages what is on disk.** On
  Windows, a blank line added at the end of a CRLF file could stage a lone
  carriage return or drop the final newline.
- **The graph's Uncommitted changes row offers Commit… and Stash**, instead
  of a commit's menu whose actions failed there.
