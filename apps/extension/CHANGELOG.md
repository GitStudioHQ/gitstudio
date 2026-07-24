# Changelog

All notable changes to **GitStudio** are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
