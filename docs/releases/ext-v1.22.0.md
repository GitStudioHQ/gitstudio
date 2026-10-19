# GitStudio 1.22.0 — stage from the code

## Stage and unstage from the code

Rest the pointer on a changed line, in the editor or on the changed side of a
diff, and a hover offers **Stage change** or **Unstage change** (**Stage the
rest** for a partly staged change). With lines selected it also offers **Stage
selected lines**. It stages exactly what the line-number menu stages, untracked
files included. Turn it off with `gitstudio.staging.hoverActions`, or turn on
`gitstudio.staging.codeLens` for the same links above every change (#87).

The staging marks in the gutter are now dots, not checkboxes: VS Code lets no
extension make a gutter icon clickable, so they only report — grey for
unstaged, half amber for partly staged, green for staged.

## Changelists

Park files you never want to stage or commit, such as a local config, in a
named changelist: right-click a file, a selection or a folder and choose
**Move to Changelist…**, or drag files onto one. Files in a changelist are left
out of Stage All, Commit all and Discard All, and are staged only when you
stage them yourself. Changelists are kept per repository inside `.git` (#122).

## Compare a commit with a branch, tag or SHA

Right-click any commit in the Commit Graph and choose **Compare With…**, then
pick a branch or a tag, or enter a commit SHA. The Compare panel opens on every
difference between the two (#123).

## Fixed

- **A column you turn on shows when there is room.** Ticking SHA in the Commit
  Graph's Columns menu could do nothing; the commit message now gives way
  first, and a column that truly can't fit is named in the menu (#124).
- **The Compare panel names commits by their short SHA.**
