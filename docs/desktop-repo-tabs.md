# Desktop — repositories as tabs

Issue #32: "In the GitStudio app I would imagine having multiple opened
projects as tabs at the top row instead of single one." Written 2026-09-25,
before the code; the code follows this, or this gets corrected.

## What the user sees

- A **tab row** at the very top of the window, above the top bar — the Fork /
  GitKraken place for repository tabs. On macOS it is the title bar: the
  traffic lights sit in it and its empty space drags the window. It replaces
  the top bar's single repository chip; the active tab is what names the
  repository you are working in.
- One tab per open repository: its folder name, `●N` when it has uncommitted
  changes (the same mark Home and Repositories use), a spinning `loading`
  codicon while an operation of that tab is running, and the `close` codicon
  ("Close gitstudio"). The active tab carries the top bar's panel colour and an
  accent rule; the rest are quiet.
- `+` (the `add` codicon, "Open a repository in a new tab") at the end of the
  row, pinned outside the scroller so a narrow window never loses it. It opens
  the menu the old chip opened: Open repository…, Clone repository…, the
  recent repositories that are not open, All repositories.
- Opening a repository that already has a tab switches to that tab (compared
  by real path, so a symlinked spelling is the same repository).
- Tabs shrink to a minimum width (120px, so a name keeps a few letters), then
  the row scrolls sideways; the active tab is always scrolled into view, clear
  of the edges. While it overflows, the edge with tabs past it fades and a
  `chevron-down` button ("All open repositories") lists every tab — VS Code's
  "Show Opened Editors", in words. A narrow window never loses the `+` or the
  list: they sit outside the scroller.
- Right-click a tab: Close, Close Other Tabs, Close Tabs to the Right, Copy
  Path, Reveal in Finder. Middle-click closes. Tabs drag to reorder (the drop
  edge is drawn in the accent colour).
- Keyboard: Ctrl+Tab / Ctrl+Shift+Tab (and Ctrl+PageDown / PageUp) cycle.
  Jumping by number follows VS Code's "open editor at index", because ⌘1–9
  already means the rail's views here: **Ctrl+1–9 on macOS, Alt+1–9 on
  Windows/Linux** (9 is the last tab). **⌘W / Ctrl+W closes the active tab**.
  Checked first: on macOS ⌘W was bound to nothing (the Window menu has no
  Close item there); on Windows/Linux it was the Window menu's Close, which
  moves to Ctrl+Shift+W, VS Code's chord for closing the window. The old
  "Close repository" item (⌘⇧W) IS closing the tab now, so it becomes "Close
  Tab". Middle-click closes a tab too.

## The bound

At most **10** tabs. Every open tab is fully live — its git context in main,
its screen, its terminals — because a tab that silently drops its state when
you are not looking is worse than a limit you can see. An eleventh open says
so and opens nothing: "GitStudio keeps up to 10 repositories open. Close a
tab to open another." A main-side `GitContext` holds no process while idle
(verified: `GitProcess` only tracks in-flight children), so the cost of the
bound is the renderer's DOM, which is why it exists.

## Architecture — which, and why

**One `App` per tab, one active at a time; background tabs are detached and
their answers wait at the door.**

- **Main** (`RepoStore`) holds an ordered list of open tabs, each with its own
  `GitContext`, and the active root. Switching never disposes a context.
  Closing a tab drops its context WITHOUT killing git commands still running
  in it (`dispose()` would SIGTERM a push halfway) — git finishes what it
  started; nobody is waiting for the answer.
- **Every IPC call says which repository it is for.** The preload's `invoke`
  takes a third argument, `{ root }`, and main's `handle` wrapper runs the
  handler inside an `AsyncLocalStorage` scope for it. `repos.getContext()` and
  `repos.current()` read that scope, so every bridge (git, GitHub, rebase, AI,
  terminal) acts on the tab that asked — including after its own awaits, and
  for work that outlives the handler (an agent run). A call for a tab that has
  been closed gets NO context; it never falls back to the active one.
