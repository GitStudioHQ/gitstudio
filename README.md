<p align="center">
  <img alt="GitStudio" src="brand/gitstudio-icon.svg" width="116">
</p>

<h1 align="center">GitStudio</h1>

<p align="center">
  <b>A free, open-source, JetBrains-grade Git suite for VS Code, Cursor, and desktop.</b>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=gitstudio.gitstudio"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/gitstudio.gitstudio?label=VS%20Marketplace&color=6f5bd7"></a>
  <a href="https://open-vsx.org/extension/gitstudio/gitstudio"><img alt="Open VSX" src="https://img.shields.io/open-vsx/v/gitstudio/gitstudio?label=Open%20VSX&color=6f5bd7"></a>
  <a href="https://github.com/GitStudioHQ/gitstudio/releases/latest"><img alt="Desktop app" src="https://img.shields.io/github/v/release/GitStudioHQ/gitstudio?filter=app-v*&label=Desktop&color=6f5bd7"></a>
  <a href="https://github.com/GitStudioHQ/gitstudio/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/GitStudioHQ/gitstudio/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center"><sub>Logo &amp; brand assets live in <a href="brand/">brand/</a>.</sub></p>

---

## Get GitStudio

### VS Code / Cursor extension

Install **GitStudio** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gitstudio.gitstudio) or [Open VSX](https://open-vsx.org/extension/gitstudio/gitstudio) (VSCodium, Gitpod, …), or from the command line:

```bash
code   --install-extension gitstudio.gitstudio    # VS Code
cursor --install-extension gitstudio.gitstudio    # Cursor
```

### Desktop app

Download the installer for your platform from the [latest GitHub Release](https://github.com/GitStudioHQ/gitstudio/releases/latest) or from [gitstudio.dev](https://gitstudio.dev):

| Platform | Installer |
|---|---|
| **macOS — Apple Silicon** | `GitStudio-<version>-arm64.dmg` |
| **macOS — Intel** | `GitStudio-<version>-x64.dmg` |
| **Windows** | `GitStudio Setup <version>.exe` (NSIS — choose your install dir) |
| **Linux** | `GitStudio-<version>.AppImage` (universal) · `gitstudio_<version>_amd64.deb` (Debian/Ubuntu) |

The app checks GitHub Releases for updates (electron-updater), so you install once and stay current.

## The idea

VS Code's built-in Git is functional but flat. GitLens is great at *information* (blame, history, lenses) but doesn't own the *interaction* (merging, staging, resolving). JetBrains IDEs nail the interaction — three-pane merges, a real commit graph, hunk-level staging, inline blame that feels native — but you only get them if you live in IntelliJ.

**GitStudio brings the JetBrains-grade Git *workflow* to VS Code, Cursor, and a native desktop app, and adds an intelligence layer on top.** The polish of a native IDE, the depth of a power-user tool, and AI that actually understands your history — all free, on public *and* private repos.

## What's inside — the six pillars

Everything ships in one extension (`gitstudio.gitstudio`) and one desktop app, both built on the same shared engine:

| Pillar | What's in |
|---|---|
| **Visualize** | A sidebar-native Commits view (true branch topology at sidebar scale, mini author avatars on the nodes, scoped search) plus a full-screen virtualized commit graph; inline + full-file blame with a code-age heatmap; file & line history; revision navigation; reflog time-machine. |
| **Change** | Instant hunk- & line-level staging; guided commit box (amend, sign-off, author, Commit & Push); side-by-side / unified diff with word-level highlighting; 3-pane merge editor with accept ribbons — conflicts auto-open as they appear. |
| **Rewrite** | Drag-to-reorder interactive rebase (pick · reword · edit · squash · fixup · drop); a universal, reflog-powered **Undo** safety net (never hijacks `Ctrl/Cmd+Z`). |
| **Manage** | Branches (live ↑/↓ badges, fetch-in-place, pull without checkout), remotes, tags, first-class stashes, worktrees; GitHub-style branch compare; status-bar sync with in-view Push/Pull. |
| **Collaborate** | In-editor GitHub pull-request review — list, check out, diff, comment inline, submit, merge, create. |
| **Assist** | GitBrain — optional, bring-your-own-key (Anthropic or any OpenAI-compatible endpoint, including local Ollama / LM Studio) or zero-key (Copilot): AI commit messages, explain-diff, summaries. Off by default; keys live in SecretStorage; AI never gates a Git operation. |

## The desktop app

A standalone, cross-platform Git client (macOS / Windows / Linux) built on the exact same core — not a rewrite. On top of the shared graph, diff/merge, staging, rebase, and undo it adds:

- **A GitHub home for your repo** — sign in with a token and get pull requests (diffs + inline review), issues, Actions runs with logs, releases, notifications, gists, orgs, and projects, all local-first.
- **An integrated terminal** (node-pty + xterm.js) that opens in your repo.
- **An AI Assistant** panel wired to `@gitstudio/ai` — connect Anthropic or any OpenAI-compatible model, including local ones.
- **Auto-update** from GitHub Releases.

## MCP server

`gitstudio-mcp` (in [`apps/mcp`](apps/mcp)) exposes a repository's Git capabilities to any MCP-compatible agent (Claude Desktop, Cursor, Copilot, Windsurf) over stdio. Read tools are always available; write/destructive tools are opt-in via environment variables.

## Monorepo layout

npm workspaces (`packages/*` + `apps/*`):

```
packages/
  engine/        Pure, unit-tested diff/merge + graph-layout model (no vscode/electron imports).
  git-service/   Thin git layer: log, blame, status, staging, refs, stashes, worktrees, sync…
  host-bridge/   Protocols shared between the hosts (extension / desktop) and their webviews.
  webview-ui/    Shared webview front-ends: commit graph, diff/merge (Monaco), rebase.
  ai/            Host-agnostic AI layer: multi-provider model registry, git AI tasks, agent
                 loop, and the shared git tool catalog that also backs the MCP server.
apps/
  extension/     The VS Code / Cursor extension.
  desktop/       The Electron desktop app.
  mcp/           gitstudio-mcp — the Model Context Protocol server.
```

`engine`, `host-bridge`, and `ai` are kept **pure** (no `vscode`/`electron` imports) so they stay portable and testable — enforced by `npm run check-purity`.

## Development

Requires **Node 22+**.

```bash
npm ci               # install all workspaces
npm test             # run every workspace's tests (tsx --test)
npm run check-types  # tsc --noEmit across all workspaces
npm run check-purity # assert the pure packages stay host-free
```

**Extension** — open the repo in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host with GitStudio loaded. Package a sideloadable VSIX with:

```bash
cd apps/extension
npm run package
npx @vscode/vsce package --no-dependencies
```

**Desktop** — build and launch Electron:

```bash
npm start --workspace apps/desktop   # dev build + launch
npm run dist --workspace apps/desktop  # installers for the host OS -> apps/desktop/release/
```

## Releasing

Both products release from tags — `ext-v*` for the extension (→ Marketplace, Open VSX, GitHub Release) and `app-v*` for the desktop app (→ per-OS installers on a GitHub Release, built natively on a 4-way matrix). CI runs typecheck + the full test suite before anything publishes. See [`RELEASING.md`](RELEASING.md) for the full playbook, including the optional signing/notarization secrets.

## Contributing

Issues and pull requests are welcome at [GitStudioHQ/gitstudio](https://github.com/GitStudioHQ/gitstudio). Before opening a PR, please run the three gates locally:

```bash
npm test && npm run check-types && npm run check-purity
```

## Facts

| | |
|---|---|
| **Extension** | `gitstudio.gitstudio` (publisher `gitstudio`) — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gitstudio.gitstudio) + [Open VSX](https://open-vsx.org/extension/gitstudio/gitstudio) |
| **Desktop** | [GitHub Releases](https://github.com/GitStudioHQ/gitstudio/releases) — `.dmg` (arm64 + x64), `.exe`, `.AppImage`, `.deb` |
| **Website** | [gitstudio.dev](https://gitstudio.dev) |
| **License** | **Apache-2.0** |
| **Sibling product** | [Merge Studio](https://marketplace.visualstudio.com/items?itemName=gitstudio.merge-studio) — `gitstudio.merge-studio`, the original 3-pane merge editor. Shares an engine, not a listing. |

## Architecture notes

- **One flagship extension, not a swarm** (the GitLens model). It grows pillar by pillar; Merge Studio stays a separate, focused product.
- **Webview custom editors** for rich UI (merge, graph, rebase), **providers + decorations** for ambient features (blame, history), and a **thin git service** with its own repo discovery (`git rev-parse`, symlink-safe) plus direct `.git` reads where speed matters — the views paint from local git instead of blocking on `vscode.git` activation.
- **Strict CSP + per-load nonces** on every webview; AI keys live in SecretStorage (extension) / safeStorage (desktop) and never reach a webview.
- **One core, two hosts.** The desktop app runs `@gitstudio/git-service` unchanged in Electron's main process and renders the same `@gitstudio/webview-ui` components the extension uses — behind the same `@gitstudio/host-bridge` protocol.

## License

**Apache-2.0** (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)). Brand assets in [`brand/`](brand/) identify the project; don't use the GitStudio name/logo in a way that implies official endorsement.