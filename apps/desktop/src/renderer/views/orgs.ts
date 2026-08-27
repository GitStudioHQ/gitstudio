// The Organizations section view. Pick an org from a searchable dropdown (with
// avatars) in the title bar, and its detail pane — Repositories / Teams /
// Members sub-tabs, each lazy-loaded on demand — fills the whole pane below.
// No left list pane, so the detail gets the full width.
//
// Every row is browsable IN-APP: a repo opens a peek (full record + Clone…
// straight into the app), a team opens a peek listing its members (drillable to
// their profiles), a member opens their profile peek. "Open on GitHub" stays
// available on each peek as a deliberate action — a plain click never leaves
// the app any more. Still read-only toward GitHub (no create/update/delete).
//
// Orgs are USER-scoped, not repo-scoped, so this view gates on the token only
// (ghGate with needsRepo=false) — it works even when the open repo's origin is
// not on github.com.

import { host } from "../bridge";
import {
  avatar,
  cleanErr,
  copyText,
  el,
  emptyState,
  errorState,
  glyph,
  loadingState,
  openMenu,
  relTimeISO,
  absTimeISO,
  span,
  textBtn,
  type MenuItem,
} from "../ui";
import {
  openPeek,
  peekChip,
  peekMetaGrid,
  peekSection,
  type PeekCard,
} from "../peek";
import { openCloneDialog } from "../cloneDialog";
import { repoDirCard } from "../repoBrowser";
import { openGhRepoInApp, openGhRepoChooseLocation } from "../ghOpen";
import { peek as cachePeek, gget, bust } from "../cache";
import {
  ghGate,
  ghHeader,
  headerPicker,
  searchField,
  wireListNav,
  type SectionNav,
  type SectionRender,
} from "./common";
import type { GhUserInfo, OrgInfo, OrgMember, OrgRepo, OrgRepoDetail, OrgTeam } from "../../shared/ipc";

// ── In-session state (in-memory only, like prSubTab — not persisted) ──────────

/** The org whose detail pane is open, restored on re-entry so it isn't empty. */
let selectedOrg: string | undefined;
/** The active detail sub-tab; persists across orgs within a session. */
let orgSubTab: SubTabId = "repos";
/** The live filter over the active sub-tab (a big org has hundreds of repos). */
let query = "";
/** Re-renders the active sub-tab — the search field's hook into the detail. */
let rerenderActiveTab: (() => void) | null = null;

/**
 * A monotonically increasing token. Every full render bumps it; in-flight async
 * work captures the value and bails if a newer render (a refresh or a view
 * switch) has superseded it — the section-module analogue of App.routeGen.
 */
let renderGen = 0;

type SubTabId = "repos" | "teams" | "members";

// ── Avatars ───────────────────────────────────────────────────────────────────

/**
 * A round avatar <img> (org / user) that falls back to the `organization`
 * codicon when the URL is missing or fails to load — so a null avatar or a
 * CSP-blocked image never leaves a broken-image glyph in the UI.
 */
/** The ORGANIZATION's own avatar. People use {@link avatar} instead — its
 *  fallback is initials, where this one's is the three-person org glyph, which
 *  on a member row said "this person is an organization". */
function orgAvatar(url: string | null, alt: string, size = 18): HTMLElement {
  if (!url) {
    const g = glyph("organization");
    g.classList.add("gh-avatar-fallback");
    return g;
  }
  const img = document.createElement("img");
  img.className = "gh-avatar";
  img.src = url;
  img.alt = alt;
  img.width = size;
  img.height = size;
  img.loading = "lazy";
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;
  img.addEventListener("error", () => {
    const g = glyph("organization");
    g.classList.add("gh-avatar-fallback");
    img.replaceWith(g);
  });
  return img;
}

// ── The section entry point ───────────────────────────────────────────────────

/** The routed nav, kept module-level so deep hover actions (Browse → the full
 *  Explore repository page) can reach it without threading it through every
 *  row builder. */
let sectionNav: SectionNav | undefined;

