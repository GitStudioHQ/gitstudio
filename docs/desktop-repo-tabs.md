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
    ask nothing. But "detached" is not "left": the shell marks the screen it
    parks (`parkScreen`, views/common.ts), and `pageState` tells a page whose
    whole tab is in the back (`away`) from one that was left (`gone`). An away
    poller asks nothing — a call made from the back would be stamped with the
    tab in FRONT — and carries on when its tab is back; `disposeOnDetach`
    keeps an away page's Monaco diff or log pane; a closed tab releases them
    (`releaseScreen`).
- **Module state is per tab.** What a section view remembers — a search, a
  segment, a sort, facet ticks, a sub-tab, the live PR diff, the reply box
  Quote writes into, the Assistant's permission — is one copy per repository
  (`perTab`, tabState.ts), read where the view is built and kept in its
  closures; a closed tab's copies go with it. A section's router is never
  module state: every control uses the `nav` its own page was built with.
- **The bridge defers answers by owner.** `bridge.ts` stamps each call with
  the tab that was active when it was made, and an answer for a tab that is
  not active now is held until that tab is shown again (and dropped if it is
  closed). So a slow `head:get` from tab A cannot paint into B, a push that
  finishes in A shows its toast when you are back in A, and a flow with two
  steps (Stash & Retry, a discard's `stash create` then `restore`) cannot make
  its second call against B. The tab-changing calls themselves (open, close,
  activate) are not deferred. A call a TIMER makes is the one gap: made while
  its tab is in the back, it would be stamped with the tab in front. So work a
  timer starts — the "N commits selected" summary's settle — waits for its tab
  (`App.whenInFront`) before it asks (`a-selection-summary-asks-its-own-tab-once-it-is-back`).
- A route asked of a background App right after an open (`await
  openPath(); nav("code")` — "land in the repository I just opened") goes to
  the active tab; any other route asked of a background App is dropped.
  `worktree:open` is an open like the others. An open whose own dialog was up
  when main announced its tab (a clone's progress card) had its switch
  deferred for that dialog; its landing (`gs:go`, carrying the opened root)
  makes the switch at once, routes only that tab, and its toast is said after
  it — a switch clears the toasts of the tab you leave.
- **Boot.** main starts the launch restore BEFORE the window loads, and the
  window's first `repo:tabs` read is answered only once it is done
  (`RepoStore.settledState`). The restore announces the same tabs a moment
  before that answer, so until it arrives the renderer ignores `repo:tabs`
  events: every tab in the answer is one the window is bringing back — a
  macOS window reopened from the dock included.
- **Menus with no window.** Menu items hand their work to the renderer, and
  on macOS the app runs on with its window closed. Open Recent, Open… and
  Clone… bring the window back and are delivered once it has loaded
  (`menuCommand`, main/menuDelivery.ts); the rest need a window to act on.

## Per tab vs global

| Per tab | Global |
| --- | --- |
| route + target, history (⌘[ / ⌘]), kept-alive views and their scroll | theme, rail width / collapsed |
| SWR cache entries (namespaced by root; a switch no longer wipes) | GitHub account (sign-out drops every tab's GitHub caches and kept views) |
| undo stack (⌘Z acts on the active tab only; an entry refuses to run in another) | notifications badge, Assistant sessions list |
| composer draft (kept on close, restored on reopen) | toasts (cleared on switch — they are about the tab you left) |
| terminal dock: its sessions, Output log (filtered by root), open or closed, height — a new tab starts with the last one's | menus, peeks, palette (dismissed on switch) |
| Changes panel / conflicts dashboard / stopped operation chip | the tab row itself |
| focus-return memory, repo epoch (confirms) | |
| section state: searches, segments, sorts, facets, sub-tabs, the live PR diff, the Assistant's chips (tabState.ts) | |

## The state table (what each cell must do)

Each row is pinned by the tests named beside it — harness checks (`node
harness/check.mjs <id>` in apps/desktop) and unit tests (apps/desktop/test).
Every one of them was seen to fail with the code it guards reverted.

| # | State | Must | Pinned by |
| --- | --- | --- | --- |
| 1 | A read (git / GitHub) started in A lands while B is active | held; painted into A when A is shown; never into B | `a-slow-answer-from-one-tab-never-paints-into-another`; tabBridge.test "row 1" |
| 2 | An operation (push) started in A finishes while B is active | A's tab spins until it ends; its toast and refresh run when A is shown | `an-operation-in-a-background-tab-reports-when-you-are-back`; tabBridge.test "row 2/10" |
| 3 | A's watcher event arrives after the switch | ignored for B (payload carries the root); A re-checks the disk when shown | `a-background-tabs-disk-event-leaves-the-front-tab-alone` |
| 4 | A rebase stopped on conflicts; switch to B and back | A's op chip, Changes panel and dashboard are A's, untouched | `a-stopped-operation-stays-with-its-tab` |
| 5 | Switch while a modal is open | refused — a modal is answered first (its verb would run on the tab it was asked in) | `a-rebase-` / `a-reset-` / `the-pull-` / `the-stash-question-does-not-follow-you-to-another-repository` |
| 6 | Switch with a menu / peek / palette open | they close, then the switch happens | `a-switch-takes-the-menus-and-the-palette-with-it`, `a-switch-takes-an-open-peek-with-it` |
| 7 | Close a background tab | its App and caches go; the active tab is untouched | `closing-tabs-picks-the-neighbour-and-ends-at-home`; repoTabs.test "rows 7–9"; cache.test |
| 8 | Close the active tab | the tab to its right becomes active, else the one to its left | the same; tabModel.test "after a close…" |
| 9 | Close the last tab | the no-repository shell (Home, repository views disabled) | `closing-tabs-picks-the-neighbour-and-ends-at-home` |
| 10 | Close a tab with an operation running | asks first, naming the operation; git is not killed | `closing-a-tab-with-an-operation-running-asks-first`; repoTabs.test "rows 7–9" |
| 11 | Close a tab with an unsent commit message | nothing asked; the message is kept and comes back when the repository is reopened | `each-tab-keeps-its-own-commit-message` |
| 12 | Open a repository that already has a tab (any spelling) | switches to it; no second tab | `opening-a-repository-that-has-a-tab-switches-to-it`; repoTabs.test "row 12" |
| 13 | Open an eleventh | refused with the notice above | repoTabs.test "row 13" |
| 14 | A repository is deleted or moved on disk | its tab stays, its name struck through ("folder not found" in words). Nothing runs git in it, in the back or in front: brought to the front, ONE screen says so in place of its own — where it was, Look again, Close Tab — and no view, refresh, focus, disk event, menu or key reaches the tab. Found gone while in front, the same. Put back, it is whole again at the row's next look (or Look again) and re-reads the disk. Closing it works. Anything that still runs git there hears "The folder … is not there any more", not Node's `spawn git ENOENT` | `a-tab-whose-folder-is-gone-says-so-and-closes`, `a-gone-folder-put-back-makes-its-tab-whole-again`; repoTabs.test "row 14"; tabModel.test "row 14" |
| 15 | Undo | per tab; an entry recorded in A cannot run while B is active | tabUndo.test |
| 16 | Boot | the open tabs come back in order with the active one, each on its own view (Search included) — in main's order too, where the restore announces the tabs before the window's first read is answered; a tab whose folder is gone is dropped with one quiet notice naming it | repoTabs.test "row 16"; `each-restored-tab-comes-back-on-its-own-view`, `a-restored-tab-comes-back-to-search-and-a-new-one-lands-on-its-code` (each also under `?latetabs=1`, the shim's model of main's order) |
| 17 | A kept page with a Monaco diff or a log (a PR's Files, a commit, a job log); switch away and back | the same diff or log, not the page around an empty pane; a tab closed in the back lets them go | `a-tab-round-trip-keeps-its-diff-or-log`, `closing-a-tab-in-the-back-lets-its-diff-or-log-go` |
| 18 | The same section kept in two tabs | each keeps its own search, filters, sort and sub-tab, and routes its own tab; a repaint never reads the other's (Issues' GitHub search hits were another repository's) | `each-tab-keeps-its-own-list-state`, `a-kept-page-routes-its-own-tab-after-a-visit-to-another`, `quote-reply-lands-in-its-own-tabs-box`, `the-org-filter-filters-its-own-tabs-page`, `each-tab-keeps-its-own-filter-through-a-rebuild`, `each-tab-keeps-its-own-search`, `a-home-still-loading-when-you-switch-away-paints-when-you-are-back`, `a-board-still-loading-when-you-switch-away-paints-when-you-are-back`, `an-assistant-run-uses-its-own-tabs-permission`; tabState.test |
| 19 | A live page (a running CI run, a following log) whose tab goes to the back | asks nothing while in the back; polls again when it is in front | `a-live-page-keeps-polling-after-a-tab-round-trip` |
| 20 | An open whose dialog is up when main announces its tab (a clone's progress card) | the switch waits for the dialog; the open's landing makes it, routes only the new tab, and says its toast there — the tab it was started from keeps its page | `a-slow-clone-lands-in-its-new-tab-and-says-so` (`?clonems=`), `a-cloned-repository-says-so-in-its-new-tab`, `opening-a-worktree-opens-a-tab-and-says-so-there` |
| 21 | A tab closed while an open is still finding its repository | the open goes on — unless it is for the repository just closed, which stays closed and is not reported as opened | repoTabs.test "closing another tab…", "…the LAST tab…", "closing the repository an open is still finding…" |
| 22 | macOS with the window closed: Open Recent, Open…, Clone… | the window comes back and the open goes through it | menuDelivery.test |

Also per tab, and pinned: the terminal dock (`each-tab-has-its-own-terminal-dock`;
its open state and height are read when the tab is built, so a new tab starts
with the last one's and each keeps its own after),
the route, scroll and kept-alive DOM (`switching-tabs-keeps-each-tabs-place`),
and the graph's position (`the-graph-keeps-its-place-across-a-tab-switch`;
webview-ui graphReattach.test).

## Where a tab lands

- A tab restored at launch lands on the view that repository was left on
  (`tabViews` in the prefs), else the window's last view — Search included,
  as the single window always came back to Search.
- A NEW tab lands on the window's last view, except Search: Search is
  identified by its target, which belongs to the tab it was searched in, so a
  new tab opened from Search lands in its own Code rather than on an empty
  search. An open's landing (`await openPath(); nav("code")`) goes to the new
  tab.

## A folder that goes away (row 14)

The tab row asks main about every open tab (`repo:tabStatus`): its change
count, or `gone` when the folder is not there or has no `.git` any more. Gone
is a `stat` asked afresh every time (never cached), and a gone folder is never
handed to git to count. The row asks when the tabs change, when an operation
ends, on a watcher event, on a window focus at most once a minute, and when
the gone screen's Look again is pressed. A gone tab is not closed for you: the
folder may be on a drive that is coming back.

The tab in front with its folder gone shows the gone screen instead of its
own (`TabShell.showGone`): its own screen stays parked (or unbuilt), its
session is not made active — answers still owed to it stay held — and the
shell hands it no key, menu command, focus or disk event. ⌘Z there undoes
nothing. In main, a spawn ENOENT (thrown or returned) in a tab whose folder is
missing is said as "The folder … is not there any more — it was moved or
deleted.", an expected condition rather than a crash report
(`missingFolderError` / `missingFolderResult`, repoNotice.ts).

## The graph's position

A node taken out of the document loses its scroll offset, and a background
tab's screen is detached — as is a parked view inside one tab. The shared
`<gitstudio-graph>` (and the extension's commit rail, the same shape) keeps
its list's offset while attached and puts it back after a re-attach, so the
commit you were reading is still on screen when you come back. This fixed the
same loss on a plain view switch, which predates tabs.
