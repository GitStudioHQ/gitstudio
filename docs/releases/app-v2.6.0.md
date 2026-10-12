# GitStudio 2.6.0 — Files changed as a tree

## Files changed as a tree

A commit's details beside the graph have a **View as Tree** / **View as List**
toggle on Files changed. The tree groups the files by folder, folders first,
compacts single-child folders, shows the lines added and removed under each
folder, and still opens a file's diff on a click. The choice is remembered
across commits and restarts, and the list can be walked with the keyboard
too. Thanks to @PanAndy for the idea.

## Fixed

- **Started from a terminal you then closed**, the app spun a CPU core trying
  to write to it and filed crash reports about it. It doesn't any more.
- **Pull says when another worktree has the branch** (or that its folder is
  gone) instead of showing git's refusal.
- **Deleting a branch with unmerged commits asks whether to force it**, in any
  language Git speaks.
- **A repository folder GitStudio isn't allowed to open, or a Git it isn't
  allowed to run**, is said as such instead of "spawn git EACCES".
- **An Actions job without a log** (not there yet, or any more) says so instead
  of "Not found on GitHub."
- **Keys typed in a diff or the code viewer stay in it**: in the Unified diff,
  ← and Esc left the pull request page and ? opened the keyboard shortcuts.
  Typing ? in the merge editor's Result types it.
- **Staging a blank line at the end of a file stages what is on disk**, and a
  line picked by its line number is one line.
- **Fewer crash reports** for git's ordinary answers — a rejected push, a
  missing credential, an unreachable remote — and for *Test connection*
  answers in Settings ▸ AI.