export const renderOrgs: SectionRender = (wrap, nav) => {
  sectionNav = nav;
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const refresh = (): void => {
    bust("orgs");
    renderOrgs(wrap, nav);
  };

  // Gate first — orgs are user-scoped, so needsRepo stays false (works even when
  // the open repo isn't on github.com). On no token → ghGate renders the prompt.
  const gate = await ghGate(wrap, nav, false, refresh);
  if (!gate) return;

  const gen = ++renderGen;

  const header = ghHeader("Organizations", gate.login, refresh);
  const view = el("div", "gh-view");
  view.appendChild(header);
  // The live filter over whichever sub-tab is showing (repos / teams / members).
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      // Was "Filter repos, teams, members…" — clipped to "Filter repos, teams, mer".
      placeholder: "Filter this organization…",
      initial: query,
      onInput: (q) => {
        query = q;
        rerenderActiveTab?.();
      },
    }),
  );
  // One full-width pane: the selected org's detail (head + sub-tabs) lives here.
  const detail = el("div", "gh-detail gh-solo");
  view.appendChild(detail);
  wrap.replaceChildren(view);

  let orgs: OrgInfo[] | undefined = cachePeek("orgs:list", undefined);
  if (!orgs) detail.replaceChildren(loadingState());
  try {
    orgs = await gget("orgs:list", undefined, 60000);
  } catch (e) {
    if (gen !== renderGen) return;
    if (!orgs) {
      detail.replaceChildren(
        errorState("Couldn't load organizations", cleanErr(e) || "GitHub request failed.", refresh),
      );
      return;
    }
  }
  if (gen !== renderGen || !orgs) return;

  header.setCount?.(orgs.length);
  if (orgs.length === 0) {
    detail.replaceChildren(
      emptyState("No organizations", "You're not a member of any GitHub organizations.", {
        icon: "organization",
      }),
    );
    return;
  }

  const select = (org: OrgInfo): void => {
    selectedOrg = org.login;
    picker.set(orgAvatar(org.avatarUrl, org.login, 20), org.name || org.login);
    showOrgDetail(detail, org, gen);
  };

  // The bar-level picker: a searchable dropdown of every org (with avatars).
  // Choosing one fills its detail full-width below.
  const picker = headerPicker({
    onOpen: (anchor) => {
      const items: MenuItem[] = orgs.map((o) => ({
        label: o.name || o.login,
        sub: `@${o.login}`,
        iconEl: avatar(o.login, o.avatarUrl, 18),
        current: o.login === selectedOrg,
        onClick: () => select(o),
      }));
      openMenu(anchor, items, { searchable: true });
    },
  });
  header.querySelector(".gh-head-titlewrap")?.appendChild(picker.el);

  // Auto-select the previously chosen org (or the first) so the detail pane is
  // never empty on entry — selectedOrg persists in-memory across re-renders.
  const initial = (selectedOrg && orgs.find((o) => o.login === selectedOrg)) || orgs[0];
  select(initial);
}

// ── Detail pane (header + Repos/Teams/Members sub-tabs) ───────────────────────

