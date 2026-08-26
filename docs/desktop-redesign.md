# Desktop redesign — the section-page system

The one spec every GitHub section view converts to. Written 2026-08-24; Issues
and Pull Requests are the reference implementations. When a view diverges from
this document, the view is wrong or this document gets updated — never a silent
third way.

## Why

The old sections were master/detail splits (`ghTwoPane`): a ~430px list pane
that truncated every title beside a detail pane that got the leftovers. Both
scrolled independently; neither had room. Actions rendered as an equal-weight
strip of mini-buttons; metadata (labels, assignees, milestone) was scattered
above the timeline. And too many features handed the user to github.com instead
of finishing the job in-app — even where the IPC layer already supported the
action.

The replacement is the Linear model translated to git/GitHub:

- **Lists are full-width pages.** Rich single-line rows, real information
  density, keyboard-first.
- **Opening an item navigates to a full detail page** in the same view host —
  no split, no overlay. `←` / `Esc` / `⌘[` go back.
- **Properties live in a right rail** on the detail page, each one inline-
  editable in place.
- **In-app actions are primary; github.com is an escape hatch** (a single
  link icon in the detail toolbar), never the way a feature works.
- **Peeks stay** for cross-entity glances (author profile, commit, branch), and
  the drill-in stack is unchanged.

## Navigation contract

A detail page is a **routed state**, not view-internal state:

- Open: `nav("issues", { number: 31 })` — routeView records it in the app
  history, forces a section rebuild, and the section renders the detail page.
- Back to the list: `nav("issues", { list: true })` — `list` is the explicit
  "section root" target that defeats routeView's same-view no-op.
- `⌘[` / `⌘]` and the mouse side buttons therefore walk list ⇄ detail ⇄ other
  sections exactly like a browser. A deep link from anywhere (project board,
  notification, prose `#123` reference, palette) is the same call.
- `Esc` on a detail page = back to the list — wired by `detailPage()`, and it
  stands down while a peek, palette, modal, or text field owns the key.

Sections keep their loaded data in the SWR cache (`cache.ts` `peek`/`gget`),
so back-to-list repaints instantly from cache and revalidates in the
background. Mutations `bust("<channel prefix>")` then re-render.

## The list page

```text
┌ sec-head ──────────────────────────────────────────────────────────────┐
│ Title  [count]  [search]              [state segment] [facets] [+ New] │
├────────────────────────────────────────────────────────────────────────┤
│ ○  #31  Split views make Issues unreadable  [ux] [desktop]   ⚑2 💬6 5h │
│ ○  #30  Workflow logs stop streaming        [bug]                💬2 9h │
└────────────────────────────────────────────────────────────────────────┘
```

- Rows are **single-line**, fixed-height (`.sec-row`, 40px): leading state
  icon, muted `#number`, strong title (truncates), label chips inline (hide
  under overflow), then a right-aligned meta cluster (assignee avatars,
  comment count, diffstat for PRs, relative time in tabular figures).
- `↑/↓/Home/End/Enter` via `wireListNav`; `Enter`/click navigates to detail.
- Empty/loading/error states use the existing `emptyState` / `skeletonList` /
  `errorState` — full-width.

## The detail page

```text
┌ det-topbar ────────────────────────────────────────────────────────────┐
│ ← Issues   #31                    [✨] [Edit] [Close] [⋯] [GitHub ↗]  │
├──────────────────────────────────────────────┬─ det-rail ──────────────┤
│  ● Open  Split views make Issues unreadable  │ STATE     ● Open        │
│  mira-holt opened 5h ago · 6 comments        │ AUTHOR    ◉ mira-holt   │
│  ┌ timeline card (prose) ┐                   │ ASSIGNEES ◉ anton  +    │
│  └────────────────────────┘                  │ LABELS    [ux] [app] +  │
│  ┌ comment ┐ …                               │ MILESTONE 1.6 — redesign│
│  [ composer                    ] [Comment]   │ CREATED   Aug 24, 18:04 │
└──────────────────────────────────────────────┴─────────────────────────┘
```

