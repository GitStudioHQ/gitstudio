<p align="center">
  <img alt="GitStudio" src="brand/gitstudio-icon.svg" width="116">
</p>

<h1 align="center">GitStudio</h1>

<p align="center">
  <b>A free, open-source, JetBrains-grade Git experience for VS Code &amp; Cursor — the whole workflow, not just one piece.</b>
</p>

<p align="center"><sub>Logo &amp; brand assets live in <a href="brand/">brand/</a>.</sub></p>

---

## The idea

VS Code's built-in Git is functional but flat. GitLens is great at *information* (blame, history, lenses) but doesn't own the *interaction* (merging, staging, resolving). JetBrains IDEs nail the interaction — three-pane merges, a real commit graph, hunk-level staging, inline blame that feels native — but you only get them if you live in IntelliJ.

**GitStudio brings the JetBrains-grade Git *workflow* into VS Code and Cursor, and adds an intelligence layer on top.** Think "GitLens on steroids" meets "GitBrain": the polish of a native IDE, the depth of a power-user tool, and AI that actually understands your history — all free, on public *and* private repos.

## Status — the suite is built

The flagship extension `gitstudio.gitstudio` is **feature-complete at `0.1.0`** and ready for release. All six pillars are implemented and shipping in one extension:

| Pillar | What's in |
|---|---|
| **Visualize** | Virtualized commit graph; inline + full-file blame with code-age heatmap; file & line history; revision navigation; reflog time-machine. |
| **Change** | Hunk- & line-level staging; guided commit box (amend, sign-off, author, Commit & Push); side-by-side / unified diff; 3-pane merge editor with accept ribbons. |
| **Rewrite** | Drag-to-reorder interactive rebase; a universal, reflog-powered **Undo** safety net (never hijacks `Ctrl/Cmd+Z`). |
| **Manage** | Branches, remotes, tags, stashes, worktrees views + operations; search & compare; status-bar sync. |
| **Collaborate** | In-editor GitHub pull-request review (list, check out, comment, submit, merge, create). |
| **Assist** | GitBrain — optional, bring-your-own-key (Anthropic) or zero-key (Copilot) commit messages, explain-diff, summaries. Off by default. |

| | |
|---|---|
| **Brand / publisher** | `gitstudio` (display **"GitStudio"**) — VS Code Marketplace **and** Open VSX |
| **Extension id** | `gitstudio.gitstudio`, version `0.1.0`, license **Apache-2.0** |
| **Domain** | `gitstudio.dev` |
| **Sibling product** | [Merge Studio](https://marketplace.visualstudio.com/items?itemName=gitstudio.merge-studio) — `gitstudio.merge-studio`, the original 3-pane merge editor. Shares an engine, not a listing. |

## Monorepo layout

npm workspaces (`packages/*` + `apps/*`):

```
packages/
  engine/        Pure, unit-tested diff/merge model (no VS Code imports).
  git-service/   Thin git layer: log, blame, staging, refs, stashes, worktrees, sync…
  host-bridge/   Protocols shared between the extension host and webviews.
  webview-ui/    Shared webview front-ends: commit graph, diff/merge (Monaco), rebase.
apps/
  extension/     The VS Code / Cursor extension — the shipping product.
  desktop/       Reserved for a future native desktop app (placeholder).
```

`engine` and `host-bridge` are kept **pure** (no `vscode` imports) so they stay portable and testable — enforced by `npm run check-purity`.

## Build & test

Requires **Node 22+**.

```bash
npm install          # install all workspaces
npm test             # run every workspace's tests (tsx --test)
npm run check-types  # tsc --noEmit across all workspaces
npm run check-purity # assert engine/host-bridge stay vscode-free
npm run package      # build the extension production bundle
```

Package a sideloadable VSIX:

```bash
cd apps/extension
node esbuild.js --production
npx @vscode/vsce package -o gitstudio.vsix --no-dependencies
```

## Architecture notes

- **One flagship extension, not a swarm** (the GitLens model). It grows pillar by pillar; Merge Studio stays a separate, focused product.
- **Webview custom editors** for rich UI (merge, graph, rebase), **providers + decorations** for ambient features (blame, history), and a **thin git service** over the built-in `vscode.git` API plus direct `.git` reads where speed matters (e.g. instant conflict detection by watching operation-state files).
- **Strict CSP + per-load nonces** on every webview; AI keys live in SecretStorage and never reach a webview.
- **GitBrain** calls Anthropic Claude (or the VS Code Language Model API). Optional and bring-your-own-key — it never gates a Git operation.

## License

**Apache-2.0** (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)). Brand assets in [`brand/`](brand/) identify the project; don't use the GitStudio name/logo in a way that implies official endorsement.