function showOrgDetail(detail: HTMLElement, org: OrgInfo, gen: number): void {
  detail.replaceChildren();

  // Identity first, then what it is, then what you can do with it. The old
  // order was name → @login → buttons → a full-width rule → description, so
  // the description was separated from the thing it described by the actions
  // and a divider, and "Copy login" — a trivial action — led the page.
  const head = el("div", "gh-detail-head gh-org-head");
  const identity = el("div", "gh-org-identity");
  identity.appendChild(orgAvatar(org.avatarUrl, org.login, 44));
  const names = el("div", "gh-org-names");
  const titleRow = el("div", "gh-detail-title gh-org-title");
  titleRow.append(span(org.name || org.login, ""));
  const meta = el("div", "gh-detail-meta");
  meta.textContent = `@${org.login}`;
  names.append(titleRow, meta);
  if (org.description) {
    const d = el("div", "gh-org-desc");
    d.textContent = org.description;
    names.appendChild(d);
  }
  identity.appendChild(names);

  const actions = el("div", "gh-detail-actions");
  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("GitHub"));
  openBtn.title = "Open this organization on GitHub";
  openBtn.addEventListener("click", () => window.open(org.htmlUrl, "_blank"));
  const copyBtn = el("button", "mini-btn gh-icon-btn");
  copyBtn.append(glyph("copy"));
  copyBtn.title = `Copy @${org.login}`;
  copyBtn.setAttribute("aria-label", copyBtn.title);
  copyBtn.addEventListener("click", () => void copyText(org.login, "Org login copied."));
  actions.append(openBtn, copyBtn);

  head.append(identity, actions);
  detail.appendChild(head);

  // Sub-tabs: Repositories · Teams · Members. The content is a responsive card
  // grid so it fills the full-width pane instead of a narrow column of rows.
  const subBar = el("div", "gh-subtabs");
  const content = el("div", "gh-subcontent gh-org-grid");
  wireListNav(content, ".list-row");
  const subDefs: ReadonlyArray<{ id: SubTabId; label: string; icon: string }> = [
    { id: "repos", label: "Repositories", icon: "repo" },
    { id: "teams", label: "Teams", icon: "organization" },
    { id: "members", label: "Members", icon: "organization" },
  ];
  const subBtns: HTMLElement[] = [];
  const selectSub = (id: SubTabId): void => {
    orgSubTab = id;
    for (const b of subBtns) b.classList.toggle("active", b.dataset.sub === id);
    void renderSubTab(content, org.login, id, gen);
  };
  // Hook the header search into whichever tab is active right now.
  rerenderActiveTab = () => selectSub(orgSubTab);
  for (const t of subDefs) {
    const b = el("button", "gh-subtab");
    b.dataset.sub = t.id;
    b.append(glyph(t.icon), span(t.label));
    b.addEventListener("click", () => selectSub(t.id));
    subBtns.push(b);
    subBar.appendChild(b);
  }
  detail.append(subBar, content);
  selectSub(orgSubTab);
}

/**
 * Stale when a newer render superseded us OR the user switched to a different
 * org — so a fast re-select never paints the previous org's rows.
 */
function isStale(org: string, gen: number): boolean {
  return gen !== renderGen || selectedOrg !== org;
}

async function renderSubTab(
  content: HTMLElement,
  org: string,
  id: SubTabId,
  gen: number,
): Promise<void> {
  const retry = (): void => void renderSubTab(content, org, id, gen);
  // Each sub-tab holds a different DENSITY of card, and one grid track size
  // suited none of them: a lone team card sat in a 330px column with 1200px of
  // dead space beside it, and a member card — a 20px avatar and a login — was
  // 90% empty at the same width. The tab tells the grid what it is holding.
  content.classList.toggle("is-people", id === "members");
  const q = query.trim().toLowerCase();
  const noMatches = (): HTMLElement =>
    emptyState("No matches", `Nothing matches “${query.trim()}”.`, { icon: "search" });

  if (id === "repos") {
    let repos: OrgRepo[] | undefined = cachePeek("orgs:repos", org);
    if (!repos) content.replaceChildren(loadingState());
    try {
      repos = await gget("orgs:repos", org, 60000);
    } catch (e) {
      if (isStale(org, gen)) return;
      if (!repos) {
        content.replaceChildren(
          errorState("Couldn't load repositories", cleanErr(e) || "GitHub request failed.", retry),
        );
        return;
      }
    }
    if (isStale(org, gen) || !repos) return;
    content.replaceChildren();
    if (repos.length === 0) {
      content.appendChild(
        emptyState("No repositories", "This organization has no repositories you can see."),
      );
      return;
    }
    const shown = q
      ? repos.filter((r) =>
          `${r.name} ${r.description ?? ""} ${r.language ?? ""}`.toLowerCase().includes(q),
        )
      : repos;
    if (shown.length === 0) {
      content.appendChild(noMatches());
      return;
    }
    for (const r of shown) renderRepoRow(content, r);
    return;
  }

  if (id === "teams") {
    let teams: OrgTeam[] | undefined = cachePeek("orgs:teams", org);
    if (!teams) content.replaceChildren(loadingState());
    try {
      teams = await gget("orgs:teams", org, 60000);
    } catch (e) {
      if (isStale(org, gen)) return;
      if (!teams) {
        content.replaceChildren(
          errorState("Couldn't load teams", cleanErr(e) || "GitHub request failed.", retry),
        );
        return;
      }
    }
    if (isStale(org, gen) || !teams) return;
    content.replaceChildren();
    if (teams.length === 0) {
      content.appendChild(
        emptyState("No teams", "This organization has no teams visible to you."),
      );
      return;
    }
    const shown = q
      ? teams.filter((t) => `${t.name} ${t.slug} ${t.description ?? ""}`.toLowerCase().includes(q))
      : teams;
    if (shown.length === 0) {
      content.appendChild(noMatches());
      return;
    }
    for (const t of shown) renderTeamRow(content, org, t);
    return;
  }

  // members
  let members: OrgMember[] | undefined = cachePeek("orgs:members", org);
  if (!members) content.replaceChildren(loadingState());
  try {
    members = await gget("orgs:members", org, 60000);
  } catch (e) {
    if (isStale(org, gen)) return;
    if (!members) {
      content.replaceChildren(
        errorState("Couldn't load members", cleanErr(e) || "GitHub request failed.", retry),
      );
      return;
    }
  }
  if (isStale(org, gen) || !members) return;
  content.replaceChildren();
  if (members.length === 0) {
    content.appendChild(
      emptyState("No members", "No public members are visible for this organization."),
    );
    return;
  }
  const shown = q ? members.filter((u) => u.login.toLowerCase().includes(q)) : members;
  if (shown.length === 0) {
    content.appendChild(noMatches());
    return;
  }
  for (const u of shown) renderMemberRow(content, u);
}