- `det-topbar`: a back button labeled with the section name, the item number,
  then the action cluster. One primary action max (Close/Reopen, Merge);
  destructive stays red; "Open on GitHub" is a de-emphasized icon at the end.
- `det-main`: measure-capped (~`--measure-read` + padding) content column —
  title block, timeline (THE prose system), composer. Never full-bleed text.
- `det-rail`: 264px sticky property rail (`propSection` rows). Every property
  is click-to-edit and reuses the section's existing menus/pickers
  (`openMenu`, `peoplePickerModal`, milestone menu…). The rail collapses under
  980px into a wrap row above the timeline.
- Sub-tabbed details (PRs: Conversation / Commits / Checks / Files) put the
  tab strip at the top of `det-main`; the Files tab widens to the full column
  (the rail hides) because diffs deserve the space.

## Rail IA

Local: Code · Changes · Commits · Branches · Rebase · Compare
GitHub: **Inbox** · **My Work** · Pull Requests · Issues · Actions · Releases · Projects
Account: Organizations · Gists

My Work is the workday-first page: review requests, items assigned to you,
your own PRs, and mentions — four `@me` searches, deduped, grouped by what
each item needs from you.

Inbox is the notifications view promoted to a rail item (the bell popover
stays for a quick glance). Orgs and Gists are account-scoped, not repo-scoped
— they get their own divider group.

## CSS

- New classes are `sec-*` (list page) and `det-*` (detail page), defined in
  ONE consolidated block in `app.css` ("SECTION PAGES"). No per-view style
  injection from TS (the old `ensureIssuesStyles` pattern is banned), no
  inline `style.*` layout from views.
- Spacing uses the `--sp-*` scale (4/8/12/16/20/24/32). New work never
  hardcodes paddings/gaps off-scale.
- The legacy `.gh-list`/`.gh-detail`/`ghTwoPane` split rules remain only while
  unconverted views still use them; each conversion deletes what it orphans.

## Conversion checklist (per view)

1. List page on `sectionList()`; rows single-line; facets in the toolbar.
2. Detail page on `detailPage()` with a property rail; every mutation the IPC
   layer supports is wired in-app; github.com demoted to the escape-hatch icon.
3. Deep-link target handling (`target.number` etc.) renders the detail page
   directly; `{ list: true }` renders the root.
4. Data through `peek`/`gget`; mutations `bust` their prefix.
5. Screenshot list + detail in both themes with the headless harness before
   calling it done.

Status: **all nine sections done** — Issues, Pull Requests, Inbox, Actions,
Releases, Gists, Projects, Orgs (and the ghTwoPane/ghListResizer scaffolding +
its CSS are deleted). Notes per view: Actions gets a Runs | Workflows segment
(dispatch is a modal, secrets stay a modal, run detail is the routed page);
Releases gets a Releases | Tags segment (tags open a peek with Draft-release);
Gists route by `target.id` (string-keyed) and render files through the
highlighted `.ghfile` code block; Projects keeps its full-width board and adds
**drag-and-drop between Status columns** (optimistic, kebab menu = keyboard
path); Orgs keeps its picker + card grid and adds a header filter over the
active sub-tab. Every section reads through the SWR cache.

## Depth guarantees (added by the autonomous night pass, 2026-08-25)

- **Paged reads everywhere.** `requestPaged`/`requestPagedKey` follow the
  `Link: rel="next"` chain (caps in `githubPaging.PAGE_CAPS`); a list that
  arrives at its cap renders `capNotice` — never a silent truncation.
- **Live surfaces.** Actions polls its runs list (12s) and a live run's detail
  (8s, signature-diffed, job-expansion preserved); a PR with pending checks
  re-fetches every 15s except while the Files tab holds a Monaco diff.
- **Drafts survive.** Issue/PR comment composers keep unsent text per item
  across every navigation until posted.
- **Keyboard layer.** `j/k` aliases in every list, `e` archives in Inbox,
  `?` opens the cheat sheet, `Esc` walks detail → list.
- **Release assets** upload (native file picker, uploads.github.com) and
  delete in-app; the PR review modal offers verdict + body in one surface.

