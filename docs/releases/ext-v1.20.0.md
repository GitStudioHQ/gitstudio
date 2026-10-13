# GitStudio 1.20.0 — the comparison where you want it

## Choose where the comparison opens

VS Code's diff editor stays the default. Turn on
`gitstudio.merge.useAsDefaultDiffViewer` and GitStudio's side-by-side
comparison opens in its place — and the new `gitstudio.diff.comparisonIn`
setting, a checkbox per place in Settings, says where: VS Code's own diffs
(Source Control, Explorer comparisons, Compare with Saved, the Timeline) and
each of GitStudio's views — the Changes list, the Commit Graph, stashes,
history, blame, compare, worktrees and the push review. Every place is ticked,
so turning the setting on means everywhere; untick the Changes list, for
instance, to keep VS Code's diff editor and its selective-staging menu there.
A diff opened from a GitStudio view takes keyboard focus in the comparison.
Pull request diffs keep VS Code's diff editor, where their review comments
live.

GitStudio's own views following the setting is a community contribution —
thank you, [@billdwhite](https://github.com/billdwhite) (#101, #102).

## Fixed

- **Right-click menus close when you click elsewhere, and fit the view.** In
  the Commit Graph, the Commits view and Worktrees, a menu stayed open after a
  click outside GitStudio, and in a short panel it ran past the bottom with no
  way to reach its last items. It now closes on a click anywhere else, opens
  upward when there is no room below, and scrolls when it is taller than the
  view (#103).
- **A diff opened from one GitStudio view right after another** (Worktrees,
  then the Changes list) opens where the setting says, instead of staying in
  VS Code's diff editor.
