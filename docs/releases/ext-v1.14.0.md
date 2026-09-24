# GitStudio 1.14.0 — a merge editor that says whether your choice matters, and Continue from where you are

GitStudio and Merge Studio now share one merge editor and one Conflicts
dashboard: install GitStudio and Merge Studio is built in. This release
answers GitStudioHQ/merge-studio#12 point by point, and makes pulling,
pushing and stashing stop handing you git's terminal advice.

## Yours is your commit during a rebase

git swaps "ours" and "theirs" while rebasing, and GitStudio used to follow
it: your own commit showed up as *Theirs*, on the right, and *Accept Yours*
followed by Continue could drop it. Yours is now the commit being replayed
from your branch, on the left, and the panes name the real branches
("Rebasing 1a2b3c4 from test" / "Already rebased commits and commits from
master"). Merges, cherry-picks and reverts are unchanged. After updating,
your first rebase conflict shows a one-time note that the sides have
changed. (GitStudioHQ/merge-studio#12, reported by @Ultraheal)

## The Conflicts dashboard, and Continue / Skip / Abort

*GitStudio: Resolve Conflicts…* — also on the status bar, on the Source
Control view's *Merge Changes* header and on every "git stopped" message —
lists each conflicted file with **Accept Yours**, **Accept Theirs** and
**Merge…**, and hold-to-undo. It says where you are in your own branch
names ("Rebasing test onto master · commit 2 of 3") and offers **Continue**,
**Skip** and **Abort**, named for the operation, with the reason when git
can't go on yet. The Changes view shows the same banner. **Close** leaves the
merge editor without ending the rebase; the file keeps its markers.

## Colours that say whether your choice matters

The merge editor colours each change by the decision it needs, in
JetBrains' merge colours, and its legend says them in words with how many
are left:

- **Conflict — you choose**, orange: both sides changed the same lines,
  differently.
- **Same on both sides — either arrow takes it**, green.
- **One side only — safe to take**, blue.
- **Removed lines**, grey.

A change's line numbers and its link to the result are in the full colour,
its lines in a lighter shade, the words that changed in the full colour.
Once you decide, a trace stays: the side you took keeps its link to the
result, a side you left out keeps only its outline. **Resolve simple**
settles every conflict whose two edits touch but don't overlap.

## Pull, push and stash stop handing you git's advice

- **Diverged branch:** Pull says what happened, in commits, and asks
  **Merge**, **Rebase** or cancel — for that pull only; your `pull.rebase`
  setting is never written. Also with `pull.ff only`.
- **A pull that stops on conflicts** says how many files conflict and offers
  *Resolve Conflicts…* instead of an error.
- **Stash & Retry:** revert, cherry-pick, checkout, merge, rebase, stash
  apply and pull, when your uncommitted changes are in the way, name the
  files and offer to stash them, run, and put them back as they were.
- **Sync could force push over a colleague's commits.** It had just
  fetched, so its lease protected nothing. Every force push is now leased on
  the remote you last saw, and refused when the remote holds work you never
  had.
- **A branch called `-f`** was checked out as `git checkout -f`, discarding
  your uncommitted changes. Option-like branch names are refused everywhere,
  with an offer to rename.
- **A branch and a tag with the same name**: checkout, merge, rebase, rename
  and delete now always act on the branch.

## Also fixed

- An unfinished merge is never saved without its conflict markers, a file
  you already resolved by hand is not overwritten when the merge editor
  opens, and edits made outside it are not written over without asking.
- Accept on a submodule conflict records the right commit; CRLF files stay
  CRLF; accepting a side writes exactly its lines at the start and end of
  a file.
- Conflicts in a linked worktree, and on a non-English git, are noticed.
- The Commit Graph branch filter (#30), after its first release: many
  branches, *Show only*, *Current branch* after a checkout, detached HEAD,
  and revealing a hidden commit offers to add a branch that has it.
- Crash reports no longer carry a repository's name, and no longer file the
  "you're in a state" messages above as crashes.

Full changelog: [apps/extension/CHANGELOG.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/extension/CHANGELOG.md).
