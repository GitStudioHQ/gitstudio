# GitStudio 1.15.0 — stashes and worktrees you can see into, a real Pull Requests view, and several commits at once

Stashes and worktrees stop being boxes you have to open blind, the Pull
Requests view is rebuilt from the ground up, and the ideas in
GitStudioHQ/gitstudio#32 (from @glazrtom) are in: several commits at once,
Drop Commit, the branch menu from the keyboard, Reset to remote and Switch
Repository.

## Stashes, in the Changes view

Under your changes, a **Stashes** group lists every stash — its message,
the branch it was made on, how long ago and how many files — and opens to
every file it holds. Click a file for its diff. **Move** brings a file back
and takes it out of the stash, **Copy** brings it back and leaves the stash
as it is, and a stash's row has **Apply** and **Pop** in words. The separate
Stashes view is gone.

**Drag and drop between them.** Drag a stash onto your changes to apply it
(hold Option or Alt to pop it), drag a stash's files there to move them, and
drag changed files anywhere onto the Stashes group to stash exactly those.
What's under the pointer says what letting go will do.

## Worktrees, rebuilt

Each worktree is a row like a stash's: its folder, then its branch and the
one state that matters (*5 changed*, *2 to push*, *merge in progress*),
with everything else in its tooltip. Open one to see its uncommitted files
and the commits it hasn't pushed, with **Pull** and **Push…** right there
when there is something to move. **Open in New Window** and **More** are on
the row; Remove, Lock, Prune and New Worktree ask before they touch
anything.

## Pull Requests, rebuilt

A new list with Open, Merged, Closed and All, search and filters, checks and
review state at a glance, and pull requests from the repository your fork
came from. Each pull request gets its own page — description, checks,
conversation, files, commits — where you can review, comment, approve and
**Merge**. **New pull request** is one form. **Checkout** puts you on the
pull request's real branch, as `gh pr checkout` does.

## Several commits at once

Select several commits in the Commit Graph with Ctrl/Cmd-click or
Shift-click and act on them together: cherry-pick, revert, squash or drop
them in one go, compare two of them, or copy their SHAs — each undoable. In an interactive rebase, set the
action of every selected commit at once. **Drop Commit…** is in the commit
menu.

## The branch menu from the keyboard

Type to find a branch, ↑/↓ to move, → to open its actions (Checkout, Pull,
Merge, Rebase, **Reset to origin/…** to make it match its remote again), and
Enter to run one. Remote branches are grouped by remote. **Switch
Repository** picks the repository the Changes view shows when a folder
holds several.

## It reads right in Cursor

Cursor's own dark theme made GitStudio's selection, drop targets and a
dialog's main button nearly invisible. They read in every theme now.
Nothing that is selected wears a line any more: it is lit.

## Undo you can trust

Undo puts back what an operation changed and only that — after a conflict,
a rebase that stopped, an amend, a reordered branch — and a deleted branch,
a dropped stash and a popped stash can really be undone.

The full list is in the changelog.
