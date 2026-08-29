// Explore — global GitHub search, in the app.
//
// The point of the whole redesign, applied to discovery: finding a repo, a
// person, an org or a line of code should not mean opening a browser. Four
// tabs over GitHub's search API, results you can act on (open in GitStudio,
// clone somewhere you choose), and paging that is honest about GitHub's hard
// 1000-result ceiling.
//
// The search budget is small (30/min; 10/min for code), so:
//   • repos / people / orgs debounce at 300ms
//   • CODE searches only on Enter — never a keystroke
//   • every request goes through main's SearchGuard, and a `limited` answer
//     renders a countdown instead of an error
//
// Routing: Explore states are `target.id` micro-paths, so ⌘[ / Esc walk the
// trail without adding fields to SectionTarget:
//   q/<tab>/<query>   the search itself
//   repo/<owner>/<name>   a repository page   (E4 fills this in)
//   user/<login> · org/<login>                (E4 fills these in)

import { host } from "./../bridge";
import { gget } from "./../cache";
import { toast } from "./../dialogs";
import {
  avatar,
  cleanErr,
  el,
  emptyState,
  errorState,
  glyph,
  openMenu,
  relTimeISO,
  skeletonList,
  span,
} from "../ui";
import { openGhRepoInApp, openGhRepoChooseLocation } from "../ghOpen";
import { openCloneDialog } from "../cloneDialog";
import { openPeek } from "../peek";
import { memberCard } from "./orgs";
import {
  parseAccountTarget,
  parseExploreTarget,
  parseRepoRoute,
  searchTargetId,
  repoRouteId,
} from "../exploreRoutes";
export { searchTargetId } from "../exploreRoutes";
import { renderRepoPage } from "./exploreRepo";
import { renderAccountPage } from "./exploreUser";
import {
  ghGate,
  searchField,
  secRow,
  sectionList,
  type SectionNav,
  type SectionRender,
  type SectionTarget,
} from "./common";
import type {
  SearchCodeItem,
  SearchPage,
  SearchRepoItem,
  SearchSort,
  SearchUserItem,
} from "../../shared/ipc";

type Tab = "repos" | "users" | "orgs" | "code";

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: string }> = [
  { id: "repos", label: "Repositories", icon: "repo" },
  { id: "users", label: "People", icon: "person" },
  { id: "orgs", label: "Organizations", icon: "organization" },
  { id: "code", label: "Code", icon: "code" },
];

// ── Section state (survives list ⇄ detail round trips, like the other views) ──
let tab: Tab = "repos";
let query = "";
let repoSort: SearchSort = "best";
/** Pages accumulated for the CURRENT (tab, query, sort) — "Load more" appends. */
let pages = 1;

/** Guards against a slow earlier query overwriting a newer one's results. */
let searchSeq = 0;



