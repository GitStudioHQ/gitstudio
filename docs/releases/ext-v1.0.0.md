# GitStudio 1.0.0

**A free, open-source, JetBrains-grade Git suite for VS Code and Cursor — the whole workflow, not just one piece.**

This is GitStudio's first public release. One Apache-2.0 extension covers the full workflow: a virtualized commit graph, inline and full-file blame with a code-age heatmap, hunk- and line-level staging, side-by-side diffs, a three-pane merge editor, drag-to-reorder interactive rebase, a reflog-powered universal Undo, full branch/remote/tag/stash/worktree management, in-editor GitHub PR review, and optional AI assistance.

## Highlights

### Performance
- **Everything loads instantly.** GitStudio discovers your repo itself (no waiting on VS Code's Git extension to activate and scan) and reads history, changes, stashes, and worktrees through its own git service — views paint from local git immediately.
- **Instant staging.** Files move the moment you click and the git op reconciles in the background; staging a folder or a whole group is one operation.
- **No churn.** Sidebar views stay warm when you switch away and back, the commit list only re-renders on real changes, and the graph loads a small first page and streams as you scroll.

### Views
- **Sidebar-native Commits view** — compact two-line rows show 3–4x more history, true branch topology renders at sidebar scale with mini author avatars on the commit nodes, and search (message/author/SHA/refs) lives in the header. Double-click promotes any commit to the full-screen Commit Graph.
- **First-class Stashes view** — one-click Stash Changes plus per-row Apply / Pop / Branch / Drop, with a stash control right in the Changes toolbar.
- **Branch compare** — a GitHub-style panel with ahead/behind counts, the commits between any two refs, and changed files as native diffs.

### Sync
- **Push / Pull are buttons now** — the ahead/behind counts in the Changes header run the op with an in-place spinner.
- **Live fetch** — Fetch runs without closing the branch menu, then every branch row's ↑/↓ badges update live. Pull a local branch without checking it out (fast-forward from upstream, straight from its submenu).

### AI (optional, off by default)
- **GitBrain** — AI commit messages, explain-this-diff, and change summaries. Bring your own Anthropic key or use GitHub Copilot's model with zero keys. Keys live in SecretStorage and never reach a webview; AI never gates a Git operation.

## Install

- **VS Code Marketplace:** https://marketplace.visualstudio.com/items?itemName=gitstudio.gitstudio
- **Open VSX (Cursor, VSCodium, etc.):** https://open-vsx.org/extension/gitstudio/gitstudio
- **Manual:** download `gitstudio.vsix` from this release's assets, then:
  ```bash
  code --install-extension gitstudio.vsix --force     # VS Code
  cursor --install-extension gitstudio.vsix --force   # Cursor
  ```

License: Apache-2.0 · Source: https://github.com/GitStudioHQ/gitstudio
