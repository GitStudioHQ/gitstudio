# GitStudio 1.26.0 — files for several commits

### Added
- **Files changed for several commits.** With two or more commits selected in
  the Commit Graph, the "N commits selected" summary lists the files they
  changed together, as a list or a tree, and a click opens a file's diff
  across them. A run of consecutive commits is shown as one change, the way
  squashing them would make it. For any other selection, each file's diff goes
  from before the first selected commit that changed it to after the last, and
  the summary says it can include commits in between.
  (#161)
- **Highlight changed lines.** An option, off by default:
  `gitstudio.staging.highlightChangedLines` gives added and modified lines a
  full-width background in ordinary editor tabs, and marks where lines were
  removed ("2 lines deleted above"), for themes where the gutter marks are
  easy to miss. Added and removed lines take your theme's diff colours,
  modified lines a blue, and all three can be changed with
  `gitstudio.changedLines.addedBackground`, `.modifiedBackground` and
  `.deletedBackground` in `workbench.colorCustomizations`. Diff editors
  are left as they are, and files not committed yet aren't painted.
  (#160)

### Changed
- **The file whose diff is open stays highlighted in the graph's Files
  changed,** as a list or a tree. Switching to another of the commit's diff
  tabs moves the highlight, and closing the diff clears it. Space opens a
  file's diff and keeps the keyboard in the list, so you can step through
  them. (#158)
- **Crash reports send only what helps fix a failure.** For a failed git
  command: its subcommand and options, never its arguments, and git's error
  lines, not the rest of its output. For an error: its call frames without
  folders, and the system's error code. Failures caused by your network,
  credentials or working tree aren't reported at all. See [PRIVACY.md](https://github.com/GitStudioHQ/gitstudio/blob/main/apps/extension/PRIVACY.md).

### Fixed
- **Tags show in every Show branches scope.** Current branch, Current +
  upstream and Local only drew no tags at all.
  (#159)
- On a branch with no commits yet (an orphan branch, or a fetched repository
  before its first checkout), the Commit Graph shows the other branches
  instead of "No commits yet".
- Windows: an npm-installed `claude`, `codex` or `gemini` CLI now runs (every
  request came back empty), prompts reach the CLI however long they are, and
  Cancel stops the CLI's whole process tree.
- Crash reports no longer carry the names of self-hosted servers, proxies,
  accounts or organisations, and are no longer filed for a cherry-pick or
  revert refused over local changes, proxy failures, unrelated histories, or
  VS Code cancelling a request while a window reloads.
