# Changelog

All notable changes to **GitStudio** are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

GitStudio and Merge Studio now share one merge experience — the same merge
editor, Conflicts dashboard, routing and JetBrains hand-off — so what one
does, the other does. (merge-studio#12)

### Added
- **Conflicts dashboard.** *GitStudio: Resolve Conflicts…* — also a button on
  the Source Control view's *Merge Changes* header, a **Resolve Conflicts**
  item in the status bar, and a button on every "git stopped for you" message
  — lists each conflicted file with **Accept Yours**, **Accept Theirs** and
  **Merge…**, hold-to-undo, and **Continue / Skip / Abort** for the operation,
  named in your branch names ("test → onto → master", "commit 2 of 3"). It
  says where you are in words: "Rebase conflicts", then "Commit 2 of 3
  resolved — Continue Rebase to replay the next commit", or why Continue
  still can't run. Each row says what you kept ("kept yours · test",
  "deleted"). Once every file is resolved, the status bar item stays as
  **Continue Rebase** (or Merge, Cherry-pick, Revert, `git am`) until git
  goes on. When a stash pop's last conflict is resolved it says the stash
  is applied, and that git kept the stash entry for you to drop.
- **Continue, Skip and Abort in the Changes view.** When a merge, rebase,
  cherry-pick, revert, `git am` or stash apply stops, a banner above your
  changes says what stopped and offers the next step. Continue is disabled —
  with the reason — until git can continue; Skip appears only where git
  offers it. The rebase workspace's stop banner gains Skip too.