// ── Row builders ──────────────────────────────────────────────────────────────

function renderRepoRow(content: HTMLElement, r: OrgRepo): void {
  // CLICK = OPEN. An org repo IS a repo — one click puts you inside it (Code,
  // Commits, Branches, PRs, everything), cloning itself into ~/GitStudio
  // first if needed. No interstitial card in the way: the info peek and the
  // no-clone browser are hover actions for when you want them.
  const row = el("div", "list-row gh-org-repo is-clickable");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Open ${r.fullName} in GitStudio`);
  row.appendChild(glyph(r.fork ? "repo-forked" : "repo"));
  const m = el("div", "row-meta");
  const t = el("div", "row-meta-title");
  t.textContent = r.name;
  const sub = el("div", "row-meta-sub");
  const bits = [r.private ? "private" : "public"];
  if (r.language) bits.push(r.language);
  if (r.stargazersCount) bits.push(`★ ${r.stargazersCount.toLocaleString()}`);
  if (r.archived) bits.push("archived");
  const when = relTimeISO(r.pushedAt);
  if (when) bits.push(`updated ${when}`);
  sub.textContent = bits.join(" · ");
  if (r.pushedAt) sub.title = `Last pushed ${absTimeISO(r.pushedAt)}`;
  m.append(t, sub);
  row.appendChild(m);
  row.title = r.description
    ? `${r.description}\n\nClick to open in GitStudio`
    : `Click to open ${r.fullName} in GitStudio`;
  row.addEventListener("click", () => openGhRepoInApp(r.fullName));
  row.addEventListener("keydown", (e) => {
    // Only the ROW itself: Enter on a nested hover button (Details/Browse)
    // must activate THAT button, not silently start a clone.
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openGhRepoInApp(r.fullName);
    }
  });
  const actions = el("div", "row-actions");
  actions.append(
    textBtn("Details", `About ${r.name} — stars, license, activity`, () => openRepoPeek(r)),
    // The full page, not the peek: browsing a repo you might adopt deserves
    // breadcrumbs, a ref switcher and go-to-file. "Details" keeps the glance.
    textBtn("Browse", `Read ${r.name}'s files and README without opening it`, () =>
      sectionNav
        ? sectionNav("explore", { id: `repo/${r.fullName}` })
        : openPeek(repoDirCard(r.fullName, "")),
    ),
  );
  row.appendChild(actions);
  content.appendChild(row);
}

