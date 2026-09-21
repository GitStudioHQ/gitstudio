# GitStudio 1.13.0 — filter the graph by branch, and the two reports that were waiting on a release

Three things people asked for, and a stack of fixes that had been sitting on
main since the last release.

## Filter the Commit Graph by branch

On a busy repository the graph shows every local branch, remote branch and tag
at once. Now there is a **Branches** button next to the graph's search box —
and in the Commits sidebar — and the graph rebuilds around only the refs you
tick. Not a highlight of matching tips: the history itself, the way JetBrains'
Git Log and Git Graph do it.

- Presets: **Current branch**, **Current + upstream**, **Local only**, **All**.
- A filter box for repositories with hundreds of branches; local, remote and
  tags in their own groups, the current branch pinned.
- Ref chips follow the selection. Right-click (or ⌥-click) a chip for **Show
  only this branch**, **Add to filter**, **Remove from filter**, **Checkout**.
- Remembered per repository. Revealing a commit the filter hides — from a
  compare, a pull request, or "Show in graph" — says so and offers **Show all
  branches**.

Thanks to @PanAndy for the write-up in #30; it read like a spec, and it was
built as one.

## Compare Branches/Tags stops collapsing your diffs

Expanded file diffs in **Compare Branches/Tags…** closed on their own every 30
seconds to a couple of minutes, on the Changes view's refresh, or when the
window regained focus — with no change to either branch. The panel was
replacing its whole page on every repository event, and VS Code's own periodic
status refresh is one of those. It now repaints only when the comparison
itself changes; open files, the filter and the layout survive the repaints
that do happen, and *Collapse all* sticks. (#24, @brofield)

## Squash and fixup of the latest commit

Interactive rebase refused to fold the newest commit into the one before it —
*"The top commit has nothing above it to fold into"* — while allowing a squash
on the oldest commit, which git cannot run. The check was reading the wrong
end of a newest-first list. Both directions are right now, and a fold whose
target commit is dropped later is flagged on its row instead of failing at the
end. (#27, @glazrtom)

## Also fixed

- **Rebase runner:** a reword with an empty sha matched every commit git asked
  about; a reword queue left by an aborted rebase could be replayed by the
  next rebase of the same branch; a patch already upstream wedged the rebase.
- **Merge editor:** resolving a conflict with no common ancestor added a blank
  line the accepted side never had.
- **Commit graph:** typing in the search box no longer moves the selection on
  every keystroke; j/k move; a refresh drops a selection whose row is gone;
  the CHANGES column's counts line up, and its numbers now cost one git
  process per visible window instead of two per row — with every row
  answered, not only the first sixty; the sidebar Commits view's *Jump to
  HEAD* pages toward a commit that is not loaded yet.
- **AI results panel:** a Markdown link URL containing a quote could inject an
  attribute into the rendered anchor.
- **Crash reports** (anonymous, opt-out) still carried your project path on
  Windows and in paths with spaces. They no longer do.
- **Fast-forward pull without checkout** split a remote named with a slash at
  the first slash.
- **The Changes view** no longer re-checks AI availability on every state push
  or re-sends its full state when nothing changed.

Full changelog: [apps/extension/CHANGELOG.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/extension/CHANGELOG.md).
