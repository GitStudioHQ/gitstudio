# Changelog

All notable changes to **GitStudio** are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
