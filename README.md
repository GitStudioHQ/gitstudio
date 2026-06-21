<h1 align="center">GitStudio</h1>

<p align="center">
  <b>A JetBrains-grade Git experience for VS Code & Cursor — the whole workflow, not just one piece.</b>
</p>

---

## The idea

VS Code's built-in Git is functional but flat. GitLens is great at *information* (blame, history, lenses) but doesn't own the *interaction* (merging, staging, resolving). JetBrains IDEs nail the interaction — three-pane merges, a real commit graph, hunk-level staging, inline blame that feels native — but you only get them if you live in IntelliJ.

**GitStudio brings the JetBrains-grade Git *workflow* into VS Code and Cursor, and adds an intelligence layer on top.** Think "GitLens on steroids" meets "GitBrain": the polish of a native IDE, the depth of a power-user tool, and AI that actually understands your history.

It ships as a **family of focused tools under one brand**, starting with the one that's already live.

## Status

| | |
|---|---|
| **Brand / publisher** | `gitstudio` (display **"GitStudio"**) — live on the VS Code Marketplace **and** Open VSX |
| **Domain** | `gitstudio.dev` (owned — for the verified-publisher badge + landing page) |
| **First product** | ✅ **[Merge Studio](https://marketplace.visualstudio.com/items?itemName=gitstudio.merge-studio)** — `gitstudio.merge-studio`, a JetBrains-style 3-pane merge + diff editor. Shipped, in active use. |
| **Release pipeline** | Token-free GitHub Actions: tag `vX.Y.Z` → auto-publishes to both registries (see [vscode-extension-starter](../vscode-extension-starter)) |
| **This repo** | Vision + scaffold for the broader suite. See [HANDOFF.md](HANDOFF.md) to start building. |

## Product pillars

Merge Studio proved the model (custom webview editors, JetBrains-faithful ribbons, a pure tested diff/merge engine). GitStudio extends that into the full workflow:

1. **Merge & Diff** — *shipped as Merge Studio.* Three-pane merge with ribbons, precise side-by-side diff, optional hand-off to a real JetBrains IDE. The seed engine for everything else.
2. **Blame & authorship lens** — inline, native-feeling blame; hover for the commit, author, message, and PR; "who last touched this line and why."
3. **History & timeline** — per-file and per-line history, a repo timeline, "step through how this file evolved."
4. **Commit graph** — a real branch/commit graph (JetBrains Log-style), not a flat list.
5. **Staging that respects intent** — hunk- and line-level staging, partial commits, an interactive-rebase UI that isn't terrifying.
6. **GitBrain (the intelligence layer)** — AI commit messages, PR/changeset summaries, "explain this diff," and conflict-resolution *suggestions* in the merge editor. This is the "but better" — context-aware help grounded in the actual repo.

> The pillars are a starting map, not a contract. The next builder should sequence them by leverage — blame + history are the highest-value, lowest-risk next steps after merge.

## Architecture sketch

- **One flagship extension** (`gitstudio.gitstudio`) that grows feature-by-feature — the GitLens model — rather than many tiny extensions. Merge Studio stays its own focused product; GitStudio is the suite. They share an engine, not a listing.
- **Reuse Merge Studio's core.** Its `src/engine/` (pure, unit-tested diff/merge model) and the Monaco webview ribbon/decoration layer are the reusable heart. The cleanest path is to **extract that engine into a shared package** (`@gitstudio/engine`) consumed by both extensions.
- **Webview custom editors** for rich UI (merge, graph, history), **providers + decorations** for the ambient stuff (blame, lenses), **a thin git service** over the built-in `vscode.git` API plus direct `.git` reads where speed matters (Merge Studio already does this for conflict detection).
- **GitBrain** calls the Anthropic Claude API. Default to the latest models (Opus 4.8 / Sonnet 4.6 / Haiku 4.5; Fable 5) — see the `claude-api` reference. Keep AI optional and bring-your-own-key friendly.

## Why this can win

- **Distribution already exists.** GitStudio is a live, verified-ish publisher with a shipped product pulling real installs. The suite launches to a warm audience, not from zero.
- **Cursor is the wedge.** Cursor users live on Open VSX and want power tooling — GitStudio is already there.
- **The hard part is done once.** Merge Studio solved the "render a JetBrains-grade Git UI inside a webview" problem. Every pillar reuses that muscle.

## Repos

- **`../merge-studio`** — the shipped flagship; source of the reusable engine.
- **`../vscode-extension-starter`** — the token-free publish pipeline + the full "zero → published" guide, distilled from shipping Merge Studio. Fork it to bootstrap.
- **this repo** — vision + where the suite gets built.

## License

TBD (Merge Studio is MIT). Pick before first publish.