export const renderExplore: SectionRender = (wrap, nav, target) => {
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  // Entity pages are Explore states too — a repo, a person, an org. Each is a
  // full page that goes BACK to the search it came from.
  const backToSearch = (): void =>
    nav("explore", query ? { id: searchTargetId(tab, query) } : undefined);

  const repoRoute = parseRepoRoute(target?.id);
  if (repoRoute) {
    const gate = await ghGate(wrap, nav, true, () => renderExplore(wrap, nav, target));
    if (!gate) return;
    renderRepoPage(wrap, nav, repoRoute, backToSearch);
    return;
  }
  const account = parseAccountTarget(target?.id);
  if (account) {
    const gate = await ghGate(wrap, nav, true, () => renderExplore(wrap, nav, target));
    if (!gate) return;
    renderAccountPage(wrap, nav, account.login, backToSearch);
    return;
  }

  const routed = parseExploreTarget(target?.id);
  if (routed) {
    tab = routed.tab;
    query = routed.query;
    pages = 1;
  }

  const refresh = (): void => renderExplore(wrap, nav, target);
  const gate = await ghGate(wrap, nav, true, refresh);
  if (!gate) return;

  const { view, listEl } = sectionList();
  view.classList.add("explore-view");

  // ── search-first header ──
  const head = el("div", "explore-head");
  const title = el("h1", "explore-title");
  title.textContent = "Explore GitHub";
  const sub = el("div", "explore-sub");
  sub.textContent = "Repositories, people, organizations and code — all of GitHub, opened here.";

  const field = searchField({
    placeholder:
      tab === "code"
        ? "Search code — press Enter (code search is rate-limited)"
        : tab === "repos"
          ? "Search repositories — try  stars:>1000 language:TypeScript"
          : tab === "orgs"
            ? "Search organizations…"
            : "Search people…",
    initial: query,
    autofocus: true,
    // Code search costs 10× more of the budget, so it never fires on a
    // keystroke: the long debounce is a backstop, Enter is the real trigger.
    debounceMs: tab === "code" ? 100_000 : 300,
    onInput: (q) => {
      if (tab === "code") return;
      setQuery(q);
    },
    onEnter: (q) => setQuery(q),
  });
  field.classList.add("explore-search");
  head.append(title, sub, field);

  const tabBar = el("div", "explore-tabs");
  tabBar.setAttribute("role", "tablist");
  for (const t of TABS) {
    const b = el("button", "explore-tab" + (t.id === tab ? " active" : ""));
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.id === tab));
    b.append(glyph(t.icon), span(t.label));
    b.addEventListener("click", () => {
      if (t.id === tab) return;
      tab = t.id;
      pages = 1;
      // Re-route rather than re-render in place, so ⌘[ walks tab changes too.
      if (query) nav("explore", { id: searchTargetId(tab, query) });
      else renderExplore(wrap, nav, undefined);
    });
    tabBar.appendChild(b);
  }

  const tools = el("div", "explore-tools");
  tools.appendChild(tabBar);
  if (tab === "repos") {
    const sortBtn = el("button", "mini-btn explore-sort");
    const sortLabel = (s: SearchSort): string =>
      s === "stars" ? "Most stars" : s === "updated" ? "Recently updated" : "Best match";
    sortBtn.append(glyph("sort-precedence"), span(sortLabel(repoSort)), glyph("chevron-down"));
    sortBtn.title = "Sort results";
    sortBtn.addEventListener("click", () =>
      openMenu(
        sortBtn,
        (["best", "stars", "updated"] as SearchSort[]).map((s) => ({
          label: sortLabel(s),
          icon: repoSort === s ? "check" : undefined,
          onClick: () => {
            if (repoSort === s) return;
            repoSort = s;
            pages = 1;
            run();
          },
        })),
      ),
    );
    tools.appendChild(sortBtn);
  }
  head.appendChild(tools);
  view.append(head, listEl);
  wrap.replaceChildren(view);

  const setQuery = (q: string): void => {
    if (q === query) return;
    query = q;
    pages = 1;
    if (q) nav("explore", { id: searchTargetId(tab, q) });
    else run();
  };

  // ── running the search ──
  const run = async (append = false): Promise<void> => {
    const seq = ++searchSeq;
    if (!query) {
      listEl.replaceChildren(startState());
      return;
    }
    // People and organizations are a DIRECTORY, not documents: a 40px row
    // holding a login in a 1350px pane read ~93% empty. Same treatment the
    // organization's Members tab uses — compact chips that wrap from the left.
    listEl.classList.toggle("is-people", tab === "users" || tab === "orgs");
    if (!append) listEl.replaceChildren(skeletonList(6));
    else listEl.appendChild(loadingMore());

    try {
      const page = append ? pages + 1 : 1;
      const result = await fetchPage(tab, query, repoSort, page);
      if (seq !== searchSeq || !view.isConnected) return;
      if (result.limited) {
        listEl.replaceChildren(limitedState(result.limited.retryInMs, () => void run(append)));
        return;
      }
      if (append) {
        pages = page;
        listEl.querySelector(".explore-loading-more")?.remove();
        listEl.querySelector(".explore-footer")?.remove();
        appendRows(result, false);
      } else {
        pages = 1;
        listEl.replaceChildren();
        appendRows(result, true);
      }
    } catch (e) {
      if (seq !== searchSeq || !view.isConnected) return;
      listEl.replaceChildren(
        errorState("Search failed", cleanErr(e) || "GitHub couldn't answer that search.", () => void run()),
      );
    }
  };

  const appendRows = (result: SearchPage<unknown>, first: boolean): void => {
    const items = result.items;
    if (first && items.length === 0) {
      listEl.replaceChildren(
        emptyState("No results", `Nothing on GitHub matches “${query}”.`, {
          icon: "search",
          anchor: "inline",
        }),
      );
      return;
    }
    for (const item of items) {
      if (tab === "repos") listEl.appendChild(repoRow(item as SearchRepoItem, nav));
      else if (tab === "code") listEl.appendChild(codeRow(item as SearchCodeItem, nav));
      else listEl.appendChild(userRow(item as SearchUserItem, nav));
    }
    listEl.appendChild(footer(result, () => void run(true)));
  };

  await run();
}

// ── one request, cached by (tab, query, sort, page) ──────────────────────────