## Clone destination control (Phase E1, 2026-08-25)

Where clones land is now a first-class setting, not a hardcoded path.

- `src/main/appSettings.ts` — userData/app-settings.json store (errorReporter
  template, injectable paths, node-tested). Holds `cloneDir` (default
  `~/GitStudio`) and `askWhereEveryTime`. IPC: `settings:get` /
  `settings:update` (null = reset) / `settings:pickCloneDir`.
- `ghrepo:open` takes `{fullName, dest?, name?}` and fails with structured
  `code: collision | clone-failed | open-failed | bad-name`. The renderer
  branches on codes — the old `/already exists/i` string-match is gone.
- `clone:start` pre-checks the destination (`code: dest-exists`) and
  validates names via shared `src/shared/cloneName.ts`
  (`deriveNameFromUrl` + `validateTargetName`, used live by both dialogs).
- `src/renderer/destinationSheet.ts` — the "Where should owner/repo go?"
  sheet: destination (prefilled from settings) + folder-name override with
  live validation. Opened by "Choose location…" (org repo peeks, remote
  browser), by every one-click open when ask-where-every-time is on, and as
  the collision-retry path (prefilled `owner-repo` suggestion).
- Clone dialog: destination prefilled from settings (Clone is one paste
  away), folder-name override field, coded-failure focus.
- Settings → Repositories card: clone-dir row (Change…/Reset) + ask toggle.
- Harness: `settings:*` fixtures (`ask=1` URL param presets the toggle),
  new driver steps `text:<needle>` (click by visible text) and
  `type:<text>` (fill the focused input).

## Local copies manager (Phase E2, 2026-08-26)

"What do I actually have on this machine?" is now answerable in-app.

- `src/main/localRepos.ts` — electron-free scanner (injected paths + clock).
  `scanLocalCopies()` unions the clone folder's top-level repos with the
  recents list, probes each `origin` (8 at a time, 5s timeout), dedupes by
  **real** path, and flags each row managed / recent / current / missing.
  `LocalRepoScanner` caches 30s; `invalidate()` after any mutation.
- macOS `/var` → `/private/var` is load-bearing: every containment judgment
  goes through `realOrResolve()`, which falls back to *the parent's* realpath
  so a missing clone is still judged against the same prefix.
- `src/main/githubRemote.ts` — `parseGitHubRemote` split out of githubBridge
  (which imports electron) so the scanner and its node tests stay clean.
  githubBridge re-exports it, so existing importers keep their seam.
- IPC: `repos:local`, `repos:reveal` (refuses paths not in the scan),
  `repos:removeRecent` (resolved-path match — a symlinked recent used to
  silently not match), `repos:trash`. Event `repo:recentChanged` repaints the
  welcome screen and rebuilds the native Recent Repositories submenu.
- The delete rule lives in ONE pure function (`trashRefusal`) with an async
  `trashRefusalResolved` wrapper that main.ts calls: refuses the clone folder
  itself, the open repo, anything outside the clone folder, and anything that
  isn't a git repo. Refusals are `expected: true` — never crash-reported.
- Settings → Repositories gained "On this machine": origin chip, path,
  managed/recent/open/missing badges, per-row Open / Reveal / Copy path /
  Forget / Delete clone… The delete uses `confirmDialog({requireTyped})` —
  a new, generic typed-confirmation for irreversible actions.
- Repo switcher gained "Manage Repositories…".
- Harness: `repos:*` fixtures + a `scroll:<selector>` driver step.

## Metadata sweep (Phase A3, 2026-08-26)

GitHub knows who merged it, why it closed, and who was asked — the app now
says so.

- `src/main/github/maps.ts` is finally what its header claimed: `mapPull`,
  `mapIssue`, `mapComment`, `mapNotification`, `mapReactions` and `subjectRef`
  all live there once. The divergent copies in githubClient.ts, github/prs.ts,
  github/issues.ts and github/notifications.ts are gone.
  `src/main/githubRemote.ts` keeps the electron-free seam.