function renderTeamRow(content: HTMLElement, org: string, t: OrgTeam): void {
  const row = el("button", "list-row gh-org-team");
  row.appendChild(glyph(t.privacy === "secret" ? "lock" : "organization"));
  const m = el("div", "row-meta");
  const ttl = el("div", "row-meta-title");
  ttl.textContent = t.name;
  const sub = el("div", "row-meta-sub");
  sub.textContent = t.description || `@${t.slug}${t.privacy ? " · " + t.privacy : ""}`;
  m.append(ttl, sub);
  row.appendChild(m);
  row.setAttribute("aria-haspopup", "dialog");
  row.addEventListener("click", () => openTeamPeek(org, t));
  content.appendChild(row);
}

function renderMemberRow(content: HTMLElement, u: OrgMember): void {
  const row = el("button", "list-row gh-org-member");
  row.appendChild(avatar(u.login, u.avatarUrl, 20, "Member"));
  const m = el("div", "row-meta");
  const t = el("div", "row-meta-title");
  t.textContent = u.login;
  m.appendChild(t);
  row.appendChild(m);
  row.setAttribute("aria-haspopup", "dialog");
  row.addEventListener("click", () => openPeek(memberCard(u)));
  content.appendChild(row);
}

// ── Peeks: the in-app drill-ins behind every row ──────────────────────────────

/** A homepage/website value rendered as a real link, not inert text. */
function extLink(url: string): HTMLElement {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const a = document.createElement("a");
  a.href = href;
  a.textContent = url;
  a.className = "peek-ext-link";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    window.open(href, "_blank");
  });
  return a;
}

/** The repo peek: the full record, with Clone… as the primary action — the org
 *  browser stops being a launcher for github.com and becomes a way IN. */
function openRepoPeek(r: OrgRepo): void {
  const chips = [peekChip(r.private ? "private" : "public", r.private ? "warn" : "muted")];
  if (r.fork) chips.push(peekChip("fork", "muted"));
  if (r.archived) chips.push(peekChip("archived", "warn"));
  openPeek({
    icon: r.fork ? "repo-forked" : "repo",
    title: r.name,
    chips,
    subtitle: r.fullName,
    actions: [
      {
        label: "Open on GitHub",
        icon: "link-external",
        onClick: () => window.open(r.htmlUrl, "_blank"),
      },
      {
        label: "Clone…",
        icon: "repo-clone",
        title: "Clone this repository and open it in GitStudio",
        onClick: (ctx) => {
          ctx.close();
          openCloneDialog((root) => void host.invoke("repo:openPath", root), {
            url: `${r.htmlUrl}.git`,
          });
        },
      },
      {
        // Browsing beats bouncing: read the code + README right here, no
        // clone, no github.com.
        label: "Browse files",
        icon: "folder-opened",
        onClick: (ctx) => ctx.push(repoDirCard(r.fullName, "")),
      },
      {
        label: "Choose location…",
        icon: "folder-opened",
        title: `Pick the folder ${r.fullName} is cloned into, then open it`,
        onClick: () => openGhRepoChooseLocation(r.fullName),
      },
      {
        // THE action: open this like any local repo — Code, Commits,
        // Branches, PRs, everything. Reuses an existing clone or makes one
        // in the configured clone folder, no questions asked.
        label: "Open",
        icon: "folder-library",
        primary: true,
        title: `Open ${r.fullName} in GitStudio as a full repo`,
        onClick: () => openGhRepoInApp(r.fullName),
      },
    ],
    async render(body) {
      const d: OrgRepoDetail = await host.invoke("orgs:repoDetail", r.fullName);
      body.replaceChildren();
      if (d.description) {
        const p = el("p", "peek-desc");
        p.textContent = d.description;
        body.appendChild(p);
      }
      const meta: Array<[string, string | HTMLElement]> = [
        ["Language", d.language ?? ""],
        // Real zeros — hiding "0 stars" made new repos look broken, not new.
        ["Stars", d.stargazersCount.toLocaleString()],
        ["Forks", d.forksCount.toLocaleString()],
        ["Open issues", d.openIssuesCount.toLocaleString()],
        ["Default branch", d.defaultBranch],
        ["License", d.license ?? ""],
        ["Last pushed", d.pushedAt ? relTimeISO(d.pushedAt) : ""],
        ["Created", d.createdAt ? relTimeISO(d.createdAt) : ""],
        ["Homepage", d.homepage ? extLink(d.homepage) : ""],
      ];
      body.appendChild(peekMetaGrid(meta));
      if (d.topics.length) {
        const topics = el("div", "peek-topics");
        for (const topic of d.topics) topics.appendChild(peekChip(topic, "accent"));
        body.appendChild(topics);
      }
    },
  });
}