function fetchPage(
  t: Tab,
  q: string,
  sort: SearchSort,
  page: number,
): Promise<SearchPage<SearchRepoItem | SearchUserItem | SearchCodeItem>> {
  // 60s cache: retyping a query you just ran must not spend the budget twice.
  if (t === "repos") return gget("search:repos", { query: q, sort, page }, 60_000);
  if (t === "code") return gget("search:code", { query: q, page }, 60_000);
  return gget("search:users", { query: q, kind: t === "orgs" ? "orgs" : "users", page }, 60_000);
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * An Explore result row.
 *
 * Deliberately NOT `secRow`: that one is a single-line <button>, and these rows
 * need a description line plus real hover-action buttons — which can't nest
 * inside a button. Same visual density, built as a div like the Inbox rows.
 */
function exploreRow(o: {
  lead: HTMLElement;
  title: string;
  titleSuffix?: HTMLElement[];
  sub?: string;
  meta?: HTMLElement[];
  time?: string;
  timeTitle?: string;
  ariaLabel: string;
  onOpen: () => void;
  actions: Array<{ label: string; title: string; run: () => void }>;
  extraClass?: string;
}): HTMLElement {
  const row = el("div", "sec-row list-row explore-row" + (o.extraClass ? ` ${o.extraClass}` : ""));
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", o.ariaLabel);

  const lead = el("span", "sec-row-lead");
  lead.appendChild(o.lead);
  row.appendChild(lead);

  const body = el("div", "explore-row-body");
  const head = el("div", "explore-row-head");
  head.appendChild(span(o.title, "sec-row-title"));
  for (const suffix of o.titleSuffix ?? []) head.appendChild(suffix);
  body.appendChild(head);
  if (o.sub) {
    const sub = el("div", "explore-desc");
    sub.textContent = o.sub;
    sub.title = o.sub;
    body.appendChild(sub);
  }
  row.appendChild(body);

  if (o.meta?.length) {
    const meta = el("span", "sec-row-meta");
    meta.append(...o.meta);
    row.appendChild(meta);
  }
  if (o.time) {
    const t = el("span", "sec-row-time");
    t.textContent = o.time;
    if (o.timeTitle) t.title = o.timeTitle;
    row.appendChild(t);
  }
  row.appendChild(rowActions(o.actions));

  row.addEventListener("click", o.onOpen);
  row.addEventListener("keydown", (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      o.onOpen();
    }
  });
  return row;
}

function repoRow(r: SearchRepoItem, nav: SectionNav): HTMLElement {
  const meta: HTMLElement[] = [];
  if (r.language) meta.push(span(r.language, "explore-lang"));
  // Formatted: the footer on the same screen writes "1,284 matches" while the
  // rows printed "48200".
  if (r.stars > 0) meta.push(statBit("star-full", r.stars));
  if (r.forks > 0) meta.push(statBit("repo-forked", r.forks));

  return exploreRow({
    lead: glyph(r.private ? "lock" : r.fork ? "repo-forked" : "repo"),
    title: r.fullName,
    titleSuffix: [
      ...(r.archived ? [pill("archived")] : []),
      ...(r.license ? [pill(r.license)] : []),
    ],
    sub: r.description ?? undefined,
    meta,
    time: relTimeISO(r.pushedAt || r.updatedAt),
    timeTitle: r.pushedAt ? `Last pushed ${r.pushedAt}` : undefined,
    ariaLabel: `Repository ${r.fullName}`,
    // E4 turns this into the full in-app repository page.
    onOpen: () => nav("explore", { id: `repo/${r.fullName}` }),
    actions: [
      { label: "Open", title: `Clone ${r.fullName} if needed, then open it`, run: () => openGhRepoInApp(r.fullName) },
      {
        label: "Choose location…",
        title: "Pick the folder it's cloned into",
        run: () => openGhRepoChooseLocation(r.fullName),
      },
      {
        label: "Clone…",
        title: "Open the clone dialog for this repository",
        run: () =>
          openCloneDialog((root) => void host.invoke("repo:openPath", root), {
            url: `https://github.com/${r.fullName}.git`,
          }),
      },
      { label: "GitHub", title: "Open on github.com", run: () => window.open(r.htmlUrl, "_blank", "noopener") },
    ],
  });
}

function userRow(u: SearchUserItem, nav: SectionNav): HTMLElement {
  const isOrg = u.type === "Organization";
  // A 40px row with a small avatar in a 1350px pane read as ~93% empty. The
  // answer is a DENSER row, not filler: the search API gives a login, an
  // avatar and a type, and a sub-line repeating "Person on GitHub" on every
  // row would be the same word thirty times. Bigger avatar, tighter row.
  return exploreRow({
    lead: avatar(u.login, u.avatarUrl, 28),
    title: u.login,
    titleSuffix: isOrg ? [pill("org")] : [],
    extraClass: "explore-person-row",
    ariaLabel: `${isOrg ? "Organization" : "User"} ${u.login}`,
    onOpen: () => nav("explore", { id: `${isOrg ? "org" : "user"}/${u.login}` }),
    actions: [
      {
        label: "Profile",
        title: `A quick look at @${u.login}`,
        run: () => openPeek(memberCard({ login: u.login, avatarUrl: u.avatarUrl, htmlUrl: u.htmlUrl })),
      },
      { label: "GitHub", title: "Open on github.com", run: () => window.open(u.htmlUrl, "_blank", "noopener") },
    ],
  });
}

