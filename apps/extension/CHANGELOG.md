# Changelog

All notable changes to **GitStudio** are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- **Handing merges and diffs to a JetBrains IDE is gone.** The **Merge with
  JetBrains IDE** and **Diff with JetBrains IDE** commands are removed, and so
  are the `gitstudio.merge.conflictResolver`, `gitstudio.merge.diffTool`,
  `gitstudio.merge.preferredIde` and `gitstudio.merge.jetbrainsPath` settings.
  Conflicts always open in GitStudio's own merge editor, and diffs in its own
  diff. If you had set one of those settings to use a JetBrains IDE, it is
  ignored.

## [1.15.0] - 2026-09-28

### Added
- **Stashes live in the Changes view, file by file.** Under your changes, a
  **Stashes** group lists every stash — its message (without git's "On
  main:"), the branch it was made on, how long ago, and how many files — and
  opens to every file it holds, staged and untracked ones too, as Changes
  rows. Click a file to see its diff against the commit the stash was made
  on. **Move** (on a file's row) brings the file back as it was stashed —
  staged, if it was — and takes it out of the stash; **Copy** brings it back
  and leaves the stash as it is. Their tips name the group a file lands in
  (*back into Staged as it was stashed*). Ctrl/Cmd-click and Shift-click select
  several files to move or copy together; in the tree view a folder moves
  too. A stash's row has **Apply** (its changes come back, the stash stays)
  and **Pop** (they come back, the stash goes) — words, not look-alike icons,
  on the row the pointer is on, each with a tip saying what happens — and its
  menu **Open All Changes**, **Create Branch…** and **Drop…** (Delete asks
  too). A file you have changed yourself is never
  overwritten: it asks, and Stash & Retry keeps both. What is left of a stash
  stays where the stash was in the list, and Undo (Ctrl/Cmd+Alt+G Z) puts the
  whole stash back. A row goes the moment you click and comes back if nothing
  happened, and the group remembers which stashes you opened. A stash made
  without a message reads "WIP: " and the subject of the commit it was made
  on. A stash of hundreds of files — a dependency folder stashed with its
  untracked files — opens 200 files at a time, with **Show 200 more of N**
  under them, and costs nothing while it is closed. The separate
  Stashes view is gone; the Command Palette has **Apply Stash…**, **Pop
  Stash…**, **Drop Stash…** and **Create Branch from Stash…**, which ask
  which stash.
- **Drag between your changes and your stashes.** Drag a stash onto your
  changes (or "Working tree clean") to apply it — hold Alt (Option on a
  Mac) as you let go to pop it instead. It comes back as it was stashed,
  staged changes staged, so your changes light up as one place rather than
  Staged or Unstaged alone. Drag a stash's files (or the ones you've
  selected, or a folder of them) there to move them out of the stash — Alt
  or Option copies them. Drag changed files — one, your selection, or a
  folder — anywhere onto the **Stashes** group to stash exactly those: the
  whole group lights up, never one stash as if the files were joining it
  (git can't add to a stash — they become a new one), and its words stay in
  sight at the top of a long list. The place
  under the pointer lights up and says what letting go does ("Drop to
  apply · Hold Option to pop"), on a line of its own under the verb in a
  narrow sidebar rather than cut off. It runs what the menus run, so Stash & Retry,
  the staging question, conflicts and Undo work as they do there. This
  replaces the "Drop to stash" box.
- **Checkout puts you on the pull request's own branch.** **Checkout** on a
  pull request — in the list, on its page, or in the Command Palette — checks
  out its real branch (`feature`, not a `pr/37` copy), tracking it where it
  lives and pushing there, so a fix you commit and push reaches the pull
  request, as `gh pr checkout` does. A pull request from a fork adds the
  fork's remote, named after its owner, the first time (and says so). A
  branch of that name that isn't the pull request's — your own `main` beside
  a fork's `main`, or one that tracks something else — is never taken over:
  you are asked, and offered **Checkout as alice-main**, **Use main**, or
  **Cancel** (Cancel changes nothing, and the remote it added goes again).
  Checked out as `alice-main`, it is pushed with GitStudio's **Push**; git's
  own `git push` refuses a branch named unlike the one it tracks, so the
  choice and the message after it give the command that works (`git push
  alice HEAD:main`). A
  branch with commits the pull request doesn't have is never moved without
  asking; your own commits on top of it are left as they are, and counted.
  Uncommitted changes in the way are offered **Stash & Retry**. A pull
  request whose branch is gone is checked out at its last commit as
  `pr/37`, and it says a push from there can't reach it; one whose author
  doesn't let maintainers edit it says a push will be refused.
- **New pull request is one form.** **New pull request** — in the Pull
  Requests view's title bar, its empty list, or the Command Palette — opens a
  form in an editor tab, with everything on one screen and nothing sent
  until **Create pull request**: the repository it opens on (a fork's parent,
  with your fork one click away); **Into** — that repository's default
  branch, or any other, picked or typed; **from** — the branch checked out,
  or any other; the title GitHub would propose; the description from the
  repository's pull request template when it has one (else the commit's
  message, or the commits as a list), with **Commit list** and **Draft with
  AI** beside it; **Create as draft**; **Reviewers**, **Assignees** (with
  **Assign yourself**) and **Labels**, when your access to the repository
  lets you set them — and it says so when it doesn't. Below, the commits and
  the files the pull request will have, compared with the base as GitHub has
  it now; a file opens its diff. A branch that isn't pushed yet, or has
  commits that aren't, is pushed first — the button says **Push and create
  pull request**. It goes where git pushes it, except a branch started from
  the base (`git switch -c feature upstream/main`), which goes to your fork
  when the clone has a remote for it, as `gh pr create` does — not into the
  repository you may not push to; **Push to another remote** picks any of
  the clone's GitHub remotes. A commit, a pull or a push made while the form
  is open shows in it at once (git is read again, GitHub isn't asked), and
  **Create** reads the branch once more before it pushes, so the pull
  request has every commit; **Refresh** at the top reads the branches and
  GitHub again. A branch that already has an open pull request says so,
  with **Open #44**, and anything else that stops it (nothing to compare, a
  branch that has diverged from its remote) is said beside the button. What
  you type is never replaced. Once created, the pull request joins the list
  and its page opens in the form's place. It replaces the six questions
  Create Pull Request asked in the Changes view, and is drawn for Dark,
  Light and both High Contrast themes.
- **A page for each pull request.** Opening a pull request — from the list,
  the Command Palette, or a link in another one — opens its own editor tab,
  titled with its repository and number (`acme/app#37`); opening it again
  brings that tab forward. The page says what the pull request is and where
  it stands: its state, who wants to merge what into where, whether its
  branch is the one checked out, and a status box for its reviews, its checks
  and whether it can be merged — with the one thing that helps when it can't:
  **Update branch** when the base has moved on, **Checkout to resolve** for
  conflicts, **Mark ready** for a draft. Its actions are the ones its state
  allows: **Merge**, **Mark ready** or **Reopen pull request** first, then
  **Checkout**, **Approve** (not on your own), **Review** and **More actions**
  (Update branch, Close pull request, Copy link), with Refresh and Open on
  GitHub beside them — the GitStudio desktop app's words and icons. Four
  tabs:
  - **Conversation**: the description as GitHub draws it — tables, task lists,
    images, code, collapsible sections — with `#12`, `owner/repo#12` and
    `@people` as links (a pull request of the same repository opens its own
    page); every comment, review (with its verdict) and event; review threads
    under their review, with **Reply** and **Resolve conversation**; and a box
    to comment. Reviewers with their verdicts, assignees and labels sit
    beside it.
  - **Commits**, each opening to its changed files, and each file to that
    commit's diff.
  - **Checks**: every check on the latest commit, failing first, with how long
    it took (or has been running), whether it is required, and **Details**.
  - **Files**: the changed files as a tree, with their line counts and
    how many conversations each has; a file opens VS Code's diff, and a
    renamed one is compared with its old name.
  What you change there shows at once and is then sent; if GitHub refuses it,
  the page goes back and says why, with what to do. While checks run, the page
  keeps itself up to date. It replaces the old description panel, and is drawn
  for Dark, Light and both High Contrast themes.
- **Merge from the pull request's page.** **Merge** lists only the methods
  the repository allows, the one set in `gitstudio.pr.defaultMergeMethod`
  first, each saying what it does ("The 4 commits become one commit on
  main."), with the commit title to use and an option to delete the branch on
  GitHub afterwards; **Confirm merge**, **Confirm squash and merge** or
  **Confirm rebase and merge** sends it. GitHub refuses the merge if the
  branch has moved on since the page read it, and the page says so. The
  list's **Merge…** opens this box, on a page that is still loading too;
  when the pull request can't be merged (a draft, blocked, read-only, already
  merged) the box doesn't open, and the keyboard lands on the status line
  that says why. Closing a box (Escape, Cancel) puts the keyboard back on the
  button that opened it. Nothing is asked in the Changes view any more.
- **Review in the editor, submit from the page.** A pull request's diffs take
  comments as soon as its page has read it — only on the lines GitHub accepts
  — and your first comment starts your review. A commit's own diff (from the
  **Commits** tab) takes none: its lines are that commit's change, not the
  pull request's. GitHub's own threads show on
  the diff too, with **Reply** and **Resolve Conversation**. Your pending
  comments are listed on the page (each opens where it is) and counted on the
  **Review** button, the **Files** tab, each file and the status bar
  ("Reviewing #37 · 3 pending"). They are kept with the workspace, so
  reloading the window keeps them. Submit them from the page's **Review** box
  as **Comment**, **Approve** or **Request changes**, with a summary (the
  header's **Approve** opens it with Approve chosen) — Approve
  and Request changes aren't offered on your own pull request — or **Discard**
  them there. Reviews of several pull requests can be under way at once, and
  comments written before the pull request moved on say so, and are sent on
  the commit they were written on.
- **A new Pull Requests list.** The Pull Requests view is rebuilt as a list
  like the GitStudio desktop app's. **Open**, **Merged**, **Closed** and
  **All** sit at the top with how many each holds; a search box finds pull
  requests by their words, and **Filter** narrows them by **Author**,
  **Review requested** (your teams' requests included), **Assignee** or
  **Label** — "you" is one click, anyone else can be typed — with each filter
  shown as a chip you can remove. Each row gives the title and number, who
  opened it (with their picture), its branch and the branch it goes into (a
  fork's shows whose), how long since it last changed, its checks (Passed,
  Failed, Running), its reviews (Approved, Changes requested, Review
  required), its comments, Draft, its labels in their colours, and
  **Checked out** on the one whose branch you have checked out. Rows come 30 at
  a time, and more load as you reach the end (or with **Load more**). Click a
  row to open its page; hover it (or move to it with the keyboard) for
  **Checkout**, **Open on GitHub** and **More actions** — Review, Merge, Copy
  link, offered only where they apply; right-click or Shift+F10
  opens the same menu. **Up/Down** move through the rows, and Down from the
  search box gets you there. The list keeps its rows while it refreshes, with
  a thin bar to show it — every row you paged in, not just the first hundred
  — and a merge, close or reopen from a page moves that row at once, in that
  repository's lists only (your fork's own #37 is another pull request).
  Checking out a fork's pull request adds its remote without resetting the
  list: your filters and rows stay. In a narrow sidebar the search box says
  **Search**, never "Search pull reque". It says what to do when there is
  nothing to show —
  **Sign in to GitHub**, **Sign in again**, **Retry**, **Authorize on
  GitHub**, **New pull request** or **Clear filters**. It is drawn for
  Dark, Light and both High Contrast themes.
- **Pull requests of the repository your fork came from.** When `origin` is a
  fork, the Pull Requests list shows the pull requests of the repository it
  was forked from — as github.com's own Pull requests button does — with your
  fork (and any other GitHub remote) one click away in the repository menu at
  the top. Your choice is remembered for the workspace, and **New pull
  request** and the Command Palette's pull request commands use it too —
  even before the Pull Requests view has been opened.
- **Worktrees, rebuilt: a row per worktree, as a stash's row.** Each
  worktree wears VS Code's own worktree icon and two lines: its folder, and
  under it, quieter, the branch it has checked out (after git's branch
  symbol; *detached at 1a2b3c4* after a commit's) and the one state that
  matters most, in words: *merge in progress*, *rebase stopped*,
  *2 conflicts*, *folder missing*, *not a worktree*, *5 changed*,
  *2 to push*, *1 to pull*, *diverged*, *3 unpublished* (a branch with no
  upstream), *2 not on main* (a repository with no remote),
  *upstream gone*, *locked*. The branch and the state read quieter than the
  folder's name in every theme — Light Modern's too, whose own
  "description" colour is its text colour. Something stopped halfway, or a
  folder that is gone, is in the warning colour (in High Contrast, full ink
  and heavier). Everything else — where the folder is, a lock's reason, how
  many changes are staged, the main worktree, both sides of a divergence —
  is in the row's tooltip, which names the folder once. The worktree this
  window has open is its bold name, and comes first, then the main one, the
  rest by name and the missing ones last; past eight worktrees a filter
  appears. In a narrow sidebar the state is never cut: the branch shortens
  first, a state that needs attention then says one word (*merging*,
  *rebasing*, *missing*), and then the branch goes; a long name gives way
  in its middle, keeping the end that tells it from its neighbours
  (*wf_4b6…cc2-3*), so no two rows ever read alike.
- **Open a worktree's row to see what it has — and only that.** Click it (or
  press Enter or →) and it opens on a soft card: its uncommitted files,
  grouped as Source Control groups them, under small-capital captions with
  their counts (*CONFLICTS*, *STAGED CHANGES 2*, *CHANGES 3*), each opening its diff read
  from that worktree, not this window's; its commits not pushed (not on its
  upstream; with no upstream, not on any remote, as the push review counts
  them; with no remote at all, not on the default branch); and what it has
  to pull. A list with nothing in it isn't shown; with nothing at all, the
  row says *Nothing to commit or push.* Each commit opens to the files it
  changed, as in the push review.
- **Pull and Push… for any worktree.** An open worktree shows **Pull** and
  **Push…** under what they would move — only when there is something to
  pull or push, never greyed out — and its menu has them too. **Pull** runs in that
  worktree's own folder, with the questions every Pull asks (Stash & Retry,
  Merge or Rebase); a stop is said naming the worktree, with **Open in New
  Window**. **Push…** opens the push review for that worktree — its commits,
  its files, "From the worktree …" — and pushes its branch. Where either
  can't work (a detached HEAD, a merge in progress, no upstream, no remote,
  nothing to push) it isn't offered.