- New wire fields — PR: closedAt, mergedBy, reviewComments, commits,
  requestedReviewers, milestone, authorAssociation, headRepoFullName,
  reactions. Issue: closedAt, closedBy, **stateReason**, authorAssociation,
  reactions. IssueComment: updatedAt, authorAssociation, reactions.
  NotificationThread: lastReadAt, subjectKind, subjectNumber, subjectSha.
- **`subjectRef()`** parses GitHub's subject API url (whose tail IS the number
  or the sha). That single function is why Inbox rows for **Releases** and
  **Commits** now open in-app — a release detail page and a graph reveal —
  instead of bouncing to github.com. The context menu stopped saying "Open on
  GitHub" for rows that open in-app.
- Closed-as-not-planned is its OWN state (`issueStateKind()` in ui.ts): gray
  circle-slash lead, "Not planned" pill, and a rail section naming who closed
  it and when. Same word, different outcome — GitHub parity.
- PR rail: pending reviewers (dashed = asked, not answered), Merged by,
  Milestone, and About facts for Commits / Review comments / From fork /
  Author is / Merged-or-Closed. PR rows carry a `fork` chip.
- Comments carry an "edited" marker, an association badge (only when it
  means something — never a CONTRIBUTOR badge on every comment), and a
  read-only reaction strip.
- Tests: `test/notificationSubject.test.ts` (13), `test/itemMaps.test.ts` (10).

## Universal facets (Phase A4, 2026-08-26)

Five views had five different ideas of what "filter" means. Now they share one.

- `src/renderer/facetModel.ts` — the PURE half (DOM-free, node-tested):
  `FacetSpec`, `facetPasses`, `facetServerValues`, `facetActiveCount`,
  `harvestValues`. **The load-bearing rule: a spec with no `predicate` is
  server-side** — it never filters locally, because doing both would hide rows
  the server already excluded.
- `views/common.ts` — `facetBar()` builds the buttons/menus on top of that
  (harvested / static / async-loaded options, label swatches and avatars as
  leading elements, menu search past 8 options, a Clear button that only
  appears while something is filtered), plus `segmented()` (extracted from the
  two hand-rolled copies) and shared `swatch()`. It re-exports the pure names,
  so views have one facet import site.
- Adoption:
  - **Actions** — workflow (async-loaded ids) / branch / actor / event /
    status, all SERVER-side: narrowing re-fetches with a different filter,
    the filter object IS the cache key, and the 12s poll asks the same
    question the view is showing. `capNotice(…, "server")` stops telling
    people to "search to narrow" a list the server already narrowed.
  - **Issues** — the three bespoke facets migrated, plus author and
    state-reason (completed vs not planned).
  - **PRs** — author / label / base / state (ready · draft · from a fork).
  - **Inbox** — type / reason / repo.
  - **My Work** — kind / type.
- `facets.sync(items)` runs on every render: the bar is built before the first
  fetch lands, and a facet menu that offers nothing is worse than no facet.
- Tests: `test/facets.test.ts` (12).

## Explore — global GitHub search (Phase E3, 2026-08-26)

The last big "go to the browser" moment: finding a repo, a person, an org or a
line of code. Now a rail page.

- `src/main/github/searchQuery.ts` — PURE path builders (node-tested): a wrong
  search query never errors, it just returns the wrong results, so every URL
  the app can ask for is pinned by tests. Also owns the 1000-result ceiling
  (`beyondCeiling`, `reachableCount`) — asking past it earns a 422.
- `src/main/github/searchGuard.ts` — token buckets, 30/min core and 10/min
  code, with headroom reserved. Refuses BEFORE spending and returns
  `retryInMs`, so the UI can show a countdown instead of an error for a
  condition that fixes itself in seconds.
- `src/main/github/search.ts` — one API request per invoke (explicit page of
  30, never an automatic Link-follow): each page is real money from a small
  purse, so "Load more" is a user action. Failure modes live in the RESULT:
  `limited`, `incomplete`, `hasMore`.
- `GitHubClient.request` gained an `accept` option — code search only returns
  match fragments under `text-match+json`.