- **Renderer**: a `TabShell` owns the tab row and a stage. Each tab gets its
  own `App` instance (created the first time the tab is shown), with its own
  screen — top bar, rail, view host, terminal dock — and its own fields:
  route, history, kept-alive views, composer draft, graph mount, compare
  state, conflicts panel. Switching detaches the old screen and attaches the
  new one; nothing is rebuilt.
  - *Why per-instance rather than one App whose fields are swapped:* a swap
    makes every late continuation write into whichever tab is loaded when it
    lands (`this.headInfo = …`). With an instance per tab, a closure always
    writes into its own tab.
  - *Why detached rather than `display: none`:* every "is my view still on
    screen" guard in the app is `isConnected` — the pollers in Actions and
    PRs, the account chip, the log tail. Detached, a background tab's pollers
    stop by the rules that already stop a parked view's.
- **The bridge defers answers by owner.** `bridge.ts` stamps each call with
  the tab that was active when it was made, and an answer for a tab that is
  not active now is held until that tab is shown again (and dropped if it is
  closed). So a slow `head:get` from tab A cannot paint into B, a push that
  finishes in A shows its toast when you are back in A, and a flow with two
  steps (Stash & Retry, a discard's `stash create` then `restore`) cannot make
  its second call against B. The tab-changing calls themselves (open, close,
  activate) are not deferred.
- A route asked of a background App right after an open (`await
  openPath(); nav("code")` — "land in the repository I just opened") goes to
  the active tab; any other route asked of a background App is dropped.

## Per tab vs global

| Per tab | Global |
| --- | --- |
| route + target, history (⌘[ / ⌘]), kept-alive views and their scroll | theme, rail width / collapsed, terminal height |
| SWR cache entries (namespaced by root; a switch no longer wipes) | GitHub account (sign-out drops every tab's GitHub caches and kept views) |
| undo stack (⌘Z acts on the active tab only; an entry refuses to run in another) | notifications badge, Assistant sessions list |
| composer draft (kept on close, restored on reopen) | toasts (cleared on switch — they are about the tab you left) |
| terminal sessions + Output log (filtered by root) | menus, peeks, palette (dismissed on switch) |
| Changes panel / conflicts dashboard / stopped operation chip | the tab row itself |
| focus-return memory, repo epoch (confirms) | |

## The state table (what each cell must do)

| # | State | Must |
| --- | --- | --- |
| 1 | A read (git / GitHub) started in A lands while B is active | held; painted into A when A is shown; never into B |
| 2 | An operation (push) started in A finishes while B is active | A's tab spins until it ends; its toast and refresh run when A is shown |
| 3 | A's watcher event arrives after the switch | ignored for B (payload carries the root); A re-checks the disk when shown |
| 4 | A rebase stopped on conflicts; switch to B and back | A's op chip, Changes panel and dashboard are A's, untouched |
| 5 | Switch while a modal is open | refused — a modal is answered first (its verb would run on the tab it was asked in) |
| 6 | Switch with a menu / peek / palette open | they close, then the switch happens |
| 7 | Close a background tab | its App and caches go; the active tab is untouched |
| 8 | Close the active tab | the tab to its right becomes active, else the one to its left |
| 9 | Close the last tab | the no-repository shell (Home, repository views disabled) |
| 10 | Close a tab with an operation running | asks first, naming the operation; git is not killed |
| 11 | Close a tab with an unsent commit message | nothing asked; the message is kept and comes back when the repository is reopened |
| 12 | Open a repository that already has a tab (any spelling) | switches to it; no second tab |
| 13 | Open an eleventh | refused with the notice above |
| 14 | A background repository is deleted or moved on disk | its tab stays, and says so when shown (the existing "not a repository" states); closing it works |
| 15 | Undo | per tab; an entry recorded in A cannot run while B is active |
| 16 | Boot | the open tabs come back in order with the active one; a tab whose folder is gone is dropped with one quiet notice naming it |
