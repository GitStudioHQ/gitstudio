<p align="center">
  <img alt="GitStudio" src="media/icon.png" width="116">
</p>

<h1 align="center">GitStudio</h1>

<p align="center">
  <b>A free, open-source, JetBrains-grade Git suite for VS Code &amp; Cursor — the whole workflow, in one extension.</b>
</p>

<p align="center">
  Commit graph · inline blame · file &amp; line history · hunk/line staging · side-by-side diff · 3-pane merge · interactive rebase with a universal <b>Undo</b> · branches, remotes, stashes, tags, worktrees · search &amp; compare · in-editor GitHub PR review · optional bring-your-own-key AI.
</p>

---

GitStudio brings the parts people love from **GitLens**, **GitKraken**, and **JetBrains IDEs** into one unified, free, open-source extension — the *information* lens *and* the *interaction* (merging, staging, rebasing, resolving), with an optional intelligence layer on top. It runs identically on VS Code and Cursor (built on stable APIs, shipped to the Marketplace and Open VSX).

> **Free, with no paywall.** GitLens gates its graph, "commit details," and AI behind GitLens+; GitKraken's client is a paid app for private repos. GitStudio's entire feature set — graph, blame, history, merge, rebase, PR review — is free on public *and* private repos. No account, telemetry off by default, Apache-2.0.

## Features by pillar

### Visualize
- **Commit graph** — a real, virtualized branch/commit graph that stays fast at tens of thousands of commits, with colored lanes, ref chips, and keyboard navigation.
- **Inline blame** — current-line authorship inline and in the status bar; full-file annotations with a code-age heatmap (recent changes warm, old changes cool) and rich command hovers.
- **History & timeline** — per-file history, **line history** (blame-over-time), revision step navigation, and a **reflog time-machine** for recovery.

### Change
- **Hunk- & line-level staging** — stage exactly the lines you mean, from any editor or diff, plus file/group stage · unstage · discard in the Changes view.
- **Guided commit box** — auto-growing message, Amend, Sign-off, author override, and **Commit & Push**, with a ✨ button to draft the message from your staged diff (when AI is on).
- **Side-by-side & unified diff** — word-level highlighting and a clean, theme-true presentation.
- **3-pane merge editor** — a JetBrains-style *yours / result / theirs* conflict editor with one-click accept ribbons; conflicts auto-open as they appear.

### Rewrite — safely
- **Interactive rebase** — a drag-to-reorder rebase editor (pick · reword · edit · squash · fixup · drop) that isn't terrifying.
- **Universal Undo** — a reflog-powered safety net that snapshots before every destructive op and reverses it with one command (pushed history falls back to a safe Revert). **Undo never hijacks `Ctrl/Cmd+Z`.**

### Manage
- **Branches, remotes, tags, stashes, worktrees** — rich sidebar views and operations (checkout, merge, rebase, rename, delete, push, set-upstream, new branch/worktree, fetch, manage remotes, stash apply/pop/drop/branch, lock/prune worktrees, tag push/checkout/delete).
- **Search & Compare** — search commits and compare any two branches/tags into a results view.
- **Status-bar sync** — ahead/behind with one-click fetch/pull/push (force-push uses the safer `--force-with-lease` by default).

### Collaborate & assist (optional)
- **In-editor GitHub PR review** — sign in once with VS Code's built-in GitHub account to list, open, check out, review (inline comments + submit), merge, and create pull requests without leaving the editor.
- **GitBrain AI** — bring-your-own-key (Anthropic) or zero-key via GitHub Copilot's model: AI commit messages, *explain this diff*, and change summaries. **Off until you turn it on, and it never gates or breaks a Git operation.**

## Keybindings

GitStudio's chorded actions use one consistent, conflict-free family — **`Ctrl+Alt+G`** (`Cmd+Alt+G` on macOS) then a letter:

| Action | Windows / Linux | macOS |
|---|---|---|
| Toggle file blame | `Ctrl+Alt+G` `B` | `Cmd+Alt+G` `B` |
| Show line history | `Ctrl+Alt+G` `H` | `Cmd+Alt+G` `H` |
| Open changes (vs HEAD) | `Ctrl+Alt+G` `D` | `Cmd+Alt+G` `D` |
| Stage selected lines | `Ctrl+Alt+G` `S` | `Cmd+Alt+G` `S` |
| Unstage selected lines | `Ctrl+Alt+G` `U` | `Cmd+Alt+G` `U` |
| Undo last Git operation | `Ctrl+Alt+G` `Z` | `Cmd+Alt+G` `Z` |

In the **commit box**: `Enter` commits, `Shift+Enter` adds a newline, `Ctrl/Cmd+Enter` also commits. All bindings are remappable in *Keyboard Shortcuts*.

## GitBrain AI — bring your own key

AI is entirely optional and stays off until configured. Two ways to enable it:

1. **Zero-key (GitHub Copilot):** if you have Copilot, set `gitstudio.ai.provider` to `auto` (the default) — GitBrain uses the built-in VS Code Language Model, no key needed.
2. **Anthropic (BYO-key):** run **GitStudio: Set AI API Key…** and paste an `sk-ant-…` key. It's stored in your OS keychain (SecretStorage) and **never** sent to a webview.

Then use the ✨ in the commit box, or **Generate Commit Message / Explain Diff / Summarize Changes** from the palette. Models and commit style are configurable (see settings).

## GitHub PR review setup

No extra account or token: open the **Pull Requests** view and click **Sign in to GitHub** (VS Code's built-in auth). GitStudio then lists open PRs for the current repo; from there you can open the description panel, check out, start a review (add inline comments and submit), merge with your preferred method, or create a new PR. Not a GitHub repo or not signed in? The view simply shows a connect prompt — nothing throws.

## Settings highlights

| Setting | Default | What it does |
|---|---|---|
| `gitstudio.blame.inlineEnabled` | `true` | Inline current-line blame at end of line. |
| `gitstudio.blame.statusBarEnabled` | `true` | Current-line author/age in the status bar. |
| `gitstudio.blame.heatmap` | `true` | Code-age heatmap on full-file annotations. |
| `gitstudio.merge.autoOpen` | `true` | Auto-open conflicts in the 3-pane merge editor. |
| `gitstudio.commit.signoffByDefault` | `false` | Default the Sign-off toggle on in the commit box. |
| `gitstudio.push.forceWithLease` | `true` | Use the safer `--force-with-lease` when force-pushing. |
| `gitstudio.ai.provider` | `auto` | `auto` · `anthropic` · `vscode-lm` · `off`. |
| `gitstudio.ai.commitStyle` | `conventional` | `conventional` · `concise` · `descriptive`. |
| `gitstudio.pr.defaultMergeMethod` | `squash` | `merge` · `squash` · `rebase`. |

(Anthropic model IDs for fast/mid/deep tiers are configurable too.)

## Get started

Install, open a folder with a Git repo, and run **GitStudio: Get Started** (or use the rocket in the GitStudio sidebar) for a guided tour. The activity-bar container reads top-to-bottom as a workflow: **Commit → Changes → Commits → Branches → Stashes → Worktrees → Search & Compare → Pull Requests.**

## License

Licensed under **Apache-2.0**. Part of the [GitStudio](https://gitstudio.dev) family. Portions of the shared engine and webview UI originate from Merge Studio (MIT) — see `NOTICE`.
