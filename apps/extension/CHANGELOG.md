# Changelog

All notable changes to **GitStudio** are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
