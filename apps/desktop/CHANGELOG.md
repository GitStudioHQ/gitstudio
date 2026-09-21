# Changelog

All notable changes to **GitStudio Desktop** are documented here. This project
adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The VS Code / Cursor extension has its own changelog at
[`apps/extension/CHANGELOG.md`](../extension/CHANGELOG.md). The two ship
separately — desktop releases are tagged `app-v*`, extension releases `ext-v*` —
but they share the same engine, so most Git behaviour lands in both at once.

## [2.0.2] - 2026-09-21

### Added
- **Filter the Commit Graph by branch.** A **Branches** picker in the Commits
  toolbar rebuilds the graph around only the refs you tick, instead of every
  branch, remote and tag at once. Presets for **Current branch**, **Current +
  upstream**, **Local only** and **All**; a filter box for busy repositories;
  ref chips follow the selection; right-click (or ⌥-click) a chip for **Show
  only this branch** / **Add to filter** / **Remove from filter** / **Checkout**.
  Remembered per repository. Revealing a commit the filter hides says so and
  offers **Show all branches**. (#30)

### Fixed
- **Compare lost the file you were reading.** A change under `.git` (another
  tool's fetch, or git refreshing its index under a plain `git status`), ⌘R, or
  coming back to the window after editing in your editor rebuilt the Compare
  view and opened its *first* file. Compare now re-reads the comparison in
  place: if nothing changed the page is untouched, if it changed the file you
  had open is reopened, and only when that file left the comparison does the
  selection move. (#24)
- **The Commits view's CHANGES column cost up to three git processes per row**
  and stopped answering past sixty rows; it is one process per visible window
  now, and every row is answered. The Code view's commit count no longer walks
  the whole history on every visit.


## [2.0.1] - 2026-09-19

### Fixed

- **A downloaded `.dmg` opened to "GitStudio is damaged"** on macOS 15 and later,
  with no way through. The shipped bundle had no signature at all — with no
  Developer ID configured, electron-builder skips signing entirely. The build
  now ad-hoc signs the bundle (`build/afterPack.js`), so a quarantined copy gets
  the ordinary "Apple could not verify…" prompt and an **Open Anyway** in
  System Settings ▸ Privacy & Security instead of a dead end. Homebrew, the
  one-line installer and the in-app updater were never affected, and a real
  certificate replaces the ad-hoc signature the moment one is configured.
- **Numbered lists with blank lines between the items** — the way every model
  writes an answer, and most people write an issue — rendered as one list per
  item, so the reader saw "1. 1. 1." in the Assistant, in issue and PR threads
  and in READMEs. A blank line no longer ends a list when another item follows
  it, and a wrapped item's indented second line stays inside the item.
- **Homebrew installs opened to "GitStudio is damaged"** on macOS 15 and later.
  Homebrew quarantines every download and no longer offers `--no-quarantine`;
  the cask now strips the attribute after installing — from the framework
  symlinks too, which `xattr -dr` skips — and its caveats say what to run if
  macOS still refuses. Homebrew is one line now — `brew install --cask
  gitstudiohq/gitstudio/gitstudio` — through the new
  [GitStudioHQ/homebrew-gitstudio](https://github.com/GitStudioHQ/homebrew-gitstudio)
  tap, which the release job updates; no `brew tap` URL and no `brew trust`,
  because the fully-qualified cask name is Homebrew's own consent path.
- **`irm https://gitstudio.dev/install.ps1 | iex` died after the download** on
  Windows PowerShell 5.1 — the shell a fresh Windows machine runs it in — because
  the installer was started with an empty `-ArgumentList`, which 5.1 rejects. The
  switch is passed only with `-Silent` now, and a failure `throw`s instead of
  `exit`ing the caller's session.
- **`install.sh` on Linux** now says up front when `libfuse2` is missing (the
  AppImage needs it; Ubuntu 22.04+ and Debian 12 no longer ship it) and installs
  the launcher icon it used to only make a folder for.
- **`SHA256SUMS.txt` omitted the `.rpm` and `.tar.gz`**; the release job hashes
  every format now.

- **winget**: `GitStudioHQ.GitStudio` is submitted to the community repository
  (microsoft/winget-pkgs#437547); once it lands, every later release opens its
  own update PR from the release workflow.

## [2.0.0] - 2026-09-18

The version number is the honest one: this is not a point release. Split panes
are gone, Home is a workbench, repositories are understood by the folders they
live in, and the app reads GitHub without cloning. The desktop app also
installs three new ways — `curl`, Homebrew, and the Windows installer it
always had.

The redesign wave: full-page details instead of split panes, a Home that is a
workbench, and repositories understood by the folders they live in.

### Added
- **Home is a workbench.** The open repository's state (staged/unstaged, commits
  to push, merged branches to sweep, stashes, last commit) with Push and Fetch
  on the card; your other repositories with `●3 ↑1 ↓2` working-tree signals;
  a Needs You card that reaches across every repository.
- **Repositories destination.** Track many folders; the app learns them from what
  you open; grouping two levels deep by the folder a repository actually lives in;
  clone a URL from the same screen; linked worktrees list as checkouts and are
  never counted as repositories.
- **Search with a scope** — this machine or GitHub — from the topbar field, ⌘K, or
  Home. Organizations and Gists live in the GitHub rail group.
- **Issues and pull requests as full-width lists with full-page details**: real
  columns, state tabs with counts, label/assignee/milestone/author facets (PRs:
  base, review state, origin), five sort orders; close with a reason; lock;
  reference in a new issue; comments edited/deleted/quoted/linked; reactions; the
  timeline of what happened; linked PRs and participants in the rail.
- **Pending reviews.** Line comments queue locally and post as ONE review with
  your verdict — ranges, pending cards in the diff, the queue visible in the
  composer, the review pinned to the head you read.
- **Branches as a table** with creator and contributors for local and remote
  branches, and who cut each tag.
- **Images** load in issues, PRs and markdown, including private-repository
  attachments.
- **Open in your editor**, from the top bar beside Push — and from Home and every
  repository's menu. The editors on this machine are found on their own: app
  bundles, the folders their command-line tools live in, Windows install paths,
  not just PATH (which a Dock-launched app barely has). Each one shows its OWN
  icon, read from the application itself, so the list is six marks you recognise
  rather than six copies of a generic glyph. Settings ▸ Editors picks your
  favourite, decides which ones show, and takes a custom command with `{path}`.
- **The Assistant grew up.** A centred transcript with the chat's title in the
  header; an empty state that offers six quick actions as cards saying what each
  does; Enter sends (Shift+Enter for a new line); every answer copies as Markdown;
  a failed turn offers Try again; "Jump to latest" when an answer streams below
  where you are reading; delete a chat from its history menu; the composer says
  which repository and branch the agent is working in.
- **A macOS 26 app icon.** The Dock icon is an Icon Composer icon the system
  renders itself — the size and glass of every other app — instead of a legacy
  icon Tahoe framed smaller; on macOS 11–15 the tile sits on Apple's icon grid.
  The in-app mark is the extension's activity-bar mark, in colour.

- **Read any GitHub repository without cloning it** — files, folders, README,
  branches, go-to-file, and the 50 most recent commits — for your own
  repositories and for anything you find by searching. The app says plainly
  which world a repository is in: `on this machine` with a folder, or `on
  GitHub` with a globe, the same two words on every list, row and page.
- **The top bar names both repositories.** While you read someone else's code it
  shows what you are reading, then `WORKING IN` and the clone your controls act
  on — because Push, Fetch, the branch switcher and Open-in-editor never stopped
  belonging to the repository you have open.
- **The details panel folds away** on every page that has one, and the choice is
  remembered.

### Fixed
- **Push, Fetch and Open in your editor now say which repository they act on.**
  They always acted on the clone you have open; while you browsed a different
  repository on GitHub, nothing on screen said so. "Push 2 commits to
  origin/main" named neither end.
- **Clicking a branch in the commit graph highlights it.** It opened the right
  tab, cleared the filters and scrolled to the right row, then marked that row
  with a CSS class that had no rule — so nothing happened, ever. The mark now
  stays until your next click or key press instead of fading in under two
  seconds, and a tag no longer lands on a branch that happens to share its name.
  The refs folded behind a row's "+N" pill can be opened too, rather than only
  read on hover.
- **Cloning from a browse page lands in the repository it cloned** instead of an
  empty search screen with the Back button disabled.
- **Screens use the window.** Every detail page — issue, pull request, run,
  release, gist, branch, repository — was pinned to an 820px column whatever the
  window size, leaving most of a large display empty; the column now grows with
  the window while running text keeps its reading measure. Home, Compare, the
  project board, the Branches subject column and the Code browser were capped
  the same way.
- **Destructive actions ask first.** "Move to Trash…" sent a whole working copy
  to the Trash on one click, ellipsis and all; "Rebase current onto…" rewrote
  the current branch's history straight from a menu; and the commit details
  toolbar ran Checkout, Revert and Reset with none of the confirmations the
  identical right-click menu has always shown — while its Branch and Tag
  buttons dispatched with no name at all and came back as an error blaming you
  for a request the app had failed to build. Both doors now ask the same
  questions from the same table.
- **The new-pull-request form stops throwing your description away.** It
  validated the title and branches *after* the modal had closed, so an empty
  title discarded however much you had written and complained over an empty
  screen. It validates before it closes, ⌘Enter submits, and a background
  navigation can no longer take unsaved text with it.
- **Requesting reviewers shows them.** Every other rail edit repainted; this one
  did not, so the people you had just asked stayed invisible and could be asked
  a second time.
- **The keyboard reaches the Checks tab.** Its rows were bare divs with a
  pointer cursor: a failing check's logs could not be opened without a mouse.
- **Dragging the file-list divider in Changes resizes the file list.** The
  keyboard and the pointer wrote to two different elements, so the drag moved
  something other than the column it was dragging.
- Edit buttons on an issue opened from the Inbox, My Work or a deep link were
  dead clicks — the page's router was parked in a module global that only one
  entry point ever set.
- Every copy action is routed through the app's clipboard helper — Copy path,
  Copy clone URL, Copy link on a comment, and the job log's Copy. They confirm,
  and they fall back to the main process when the browser refuses; raw, a
  refused write was swallowed and copying looked identical to doing nothing.
- "Reset plan" in the rebase workspace asks first when there is something to
  lose. Reorders, drops and reworded messages exist nowhere else until the
  rebase runs, and one click threw all of it away.
- "Open on remote" on a commit opens the commit. The button was drawn whenever
  the repository had a remote, emitted an action nothing listened for, and did
  nothing at all.
- A peek that fails to load says why, and offers a Try again that works. It used
  to say "try again" with nothing to try, and discarded the error unread.
- "Mark all read" says what it does. Its tooltip repeated its own label, and in
  the bell popover — where the label is hidden — that tooltip is the button's
  only name. It now says the request marks the whole inbox on GitHub, which is
  more than the list in front of you shows.
- Repositories spelled it "organisation" while the rest of the app, the rail and
  GitHub itself spell it "organization".
- Go to file counted "1 files".
- Stashing the whole working tree said "Stashed 0 files."
- **Light theme is readable.** Borders were within 1.15:1 of the page, which is
  not a hairline; row hover was 1.04:1, which is no hover at all; state badges
  had no edge, board status dots were painted over with a wash that made them
  ghosts, and a dozen labels fell under the contrast minimum because they were
  dimmed with opacity, which spends contrast on a light ground and keeps it on a
  dark one. Line numbers in dark were dimmer than any editor renders them.
- Extension rebase: folding the newest commit into the one below was refused
  (#27). Extension compare: open diffs collapsed on a timer (#24).
- The Code page header lines up with the file list and README below it, and the
  README fills its card instead of stopping four-fifths of the way across.
- **Reacting no longer reloads the page.** A 👍 on an issue or a pull request
  refetched the whole thread and repainted every comment, the timeline and the
  rail to move one number by one — a whole-screen flash on a single click. The
  strip now updates itself and puts the value back if the request does not stick.
- The Assistant's composer is one field with the send button inside it, which
  fixes a focus ring that used to draw a boundary excluding the very button it
  was meant to contain. The dock chat's Send also stops sitting lit over an
  empty box.
- Repositories tells folders from repositories: folder icons carry the accent and
  repository icons do not (the rule the Code view already used, running backwards
  here), a repository's name is the largest thing on the page, and its origin sits
  beside that name instead of ~470px away across an empty row.
- On GitHub, each owner is a section you can collapse — ⌥-click collapses every
  owner — and a section head that is pinned to the top now looks pinned.
- The app icon is redrawn: a bolder cube with real separation between its three
  faces, heavier graph lines and solid nodes, filling the tile the way Apple's
  icon grid expects. The old one faded out at Dock size, and the framing left
  the mark floating in a large empty square. The tile is a neutral grey rather
  than near-black, so it never glares beside a light Dock.
- Streaming answers no longer lose the reader partway through a long reply: the
  throttled Markdown paint scrolled before it grew, so the transcript stopped
  following after the first big paragraph.
- List headers are two lines at every width with refresh on the title line;
  menus hang from the control that opened them; completed issues are purple
  (the merged family), never the failure red; check rows are clickable only when
  they link somewhere; the Checks pill agrees with the Checks tab.
- **Opening a file in a commit no longer throws.** Every click produced seven
  uncaught errors — `getNavigationTree`, `provideInlayHints`,
  `getSyntacticDiagnostics` — because the editor loaded four language services
  that each want their own web worker while the app ships only the base one.
  The app has never offered IntelliSense, so the services are gone; syntax
  highlighting and diffing are untouched.
- **A file diff opens in the panel at the bottom, full width.** In the commit
  details column it got 571px of a 1600px window — under the threshold where the
  editor gives up on side-by-side, so every diff quietly opened inline — while
  the rule that made room for it pinned the graph to a third of the width, below
  its own breakpoint, so the column header and four columns vanished. Closing
  the details panel then left a third of the screen blank. Code needs width; the
  panel's height is the thing you were already able to drag.
- **The graph and the details column resize freely.** The divider had four
  pixels of travel on a 1440px window, and none at all at 1280 — a guard meant
  to protect the graph's columns had collapsed into a lock on exactly the widths
  most laptops use. The panel now opens to nine tenths of the window instead of
  stopping at six.
- **The commit graph keeps its graph and Branch/Tag columns when it narrows.**
  Below 620px it used to drop the whole column header — labels and resize grips
  together — while still spending width on Changes and Author. Now the metadata
  yields first, the header stays at every width, and a branch name is never
  ellipsised to make room for a column you can read in the panel.
- **A selected tab, segment, row or menu item answers the pointer.** One cascade
  mistake repeated eighteen times: the `:hover` rule sat immediately before the
  `.active` rule at the same weight, so the selected thing was the one element
  on screen that could not light up. Hovering the branch you are on, in the
  branch switcher, did nothing at all.
- **Dropdowns that were not dropdowns.** The two native pickers (a new pull
  request's branches, a workflow's inputs) had no pointer cursor and no hover
  state; a pull request's file rows were stuck on the arrow while being
  perfectly clickable; and the cursor turned back into an arrow as it crossed
  the second line of a row that was still one click target.
- **The Output log can be selected and copied**, and there is a Copy button for
  the whole of it. Its filter and Clear controls no longer sit in the status bar
  over a closed panel, and they are status-bar sized rather than full app
  buttons overflowing a 23px strip.
- **Scope and filter controls sit beside the title they belong to**, on every
  list, instead of being pushed across the header to huddle against the action
  buttons.
- **A segmented control is one control.** There were three implementations at
  three heights, three corner radii and three weights; the selected one drew a
  square ring inside a rounded, clipped box, so its corners were sliced flat and
  its inner edge doubled with the next button's divider. One track, one pill.
- **The split button is one button.** Three later rules re-rounded and
  re-shadowed each half, so a control that was flush to the pixel still read as
  two blocks, and hovering the caret deleted its colour outright.
- **A reference to another project goes to that project.** "mentioned this in
  #12" routed into the repository you were reading and opened whatever carried
  that number there; the Development rail keyed its linked pull requests by
  number alone, so two from different projects collapsed into one row. Both name
  their repository now, and open it in the reader the Inbox already uses.
- **The app icon's nodes are part of the mark.** They were holes punched through
  the artwork, so the circles showed whatever sat behind the icon — which on a
  light ground let the grey through and changed the logo's character. The lines
  and circles are bolder, and the light variant is a genuinely light tile rather
  than the dark one lightened by fifteen values out of 255. Picking Light or
  Dark in Settings changes the Dock icon again on macOS 26.
- **Menus follow the control that opened them** when the list underneath
  scrolls, instead of floating over unrelated rows; and a menu whose trigger has
  scrolled out of sight closes.
- A README fills its card on a repository page instead of stopping 820px in with
  every heading rule running past it. Issue and pull-request bodies keep their
  reading measure but sit centred.
- Issues, pull requests and Actions start clean when you switch repositories,
  instead of showing the previous one's search, sort and facets.
- "Create pull request" in Changes reads the branch you are on when you press
  it, not the one resolved before HEAD had loaded. "Collapse all projects"
  collapses the folder whose menu you opened, not every folder on the screen.
  Go to file offers a retry when the listing fails, instead of a dead search box.

## [1.6.0] - 2026-08-26

### Added
- **Prune deleted remote branches on fetch.** Fetch now passes `--prune` by
  default, so remote-tracking branches deleted on the remote drop out of the
  branch list instead of lingering as stale entries. Only stale remote-tracking
  refs are removed — your local branches are never touched. Toggle it in
  Settings → Fetch. (#23)

## [1.5.1] - 2026-08-22

### Fixed
- **Amending a commit you had already pushed could not be pushed.** Rewriting a
  commit leaves the branch ahead *and* behind its upstream, so git refuses an
  ordinary push. Committing with Amend ticked reported "Committed, but push
  failed" and left you there; it now offers a force push using
  `--force-with-lease`, which still refuses if someone else has pushed.
- **The commit box stayed empty when you ticked Amend.** It was meant to prefill
  with the commit you are amending. The command that fetched it passed a NUL
  byte as a field separator, which Node refuses to put in a process argument —
  so the call threw on every attempt, the error was swallowed, and the box was
  simply always blank. The message now prefills in full, body and trailers
  included, so editing a subject no longer means retyping the rest.

## [1.5.0] - 2026-08-21

The commit graph is shared with the extension, so this release is mostly that
work arriving here.

### Added
- **The commit graph fits what is in it.** The Branch/Tag column measures the
  busiest row you have loaded rather than sitting at a fixed width, and a chip
  may grow with the column — so a long remote branch renders in full instead of
  ellipsizing at every width. It only spends width that is spare, so a narrow
  window gives it back to the commit message.
- **Hover cards for anything a row had to cut off.** A clipped ref chip or commit
  message shows in full on hover, wrapped. Hovering an author shows who they are
  — full name, the address the commits are keyed on, how much of the loaded
  history is theirs, and when.
- **Resizable columns you can find.** The dividers are visible at rest, take the
  accent while you drag one, and the grab zone is the full header height.

### Changed
- Added, modified and deleted are green, blue and red. The previous palette made
  "added" a sage green and "modified" a tan, which at the size of a 4px bar or a
  single letter read as the same warm grey.
- The graph's lanes, nodes and avatars are larger, and the lane strokes heavier.
- Author, Changes, Date and SHA are narrower, and every column's text is inset
  from its divider rather than butting against it.

### Fixed
- **The graph counted git notes as history.** `git log --all` includes
  `refs/notes/*` and `refs/stash`, so notes commits were rows in the graph and
  shifted the page boundaries under paging — commits went missing as you
  scrolled.
- **A commit on two remotes drew one chip and no `+N`.** The overflow pill
  rendered only if it still fit, and missed by two pixels at some widths — so the
  row claimed to have one ref.
- **Dragging a divider could wreck the columns.** The resize was bounded by each
  column's own limits with nothing watching the total, so the trailing columns
  collapsed to nothing once the widths overflowed.

## [1.4.0] - 2026-08-19

### Added
- **Tick individual changes in a diff.** In Split view every change carries a
  tri-state tick — staged, unstaged, or partly staged — and clicking it stages or
  unstages exactly that change, leaving the rest of the file untouched. Inline
  view says where to find them: Monaco draws deleted lines with no line of their
  own there, so a deletion has nothing to attach a tick to.
- **Select files in the Changes list.** Shift-click for a range, Ctrl/Cmd-click
  for individual files, Ctrl/Cmd-click a section header for the whole section. A
  plain click still opens the file.
- **Stash a selection** — drag it onto the stash target that appears while
  dragging, use the selection bar, or right-click a row. This is the app's first
  stash UI.
- **Stage, unstage or discard several files at once** from the row menu, with one
  refresh at the end rather than one per file.
- **A stash button in the Changes toolbar** that follows your selection and says
  what it will take — "Stash all changes…" against "Stash 3 selected files…".

### Fixed
- **Partial staging wrote different bytes than `git add` would.** Staging lines
  bypassed the clean filters `.gitattributes` and `core.autocrlf` apply, so in a
  repository normalising line endings, staging one hunk could show the whole file
  as modified and a commit could carry CRLF into an LF history.
- **"Stage lines" did nothing in Inline view** — which is the default on a narrow
  window — because it read the side-by-side editor that mode does not create.
- **"Stage lines" ignored every cursor but the first.** Alt-clicking several
  scattered lines staged only one of them, with nothing to say so.

## [1.3.0] - 2026-08-18

### Changed
- **The interactive-rebase list now reads newest-first, matching the Commits
  list.** Git replays the plan bottom-to-top, and the view says so. `squash` and
  `fixup` fold into the commit *below* them now, so a squash on the top row is
  allowed where the first row previously could not fold into anything.
  *(Reported by @wkornewald, #18.)*

### Fixed
- **The branch list and the top-bar branch name could show the repository you had
  just switched away from.** A ref lookup already running for the old repository
  would finish last and overwrite the new one's.
- **Returning to Branches after committing showed the list as it was before the
  commit,** with no refresh — and a later fetch or pull silently refreshed nothing
  at all.
- **Scrolling the graph while it reloaded could produce a jumbled history** —
  duplicated rows and mis-drawn lanes — because a page still being read was
  appended to history that had already been replaced.

## [1.2.0] - 2026-08-18

### Added
- **The Changes list keeps itself up to date.** Edit a file in your editor,
  switch back to GitStudio, and the list was whatever it last read — you had to
  hit Refresh or leave the view and come back. The app now watches the repository
  and refreshes on its own, debounced, and again whenever the window regains
  focus so changes made by any other tool show up too.
  *(Reported by @wkornewald, #17.)*
- **Check out a branch straight from the graph.** Right-clicking a commit offered
  only "Checkout", which detached HEAD even when the row was a branch tip. The
  refs on a row now head the menu — *Checkout main*, *Checkout origin/main* — so
  a branch tip no longer sends you to the Branches view.
  *(Reported by @wkornewald, #19.)*
- **Commit without staging first**, with a confirmation, and an optional
  **checkbox model** for the Changes view (one list, a tick per file) alongside
  the Staged/Unstaged split. Toggle it from the Changes toolbar. *(#16.)*

### Fixed
- **Stashing when there is nothing to stash no longer reports success**, and
  operations that git declines — reverting something already reverted, continuing
  a rebase with conflicts unresolved — explain themselves instead of showing an
  empty notification.
- **Being mid-conflict is no longer filed as a crash report.**

## [1.1.2] - 2026-08-17

### Fixed
- **Being offline, or having an expired token, is no longer treated as a crash.**
  1.1.1 stopped filing "Not connected to GitHub." as a failure report; its
  siblings kept arriving. Losing your connection, a revoked or expired token, a
  permission you never granted, GitHub's rate limiter and GitHub being down are
  all states you are allowed to be in — anyone on flaky wifi produced a stream of
  reports. There is now one policy for the whole GitHub layer: our bugs get
  reported, the network and your sign-in state do not. Nothing you see changes;
  the same message reaches the same place.
- **Committing with nothing staged showed an empty toast.** `git commit` reports
  that particular refusal on *stdout* rather than stderr, so passing stderr
  through produced a notification with no text in it. It now says which situation
  you are in — changes waiting to be staged, only new untracked files, or a clean
  tree — decided by asking git directly, so it reads correctly on a translated
  git too.
- **The Branch/Tag column reveals more branches as you widen it,** instead of
  stopping at four however far you drag. And the "+N" badge opens its own hover
  card immediately, naming each hidden ref's kind, rather than waiting on the
  browser's tooltip delay.

## [1.1.1] - 2026-08-15

### Fixed
- **Clicking a commit did nothing once the details pane was closed.** Clicking
  the row that was already selected emitted nothing at all, so the pane stayed
  shut. It now reopens — without re-fetching the commit or disturbing a diff you
  have open.
- **Branch/tag chips did not reflow while dragging the column.** Chips that do
  not fit are removed from the row rather than clipped, but only releasing the
  mouse re-rendered — so the column widened while the chips stayed folded behind
  a "+N", then everything snapped into place at the end.
- **The "+N" chip read as decoration.** Clicking it opens the commit details,
  which lists every hidden ref in full, but nothing said so. It now shows a
  pointer and a hover state, and its tooltip names each hidden ref *and* whether
  it is a local branch, a remote branch or a tag.
- **Not being signed in to GitHub was treated as a crash.** Opening
  notifications without a connected account raised an error that GitStudio filed
  as a failure report. It is a state you are allowed to be in, and is now handled
  as one.

## [1.1.0] - 2026-08-08

### Added
- **Push and Publish from the Branches view.** Previously only the top-bar sync
  widget could push, and only the branch you had checked out — so an unpublished
  or ahead branch could not be pushed from the list that was showing it. The
  branch menu now publishes (creating the remote branch and setting upstream)
  or pushes to the tracked remote.
- **Update notifications.** macOS cannot apply an in-app update to an unsigned
  build, so the app now asks GitHub whether a newer release exists and points
  you at the download rather than staying silent. Windows and Linux say when an
  update has been staged instead of replacing the app on quit unannounced.

### Changed
- **GitStudio no longer uses your OS keychain, so it can no longer ask for your
  password.** Electron's `safeStorage` keeps its master key in the login
  keychain, and on macOS that entry's ACL is bound to the app's code signature —
  so every rebuild or update invalidated it and the next read raised *"GitStudio
  wants to make changes. Enter your password to allow this."* Your GitHub token
  and AI keys now live in GitStudio's own AES-256-GCM store under
  `userData/secrets`, owner-only on disk, and every "is this connected?" check is
  answered from the filesystem without decrypting anything. Tokens saved by an
  earlier version are migrated the first time you actually use GitHub or an AI
  feature — one prompt at most, ever, and never at launch.

### Fixed
- **Git could hang forever on a credential prompt.** The app has no terminal, so
  when git asked for a username, password or key passphrase the question had
  nowhere to go and the operation blocked indefinitely. Git now fails fast with a
  real message; credential *helpers* (macOS Keychain, Git Credential Manager, any
  GUI askpass) are unaffected.
- **A deleted branch could reappear for a minute.** A request already in flight
  when the cache was invalidated wrote its pre-deletion answer back with a fresh
  timestamp, so the branch returned and the delete looked like it had failed.
- **The bottom dock could open far too tall.** A height dragged out for the
  terminal was replayed verbatim on a different window, leaving the graph a few
  rows tall; it is now clamped to a share of the current window.
- **Multi-line git errors were unreadable as toasts.** A toast collapses
  newlines, so git's "your local changes would be overwritten by merge" arrived
  as a run-on. Toasts now show the one actionable line.
- **Crash reports could include repo-relative paths and branch names.** git
  stderr is now scrubbed with the git-aware scrubber, matching what PRIVACY.md
  promises.
- **Agent Access could erase your MCP configuration.** Installing GitStudio's
  MCP server into a client whose config was not strict JSON — Cursor and VS Code
  accept JSONC, which `JSON.parse` rejects — replaced the entire file, deleting
  every other server you had configured. GitStudio now refuses to overwrite a
  config it cannot parse, and backs one up before writing.
- **Crash reports could contain file and branch names.** Git writes both into
  its error output, and the shared scrubber only removed things that are
  repo-independent (absolute paths, emails, remote URLs, tokens, SHAs). Reports
  now keep the diagnostic sentence and redact the identifiers, matching what
  [PRIVACY.md](PRIVACY.md) promises.
- **Git could hang forever waiting for a password.** A fetch, pull or push over
  HTTPS with no cached credential blocked on a terminal prompt that a desktop
  app can never answer, freezing the sync UI with no way out. Git now fails fast
  with a real error; credential helpers are unaffected.
- **Typing a commit message and then staging a file discarded the message** —
  along with the amend and sign-off toggles and any co-authors. The draft now
  survives, and clears when you commit or switch repository.
- **A merge or rebase in progress went undetected inside a linked worktree**, so
  the Abort / Continue banner never appeared and there was no in-app way out.
- **Deleting a local branch happened immediately, with no confirmation** — the
  only destructive action in the app that did not ask.
- **The Rebase workspace had no destructive colour at all**: a commit marked
  Drop rendered identically to a Pick, and the error banner lost its fill and
  border, because the two CSS tokens that view was written against were never
  declared.
- **Interactive rebase from a commit's actions said it "isn't available in the
  desktop app yet"** while the Rebase view sat in the sidebar. It now opens it.
- **Stale results could overwrite newer ones.** Selecting a second file or
  commit while the first was still loading painted the older diff; a graph
  refresh during paging spliced a stale page onto the reset list and corrupted
  the paging cursor; and a request in flight when the cache was invalidated
  re-seeded pre-mutation data, so a just-deleted branch reappeared.
- **Linux packages described themselves with an internal developer note.**
  `apt show` and software centres now get a real description.

### Release process
- The GitHub Release is created as a **draft** and only published once every
  platform's installer has built and uploaded, so a failed build can no longer
  leave a "latest" release with missing or zero installers.