- **Every worktree action says what it does.** Hovering a row shows two
  buttons at its end: **Open in New Window** and **More**. More — the
  row's right-click menu too — lists what that worktree can do now: Open in
  This Window, Open in New Window, Reveal in Finder, Open in Terminal, Copy
  Path, Pull, Push…, Lock… (or Unlock), Remove Worktree… (or Forget
  Worktree… when its folder is gone, or isn't a worktree any more). What it
  can't do isn't listed: the main worktree has no Remove, the one this
  window has open no Open. The whole list works from the keyboard (arrows,
  Home/End, Enter, the context-menu key, Delete — on a Mac also
  Cmd+Delete), and a screen reader hears an open worktree's files and
  commits as that worktree's, and each row's tooltip as its name. Unlock
  shows at once, and comes back if git refuses. A row busy with an action
  says so ("Removing…") without fading its words — hovered too, and its
  menu doesn't open until the action is done — and while a row is open,
  a status landing for it (or for any other row) leaves its open commits
  and the keyboard where they are. Nothing hovered or open is drawn with a
  line — a soft fill, in every theme, High Contrast too.
- **Stash & Remove.** Removing a worktree with uncommitted changes offers
  **Stash & Remove** first: its changes go into a stash you can apply from
  any worktree, then its folder is deleted. **Discard Changes and Remove** is
  still there, second. When its branch is fully merged into the default
  branch, the question also offers **Also delete the branch**, unchecked;
  it is deleted only if it is still fully merged when you answer — a commit
  made on it meanwhile (an agent at work in the worktree) keeps it, and the
  report says why. Undo (Ctrl/Cmd+Alt+G Z) brings a deleted branch back.
- **Prune missing worktrees.** When worktrees' folders are gone (or
  aren't worktrees any more), a quiet **Prune 2 missing worktrees…** link
  sits under the list, where those rows are — the words of the view's own
  **Prune Missing Worktrees…** and of the question it asks; it asks first,
  naming them, and says that a locked one is kept.
- **New Worktree suggests where the folder goes**: beside your project,
  named `<project>-<branch>` (`app-feature-login`), in the question itself,
  ready to edit — a relative folder lands beside the project, `~` is home.
  With the repository in a hidden folder inside the project (`project/.bare`,
  its worktrees beside it) it suggests `project/feature-login`. It no longer
  opens a system folder picker. A folder that is taken is asked for again
  with why. The `gitstudio.worktrees.prefixWithProjectName` setting is no
  longer used.
- **The push review's commits open to their files.** Click a commit in the
  review (or press Enter or →) to see the files that commit changed; click
  one for what that commit did to it. The list of every file changed is
  still below.
- Worktrees reads only the rows you can see: a repository with dozens of
  worktrees lists them all at once, and reads each one's changes as it
  scrolls into view — and nothing while the view is collapsed.
- **Select several commits.** In the Commit Graph and the Commits list,
  **Cmd/Ctrl+click** adds or removes a commit, **Shift+click** selects
  everything from the last one you clicked, and **Shift+Up/Down** extends the
  selection from the keyboard; **Escape** keeps only the commit the cursor is
  on. Right-click inside the selection (or press Shift+F10) for one menu for
  all of them; right-click outside it and it is that commit's own menu, as
  before. The commit details pane says how many commits are selected, by whom
  and when, and offers the same actions — it no longer shows one commit's
  details as if they were all. (#32)
- **Act on several commits at once.** **Cherry-Pick N Commits** applies them
  oldest first in one run, and **Revert N Commits** reverts them newest first;
  if one conflicts, **Resolve Conflicts…** takes you to the Conflicts
  dashboard to continue, skip or abort — abort puts the branch back as it was
  — and uncommitted changes that any of them would overwrite are asked about
  before anything is applied, with **Stash & Retry**. **Squash N Commits…**
  opens a message editor with every commit message, oldest first, ready to
  edit, and makes them one commit with your message. **Drop N Commits…** asks
  once, listing every commit it removes and whether they are already pushed.
  **Compare These Two Commits** opens the Compare view for exactly two, and
  **Copy SHAs** copies every one, a line each. Only what can apply is offered:
  Cherry-Pick and Revert are left out when a merge commit is selected, Squash
  and Drop when the commits are not all on your current branch — and Squash
  also when there are other commits between them. Undo (Ctrl/Cmd+Alt+G Z)
  covers every one, and after a drop or squash with "move those branches" it
  puts those branches back too. (#32)
- **Drop Commit… in the commit menu.** Right-click a commit on your current
  branch — in the Commit Graph or the Commits list — and choose **Drop
  Commit…** to take it out of the branch; the commits after it are replayed
  on top. It asks first, in words: which commit, how many later commits are
  replayed, and — if the commit is already pushed — that this rewrites
  history other people have and the next push will need to be a force push.
  When other branches point at a replayed commit, it asks whether they move
  with it, as reordering does. It is offered only where it can work: not for
  a merge commit, a commit below a merge, a commit on another branch, or the
  only commit on the branch. With uncommitted changes, or with a merge,
  rebase, cherry-pick or revert still in progress, it says so before asking
  anything. If a later commit conflicts, the rebase stops and **Resolve
  Conflicts…** takes you to the Conflicts dashboard to continue, skip or
  abort — abort puts the branch back as it was. Undo (Ctrl/Cmd+Alt+G Z)
  restores the branch afterwards — and, after "move those branches", the
  branches it carried. (#32)
- **Switch Repository.** When the folder you open holds more than one
  repository — a parent folder of checkouts, a multi-root workspace, a repo
  inside another's folder — the Changes view's header shows which one it is
  showing, before the branch. Click it (or run *GitStudio: Switch
  Repository…*) to pick another from a list of every repository, with its
  path, its branch and how many files it has changed. The Changes view, the
  commit graph, Worktrees and the sync status all follow your pick, and keep
  it while you edit files in other repositories — until you pick again, or
  that repository closes. The pick is remembered for the workspace; *Follow
  the active editor* in the same list goes back to showing whichever
  repository holds the file you're editing. (#32)
- **The branch menu works from the keyboard.** Type to search, then **Up** and
  **Down** move through the actions and branches, **Right** (or **Enter**) on a
  branch opens its actions, **Enter** runs one, and **Left** or **Escape** goes
  back — as in IntelliJ's branch popup. The highlighted row is drawn in your
  theme's selection colours (with the focus outline in high-contrast themes),
  follows the mouse too, and is read out by screen readers. Holding Enter never
  runs a second action, nor answers the question the first one asked.
  **PageUp** and **PageDown** move a page at a time, **Ctrl/Cmd+Home** and
  **End** go to the first and last row, and **Tab** leaves you in the search
  box, as does a click anywhere in the menu. A local branch's actions include
  **Add to Favorites** (or **Remove from Favorites**), so the star can be set
  from the keyboard; from there or from the star, the branch moves to or from
  Favorites at once, and stays there. (#32)
- **GitStudio: Branches…** in the Command Palette opens the branch menu, as
  the branch name in the Changes view and the status bar do — and so does
  **Ctrl/Cmd+Alt+G G**, in the same chord as GitStudio's other keys.
- **The branch menu finds the branch you meant.** Letters can be scattered,
  as long as each follows the one before or starts a word: `rel21` finds
  `release/2.1`, `fl` finds `feature/login`. An exact name or a prefix always
  ranks above a scattered match. With a query, the highlight — what Enter
  runs — is on the best match of all, and a branch wins a tie with an action:
  `fe` + Enter opens `feature`'s actions instead of fetching, while `fetch`
  still fetches. Every matched letter is marked, on the highlighted row too,
  and a long name whose match is past the row's end is cut in the middle
  instead (`feature/…/billing-address-val…`) — scattered letters too, the
  name's start kept (`fval`: `feature/…validation-for…`) — the whole name in
  its tooltip.
  A query that matches no branch or tag offers to make it — *New Branch
  'fix/login'…* — or to check it out as a revision — *Checkout Revision
  'a1b2c3d'…* — each opening its dialog with what you typed. (#32)
- **A branch's actions fit a sidebar.** Where there is no room beside the
  branch menu, a branch's actions open in the menu itself, under a back row
  naming the branch (**‹ feature**); the back row, Left and Escape return to
  the list where you left it, and typing returns to it and searches. Where
  there is room, they open beside the menu as before — every branch of one
  menu the same way — and resizing the sidebar moves them between the two.
  The same action stays highlighted through a resize or a refresh, also one
  that adds or removes actions above it (an upstream pruned by a fetch). A
  screen reader hears the back row as a button, *Back to the branches*, and
  each group's heading in words: *Remote origin, 56 branches*. (#32)
- **Remote branches are grouped by remote** in the branch menu — origin,
  upstream, a fork's — each under its own heading with its count, its rows
  named without the remote, and shown 40 at a time with **Show more**. A
  group's heading stays pinned at the top while its rows scroll under it.
- **Reset a branch to its remote.** A local branch that tracks a remote branch
  has **Reset to 'origin/feature'…** in its branch-menu actions. GitStudio
  fetches first, then says exactly what the reset would take away — the commits
  on your branch that the remote doesn't have (with their messages), and, for
  the branch you're on, how many files with uncommitted changes are discarded —
  before anything happens. A branch that is only behind is fast-forwarded, and
  says so. The branch you're on is reset with its working tree; any other branch
  is moved without touching your files, and one checked out in another worktree
  is left alone, with a message saying where. **Undo** (Ctrl/Cmd+Alt+G Z) puts
  the branch back, with the uncommitted changes you had. (#32)
- **Checkout 'origin/feature' when your local 'feature' has commits of its
  own** now asks: switch to your local branch as it is, or reset it to
  'origin/feature' first. When your local branch has nothing of its own, the
  checkout just switches to it, as before. (#32)
- **Set the action of several commits at once in an interactive rebase.** In
  the Interactive Rebase workspace, click a commit, then Shift-click or
  Cmd/Ctrl-click others — or use **Shift+Up/Down**, **Home**/**End** and
  **Cmd/Ctrl+A**; **Escape** goes back to one — and choose **Pick**,
  **Reword**, **Squash**, **Fixup**, **Edit** or **Drop** in the **Set
  action** bar at the top, or press git's own letter for it: **P R S F E D**.
  **Alt+Up/Down** and dragging move the whole selection. **Squash** or
  **Fixup** folds each selected commit into the kept commit below it, so a
  block of commits folds into the one under the block. When no kept commit is
  below — the selection reaches the oldest commit you keep — that oldest
  selected commit stays as it is, for the rest to fold into, and the plan
  says why instead of letting the rebase fail. The editor that opens for a
  `git rebase -i` run in a terminal does the same in git's own order, oldest
  at the top, so there a commit folds into the kept one above it. (#32)
- **The Changes list from the keyboard.** The list is one tab stop now, and
  the arrow keys walk it: **Up**/**Down** (and **Home**, **End**, **PageUp**,
  **PageDown**) move through what is showing, **Right** and **Left** open and
  close a group, a folder or a file's changes — or step into and out of one —
  **Enter** opens a file's diff, **Space** ticks a file (or a single change)
  in the checkbox view, **Shift+Up/Down** extends the selection and
  **Ctrl/Cmd+A** selects every file. **Shift+F10** (or the menu key) opens
  the menu of a file, a folder or a group — with everything its buttons do:
  Stage, Unstage and Discard, Stage Folder, Stage All, Unstage All and
  Discard All — and a right-click on a folder or a group opens the same
  menu. **Up** and **Down** move through a menu, and choosing from it or
  pressing **Escape** puts you back on the row. A screen reader hears a tree:
  each row is its file and what happened to it ("README.md, Modified"),
  whether it is ticked, and whether a group or folder is open — not every
  button on the row read out together. **Tab** reaches the first row you can
  see, also when nothing is staged. When a file you are on leaves the list
  (staged — from its menu too — or discarded), the keyboard moves to the next
  one. The Stashes group is part of the same tree: the arrows walk on from
  your changes into it, **Right** opens a stash and steps into its files, and
  **Delete** on a stash asks to drop it. The push review's files are
  reachable with **Tab** (**Enter** opens one's diff), and **Tab** stays in
  the dialog. A button reached with **Tab** shows its tip, as it does under
  the pointer.
- **GitStudio's settings in groups.** In the Settings editor they are no
  longer one list sorted with fourteen AI settings first: *General*, *Changes
  & Staging*, *Commit & Sync*, *Blame*, *Merge & Diff*, *AI* and *Advanced*,
  each with the setting people reach for first at the top. Every setting keeps
  its name, so what you have set keeps working.
- **Get Started shows each step.** Every step of the walkthrough showed the
  GitStudio logo; each now shows what it leads to — the Commit Graph, a commit
  opened from a blamed line, the Changes view with a file's changes ticked,
  Line History, the merge editor on a conflict, the AI settings — in your
  theme, high contrast included. Staging or committing in the Changes view now
  checks off "Stage changes & commit" (only the editor's Stage Hunk did).

### Changed
- **Whatever you picked is lit, never lined.** A selected thing is marked by
  a tint of the theme's accent, with a soft glow on a tab, a pill or a
  button, and no longer by a line. That covers the selected commit in the
  graph and in the Commits list (the commit the keyboard is on is lit a shade
  deeper), selected files in Changes and in a stash (a little stronger under
  the pointer, and the row under the pointer no longer grows a coloured
  rail), a question's highlighted choice, the rebase selection and the action
  it is set to, the Compare panel's tabs, a pull request's tab, verdict and
  merge method, and the pull request checked out here. Search matches in the
  graph and the Commits list are washed a soft yellow; a result you select
  stays selected, its selection fill touched with that yellow, and a
  selected commit the search does not match no longer fades with the rest.
  The branch you're on, open in its pill, the row whose actions are open
  beside a wide branch menu, and the merge editor's pressed Synchronized
  scrolling toggle are lit too. Before, many of these were marked by a bar
  down an edge, an underline or an accent outline. The words on every tint
  are at least 4.5:1, under the pointer too. High Contrast themes keep VS
  Code's own whole ring around a selection (dashed on a selected file), and
  the keyboard's focus ring is unchanged.
- **The branch menu's highlighted row is lit, not outlined.** The row the
  arrow keys or the pointer are on — an action, a branch, one of a branch's
  actions, a Delete — is a soft tint of your theme's accent with its words
  at full strength, the same under the pointer as from the keyboard, and
  only one row is lit at a time. Under the pointer, an item used to turn
  grey inside a blue outline with its words faded. A row's own menu (a
  file's, a stash's) highlights its items the same way. High contrast
  themes keep their border. A tooltip now shows only when it adds
  something — a name that is cut short, or an explanation — never the words
  already on the row (a file at the root no longer shows its own name), and
  one too wide for a narrow sidebar wraps between its words.
- **A branch's actions are in one order for every kind of ref** — the
  branch you're on, any other, a remote branch, a tag: checkout and what
  starts from it, then compare, merge and rebase, then push and the tracked
  branch, then rename, copy and favorite, then reset and delete — with a
  separator only between those groups. A branch whose upstream was deleted
  from its remote starts with **Set Tracked Branch…**. The branch you're on
  has **Tracked Branch…** too, and offers no pull when it tracks nothing, or
  a branch deleted from its remote — in its own actions and at the top of
  the menu alike; searching for Pull then says why.
- **On a detached HEAD the branch menu offers no Pull or Push**, which had
  no branch to act on; one line says so where they were — *Detached at
  a1b2c3d — check out a branch to pull or push* — with the search box empty,
  or when you search for Pull or Push, and is read out with the search box.
- The branch menu's words: **Update (pull)** is **Pull**, as the Changes
  view and the status bar call it (typing "update" still finds it), and
  Rebase no longer wears the pull-request icon.
- A branch row in the branch menu names its upstream by the remote alone
  (**origin**) when it tracks the branch of the same name there, and in full
  otherwise — or when that branch is gone from the remote, struck through;
  ↑/↓ counts past 999 read **999+** (the tooltip has the number).
  An empty favorite star shows only on the row under the pointer or the
  highlight — a set one always — and every row's chevron is shown, saying it
  has actions. On the highlighted row, the ↑/↓ counts take the selection's
  colour, so they stay readable in Light themes.
- **Pull requests speak the GitStudio desktop app's words.** The list, a pull
  request's page and the new form use the desktop's words and icons for the
  same things — **Checkout**, **Approve**, **Review**, **Merge**, **Mark
  ready**, **Update branch**, **Close pull request**, **Copy link**, **More
  actions**, **New pull request**, and the tabs Conversation, Commits, Checks
  and Files. In the Command Palette, *Create Pull Request* is now **New Pull
  Request**, *Check Out Pull Request* is **Checkout Pull Request**, and *Start
  Review* is **Review Pull Request**.

### Fixed
- **GitStudio reads in Cursor.** Cursor's own dark theme draws its focus
  colour at 15% white, and GitStudio's accent was that colour: a selected
  file was a 3% white wash, a drop target barely changed, and the band of
  words over your changes let the rows show through. Where a theme's focus
  colour is see-through, GitStudio's accent is now that theme's own button
  colour (Cursor's light blue); every other theme looks as it did. The AI
  settings' open form glows in their violet again.
- **A dialog's main button always reads.** Its label took the theme's
  button text and its fill the focus colour — near-black on dark grey in
  Cursor, and under the 4.5:1 contrast bar in Dark+, Light+ and High
  Contrast Dark. It is GitStudio's violet with white now, as Push and
  Commit & Push are, and darkens under the pointer instead of washing out.
- **Apply/Pop Unstaged says what git does.** Without its staging, git brings
  a stash's changes back unstaged — all but a new file and a renamed file's
  new name, which it adds back staged. The choice now says so when the
  stash holds one; and when all a stash had staged is new files, nothing is
  asked, because the answer would change nothing.
- **Checkout Tag or Revision… no longer hands git an option.** A revision
  typed as `-f` was read by git as its force flag and threw away every
  uncommitted change. A revision starting with "-" is refused, in the dialog
  and before git sees it. A tag or branch picked from its list is checked
  out as exactly that ref, even when a tag and a branch share its name —
  git took the branch.
- A branch's actions closed by typing in the branch menu no longer open again
  when the view refreshes, and a tag's actions stay on the tag's row when it
  refreshes — also when a branch has the same name.
- **Undo puts back what the operation changed — and only that.** Undo used to
  reset whichever branch you were on to the commit HEAD had been at. Undoing
  *Checkout feature* moved `feature` onto your previous branch's commit
  instead of switching back — and when `feature` was pushed, it committed a
  revert of it; undoing *Checkout main* from a branch ahead of it
  fast-forwarded `main`; undoing a tag checkout or *Detach HEAD Here* left
  you detached. Undo now switches back to the branch (or detached commit) you
  were on — your uncommitted changes come along, and it refuses rather than
  overwrite them — and deletes the local branch a *Checkout origin/x* created.
  Its question says what will happen, in words: "Switch back to 'main'",
  "Bring back branch 'feature' at 1a2b3c4".
- **Delete branch, Drop stash and Pop stash can really be undone.** Their
  questions promised Undo could bring the branch or the stash back; Undo said
  it had and restored nothing, and undoing a pop threw the popped changes
  away. Undo now brings a deleted branch back at its commit, tracking what it
  tracked, and a dropped or popped stash back where it was in the list — also
  while a merge or rebase is stopped on a conflict, where nothing was
  recorded at all. Cancelling at "not fully merged" no longer offers "Undid?
  Delete branch", and a file you save while that question is open is yours:
  Undo of the delete brings the branch back and leaves the file alone.
- **A file saved while an operation's question is open** is no longer taken
  as the operation's. Cancelling *Stash & Retry* on a merge or rebase records
  nothing, and where an Undo would put the working tree back over such an
  edit, its question says so, in red.
- **Undo never throws away work you did after the operation without saying
  so.** With a commit made since, Undo says the branch has moved and changes
  nothing. Uncommitted edits made since are kept when they don't touch the
  files going back, and named as discarded when they do; a new untracked file
  where Undo would put a file back is never overwritten — Undo names it and
  waits.
- **The *Reset --hard* question said Undo could not bring your uncommitted
  edits back.** It can, and does: undoing the reset puts the branch back and
  the edits with it. The question now says so — except while a conflict is
  unresolved, when git can't keep a copy of them: then it says Undo can put
  the branch back but not those edits, and Undo says the same. *Reset to
  'origin/x'* words its question the same way.
- **Undo of a rebase that stopped** — Rebase onto…, the Interactive Rebase
  workspace, or *Start Interactive Rebase Here* while paused — abandons the
  rebase, instead of leaving it half-open on a detached HEAD, and brings back
  the uncommitted changes *Stash & Retry* had set aside for it. An interactive
  rebase you quit without running changed nothing, so Undo says so; it no
  longer resets the branch to where it was at launch, dropping the commits
  you made since — nor puts back a branch you rebased yourself afterwards.
  Its Undo names the base as a short sha, not all forty characters.
- **Undo after reordering commits with "move those branches"** puts those
  branches back too, not just the current one — as long as nothing has been
  committed on them since; if something has, Undo says so and changes
  nothing. (#32)
- **Undo of an amend** brings your staged changes back staged. Once the
  amended commit has been pushed, Undo adds a commit that undoes just the
  amendment — it used to revert the whole commit. A commit you make while
  that question is open is kept: nothing is reverted, and Undo says why.
- **Undo no longer reverts commits that were already on the remote.** After a
  fast-forward merge, a rebase that fast-forwarded, or a reset forward onto
  your remote's newer commits, Undo moves the branch back rather than offering
  to commit a revert of them. Revert instead of rewrite is kept for a result
  you pushed after the operation.
- **Undo History** undoes an older entry after every newer one, newest first,
  each asking its own question. A newer one that can't be undone any more
  (you have committed since) can be forgotten on the way, and Undo's own
  warning about it has **Forget It** — it no longer stands in front of
  everything older for good.
- **The Undo on an operation's notification undoes that operation.** Pressed
  after you had done something else, it undid the newer operation instead;
  now the newer ones are undone first, each asked, then the one it names.
- **Undoing Accept Yours / Accept Theirs** in the Conflicts panel no longer
  writes the conflict markers over edits you made to that file since, staged
  or not; it says so and leaves the file alone.
- **The editor for a `git rebase -i` run in a terminal listed no commits.**
  It opened saying "No commits to rebase." over a todo full of them. It shows
  the plan now, each line with the action the todo gives it, and a long one
  scrolls with **Start rebase** kept on screen. It also opens for `git rebase
  --edit-todo` on a paused rebase, where git has already applied a commit
  above the first line: a first line that squashes into it is a plan git
  runs, and the editor lets you start it. (#32)
- **Interactive Rebase: a dragged commit lands where the line says.** A drag
  could put the commit one row away from the line drawn for it — dragging up
  in the workspace, dragging down in the terminal rebase's editor. The line is
  drawn on the side you are pointing at, and the commit lands there. Also in
  the workspace: the reason a squash was refused is shown just above **Start
  Rebase**, on screen however long the plan is; the commit the keyboard moves
  to is never hidden under the header or the footer; and **Reset plan** no
  longer has a grey button face. (#32)
- **Interactive Rebase: a paused rebase keeps Continue, Skip and Abort.**
  While a rebase is paused on a conflict or an edit, the workspace's banner
  holds its way out. A refused squash or **Reset plan** took that banner away
  for good; now the reason shows for a few seconds and the banner comes back,
  without moving the keyboard. (#32)
- **Undo after moving a branch back onto pushed history.** Undoing an
  operation that left the branch on an older, already-pushed commit — a reset
  to it, or dropping your last local commit — offered to revert an empty range
  and failed with git's "empty commit set passed". Going back is a
  fast-forward that rewrites nothing, so Undo now simply does it. (#32)
- Blame in a repository nested inside another's folder (a vendored checkout,
  a submodule) no longer runs in the outer repository when the outer one is
  the repository on screen. (#32)
- **Staging several files at once works.** Stage, Unstage or Discard on a
  multi-selection, the selection bar, or a few quick clicks sent one git
  command per file, all together, and most were refused ("Unable to create
  '.git/index.lock': File exists"), so only some files moved and nothing
  said so. A selection is now one request, writes to a repository's index
  run one at a time, and a file git refuses goes back to where it was, with
  git's reason.
- **Discard on a multi-selection discards every selected file.** "Discard 3
  Files" asked once per file, each question dismissed the one before, and
  only the last file was discarded. It asks once, naming the count, and says
  what happens: a partly staged file keeps its staged part; an untracked
  file is deleted.
- **A conflicted file is never staged or committed with its conflict markers
  in it.** Staging a conflicted row (its +, its tick, its folder, Stage All)
  holds back every file that still has markers and says which; **Commit
  all** never includes a conflicted file, and no longer counts them.
- **The commit button no longer offers a push that cannot work.** On a
  detached HEAD (every stopped rebase is one) or in a repository with no
  remote, it offers Commit, and its tip says why. The push review on a
  detached HEAD says that is why it cannot push, and it never starts with
  **Force push** focused. In a stopped rebase the reason is to finish it —
  the commits then land on the branch being rebased — never to create a
  branch at a half-rebased commit; any other operation stopped on a detached
  HEAD is named, and finished before a branch is made.
- **Diffs of a renamed file show the change, not an empty or all-new file.**
  Blame's Show Diff and Open Previous Revision on a line older than the
  rename, a rename commit in the Commit Graph's details, a staged rename in
  the Changes view, and file history, the Timeline and Line History before a
  rename now read each side under the name the file had there. Opening a
  file deleted from the working tree shows it removed.
- The Commit Graph's header counted the *Uncommitted changes* row as a
  commit ("18 commits" for 17).
- **The Command Palette lists only what works.** *GitStudio: Welcome* (which
  said "The full Git suite is coming online") now opens Get Started and is
  not listed beside it; *Show Commit Graph* is listed once; the retired
  *Refresh Commits* / *Refresh Branches* are gone; *Continue / Skip / Abort
  Operation* and *Abort Rebase* appear only while something is stopped; *Show
  Process Audit* only while the audit is on.
- The status bar's Force push question described it, with
  `gitstudio.push.forceWithLease` off, as overwriting work you haven't seen.
  Every force push is leased; the question says so, and the setting, which
  changed nothing else, is gone.
- Connecting Claude Code, Codex or Gemini CLI set `gitstudio.ai.provider` to
  a value the Settings editor flagged as not allowed. `cli` is now one of its
  values.
- Messages that said to run *GitStudio: Set AI API Key*, which does not
  exist, name *Set Anthropic API Key…* or *Connect AI Provider*, and the
  walkthrough's AI button opens Connect AI Provider.
- The toast after an operation read "Undid? Amend commit". It says what
  happened — "Amend commit — done." — with **Undo** beside it. One that
  stopped for you (a conflict, an emptied cherry-pick) says "Cherry-pick 2
  commits stopped — finish it, or Undo.", and a pop that hit conflicts and
  kept its stash says it did not finish.
- **The status bar items have names of their own.** The branch, Commit Graph,
  terminal and blame items each have an id and a name, so the status bar's
  menu lists and hides them one by one; a screen reader hears the branch
  item in words ("Branch main: 1 commit to pull, 2 commits to push"). On a
  detached HEAD the item says "Detached HEAD at abc1234", and no longer shows
  the publish cloud or offers Publish Branch, which cannot work there.
- **The Changes view's arrows point the way they open**: › when closed and ˅
  when open, as everywhere else in VS Code, for groups, folders and a file's
  changes toggle (a closed one showed ˄ and an open one ›).
- Before the Changes view has read anything it says "Reading changes…", not
  "Working tree clean"; while repositories are still being found, it, the
  Commit Graph, the Commits view and Pull Requests say "Looking for a
  repository…", not "No repository open". With no repository, the Commit
  Graph and Commits view say so instead of "No commits yet".
- GitStudio's AI sparkle no longer appears in VS Code's own commit box while
  AI is off, and the Connect-AI plug leaves the commit box once you turn AI
  off.
- *Open on GitHub* and blame's *View in Browser* open the commit on the
  branch's upstream remote (then origin, then any other), not always on
  `origin`: a repository whose only remote is `upstream` works.
- The Compare panel says "1 commit" and "1 file changed", and each ref shows
  the icon of what it is: branch, remote branch, tag or commit.
- On a clean tree, Stage All and Stash are disabled instead of acting on
  nothing, and the toolbar's Stage All is disabled while only conflicted files
  are left (the Merge Changes group's Stage All stages those); the tree/list
  toggle says which view it switches to.
- A double-click on a file opens its diff once, not twice.
- At sidebar width a file row keeps the file's name whole while its folder
  can give way, and the folder keeps its end (the folder the file is in).
- Destructive buttons (a Discard or Delete confirm, Force push) are readable:
  white on the theme's error colour was about 2.5:1 in Dark+.
- The subject-length counter says what it counts on hover, and past 50
  characters turns the warning colour instead of blue.
- A screen reader hears every tick and icon button in the Changes view by
  name (a file's tick: "Include README.md in the commit"), and whether a
  group, or a folder in the tree view, is expanded.
- The README and the Get Started walkthrough no longer say Enter commits,
  that AI is off by default (with Copilot it works with nothing to set up),
  or that the graph is at the top of the sidebar or in an editor tab; the
  shortcut table lists Ctrl/Cmd+Alt+G T.
- **Stashes: Drop, Pop, Apply and Create Branch act on the stash you picked.**
  They named it by its place in the list (`stash@{2}`), and a stash made
  while a question was open — a pull that stashes by itself, Stash & Retry, a
  terminal — moved every number down, so Drop could drop a different stash.
  They now find the stash you picked just before git runs; if it has left the
  list, they say so and change nothing. The Drop question names the stash by
  its message.
- **A stash of new files opened as an empty document.** A stash made with
  untracked files (the Stash dialog makes one whenever a new file is ticked)
  left those files out of its document, so a stash of only new files looked
  empty. They are shown now, beside the edits.
- **Apply and Pop keep what the stash had staged.** Its staged changes came
  back unstaged, and popping a file that was staged and then edited further
  lost the staged version for good. They come back staged now. When your own
  staged changes are in the way, or the staged part no longer applies, it asks
  first whether to apply the stash unstaged — and says a staged version is
  lost only where one is. A change you had staged and then undone in the file
  before stashing comes back unstaged too; git alone brought nothing of it
  back.
- **The Stash dialog listed a partly staged file twice**, and unticking one of
  its two rows still stashed it. Each file has one row now.
- **Create Branch from a stash asks about changes in its way.** Over an
  uncommitted edit — or, for a stash with staged changes, over anything you
  had staged — git switched to the new branch, then refused to apply the
  stash and showed its error in red, leaving you on the new branch without
  your stash. Now it asks first, Stash & Retry or Cancel, as Apply and Pop do,
  naming the branch it is in the way of, and a name a branch already has is
  said before anything runs.
- **Undo names a stash by its message.** "Pop stash@{0} — done." named
  whichever stash was on top by the time you read it, in the toast and in
  Undo History; it reads "Pop “my work” — done." now, and the Drop question
  says how many files leave the list. Undo's own question says the same —
  "Put the stash “my work” back where it was in the stash list", not git's
  "On main: my work" and a stash@{n}.
- **The Changes view keeps the keyboard where it was.** Opening a group or a
  folder with Enter, or anything that redrew the list, dropped the keyboard
  to the top of the view; the same row keeps it now. When the last stash
  leaves, the row above the Stashes group takes the keyboard.
- The Changes toolbar's title stays on one line in the tree view at sidebar
  width, and its Stash buttons wear the stash icon the stashes do.
- The branch menu's last **Show more** row says its number once: "Show 5
  more", not "Show 5 more of 5".
- **Removing a locked worktree works.** Remove asked twice and then failed
  with git's "cannot remove a locked working tree". It now asks once, quoting
  the lock's reason, and **Unlock and Remove** removes it.
- **Removing a worktree says what goes with it.** The question names the
  worktree by its folder, as the list does, and its branch in the body; it
  lists the uncommitted files that are deleted (five,
  then how many more) and says the branch and its commits stay; the button
  reads **Discard Changes and Remove** when there are any. A worktree that
  changed before you answered — an agent still at work in it — is asked about
  again instead of deleted, and keeps its lock: a file the question didn't
  name is never deleted with the rest, whether the worktree was clean or
  already had changes when you were asked.
- **The worktree this window has open is never removed from under it.** Remove
  deleted the window's own folder; it is no longer offered there (a worktree
  open as another folder of the workspace counts too), and says why if
  reached. The main worktree, which git never removes, now reads *main
  worktree* and offers no Remove.
- **A worktree whose folder is gone** reads *folder missing* — locked ones too,
  which git never calls prunable — opens nothing when clicked, and offers
  **Forget Worktree**, which clears git's record of it (past its lock, when it
  has one). For a locked one the question says that a folder on a drive that
  isn't connected is no longer a worktree when the drive comes back. It used
  to open a window onto the missing folder.
- **A worktree folder whose `.git` is gone** — still listed by git, but no
  longer a worktree — reads *Not a worktree*, and is never read, opened,
  pulled, pushed or removed as one: git in that folder reads the repository
  around it, which for a worktree nested in your project (as agents'
  `.claude/worktrees/…` are) is your main worktree. Its only actions are
  Reveal and **Forget Worktree…**, which clears git's record of that one
  worktree and leaves the folder and its files alone, and **Prune** counts
  it. Removing one used to fail with git's "validation failed". The
  **GitStudio: Forget Worktree…** command offers only the worktrees there is
  something to forget for, and never deletes a folder.
- **New Worktree no longer leaves a stray branch behind when it fails**, so
  trying again with the same name works. Folders are named for the whole
  branch (`feature/login` → `app-feature-login`), so `bugfix/login` beside it
  no longer lands in the same folder; a folder that already exists is refused
  before anything runs, and so is one git still keeps for a worktree whose
  folder is gone (with where to forget it); a branch name that's taken is
  asked for again; and a branch another worktree has checked out goes
  straight to a new branch from it, saying where it's checked out.
- *This window* in Worktrees survives opening the repository through a
  symlink, and the worktree this window has open no longer offers to open
  itself again.
- **Lock Worktree…** asks why (optional); the reason shows in the row's
  tooltip and in the Remove question.
- **Prune Worktrees** says which worktrees it pruned, or that there was nothing
  to prune — it reported success either way.
- Branch tooltips show upstream names without stray backslashes.
- **The push review and Compare name every file as it is on disk.** A file
  whose name had an accent (`été.txt`) or a tab was listed in git's quoted
  form ("\303\251t\303\251.txt"), without its line counts, and opening it
  showed nothing.
- A worktree row's button is **Open in New Window**, and it opens the
  worktree straight away; **Open in This Window** is in the row's menu. The
  button was *Open Worktree* and asked which window first.
- **Removing a worktree that is stopped in a merge, rebase, cherry-pick or
  revert says so**, and that removing it abandons the operation. A worktree
  stopped in a rebase with nothing uncommitted used to go without a word.
- **Checking out or deleting a branch that another worktree has checked out
  says where it is** — from the Branches view, the branch menu, the Commit
  Graph and a pull request's Checkout — with **Open Worktree in New
  Window**. Each used to run git and show its refusal (*already used by
  worktree*); Delete asked first, and the graph reported it as an error.
  When that worktree's folder is gone — git still keeps the branch for it —
  it says to forget that worktree first.
- New Worktree from a branch whose name starts with "-" makes a new branch
  from it, saying why, instead of offering a checkout that git would turn
  into a detached HEAD.
- **A branch's actions in a narrow or short sidebar.** The actions a branch
  opens in the branch menu no longer run off the right or bottom edge of the
  view, where Reset and Delete could not be reached: they stay inside it and
  scroll when there are more than fit, keeping the highlighted one in sight.
  The actions menu a changed file opens does the same.
- **The branch menu in a short or narrow sidebar** uses all the room below
  the branch name rather than about three quarters of the view's height,
  fits a sidebar narrower than itself, and stays inside the view — with a
  branch's actions — when you resize the sidebar while it is open.
- The branch menu says **Loading branches…** until the branches arrive,
  instead of showing a repository with none.
- On a detached HEAD, a branch's actions name the commit they act on —
  *Merge 'origin/main' into HEAD (a1b2c3d)* — rather than a branch called
  'current branch', and so does the question Merge or Rebase then asks,
  which says the result is on no branch rather than warning about a push.
- The branch menu keeps its width while you type — the width its branches
  need, also when they arrive after the menu opened or the sidebar is resized
  under it — and a new search starts at the top of the list with its first
  group heading in view.
- A branch's name keeps its room in the branch menu: in a narrow sidebar the
  upstream beside it is shortened, or left to the tooltip, before the name
  loses a letter, and the ↑/↓ counts step aside, to the tooltip, before the
  name is cut to under half the row. The upstream, the group counts and the
  empty stars are drawn in your theme's secondary text colour, readable in
  light themes, and the highlighted row still shows which letters matched
  your search, and its star.
- A branch whose upstream was deleted from the remote — what a merged pull
  request leaves behind — shows that upstream struck through and marked
  **gone** in the branch menu, instead of looking like a live one, and its
  actions no longer offer a pull from it that could only fail.
- A branch-menu action that fails is named as you chose it — *Pull into
  'feature' failed* — rather than by an internal name.
- The branch menu's words and icons: **Push…** says it asks before pushing,
  *Pull 2 Commits into 'feature'* says what the number counts, and Checkout
  and New Worktree have icons of their own — Checkout no longer wears the
  check that marks the branch you're on, nor New Worktree the Changes view's
  tree/list toggle.
- **Pull requests: checks from GitHub Actions.** The Pull Requests list and a
  PR's page said "running" or "No checks" for every repository on GitHub
  Actions, whether its runs had failed or passed. They read the runs now, with
  any legacy statuses: a failure reads as failed, a pass as passed, "No
  checks" only when there are none. Every row shows it — drafts too, not just
  the first eight — as a mark of its own in a colour of its own, with the word
  beside it (Passed, Failed, Running); rows no longer show the literal text
  `$(check)`, `$(x)` or `$(circle-filled)`.
- **Creating a pull request: Draft creates a draft.** Every pull request was
  created ready for review, whichever you picked. A branch that lives in your
  fork is now sent to GitHub as `owner:branch` — as a bare name, GitHub looked
  for it in the target repository. The branch is pushed to the remote git
  pushes it to, under its own name: one started from `origin/main` tracks
  `main`, and creating the pull request pushed its commits into `main` — or, with a
  push remote set to your fork, into the original repository's `main`, and
  nothing reached the fork. It is pushed only when it isn't there yet or has
  commits that aren't, and what the branch tracks is left alone. The title
  proposed is the branch's one commit subject, or with several commits the
  branch name, as GitHub proposes it (it was the newest commit's subject).
  The base branches offered are the repository's own (`master` and `develop`
  were offered everywhere). "A pull request already exists" opens that pull
  request, not the list.
- **Renamed files in a pull request** diff against the file as it was, under
  its old name — the whole file showed as added — and the page says what each
  was renamed from.
- **Review comments GitHub accepts.** Only lines inside the diff take a
  comment: one comment anywhere else made GitHub refuse the whole review with
  just "Unprocessable Entity". Removed lines, and deleted files, take comments
  on their left side. A review is pinned to the commit its diffs show, so a
  push during the review no longer moves its comments onto other code, and a
  comment on several lines is sent as that range. Start Review reads the pull
  request's current head and opens its first file (it opened five previews,
  each replacing the last), and a file opened from the pull request's page
  during the review opens as the review sees it, so it takes comments too. A
  comment GitHub would still refuse is named before anything is sent, and when
  GitHub refuses, its reason is shown.
- **A pull request's diff starts where its branch left the base.** The left
  side was the base branch as it is now: once others had merged, it showed
  their new work as if the pull request removed it, and comments on removed
  lines were placed on the wrong lines — or couldn't be placed at all.
- **Delete Comment on a pending review comment** deletes that comment. It
  threw and deleted nothing. A comment already posted to GitHub no longer
  offers it.
- **Pending review comments are no longer thrown away.** Starting a review of
  another pull request leaves the one you were writing as it was — each pull
  request keeps its own — and **Discard Pending Review** asks first, counting
  the comments that are pending; discarding them leaves the ones already
  posted. A pull request whose files fail to load leaves your queued comments
  alone.
- **Checkout on a pull request you already have** brings its branch up to
  date. It failed while the branch was checked out, and it silently threw
  away any commits you had made on it; now a branch with commits the pull
  request doesn't have is never moved without asking. On the pull request's
  own branch already, it says so. The progress notification ends before
  "Checked out" appears, and its Open Pull Request opens that pull request
  even after you have switched repositories (it opened the same number in the
  repository active then).
- **A pull request's page:** label chips wear their colours (the page's own
  security policy dropped them, and every label was grey); a merged pull
  request reads **Merged** in purple and one closed without merging reads
  **Closed** in red (both read a purple "Closed"); after **Merge** the page
  flips to Merged at once, and the row leaves the list, without a reload or a
  second Merge — and stays Merged when a Refresh was still loading as the
  merge landed. Merge offers only the methods the repository allows, and
  isn't offered on a draft. A same-repository branch reads without its owner,
  and a file's line counts no longer show a red "−0".
- **The Pull Requests list no longer asks GitHub on every file save**, even
  while collapsed. It refreshes when it comes into view after two minutes,
  every two minutes while in view in a focused window, on Refresh, and when
  the repository or your sign-in changes. It names the repository it shows,
  drops another repository's pull requests as soon as you switch, and says why
  there is no list — no repository, no remote, or remotes not on github.com —
  instead of staying blank. A refresh that fails keeps the list and says so; a
  list that fails to load offers what can put it right: Retry; Sign in, as a
  new sign-in when GitHub no longer accepts yours (it handed the refused one
  back); or GitHub's page, when GitHub refuses you access. An answer that
  arrives after you have switched repositories is not shown over the other
  repository's list. Rows show when each pull request was last updated, the
  order they are in.
- **No more silent 100-item limits.** The Pull Requests list reaches every
  pull request, a page at a time, and says how many there are; every changed
  file is listed (GitHub lists up to 3,000), each one commentable in a
  review. A page's "Changed files" count is the pull request's own, and a
  list that is partial, or failed to load, says so.
- **github.com under another name.** Remotes using an SSH host alias
  (`git@github.com-work:…`, or any `~/.ssh/config` Host whose HostName is
  github.com), `ssh.github.com` (SSH over port 443) or `www.github.com` turned
  the pull request features off without a word. They are github.com now —
  and **Open on GitHub** and blame's **View in Browser** open their commits
  on github.com too (an `ssh://` remote was "not a GitHub address", and an
  alias opened `https://github.com-work/…`).
- **A pull request's diff that can't be loaded says why** — signed out, rate
  limited, offline — instead of an empty pane that claimed the file was added
  or deleted. A binary or very large file shows a note, not its bytes.
- **Interactive rebase under git 2.55 shows commit titles as they are.**
  git 2.55 writes each line of a rebase plan as `pick <sha> # <title>`, and
  the rebase editor showed that `#` in front of every commit's title. It
  reads both the older and the newer form now, telling them apart by the
  whole plan — so a title that itself starts with `#`, and an empty commit
  with no message (`# empty`), read as git wrote them under either — and a
  line whose action you change keeps git's own spelling.
- **A worktree is one folder however its path is spelled.** git names a
  worktree by its resolved path — `C:/Users/you/…` on Windows — and the same
  folder can be reached through a symlink or Windows' short `C:\Users\YOU~1\…`
  names. **New Worktree** into the folder of a worktree git still keeps, its
  folder gone, picked by such a spelling, ran git and showed its error; it
  says whose folder it is now. On Windows, worktree paths — in the Worktrees
  view, its tooltips and questions, and "checked out in the worktree at …" —
  are shown the Windows way, `C:\Users\…`.
- On Windows, SSH host aliases are read from `%HOME%\.ssh\config` when
  `HOME` is set — where Git for Windows' ssh reads them — so a remote through
  one is recognised as github.com there too.
- **Rebasing in a SHA-256 repository.** In a repository whose commit ids are
  64 characters long (`git init --object-format=sha256`), the rebase panel,
  Drop Commit and the several-commit actions were refused as an
  "unrecognised plan entry", and the rebase editor showed part of each id in
  front of the commit's title. They run now, and a reworded commit gets its
  new message — also when the rebase is continued after a conflict.
- **The operation banner reads right.** A stopped merge, rebase or
  cherry-pick was drawn conflict-red whatever its state, so "Every conflict
  is resolved." sat in an error box. It is amber while something is in the
  way (files still conflicted, or a stop git can't continue from) and your
  theme's accent once nothing is, with a pause or a tick for its icon. It no
  longer says things twice — "Rebasing feature onto main" is the title and
  "Commit 2 of 5: …" the line under it, without a "feature → onto → main"
  line repeating it — and at a sidebar's width its buttons sit on two rows,
  not three: the action it is waiting for on its own, the rest beside each
  other by their first word ("Continue", "Skip", "Abort").
- **Staging in a long list is instant.** Each Stage, Unstage or tick rebuilt
  every row of the Changes list — thousands of elements on a big change, and
  your place, hover and tooltip lost each time. Only the rows that changed are
  rebuilt now.
- **Saving a file no longer reloads the Commit Graph, blame and the
  Timeline.** Every save and every window focus made the graph (in the
  sidebar and the panel) re-read its history, blame forget every file and the
  Timeline empty. They reload when a branch, a tag or HEAD moves, an operation
  starts or stops, or you switch repositories; a save only updates the
  graph's *Uncommitted changes* row when it appears or goes (and its files, if
  it is open).
- **A narrow header keeps the branch's name.** With several repositories at
  sidebar width the branch was down to "fea…" while "Push 2" and "Pull 3" kept
  their full width. The repository's name still gives way first; then the
  Push and Pull pills keep their arrow and count.
- **Changed Files counts files.** A partly staged file — in Staged and in
  Unstaged — counted twice. The checkbox view's *Changes* tick shows as
  partly ticked when a file is partly staged, instead of empty.
- **Only where they can act.** *Open Changes* and *Stage with Ticks* were in
  the title bar of every file in a repository, a clean one too; they show on a
  file with changes now, as in Merge Studio. GitStudio's six items in the
  editor's right-click menu are one **GitStudio** submenu, its staging items
  (and the gutter's *Stage or Unstage the Change at This Line*) only on a file
  with changes, and *Annotate with Git Blame* shows whether it is on.
- **One symbol, one meaning.** *Review changes with AI* wore the same icon as
  the checkbox view and *Stage with Ticks*, and the Compare panel's unified
  diff the same as the Staged/Unstaged view. Each has its own now.
- The Compare panel shows an arrow between the two refs instead of git's
  `..` / `...` (the buttons beside them already say which comparison it is).
- **The AI settings panel wears your theme.** It was drawn in the desktop
  app's own dark palette under every dark theme, with no high-contrast look,
  and a dark theme drew the providers' names black on near-black. It uses the
  editor's colours now, high contrast included.
- **Notifications speak with one voice.** The same failure read "Push failed:
  …" from the status bar and "GitStudio: push failed — …" from the Changes
  view; "no repository" was said four ways; the graph's failures read
  "Cherry-pick failed: error: …" or "git branch failed: …", and a failed
  branch action (rename, delete, publish, push, fetch, tags, remotes) showed
  git's words alone. The status bar, the Changes view, the branch actions,
  Undo, file and line history, rebase, blame, the graph and Compare now say
  things one way: a notification starts "GitStudio:", a failure names what
  failed and then git's reason — "GitStudio: Delete branch failed — …" — and
  a copy is confirmed in the status bar, as the graph's always was (blame's
  was a notification). The push review gives a commit's age as the rest of
  GitStudio does ("3h", not "3h ago").

## [1.14.0] - 2026-09-25

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
