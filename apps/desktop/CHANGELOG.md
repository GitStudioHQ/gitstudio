# Changelog

All notable changes to **GitStudio Desktop** are documented here. This project
adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The VS Code / Cursor extension has its own changelog at
[`apps/extension/CHANGELOG.md`](../extension/CHANGELOG.md). The two ship
separately — desktop releases are tagged `app-v*`, extension releases `ext-v*` —
but they share the same engine, so most Git behaviour lands in both at once.

## [Unreleased]

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