- `views/explore.ts` — search-first page: hero field, tab strip (Repositories ·
  People · Organizations · Code), repo sort, and result rows with hover
  actions (Open · Choose location… · Clone… · GitHub). **Code searches only on
  Enter** — never a keystroke. Explore rows are their own two-line builder
  (`secRow` is a single-line `<button>`, which can't hold a description or
  nested action buttons).
- Routed via `target.id` micro-paths (`q/<tab>/<query>`, `repo/<owner>/<name>`,
  `user/…`, `org/…`) so ⌘[ walks the trail — no SectionTarget change.
- Rail: **Explore heads the Account group** — discovery before inventory.
- Harness: `search:*` fixtures; the `key:` driver step now dispatches at the
  FOCUSED element (a real Enter goes to the input, not the window).
- Tests: `test/searchQuery.test.ts` (11), `test/searchGuard.test.ts` (5).

## Explore entity pages (Phase E4, 2026-08-26)

The peek browser is a glance; these are places to actually read a repository.

- `src/renderer/exploreRoutes.ts` — PURE routing vocabulary (node-tested):
  `q/<tab>/<query>`, `repo/<owner>/<name>[/(tree|blob)/<ref>/<path>]`,
  `user|org/<login>`. A wrong parse doesn't throw, it strands the user on the
  wrong page — hence tests. **"HEAD" is a sentinel that parses back to "the
  default branch"**: without that, walking into a file silently pinned the ref
  and relabelled the switcher.
- `views/exploreRepo.ts` — routed breadcrumbs (every segment navigable, so ⌘[
  walks the trail), a ref switcher, **go-to-file** (whole tree in one
  `git/trees?recursive=1`, ranked by the palette's own exported `fuzzyScore`),
  directory listings, README + markdown in the prose system with relative
  links resolving in-page, code with the Code view's colorizer, and a metadata
  rail. Top bar: ref · Go to file · GitHub · **Open in GitStudio ▾** (split
  button: Choose location… / Clone…).
- `views/exploreUser.ts` — an account page for a person or an org: profile
  rail (company, location, counts, links, orgs) beside their repositories,
  each openable here, with a filter.
- Main: `ref?` threaded through ghrepo:tree/file/readme; new `ghrepo:branches`
  (paged — a busy repo has hundreds) and `ghrepo:paths` (25k cap, and BOTH its
  own and GitHub's truncation are reported: a file search that can't see a
  file must say so). New `users:repos` / `users:orgs`; `GhUserInfo` gained
  type/following/twitter/email.
- Orgs' "Browse" hover action now opens the full page; "Details" keeps the peek.
- Tests: `test/exploreRoutes.test.ts` (13).

## Palette search + global wiring (Phase E5, 2026-08-26)

⌘K stopped being a jump list and became the front door.

- `src/renderer/searchDebounce.ts` — PURE scheduler (node-tested with fake
  timers). Three rules that are each easy to get subtly wrong: debounce (don't
  spend a request per keystroke), a minimum length (two characters match
  everything), and **generation tokens** — a slow answer to an old query must
  be dropped, not rendered over a newer one. Typing back *below* the minimum
  invalidates a search already in flight.
- `PaletteProviders` gained `search?: (query) => …` (fires as you type, unlike
  `remote`, which fires once at open) and `pinned` groups that skip fuzzy
  filtering — a search group's items ARE the answer, so re-filtering them by
  the same query would throw away GitHub's own ranking.
- Wired: a pinned "Search GitHub for …" row → Explore, plus the top 3
  repositories and top 3 people, using **Explore's exact gget cache keys** so
  opening the full page after previewing costs nothing. Code search is never
  called from the palette — 10/min is too small to spend on typing.
- `github:status` was being fetched three times per palette open; now once.
- Entry points into Explore: the topbar affordance ("Search anything…"),
  Inbox repo links (the full repo page, not the peek stack), and every person
  chip in the app — `memberCard` gained a primary "View full profile".
- Tests: `test/searchDebounce.test.ts` (8).

---

**Wave 2 complete**: A1 · A2 · E1 · E2 · A3 · A4 · E3 · E4 · E5.
269 tests green; both tsconfigs clean; every surface shot in dark and light.