/** The team peek: description + the member list, each member drillable. */
function openTeamPeek(org: string, t: OrgTeam): void {
  openPeek({
    icon: t.privacy === "secret" ? "lock" : "organization",
    title: t.name,
    chips: t.privacy ? [peekChip(t.privacy, "muted")] : [],
    subtitle: `@${org}/${t.slug}`,
    actions: t.htmlUrl
      ? [
          {
            label: "Open on GitHub",
            icon: "link-external",
            onClick: () => window.open(t.htmlUrl, "_blank"),
          },
        ]
      : [],
    async render(body, ctx) {
      const members = await host.invoke("orgs:teamMembers", { org, slug: t.slug });
      body.replaceChildren();
      if (t.description) {
        const p = el("p", "peek-desc");
        p.textContent = t.description;
        body.appendChild(p);
      }
      const { root, body: mbody } = peekSection("Members", members.length);
      for (const m of members) {
        const row = el("button", "peek-row");
        row.appendChild(avatar(m.login, m.avatarUrl, 22, "Member"));
        const main = el("div", "peek-row-main");
        const title = el("div", "peek-row-title");
        title.textContent = m.login;
        main.appendChild(title);
        row.appendChild(main);
        const side = el("div", "peek-row-side");
        const chev = glyph("chevron-right");
        chev.classList.add("peek-row-chev");
        side.appendChild(chev);
        row.appendChild(side);
        row.addEventListener("click", () => ctx.push(memberCard(m)));
        mbody.appendChild(row);
      }
      if (!members.length) {
        const none = el("div", "peek-row");
        none.appendChild(span("No members visible to you.", "peek-row-sub"));
        mbody.appendChild(none);
      }
      body.appendChild(root);
    },
  });
}

/** The member/profile card — openable directly or pushed from a team peek. */
export function memberCard(u: OrgMember): PeekCard {
  return {
    icon: "account",
    iconEl: u.avatarUrl ? avatar(u.login, u.avatarUrl, 22) : undefined,
    title: u.login,
    subtitle: "GitHub profile",
    actions: [
      {
        label: "Copy login",
        icon: "copy",
        onClick: () => void copyText(u.login, "Login copied."),
      },
      // The peek is a glance; the full page is where their repositories are.
      // Every person chip in the app opens this peek, so this one action makes
      // every author, assignee and reviewer a doorway into Explore.
      {
        label: "View full profile",
        icon: "person",
        primary: true,
        title: `Open @${u.login}'s profile page in Explore`,
        onClick: (ctx) => {
          ctx.close();
          sectionNav?.("explore", { id: `user/${u.login}` });
        },
      },
      {
        label: "Open on GitHub",
        icon: "link-external",
        onClick: () => window.open(u.htmlUrl, "_blank"),
      },
    ],
    async render(body, ctx) {
      const info: GhUserInfo = await host.invoke("github:userInfo", u.login);
      body.replaceChildren();
      ctx.retitle(info.name || info.login, `@${info.login}`);
      if (info.bio) {
        const p = el("p", "peek-desc");
        p.textContent = info.bio;
        body.appendChild(p);
      }
      body.appendChild(
        peekMetaGrid([
          ["Company", info.company ?? ""],
          ["Location", info.location ?? ""],
          ["Website", info.blog ? extLink(info.blog) : ""],
          ["Followers", typeof info.followers === "number" ? info.followers.toLocaleString() : ""],
          ["Public repos", typeof info.publicRepos === "number" ? info.publicRepos.toLocaleString() : ""],
          ["Joined", info.createdAt ? relTimeISO(info.createdAt) : ""],
        ]),
      );
    },
  };
}