- **Every change coloured by the decision it needs.** The merge editor's
  legend names its four colours, JetBrains' merge colours, in words, with how
  many changes are left: **Conflict — you choose**, in orange (both sides
  changed the same lines, differently); **Same on both sides — either arrow
  takes it**, in green (both sides made the same change: nothing to choose);
  **One side only — safe to take**, in blue (only one side added or changed
  these lines); and **Removed lines**, in grey (lines removed without a
  conflict). As in JetBrains, a change still to decide has its line numbers
  and its link to the result in the full colour and its lines in a lighter
  shade, with the words that changed in the full colour. Each change is one
  band from its side into the result; a conflict with one side taken looks
  half done, and a settled change keeps a trace of what you took, in the
  lighter shade of its colour: the side you took stays joined to the result,
  a side you left out keeps only its outline, and when you took both, both
  stay joined. Every change has an arrow toward the result and a cross to
  leave it out, each saying what it does ("Accept Yours (test) for
  this conflict"), from the mouse, the keyboard or a screen reader.
  **Resolve simple** on the toolbar settles every conflict whose two edits
  touch but don't overlap, and the legend says how many there are. A change
  the file already had merged outside its conflict markers looks settled,
  with a hover that says where its text came from. It used to colour a
  change by its side alone, so nothing said which conflicts could be settled
  for you.
- **Close** leaves the merge editor at any point without ending the
  operation: the file keeps its conflict markers, git stays stopped where it
  was, and the Conflicts dashboard opens the file again when you are ready.
- **JetBrains IDE hand-off.** New settings `gitstudio.merge.conflictResolver`
  and `gitstudio.merge.diffTool` send merges and diffs to your installed
  JetBrains IDE (`gitstudio.merge.preferredIde`,
  `gitstudio.merge.jetbrainsPath`, which can be the IDE's launcher or its
  install folder; Toolbox and snap installs are found too); its menus appear
  only when an IDE is found, and *Mark Resolved & Stage* stages the result.
- **`gitstudio.merge.autoApplyNonConflicting`** (off by default, as in
  JetBrains IDEs): open the merge editor with every non-conflicting change
  already applied.
- *Compare File…* diffs two files selected in the Explorer directly. New
  palette commands: *Open in Embedded Diff*, *Merge / Diff with JetBrains
  IDE*, *Open Sample Merge*, *Open Sample Diff*, *Continue / Skip / Abort
  Operation*.
- **A sample merge that shows everything** (*Open Sample Merge*): a rebase
  stop on *Sample: authorizeRequest.ts* with every kind of change the
  legend names — conflicts, changes only one side made, and changes both
  sides made the same way — both branch names, the step and the commit. It
  touches no repository: *Apply* says what a real Apply does and *Close*
  closes it.

### Changed
- **During a rebase, Yours is your commit, on the left** — the side
  *Accept Yours* keeps. Pane titles name the real branches ("Rebasing 1a2b3c4
  from test" / "Already rebased commits and commits from master"). Before,
  the left pane held the branch you were rebasing onto, so *Accept Yours*
  could silently drop your only commit on Continue. The buttons below the
  merge editor name the side too ("Accept Yours · test"). If you used
  GitStudio 1.13.0 or earlier, your first rebase or stash conflict after
  updating shows a one-time note that the sides have changed, until you press
  *Got it*.
- **With Merge Studio installed too**, the two extensions show one status bar
  item and one Conflicts dashboard, and a question either one asks at your
  first conflict is asked once between them. When you let Merge Studio open
  conflicts, GitStudio steps back at once. A `jbMerge.*` merge setting you
  set is read while its `gitstudio.merge.*` twin is unset (never `autoOpen`,
  and a JetBrains path only from user settings). An older Merge Studio, which
  still shows a rebase's sides the old way round, is named once, with a
  button to update it.
- A conflicted file the merge editor opens for you keeps one tab: the text
  tab it came from closes, unless it has unsaved changes.
- **`gitstudio.merge.autoOpen` has a new meaning.** It no longer opens every
  conflicted file as its own tab. When an operation stops it shows the
  Conflicts dashboard, opens a conflicted file in the resolver when you
  switch to it, and takes over VS Code's built-in merge editor tab. A file
  whose merge editor you closed does not reopen in it by itself until its
  conflict is gone.
- A conflicted file in the Changes view opens in the merge editor, not in a
  diff full of conflict markers.
- The merge editor's title-bar actions show only on a file with merge
  conflicts.
- The first time a conflict appears, GitStudio asks — in a notification,
  never a modal — whether to turn off VS Code's built-in merge editor and
  conflict highlights, which compete with it: *Turn them off*, *Not now* (asked
  again next time) or *Don't ask again*. Nothing is remembered until you
  answer, the values it changes are saved first, and *GitStudio: Restore VS
  Code's Merge Editor* puts them back (it is also offered when you turn
  `gitstudio.merge.autoOpen` off).
- **Compare File… → HEAD now opens an editable diff with staging ticks.**
  The right side is the file on disk: you can edit it there, and tick changes
  to stage them. It used to be a read-only view.
- `gitstudio.merge.jetbrainsPath` is a **user** setting only: a workspace's own
  settings cannot name the program GitStudio launches.
- Continue / Skip / Abort say what they do per operation — "All patches
  applied.", "Commit 2 of 3 skipped; the rest applied — rebase complete",
  "Last patch skipped. The series is finished, without it" (it used to say
  "All patches applied"), "Stash apply cancelled — the stash is still in your
  list." — in the same words as the Conflicts dashboard, and cancelling
  unmerged files with no operation now warns that anything staged is
  discarded too.
- Opening a conflict in the JetBrains IDE while the merge editor holds
  unapplied work asks first: the IDE starts the merge over, so that work is
  discarded — never left behind to be saved over the IDE's result.
- **Apply non-conflicting changes** also takes the changes both sides made
  the same way, and two edits that touch without overlapping are one
  conflict, as git and JetBrains IDEs see them, which **Resolve simple**
  settles.
- **The status bar's Pull asks "Merge or Rebase?" only when it has to**: when
  your branch and its upstream have both moved on. It used to ask before
  every pull, also on a branch that was only behind.
- The Interactive Rebase panel's stop banner names its buttons ("Continue
  Rebase", "Abort Rebase"), and keeps the keyboard on them when the rebase
  stops again.

### Fixed
- *Apply* said "resolved file saved and staged" even when `git add` failed
  (for example on a stale `index.lock`); it now says the file is saved but
  not staged, and why.
- *Apply* in the merge editor can be undone: hold **Undo** on the file's row
  in the Conflicts dashboard to bring the conflict back while git is still
  stopped there. GitStudio's Undo history cannot record a change while files
  are unmerged, so before this an Apply could not be undone at all. (Apply no
  longer raises a notification: it covered Apply and Continue in the merge
  editor's corner, which already says "Merge applied and staged".)
- **An unfinished merge is never saved without its conflict markers.** The
  merge editor keeps the file's editor buffer in step with the result, and
  autosave (or Save) wrote it: one accepted change put the original text over
  every conflict not yet touched, with no markers, so `git add` or a later
  Continue could commit half a merge. Every conflict still open is written
  with its markers, named after the two sides; *Apply* writes the finished
  result. Opening the merge editor writes nothing, typing in the result
  beside a conflict keeps that conflict's markers, and once *Apply* has
  staged the file its markers never come back.
- **A file already resolved is not overwritten when the merge editor opens.**
  With no conflict markers left in it (fixed by hand, or by git rerere), the
  merge editor leaves the file alone, says so, and asks before *Apply*
  replaces it. A conflict you fixed by hand before opening the merge editor
  stays as you left it until you settle it there.
- **Edits made outside the merge editor are not written over without
  asking**: a second tab on the same file, a formatter, a checkout in the
  terminal.
- **Accept Theirs on a submodule conflict recorded yours.** Taking a side of
  a submodule now records that side's commit (its checkout is left for you to
  update), and holding Undo brings a submodule or a symbolic-link conflict
  back. A submodule conflict is called a submodule — not a "Conflicted binary
  file" — and its row names the commit each side points it at.
- **The merge result keeps its line endings**: with Yours in CRLF and Theirs in
  LF the editor said the result keeps CRLF, then saved LF.
- **Apply non-conflicting changes could lose one side's deletion.** Where both
  sides rewrote the same line and one of them also deleted the next, the
  change was taken as "the same on both sides", and the deletion was dropped
  without a word. Each side is now compared over everything it changed.
- **Accepting a side writes exactly that side's lines**, also at the very
  start and end of the file: a final newline, a blank last line, and a line
  added after a last line with no newline were lost or doubled. The diff's
  copy arrow had the same fault, and is fixed with it.
- With *Trim* or *Ignore whitespace*, a change that only touched whitespace
  was dropped, and the result kept the original bytes; it is shown as a
  change, in the lighter shade, with a hover that says only whitespace
  changed. A side that only changed its line endings is no
  longer a conflict over the whole file, and word highlights under *Ignore
  whitespace* are drawn at the right columns.
- **A range of reverts was called a cherry-pick** once you had committed one of
  them yourself, and its Continue could never work; it is a revert again. And
  when git declines to rewind an Abort (after such a commit), it says the
  branch was left where it is instead of "aborted".
- A refresh of the Conflicts dashboard no longer cancels a Hold Undo in
  progress, and after Continue finishes the operation the dashboard says
  "Rebase complete" without a red "Unmerged files" label over an empty list.
  Its Close button is a secondary one beside Continue.
- **Abort Rebase during `git am`** (the command, the rebase todo's Abort and
  the Interactive Rebase panel's) ran `git rebase --abort`, which git refuses
  there; it now ends the patch series with `git am --abort`.
- Delete and Abort buttons are readable in light themes (Light Modern's red
  was below the contrast they need).
- A file deleted on both sides opens the Conflicts dashboard (where *Delete the
  file* settles it) instead of a text editor on a file that does not exist.
- *Skip* in the rebase workspace reported its outcome twice.
- The JetBrains hand-off passes the same checks as *Apply*: a file that is not
  UTF-8, or one reached through a symlinked folder, is refused instead of
  being handed over and saved back damaged or outside the repository.
- Conflicts in a **linked worktree** were noticed late: GitStudio looked for
  git's operation files in the wrong place there. It now asks git where they
  are.
- On a non-English git, "a rebase is already in progress" and "pull hit
  conflicts" were never detected (they matched git's English messages); they
  now read the state git writes. A stash apply or pop that conflicts is no
  longer reported as an error.
- **Pull failed with git's advice instead of doing something about it.** When
  your branch and its upstream had both moved on and nothing in your git config
  said how to reconcile them, Pull came back with git's own note for a terminal
  — *"You have divergent branches and need to specify how to reconcile them"*,
  followed by three `git config` commands to run. Pull now says what has
  happened, in commits, and offers the choice git is asking for: **Merge**,
  **Rebase**, or cancel. Nothing is changed while the question is open, and
  picking one applies to **that pull only** — your `pull.rebase` setting is
  never written. **Pull using Merge** in the branch menu, the one item that
  had already asked you, no longer walks into the same wall.
- **A pull that stopped on conflicts looked like a failure.** *Pull using
  Rebase* showed git's *"Resolve all conflicts manually… git rebase
  --continue"* as an error, and *Pull using Merge* a bare "pullMerge failed".
  Every pull — the branch menu's and the status bar's Sync and Pull — now says
  how many files conflict, offers *Resolve Conflicts…*, and reveals the Changes
  view, where they wait in their own group. Sync no longer tries to push after
  a pull that stopped.
- **Pull asked "Merge or Rebase?" when it could not reach the remote.** It now
  shows the connection error instead.
- **Sync could force push over someone else's commits.** On a branch where a
  colleague had pushed while you committed, the status bar's **Sync** said
  *"This branch was rewritten"* and offered **Force push**, promising the lease
  would refuse if someone else had pushed. Sync had just fetched, so it would
  not have — their commits would have been deleted from the remote. Sync now
  offers the force only when the commits it replaces are ones you rewrote (an
  amend or a rebase); any other divergence gets the **Merge / Rebase**
  question. The branch menu's **Push** and the push dialog follow the same
  rule. And Sync forces only when the remote is still where you last saw it,
  holding the push to that — so the same commit amended on another machine, or
  a colleague's amend of one of yours, is not overwritten either. Every force
  push (Sync, Push, the push dialog) is also refused when the remote holds a
  version your branch never had, even one a background fetch brought in
  unseen; it says so and offers **Pull** instead.
- **"Rebase onto" over uncommitted changes said it had hit conflicts.** In any
  repository where a rebase had once stopped and then been finished, a rebase
  that git refused because of uncommitted changes was reported as *"Rebase hit
  conflicts"*. It now says which of your changes are in the way, and offers
  **Stash & Retry** (below).
- **Sync and Pull on a detached HEAD showed git's terminal advice as an
  error.** With a commit or a tag checked out, the status bar's **Sync** and
  **Pull** (and the branch menu's pulls) said *"You are not currently on a
  branch… git pull &lt;remote&gt; &lt;branch&gt;"*. They now say there is no
  branch to pull into and offer **Check Out a Branch…**; **Pull** no longer
  asks *Merge or Rebase?* first — and in the middle of a rebase (or over a
  merge in progress) it says that, rather than calling it a detached HEAD.
- **Start Rebase over uncommitted changes** in the rebase panel now says to
  commit or stash them first, before anything is written. With
  `rebase.autoStash` set, git still stashes them and the rebase runs, as
  before.
- **Pull over uncommitted changes showed git's refusal as an error.** When your
  edits were in the pull's way — a file the incoming commits change, or any
  edit when pulling with rebase — every pull door showed git's *"Your local
  changes to the following files would be overwritten by merge"* (or *"cannot
  pull with rebase"*). It now says which files are in the way and offers
  **Stash & Retry** — stash them, pull, and put them back — or **Cancel**.
- **Revert, cherry-pick, checkout, merge, rebase and stash apply over your
  changes showed git's refusal as an error, and sent a crash report.**
  Reverting a commit while you had an edit to a file it touches showed *"Your
  local changes to the following files would be overwritten by merge … fatal:
  revert failed"* in red. Every command that applies commits — the graph's
  Cherry-Pick, Revert and Checkout, the Branches view's Checkout, Merge,
  Rebase onto and Create and Switch, the Changes view's Checkout Revision, a
  pull request's Checkout, and the Stashes view's Apply and Pop — now says
  which of your changes are in the way and offers **Stash & Retry** or
  **Cancel** — also in a window where the Changes view has not been opened
  yet. Stash & Retry puts your changes back as they were, staged ones
  staged; when they can't simply come back, it says which stash they are in.
  Its stash is named after the branch the way you write it ("GitStudio:
  before merging release"). Nothing is sent as a crash report.
- **Stashing chosen files could stash the wrong ones.** A file whose name
  git reads as a pattern — `:notes`, `*draft*`, `a[bc].txt` — was stashed as
  that pattern: the files it matches went into the stash, and the file you
  chose stayed where it was (and Stash & Retry could not clear it out of the
  way). Every file is stashed by its exact name now.
- **"Resolve them and commit" during a rebase.** When a command was refused
  because files still had conflicts, the message told a rebase, cherry-pick,
  revert or `git am` to commit. It names each operation's own way on now
  ("continue the rebase", "commit the merge"), and after a stash pop just
  "resolve them".
- **Taking the file's side of a file/folder conflict deleted the folder.**
  When one side has a file and the other a folder at the same path (a
  `rebase --apply` or `git am` can stop so), *Accept Yours* or *Accept
  Theirs* for the file removed the folder and every file in it, and Continue
  committed the loss. It now changes nothing and says why; taking the side
  without the file keeps the folder.
- A command you cancelled at its question (Stash & Retry's *Cancel*) no
  longer offers **Undo** for a change it never made.
- **Commands pressed while a merge, rebase, cherry-pick, revert or `git am`
  was stopped showed git's refusal — and some changed the stop.** Merge,
  Rebase onto, Checkout, Cherry-Pick, Revert, the Stashes view's Apply and
  Pop, and Pull, Sync or Update, pressed while an operation was waiting for
  you, showed git's *"Merging is not possible because you have unmerged
  files"*, *"Pulling is not possible because you have unmerged files"*, *"You
  have not concluded your merge"* or *"It seems that there is already a
  rebase-merge directory"* in red (and Update asked Merge or Rebase all over
  again); Cherry-Pick and Revert over a resolved stop sent a crash report.
  During a `git am` — and for a pull with rebase during a cherry-pick or
  revert — your resolved files were offered to **Stash & Retry**, which took
  them out of the operation. And a checkout, or a new branch, quietly ended a
  stopped merge, cherry-pick or revert. Each now says what is in progress —
  finish it or abort it first — with **Resolve Conflicts…** while files are
  left to resolve, and a pull reveals the Changes view; a checkout, a new
  branch, a merge, a rebase or a pull is not run over a stopped operation at
  all.
- **With `pull.ff only` in your git config, a diverged branch got git's
  advice.** That setting is one git's own advice suggests, and Sync and Update
  then showed *"Diverging branches can't be fast-forwarded"* and its hints as
  an error. They now ask **Merge** or **Rebase** like any other divergence —
  for that pull only; your setting is left as it is.
- **A branch named like an option could discard your work.** A branch called
  `-f` (git's plumbing and a fetch can make one) was checked out as
  `git checkout -f`, which throws away every uncommitted change, from the
  graph's *Checkout Commit* among others. Every door now refuses it, says why,
  and offers to rename the branch.
- **A branch and a tag with the same name** (`release`, say) were told apart
  only by git's short names, "heads/release" and "tags/release", and several
  commands got the wrong one: checking out the branch left HEAD detached while
  saying it had switched, a merge was recorded as "Merge branch
  'heads/release'", publishing pushed a branch called `heads/release`, and
  rename and delete found no branch at all. Every branch action now names the
  branch exactly; chips, menus, the Branches view and the status bar say
  "release". Checking out a remote branch no longer fails as "ambiguous"
  when a local branch is called `origin/x`.
- The Branches view and the Changes view's branch menu no longer list
  `origin/HEAD` as a remote branch called "origin", whose checkout could only
  fail. The commit details pane and the row's menu no longer offer it either.
- **Commit Graph branch filter (#30), after its first release:** with many
  branches (about 800 on Windows) the filtered graph showed an error instead
  of history; **Show only** a branch you are not on also showed your current
  branch's history; **Current branch** stayed on the old branch after a
  checkout, and **Local only** missed branches made after it was picked; on a
  detached HEAD the graph said "no commits yet" and the sidebar lost *Jump to
  HEAD*; a new filter opened far down the list and loaded every page; a plain
  click on a chip in the graph did nothing. The commit details pane's chips
  now open the same menu as the graph's; revealing a commit the filter hides
  offers to add a branch that has it (*Add main to the filter*) before **Show
  all branches**; the filter is one choice per repository, however the folder
  was opened; *Jump to HEAD* shows only when HEAD can be in the filtered
  graph; the sidebar's Branches picker fits a narrow sidebar; and the
  pickers' muted text is readable in Light+ and Dark+.
- **Crash reports no longer carry a repository's name** when an error message
  quotes it (GitHub's "Could not resolve to a Repository with the name …"
  did), or a quoted path.

## [1.13.0] - 2026-09-21

### Added
- **Filter the Commit Graph by branch.** A **Branches** picker in the graph's
  toolbar — and in the Commits sidebar — rebuilds the graph around only the
  refs you tick, JetBrains Git Log / Git Graph style, instead of every branch,
  remote and tag at once. Presets for **Current branch**, **Current + upstream**,
  **Local only** and **All**; a filter box for busy repositories; ref chips
  follow the selection; right-click (or ⌥-click) a chip for **Show only this
  branch** / **Add to filter** / **Remove from filter** / **Checkout**. The
  selection is remembered per repository. Revealing a commit the filter hides
  says so and offers **Show all branches**. (#30)
- **Show in Graph from the blame hover.** The inline blame hover's commit line
  gains a *Show in Graph* link beside *Copy SHA*. Thanks to @XEGARE. (#28)

### Fixed
- **Interactive rebase refused to fold the newest commit into the one before
  it** — "The top commit has nothing above it to fold into" — while allowing a
  squash on the oldest commit, which git cannot run. The guard checked the
  wrong end of a newest-first list. A fold whose target commit is later
  dropped is now flagged on its row instead of silently orphaned, and the
  rebase workspace selects commits the way the graph does (`--no-merges
  --topo-order --cherry-pick --right-only`), so it no longer builds plans git
  refuses. (#27)
- **Compare Branches/Tags collapsed every open file diff on its own** — every
  30 seconds to a couple of minutes, on the Changes view's refresh, or when the
  window regained focus, with no change to either branch. The panel replaced
  its whole page on every repository event (vscode.git's periodic status
  refresh included); it now repaints only when the comparison itself changed,
  open files, the filter and the layout survive the repaints that do happen,
  and *Collapse all* sticks. (#24)
- **Interactive rebase, reword and fold correctness** in the shared rebase
  runner: a reword entry with an empty sha matched every commit git asked
  about, so a message could land on the wrong commit; a reword queue left by an
  aborted rebase could be replayed by the next rebase of the same branch; and
  a commit whose patch was already upstream wedged the rebase.
- **Merge editor:** resolving a conflict with no common ancestor (both sides
  added the file) appended a blank line the accepted side never had.
- **Commit graph:** typing in the search box moved the selection and re-fetched
  details on every keystroke (Enter travels now; j/k move); a refresh kept a
  selection whose row was gone; *Show in graph* on a commit beyond the loaded
  pages said nothing (it says so now, and the details still load); the CHANGES
  column's counts line up; the graph|details resizer stopped 60px past the
  width where columns vanish; the sidebar Commits view's *Jump to HEAD* and
  reveal now page toward a commit that is not loaded yet instead of doing
  nothing.
- **AI results panel:** a Markdown link whose URL contained a quote could
  inject an attribute into the rendered anchor. Escaped like every other panel.
- **Crash reports** (anonymous, opt-out) still carried your project path on
  Windows and in any path with a space in it. The scrubber's last line of
  defence now holds there too.
- **Fast-forward pull without checkout** split a remote named with a slash
  (`team/eu`) at the first slash and fetched from the wrong remote.

### Changed
- **The graph's CHANGES column costs one git process per visible window**
  instead of two per row — and every row is answered: the old version capped
  at sixty rows and left the rest blank for the session.
- **The Changes view no longer re-checks AI availability on every state push**
  (a debounced firehose during a rebase or fetch), and no longer re-sends its
  full state a second time when nothing changed. A CLI agent installed after
  the window opened is noticed within five minutes.
- The graph repaints once per selection, not twice; an unstaged file is diffed
  once, not twice.

## [1.12.1] - 2026-09-04

### Added
- **Process Audit — a diagnostic for tracing OS password/permission prompts.**
  A new setting, `gitstudio.debug.logChildProcesses` (off by default), records
  every child process GitStudio launches — the binary, its full arguments, the
  working directory, and the environment variables GitStudio adds — to a
  **GitStudio: Process Audit** output channel (open it from the command palette).
  It exists for one job: when a macOS/Windows credential or authorization prompt
  appears while you work, this shows exactly what GitStudio handed the OS at that
  moment, so a prompt raised by a credential helper, a git hook, or the editor's
  own updater can be traced to its real source rather than guessed at. It costs
  nothing when off, and secret-looking values are scrubbed.

## [1.12.0] - 2026-08-26

### Added
- **Prune deleted remote branches on fetch.** Fetch now passes `--prune` by
  default, so remote-tracking branches that were deleted on the remote drop out
  of the branch list instead of lingering as stale entries. Only stale
  remote-tracking refs are removed — your local branches are never touched. Turn
  it off with the new `gitstudio.fetch.prune` setting. (#23)

## [1.11.1] - 2026-08-22

No change to GitStudio itself. 1.11.0 was tagged from a commit whose build was
still running, and it went red: a test used a shell script as git's sequence
editor, which has no shell on Windows. Tests are not part of the published
extension, so 1.11.0 behaves identically — this re-releases the same code from a
commit that builds green on every platform.

## [1.11.0] - 2026-08-22

### Added
- **Reorder commits by dragging them in the Commit Graph.** Drag a commit, an
  insertion line shows where it will land, and a confirmation runs the rebase —
  the drag alone never changes anything. Only commits that are safe to rewrite
  can move: unpushed, on your current branch, and above any merge. Everything
  else stays put and says why on hover. Because the graph shows every branch at
  once, the line skips over commits belonging to other branches rather than
  letting you drop between them.
  - Branches sitting on the commits you move can come along, so they end up on
    the rewritten history instead of pointing at commits that are no longer part
    of it. GitStudio asks which you want; it never moves a branch you did not
    name.
  - Reordering can conflict, exactly as a rebase can. GitStudio leaves it where
    git does, so you can resolve and continue, or abort and be back where you
    started. Undo covers it either way.

### Changed
- **Stashing is one dialog again.** It used to ask for a message, then ask about
  options, before anything happened — and neither screen ever showed which files
  were about to move. Now the files themselves are the confirmation: they are
  listed, already ticked, and **Stash** puts them away. Untick a row to leave it
  in the working tree. Untracked files appear in the list, so nothing is left
  behind by accident and nobody has to know `--include-untracked` exists. A
  message is one opt-in tick away, and *Keep staged changes staged* appears only
  when there is an index for it to keep.

### Fixed
- **Amending a commit you had already pushed could not be pushed.** Rewriting a
  commit leaves the branch ahead *and* behind its upstream, so git refuses an
  ordinary push — but every push button offered one anyway, and the only hint on
  screen was "1 behind — pull first". After an amend that advice is destructive:
  pulling either merges the old commit back beside the corrected one, or (with
  `pull.rebase`) drops your amended commit as "previously applied" and silently
  restores the original message. GitStudio now recognises the state and offers
  the one thing that works — a force push using `--force-with-lease`, which
  still refuses if someone else has pushed in the meantime. Sync asks instead of
  pulling over your rewrite, and a push git rejects offers the force rather than
  the same doomed button again. "N behind — pull first" is unchanged for the
  case it was written for, where the remote genuinely moved.

## [1.10.0] - 2026-08-21

### Added
- **The commit graph fits what is in it.** The Branch/Tag column measures the
  busiest row you have loaded instead of sitting at a fixed width, and a chip may
  grow with the column — so `origin/feat/diff-tick-staging` renders in full
  rather than ellipsizing at every width. It only spends width that is spare, so
  a narrow window gives it back to the commit message.
- **Hover cards for anything a row had to cut off.** A clipped ref chip or commit
  message shows in full on hover, wrapped, in both the Commit Graph and the
  Commits sidebar. Hovering an author shows who they are — full name, the address
  the commits are keyed on, how much of the loaded history is theirs, and when.
- **Checking out a branch tip checks out the branch.** One short dialog offers
  both outcomes — switch to the branch, or detach here — and asks which when a
  commit is the tip of more than one. *Detach HEAD Here…* is a menu action in its
  own right, so the old behaviour is one click away.
- **Paste a ticket title as a branch name.** When a name is rejected, the dialog
  offers the corrected form — `SPS-1234 ALA baLa 12/02/21 thing` becomes
  `SPS-1234-ALA-baLa-12-02-21-thing` — with **Use** to swap it in and **Copy** to
  take it elsewhere. A slash between words is kept, because `feature/x` means
  something; a slash between digits is flattened, because a date is not a
  hierarchy and a slash there would permanently block the prefixes from ever
  being branches.
- **Resizable columns you can find.** The dividers are visible at rest and take
  the accent while you drag one, the grab zone is the full header height, and
  each says which column it resizes. Compact mode has them now too.

### Changed
- Added, modified and deleted are green, blue and red. VS Code's own palette
  makes "added" a sage green and "modified" a tan, which at the size of a 4px bar
  or a single letter read as the same warm grey.
- The graph's lanes, nodes and avatars are larger in both the Commit Graph and
  the Commits sidebar, and the lane strokes heavier.
- Author, Changes, Date and SHA are narrower, and every column's text is inset
  from its divider rather than butting against it.

### Fixed
- **The graph counted git notes as history.** `git log --all` includes
  `refs/notes/*` and `refs/stash`, so notes commits were rows in the graph and
  shifted the page boundaries under paging — 163 of them against 202 real
  commits in one repo, and commits went missing as you scrolled.
- **A commit on two remotes drew one chip and no `+N`.** The overflow pill
  rendered only if it still fit, and missed by two pixels at some widths — so the
  row claimed to have one ref. It now always renders.
- **Compact mode had every column one place to the left.** The commit message
  rendered inside the ref track while CHANGES took the space meant for it.
- **Dragging a divider could wreck the columns.** The resize was bounded by each
  column's own limits with nothing watching the total, so Changes, Author and
  Date collapsed to nothing once the widths overflowed.
- **Expanding a file in the Changes view was slow and lost your place.** It
  rebuilt the entire view to open one file, and again when the changes arrived.
- The branch menu's *New Branch* and the push modal's used their own copies of
  the branch-name rules; the push-modal copy checked only for spaces, so it
  accepted names git then refused.
- Branch popovers dismiss when focus leaves the webview, while dialogs keep what
  you typed when you switch to another application. Thanks to
  [@wanzirong](https://github.com/wanzirong) ([#22]).

[#22]: https://github.com/GitStudioHQ/gitstudio/pull/22

## [1.9.0] - 2026-08-19

### Added
- **Tick individual changes in a diff.** Every change carries a tri-state tick —
  staged, unstaged, or partly staged — and clicking it stages or unstages exactly
  that change, leaving the rest of the file alone. *Stage Changes with Ticks*
  opens a file this way; VS Code's own diff editor stays the default so your
  keybindings, settings and other extensions are untouched.
- **See what is staged without leaving the editor.** A gutter mark on every
  change since your last commit, toggled with `Ctrl/Cmd+Alt+G T` or by
  right-clicking the line number. The mark reports state only — VS Code gives
  extensions no way to make a gutter icon clickable — so the tick itself lives on
  GitStudio's diff page, one command away.
- **Select files in the Changes view.** Shift-click for a range, Ctrl/Cmd-click
  to pick individual files, Ctrl/Cmd-click a section header for everything in it.
  A plain click still opens the diff, so nothing changes if you never select.
- **Stash a selection.** Drag the selected files onto the stash target that
  appears while dragging, use the selection bar, or right-click. Previously a
  stash could only ever take the entire working tree.
- **The stash button says what it will take** — "Stash all changes…" normally,
  "Stash 3 selected files…" when you have a selection.
- **A toggle for the staging model,** beside the tree/list one — the checkbox
  view existed only as a setting, so finding it meant already knowing the
  setting's name.
- **Escape steps back one level.** It closes whatever is open — a menu, a
  submenu, a dialog — and clears the file selection when nothing is.
- **Status bar:** the branch now shows uncommitted work (`main ↑1 ✎3`) and opens
  the branch menu when clicked. Beside it, one-click buttons for the Commit Graph
  and for a terminal in the **repository's** root — which is not the workspace
  root in a monorepo. The terminal button counts open terminals, lists them by
  name on hover, and toggles. Both buttons can be switched off under
  `gitstudio.statusBar`.

### Fixed
- **A partly staged file appeared twice in the checkbox view,** once for its
  staged part and once for its unstaged one. It is a single row now, with the
  tick showing "partly staged"; clicking it stages the rest.
- **Ticking a change made it disappear.** The per-file change list only showed
  what was still unstaged, so staging a change removed it from its own list — and
  staging the last one took the whole panel with it. Every change is now listed
  with its state, ticks work both ways, and a file folds itself back once
  everything in it is staged.
- **A change could not be opened.** Clicking a file opens its diff; clicking one
  of its individual changes did nothing. It now opens the diff at that change.
- **The tree/list toggle did nothing in the checkbox view.**
- **Checkboxes were the raw platform control,** rounded and blue on macOS and a
  different shape on Windows, unlike every other checkbox in the editor.
- **Partial staging wrote different bytes than `git add` would.** Staging lines
  or hunks bypassed the clean filters that `.gitattributes` and `core.autocrlf`
  apply, so in a repository normalising line endings, staging one hunk could show
  the whole file as modified and a commit could carry CRLF into an LF history.

### Changed
- **Requires VS Code 1.78 or later** (was 1.74), for the line-number context
  menu. Cursor and VSCodium builds based on 1.78+ are unaffected.

## [1.8.0] - 2026-08-18

### Added
- **Create a worktree from a remote branch or a tag,** not just a local branch —
  and either check the ref out directly or use it as the starting point for a new
  named branch. New Worktree offers all three kinds now.
  Thanks to [@wanzirong](https://github.com/wanzirong) (#14).
- **`gitstudio.worktrees.prefixWithProjectName`** — name the worktree folder
  `<project>-<branch>` instead of `<branch>`, so a row of worktrees from different
  repositories stays readable. Off by default. Also from #14.

### Changed
- **The interactive-rebase list now reads newest-first, matching the Commits
  list.** Git replays the plan bottom-to-top, and the view says so. `squash` and
  `fixup` therefore fold into the commit *below* — which means a squash on the top
  row is now allowed, where the first row previously could not fold into anything.
  The `git-rebase-todo` editor keeps git's own oldest-first order, since its rows
  are that file's lines. *(Reported by @wkornewald, #18.)*

### Fixed
- **A new branch created in a worktree from a remote branch no longer adopts that
  remote as its upstream** unless the names match. Git's default would set it, and
  GitStudio's push targets a differently-named upstream explicitly — so pushing
  from a worktree branch called `my-experiment` started from `origin/feature`
  could have sent your commits to `origin/feature`.
- **The branch menu no longer shows the previous repository's branches** for a
  moment after switching repositories.
- **A branch you just created or deleted no longer keeps showing its old state.**
  A ref listing already in flight when the change landed could write its
  pre-change answer back over the refresh.

## [1.7.0] - 2026-08-18

### Added
- **Commit without staging first.** Hitting Commit with nothing staged used to be
  refused; it now asks — *"Commit all 7 changed files?"* — and stages everything
  on yes. The confirmation is the point: you see what is about to go in before it
  does. *(Requested by @wkornewald, #16.)*
- **A checkbox model for the Changes view.** Set
  `gitstudio.changes.stagingModel` to `checkboxes` for one list with a tick per
  file, JetBrains-style, instead of the Staged/Unstaged split. The tick *is* the
  index — ticking stages, unticking unstages — so both models are the same Git
  state seen two ways, and nothing can drift out of sync. The split remains the
  default. *(#16.)*

### Fixed
- **Being mid-conflict is no longer reported as a crash.** Git refusing to switch
  branches while you have unresolved conflicts is correct behaviour, not a
  defect. It was shown as a red error and filed as a crash report; it now reads
  as a warning that names how many files are still conflicted and what to do.
- **"Checkout origin/…" no longer promises a dialog it stopped opening** — the
  trailing ellipsis is gone now that the checkout happens immediately.
- **Stashing when there is nothing to stash no longer reports success.** `git
  stash` exits 0 with nothing saved, so GitStudio said "Stashed changes" over an
  untouched working tree. It now says what actually happened — including the case
  where the only changes are new files, which need *Include untracked files*.

## [1.6.0] - 2026-08-17

### Added
- **The Changes list keeps itself up to date.** Editing a file and switching back
  to GitStudio showed the list as it was, until you hit refresh or left the view
  and came back — because nothing in GitStudio watched the working tree. Its two
  file watchers only ever looked at git's own metadata, so a save produced no
  signal at all, and the list's data source is a cache that was read but never
  asked to refresh. It now updates after you save, and again whenever the window
  regains focus so that edits made by another tool entirely — a CLI, a formatter,
  another editor — appear as well. Bursts are folded together, so *Save All*
  across fifty files is one refresh. Set `gitstudio.changes.autoRefresh` to
  `false` on a very large repository to go back to refreshing on demand.
  *(Reported by @wkornewald, #17.)*

### Fixed
- **Committing with nothing staged said nothing at all.** The error dialog was
  empty. `git commit` is the one git command that reports this particular refusal
  on *stdout* rather than stderr — so reading stderr, as every other operation
  safely does, produced a failure with no text in it. GitStudio now says which
  situation you are actually in: changes waiting to be staged, only new untracked
  files, or a genuinely clean tree. It asks git rather than reading its wording, so
  the message is right on a translated git too, and it is shown as information
  rather than as an error, because having staged nothing yet is not a mistake.
  *(Reported by @wkornewald, #16.)*
- **Widening the Branch/Tag column now actually reveals more branches.** The
  column stopped at four chips no matter how wide you dragged it — the limit was
  a count applied before any width was measured, so the obvious thing to try
  silently did nothing. Width is the only limit now, and the column reveals as
  many as genuinely fit. *(#11, following on from #5.)*
- **The "+N" badge explains itself immediately.** Hovering it used to mean
  holding the pointer still for several seconds and hoping, because it relied on
  the browser's own tooltip — whose delay restarts every time the pointer moves.
  In the Commits sidebar it never appeared at all, since the row's tooltip won
  over it. It is now GitStudio's own hover card, opens straight away on both
  surfaces, and names each hidden ref's kind so you can tell a tag from a branch.
- **A merge or rebase that stops for conflicts is no longer reported as a
  failure.** The same defect 1.5.2 fixed for cherry-pick and revert: the two were
  told apart by matching git's English output, so on a translated git a merge that
  had merely paused was presented as an outright failure with raw stderr instead
  of "resolve, then continue or abort". GitStudio asks git directly now. This case
  needed more care than cherry-pick did, because for merge and rebase a plain
  failure and a pause can share the same exit code — an unknown branch name and a
  rebase over unstaged changes both exit the way a conflict does. *(#9.)*

### Changed
- **Checking out a remote branch just checks it out.** It used to open a dialog
  asking you to name the local branch, pre-filled with the name it had already
  worked out — so the answer was almost always "yes, that one". Picking
  `origin/fix/login` now puts you on `fix/login`, tracking it, in one step; if a
  local branch of that name already exists, you simply switch to it. To land on a
  different name, use *New Branch From Here…*, or rename after checking out.

## [1.5.2] - 2026-08-15

### Fixed
- **A cherry-pick or revert that stops to ask you something is no longer
  reported as a failure.** Git pauses in two situations — a conflict, or a
  cherry-pick that turns out to be empty because the change is already on your
  branch — and GitStudio told those apart by reading git's English wording. On a
  translated git, the wording did not match: a routine "this change is already
  applied" appeared as *"Cherry-pick failed"* and was filed as a crash report.
  GitStudio now asks git directly whether the operation is paused, which is the
  same answer in every language, and offers the choices you actually have. Revert
  gets the same treatment, in both the commit-graph action and the Undo flow that
  becomes a revert once history has been pushed.

## [1.5.1] - 2026-08-15

### Fixed
- **GitStudio filed other extensions' crashes as its own.** The crash reporter
  listens for unhandled promise rejections, but that listener is process-wide and
  the extension host is shared by every installed extension — so it saw theirs
  too. A check on the error's stack was meant to keep only GitStudio's own
  failures; it ran *after* wrapping non-Error values in a new `Error`, which
  stamped GitStudio's own frame onto the stack and made the check accept
  everything. Three reports had been filed from other extensions this way, one of
  them carrying an unrelated project's source code. A failure is now attributed
  to GitStudio only when it arrives as an `Error` whose own *call frames* point
  into GitStudio's code; anything without that provenance is discarded rather
  than sent. Matching the error's message was part of the same leak — another
  extension's failure mentioning a path like `~/code/gitstudio/` was enough to
  be counted as ours.
- **Closing a panel while it was still working raised "Webview is disposed".**
  Reading a panel's webview after it is closed throws immediately, so closing the
  AI result panel mid-answer, the AI settings panel while models were being
  detected, or the rebase workspace during a git operation each produced a
  background error you could do nothing about. All three now stop writing once
  the panel is gone.
- **Reverting a merge commit failed with git's own error.** A merge has more than
  one parent, so "undo this commit" is ambiguous and git refuses unless told
  which side to keep. GitStudio passed that refusal straight through. It now asks
  which parent to keep as the mainline, showing each one's commit subject —
  including for octopus merges with three or more parents. Reverting something
  that is already reverted now says so, instead of failing with an empty reason.

## [1.5.0] - 2026-08-15

### Fixed
- **Branch and remote names containing the letter "s" were rejected as
  containing a space.** The Changes webview is built as one template literal, so
  the backslashes in its inline script were consumed before the browser saw
  them: `/\s/` became `/s/`. Every dialog that validates a ref name shares those
  validators, so you could not create or rename a branch called `styles`, add a
  remote named `upstream`, or paste any `https://` URL — each refused for
  "containing a space", while an actual space was accepted. The same cooking
  silently degraded the check beside it into one that only rejected the
  characters git forbids (`~ ^ : ? * [ \`) at the very end of a name, and never
  rejected a backslash at all. Both are fixed, and two tests now guard the class
  of mistake — one that no compiler or linter can see. Thanks to
  [@wanzirong](https://github.com/wanzirong) for diagnosing it (#8).
- **The activity-bar badge kept a stale count after committing.** Commit and
  push everything, and the GitStudio icon still read "1" beside a view that said
  "Working tree clean". Clearing a webview view's badge does not work in VS Code
  — the pane only applies a badge when there is one, and never clears the old —
  so the count is now published as zero, which the activity bar renders as
  nothing. Turning the badge setting off also takes effect immediately instead
  of on the next window reload. (#7)
- **Clicking a commit did nothing once the details dock was closed.** Clicking
  the row that was already selected emitted no intent at all, so the dock stayed
  shut with no way back short of reloading the window. (#4)
- **Branch/tag chips did not reflow while dragging the column.** Chips that do
  not fit are removed from the row rather than clipped, but only releasing the
  mouse re-rendered — so the column widened while the chips stayed folded behind
  a "+N" and everything snapped into place at the end. (#5)
- **The "+N" chip read as decoration.** Clicking it opens the commit details,
  which lists every hidden ref in full, but nothing said so. It now shows a
  pointer and a hover state, and its tooltip names each hidden ref *and* whether
  it is a local branch, a remote branch or a tag. (#5)
- **"Cherry-Pick Commit" had no icon** in the commit-graph context menu, where
  every other item had one.

### Added
- **Check out a branch from the commit graph.** Right-clicking a row now heads
  the menu with the refs on that commit — "Checkout main", "Checkout
  origin/main…", "Checkout v1.4.0…" — above the commit-scoped actions.
  Previously the only checkout offered was "Checkout Commit", which detaches
  HEAD; landing on a detached HEAD when you meant "switch to main" is the wrong
  outcome. A remote branch offers a local name to track it with, a tag confirms
  the detached HEAD first, and the branch you are already on is omitted. (#6)

## [1.4.0] - 2026-08-08

### Fixed
- **Git could hang forever on a credential prompt.** No editor host has a
  terminal, so when git asked for a username, password or key passphrase the
  question had nowhere to go and the operation blocked indefinitely — a fetch,
  pull or push over HTTPS on a repo with no cached credential froze the sync UI
  with no way out. Git is now told there is no terminal, so it fails fast with a
  real message instead. Credential *helpers* — macOS Keychain, Git Credential
  Manager, any GUI askpass — are unaffected; only the read-from-the-tty fallback
  is gone.
- **Dead column-resize handles in the narrow commit graph.** Below the width
  where the date and SHA columns hide, their resize grips survived as invisible
  hit targets: the cursor changed to a resize arrow over a handle that could
  never be dragged.
- **Renaming a published branch left it pushing to the old name.** `git branch
  -m` deliberately keeps the tracking config — the branch on the server was not
  renamed — so a renamed branch still pointed at `origin/<old-name>`. Everything
  downstream inherited that: the push modal named the old branch, the ↑/↓ badges
  counted against it, and the push itself did one of three different things
  depending on a `push.default` you never set (refuse outright on `simple`, push
  to the old name on `upstream`, push to the new name while still tracking the
  old on `current`). Renaming a published branch now asks what you meant —
  rename it on the remote too, publish the new name and keep the old, or keep
  tracking the old — and a push resolves its refspec explicitly, so it lands in
  the same place on every machine and reports the real problem (a divergence
  needing a force push) instead of a lecture about `push.default`.

### Changed
- **GitStudio no longer uses your OS keychain, so it can no longer ask for your
  password.** Reading a key from the editor's SecretStorage unlocks the host
  app's keychain entry, and on macOS that entry's ACL is bound to the app's code
  signature — so every Cursor / VS Code update invalidated it and the next read
  raised *"Cursor wants to make changes. Enter your password to allow this."*
  GitStudio read its key while merely deciding whether to show the ✨ button, on
  every launch and again on every Changes-view refresh, which meant the prompt
  fired at startup even for people who had never configured AI at all. API keys
  now live in GitStudio's own AES-256-GCM store under the extension's private
  storage directory, owner-only on disk, and "is a key configured?" is answered
  from the filesystem without ever touching key material. If you had a key saved
  in a previous version, **GitStudio · AI** has an *Import key from the editor's
  secret storage* button — the one and only remaining action that can raise a
  keychain prompt, and only when you click it.
- **The command palette is gone from GitStudio entirely.** 1.3.0 moved nine
  action menus into real dialogs; this finishes the job. Every remaining
  question — renaming a branch, setting an upstream, adding a remote, naming a
  stash, choosing a base for an interactive rebase, picking a PR, entering an
  API key, and every destructive confirmation — now renders as a GitStudio
  dialog inside the Changes view, whether you started from the branch menu, a
  tree context menu, the commit graph, or the palette itself. The quick input
  was the palette wearing a different hat: it hijacked the top of the window,
  discarded whatever you had typed the moment focus moved, and could not
  complete over the refs the view was already holding. Rebase and revision
  prompts now complete over every branch, remote branch and tag while still
  accepting any revision expression. A test now fails the build if
  `showInputBox`, `showQuickPick`, or a modal message box is reintroduced
  anywhere in the extension.
- Confirmations say what will actually happen and what can be recovered, instead
  of asserting "this cannot be undone" on operations Undo handles fine. The one
  case that genuinely cannot be recovered — discarding uncommitted work — says
  so, and says why: git never recorded those edits.

## [1.3.0] - 2026-08-01

### Added
- **Git blame annotations, JetBrains-style.** Inline annotations beside each
  line — revision, date, author, commit number — with per-field toggles, name
  styles (initials / first / last / full / email), author or order colouring,
  and diff-on-hover. Right-click an annotation for the full menu: copy revision,
  show diff, open the previous revision, view in browser, reveal the commit in
  the graph. Sticky per file, and never routed through the command palette.
- **Commit graph in the bottom panel.** The graph and the commit details now sit
  side by side beside the terminal, so you can read code and history at once
  without spending an editor tab.
- **"In N branches".** The details pane answers where a commit has actually
  landed — which branches *contain* it, as distinct from which refs point at it.
  Loaded lazily, because it is a real history walk.
- **Changed-files badge** on the activity-bar icon, matching the built-in Source
  Control behaviour, with incoming-commit count in the tooltip. Disable with
  `gitstudio.changesBadge`.
- **Disable AI Features** command, so turning GitBrain off no longer means
  hunting for a provider setting.

### Changed
- **The command palette is no longer used for GitStudio's own menus.** Nine
  action menus became real dialogs (reset mode, merge method, review verdict,
  PR draft state, remote actions, branch create-and-switch, undo mode). "New
  Branch" and "Checkout Tag or Revision" now open an in-view picker that
  completes over your branches and tags, accepts any revision expression, and —
  unlike the quick input — survives alt-tabbing without losing what you typed.
- **Every branch and tag is browsable.** Removed the hidden caps that silently
  dropped refs past the 16th (desktop) and 40th (extension) — the latter applied
  even while searching, so those refs were unreachable by any means. Tags now
  sort newest-first instead of byte order.
- **Redesigned the commit details pane.** Refs are grouped by the question they
  answer — `tip of`, `pushed to`, `tagged`, `in` — so nothing has to be decoded
  from colour. `pushed to` states publication by presence, and an unpushed
  commit says so explicitly instead of just showing one chip fewer. Ref chips
  are flat and borderless across the graph, the sidebar rail and the details
  pane; full branch names wrap rather than truncate; sizes scale with the
  editor's font size.
- **A detached HEAD shows the revision** (`b7ddc41b`) instead of "(no branch)".
- Copying a SHA now acknowledges the copy.
- Sidebar views declare relative sizes, so collapsing one gives its space to
  Changes rather than spreading it evenly.
- The editor-tab commit graph is deprecated in favour of the panel; existing
  commands and keybindings still work and open the panel.

### Fixed
- **Pushing an unpublished branch with no new commits did nothing.** The Changes
  view decided publishability by counting commits, so the button rendered
  disabled and the branch menu reported "nothing to push".
- **A branch whose name collides with a tag could not be published** — the
  unqualified refspec matched both.
- **Publishing ignored `branch.<name>.pushRemote` / `remote.pushDefault`**, so a
  fork workflow published to the wrong remote.
- **Sync showed git's "no such ref was fetched"** when a tracked remote branch
  had been deleted. It now explains the situation and offers Republish or Stop
  Tracking.
- **"In N branches" misclassified refs** — every `feature/…` branch was filed
  under remotes, and `refs/remotes/origin/HEAD` appeared as a phantom branch
  named `origin`.
- **Clicking a parent SHA did nothing** in the extension; only the desktop app
  handled it.
- Ref names are no longer interpolated as HTML in the new ref picker.
- Interactive rebase: the todo is validated before it is written, git can no
  longer hang forever on a credential or signing prompt, and the editor
  environment is shell-quoted so an install path containing shell metacharacters
  cannot execute.

## [1.2.0] - 2026-07-24

### Added
- **Visual interactive rebase.** A dedicated rebase workspace — reorder commits
  by dragging, choose a per-commit action (pick / reword / squash / fixup / edit
  / drop) with a plain-English preview of what each one does, then apply with a
  real one-step Undo. Open it from a commit's **Rebase** action or the graph
  context menu. Works in **VS Code *and* Cursor** via an editor-agnostic,
  non-interactive rebase driver (no more relying on `code --wait`).
- **Anonymous crash reporting.** When a GitStudio command fails during the beta,
  an anonymized, PII-scrubbed report can be sent so we can find and fix issues
  without waiting for a manual bug report. It honors VS Code's telemetry setting
  and is one flip to disable (`gitstudio.errorReporting.enabled`). Absolute
  paths, home dirs, emails, remote URLs, tokens, and SHAs are stripped locally —
  your code, file names, commit messages, and branch names never leave the
  machine.

### Changed
- **Marketplace positioning.** Refined the title, description, and keywords
  around how people actually search for a JetBrains-style Git GUI. No functional
  changes.

## [1.1.1] - 2026-07-19

### Changed
- **Marketplace discoverability.** The listing title now surfaces the core
  capabilities (*Git Graph, GUI, Blame & Merge*) instead of the bare name, and
  the keyword/tag set now covers the terms people actually search for a Git GUI —
  so GitStudio shows up where it should. No functional changes.

## [1.1.0] - 2026-07-19

A big round of push, compare, and commit-graph improvements.

### Added
- **Push review modal.** Every push route — the ↑ pill, the branch menu, and the
  Commit&Push button — now opens a confirmation that lists the exact commits and
  file changes about to be pushed, with per-file `+/−` and a diffstat header.
  From it you can open any file's diff, **Undo local commits** (reset them back to
  staged / unstaged changes), or **branch off** with *New branch…*. The Push
  button shows a live in-button loader while it runs.
- **State-driven Commit / Push buttons.** The primary action reads **Commit & Push**
  when there's staged work, and **Push N** / **Publish** when there are only
  unpushed commits (no commit message required), each with an in-button spinner.
- **Tags** now appear in the branch menu alongside a **Recents** group; every row
  shows its full ref name on hover and the popover widens with the sidebar.
- **Compare view, rebuilt GitHub/GitLab-style:** a *commits · files · +X −Y*
  diffstat header, inline **unified & split** diffs rendered in-page, an optional
  **file-tree sidebar**, a path filter, and per-file additions/deletions.

### Fixed
- **Commit graph.** Lane lines now route through their commit nodes, so every
  node sits on its own line — no more lines that end nowhere, doubled crossings,
  or nodes floating beside the graph. Author avatars are pixel-aligned to their
  nodes, and the lane layout is hardened against duplicate / out-of-order commits
  from paginated history.
- **Branch-name tooltips** wrap to show the full name instead of ellipsizing.
- The push window is now robustly centered and responsive at any sidebar width.

### Changed
- **Fetch** is listed **above Update (pull)** in the sync menus.
- Firmer, more legible **hover** states in dark themes across every surface.

## [1.0.0] - 2026-07-14

The first stable release: the whole extension loads **instantly**, the commit
graph lives in the sidebar, sync is live, and stashing is first-class.

### Performance — the views are now instant
- **No more waiting on VS Code's Git extension.** GitStudio discovers your repo itself
  (its own `git rev-parse`, symlink-safe) and reads worktrees, stashes, commit history,
  and working-tree changes through its own git-service. The views paint from local git
  that's already loaded instead of blocking on vscode.git's activation + scan.
- **Views stay warm.** Sidebar webviews retain their context, so switching away and back
  is instant instead of a full rebuild.
- **Instant staging.** Files move the moment you click; the git op reconciles in the
  background. Staging or unstaging a folder (tree view) or a whole group is one operation.
- The commit list only re-renders when something actually changed (no churn on background
  git activity), and the graph loads a small first page, then streams as you scroll.

### New & reworked
- **Live sync in the Changes view** — the ahead/behind counts in the header are now real
  **Push / Pull buttons** that run the op with a spinner in place. The branch menu's
  **Fetch runs without closing the menu**: the item spins, then every branch row's new
  **↑/↓ badges** update live — you see exactly what's unpulled where. Local branches can
  be **pulled without checking them out** (fast-forward from upstream, straight from the
  branch's submenu), and every branch's submenu gained **Copy Branch Name**.
- **A sidebar-native Commits view** — rebuilt from scratch for the sidebar instead of
  squeezing the full graph in. Compact two-line rows (message on top; refs, author, and
  age below) show 3–4× more history at a glance, the true branch topology renders at
  sidebar scale with **mini author avatars riding the commit nodes**, and remote branches
  fold into their local chip. Search with scopes (message/author/SHA/refs) and match
  stepping lives in the header, every commit action is on right-click, and double-click,
  Enter, or the row's hover action promotes a commit to the full-screen Commit Graph —
  which is unchanged for deep work.
- **Branded Stashes view** — rebuilt as a first-class panel with a one-click **Stash
  Changes** button and per-row Apply / Pop / Branch / Drop, plus a stash control right in
  the Changes toolbar.
- **Branch compare** — a GitHub-style panel (ahead/behind, the commits between two refs,
  and the changed files as native diffs), reachable from the Changes branch menu.

### Design
- A unified, on-brand **GitStudio-violet** button system across every surface (commit,
  checkout, PR, compare), a redesigned activity-bar icon derived from the brand mark, the
  HEAD chip and primary actions consistently violet, and reliable tooltips throughout.

### Removed
- The **Search & Compare** tree — superseded by the in-sidebar commit graph and the
  dedicated branch-compare panel.

## [0.1.0] — Initial release

The first public release: a free, open-source, JetBrains-grade Git suite for VS Code
and Cursor, with the full workflow in one extension.

### Visualize
- **Commit graph** — a virtualized branch/commit graph that stays fast at tens of
  thousands of commits, with colored lanes (theme-aware light / dark / high-contrast
  palettes), ref chips, and full keyboard navigation.
- **Inline blame** — current-line authorship inline and in the status bar, full-file
  annotations with a code-age heatmap, and rich command hovers.
- **History & timeline** — per-file history, line history (blame-over-time), revision
  step navigation, and a reflog time-machine.

### Change
- **Staging that respects intent** — hunk- and line-level staging from any editor or
  diff, plus file/group stage · unstage · discard in the Changes view.
- **Guided commit box** — auto-growing message, Amend, Sign-off, author override, and
  Commit & Push, with a ✨ button to draft the message from the staged diff (when AI is on).
- **Diff & 3-pane merge** — side-by-side and unified diffs with word-level highlighting,
  and a JetBrains-style three-pane merge editor with one-click accept ribbons; conflicts
  auto-open as they appear (configurable).

### Rewrite
- **Interactive rebase** — a drag-to-reorder rebase editor (pick · reword · edit · squash
  · fixup · drop).
- **Universal Undo** — a reflog-powered safety net that snapshots before destructive ops
  and reverses them with one command; pushed history falls back to a safe Revert. Undo is
  bound to `Ctrl/Cmd+Alt+G Z` and never hijacks `Ctrl/Cmd+Z`.

### Manage
- **Branches, remotes, tags, stashes, worktrees** — sidebar views and operations
  (checkout, merge, rebase, rename, delete, push, set-upstream, new branch/worktree, fetch,
  manage remotes; stash apply/pop/drop/branch; lock/prune worktrees; tag push/checkout/delete).
- **Search & Compare** — search commits and compare any two branches/tags.
- **Status-bar sync** — ahead/behind with one-click fetch/pull/push; force-push uses
  `--force-with-lease` by default.

### Collaborate
- **In-editor GitHub PR review** — sign in once with VS Code's built-in GitHub account to
  list, open, check out, review (inline comments + submit), merge, and create pull requests.

### Assist (optional)
- **GitBrain AI** — bring-your-own-key (Anthropic) or zero-key (GitHub Copilot's model):
  AI commit messages, explain-this-diff, and change summaries. Off until enabled; the key is
  stored in SecretStorage and never reaches a webview; AI never gates a Git operation.

### Polish
- **Getting Started walkthrough** and a first-run tour (`GitStudio: Get Started`).
- A consistent, conflict-free **`Ctrl/Cmd+Alt+G`** keybinding family.
- Theme-true webviews (light / dark / high-contrast) with keyboard focus rings, ARIA
  roles/labels, and `prefers-reduced-motion` honored throughout.

[0.1.0]: https://github.com/GitStudioHQ/gitstudio/releases/tag/v0.1.0