function codeRow(c: SearchCodeItem, nav: SectionNav): HTMLElement {
  const row = exploreRow({
    lead: glyph("file-code"),
    title: c.path,
    ariaLabel: `${c.path} in ${c.repoFullName}`,
    sub: c.repoFullName,
    // Open the FILE you found, not the repository it happens to live in. This
    // navigated to `repo/<fullName>` and threw `c.path` away — so a code search,
    // whose entire purpose is finding one file among thousands, answered a click
    // by dumping you at the repo root with the result gone from the screen.
    onOpen: () =>
      nav("explore", {
        id: repoRouteId({ fullName: c.repoFullName, path: c.path, kind: "blob" }),
      }),
    extraClass: "explore-code-row",
    actions: [
      {
        label: "GitHub",
        title: "Open this file on github.com",
        run: () => window.open(c.htmlUrl, "_blank", "noopener"),
      },
    ],
  });
  const body = row.querySelector(".explore-row-body");
  // ONE code block, not one box per matched line. Three separate bordered
  // <pre>s stitched by :has() sibling rules still read as three boxes (the
  // row body's gap sat between them), so a single hit looked like three hits.
  // Non-adjacent fragments are separated the way a diff separates hunks.
  const frags = c.fragments.slice(0, 3);
  if (frags.length && body) {
    const pre = el("pre", "explore-code-frag");
    frags.forEach((f, i) => {
      if (i > 0) pre.appendChild(span("⋯", "explore-code-gap"));
      pre.appendChild(span(f, "explore-code-line"));
    });
    body.appendChild(pre);
  }
  return row;
}

// ── small builders ───────────────────────────────────────────────────────────

function pill(text: string): HTMLElement {
  return span(text, "gh-pill explore-pill");
}

function statBit(icon: string, n: number): HTMLElement {
  const s = span("", "explore-stat");
  s.append(glyph(icon), span(n.toLocaleString()));
  return s;
}

function rowActions(actions: Array<{ label: string; title: string; run: () => void }>): HTMLElement {
  const acts = el("div", "row-actions");
  for (const a of actions) {
    const b = el("button", "row-btn");
    b.textContent = a.label;
    b.title = a.title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      a.run();
    });
    acts.appendChild(b);
  }
  return acts;
}

function startState(): HTMLElement {
  // The header subtitle already makes the pitch; this says what to DO.
  return emptyState("Start typing to search", "Try a name, an owner, or a qualifier like stars:>1000.", {
    icon: "telescope",
  });
}

function loadingMore(): HTMLElement {
  const d = el("div", "explore-loading-more");
  d.append(glyph("sync"), span("Loading more…"));
  return d;
}

/** The rate-limit state: a real countdown, not a dead error. */
function limitedState(retryInMs: number, retry: () => void): HTMLElement {
  const secs = Math.max(1, Math.ceil(retryInMs / 1000));
  const wrap = emptyState(
    "Search is catching its breath",
    `GitHub allows a limited number of searches per minute. Trying again in ${secs}s.`,
    { icon: "watch" },
  );
  const btn = el("button", "btn btn-soft list-empty-action");
  btn.append(glyph("sync"), span(`Retry now`));
  btn.addEventListener("click", retry);
  wrap.appendChild(btn);
  // Retry itself when the window opens — the user shouldn't have to babysit it.
  window.setTimeout(() => {
    if (wrap.isConnected) retry();
  }, retryInMs);
  return wrap;
}

/** The end-of-results line: honest about totals, the ceiling, and partials. */
function footer(result: SearchPage<unknown>, more: () => void): HTMLElement {
  const f = el("div", "explore-footer");
  const bits: string[] = [];
  const total = result.totalCount;
  bits.push(`${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`);
  if (total > 1000) bits.push("GitHub serves the first 1,000");
  if (result.incomplete) bits.push("GitHub timed out and returned partial results");
  const note = el("div", "explore-footer-note");
  note.append(glyph("info"), span(bits.join(" · ")));
  f.appendChild(note);
  if (result.hasMore) {
    const btn = el("button", "btn btn-soft explore-more");
    btn.append(glyph("chevron-down"), span("Load more"));
    btn.addEventListener("click", () => {
      btn.setAttribute("disabled", "true");
      more();
    });
    f.appendChild(btn);
  }
  return f;
}

/** Toast helper kept for future entity pages (E4) — exported so the module's
 *  error path stays consistent with the rest of the app. */
export function exploreError(e: unknown): void {
  toast(cleanErr(e) || "GitHub request failed.", "error");
}
