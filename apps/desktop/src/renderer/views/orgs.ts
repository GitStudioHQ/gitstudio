// The Organizations section view (read-only). A two-pane gh-view: the org list
// on the left, and on the right an org detail pane with Repositories / Teams /
// Members sub-tabs, each lazy-loaded on demand. Modeled on the PR & Issue views
// so the whole GitHub surface feels like one product.
//
// Read-only by design (the "Mostly read v1" bar): the only interactions are
// open-on-GitHub (window.open) and copy-to-clipboard. There is no create/update/
// delete, so no confirms or mutation toasts beyond the copy feedback.
//
// Orgs are USER-scoped, not repo-scoped, so this view gates on the token only
// (ghGate with needsRepo=false) — it works even when the open repo's origin is
// not on github.com.

import { host } from "../bridge";
import {
  cleanErr,
  copyText,
  el,
  emptyState,
  errorState,
  glyph,
  loadingState,
  relTimeISO,
  span,
} from "../ui";
import { ghGate, ghHeader, type SectionRender } from "./common";
import type { OrgInfo, OrgMember, OrgRepo, OrgTeam } from "../../shared/ipc";

// ── In-session state (in-memory only, like prSubTab — not persisted) ──────────

/** The org whose detail pane is open, restored on re-entry so it isn't empty. */
let selectedOrg: string | undefined;
/** The active detail sub-tab; persists across orgs within a session. */
let orgSubTab: SubTabId = "repos";

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

export const renderOrgs: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const refresh = (): void => renderOrgs(wrap, nav);

  // Gate first — orgs are user-scoped, so needsRepo stays false (works even when
  // the open repo isn't on github.com). On no token → ghGate renders the prompt.
  const gate = await ghGate(wrap, nav, false);
  if (!gate) return;

  const gen = ++renderGen;

  const view = el("div", "gh-view");
  view.appendChild(ghHeader("Organizations", gate.login, refresh));
  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, detail);
  view.appendChild(body);
  wrap.replaceChildren(view);
  detail.replaceChildren(
    emptyState(
      "Select an organization",
      "Pick an org to see its repositories, teams, and members.",
    ),
  );

  listEl.replaceChildren(loadingState());
  let orgs: OrgInfo[];
  try {
    orgs = await host.invoke("orgs:list", undefined);
  } catch (e) {
    if (gen !== renderGen) return;
    listEl.replaceChildren(
      errorState("Couldn't load organizations", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }
  if (gen !== renderGen) return;

  listEl.replaceChildren();
  if (orgs.length === 0) {
    listEl.appendChild(
      emptyState("No organizations", "You're not a member of any GitHub organizations."),
    );
    return;
  }

  const rowFor = new Map<string, HTMLElement>();
  for (const org of orgs) {
    const row = el("button", "gh-row gh-org-row");
    const top = el("div", "gh-row-title");
    top.append(orgAvatar(org.avatarUrl, org.login), span(org.name || org.login, "gh-org-name"));
    const sub = el("div", "gh-row-sub");
    sub.textContent = org.description || `@${org.login}`;
    row.append(top, sub);
    row.addEventListener("click", () => {
      for (const n of listEl.querySelectorAll(".gh-row.active")) n.classList.remove("active");
      row.classList.add("active");
      selectedOrg = org.login;
      showOrgDetail(detail, org, gen);
    });
    rowFor.set(org.login, row);
    listEl.appendChild(row);
  }

  // Auto-select the previously chosen org (or the first) so the detail pane is
  // never empty on entry — selectedOrg persists in-memory across re-renders.
  const initial =
    (selectedOrg && orgs.find((o) => o.login === selectedOrg)) || orgs[0];
  if (initial) {
    rowFor.get(initial.login)?.classList.add("active");
    selectedOrg = initial.login;
    showOrgDetail(detail, initial, gen);
  }
}

// ── Detail pane (header + Repos/Teams/Members sub-tabs) ───────────────────────

function showOrgDetail(detail: HTMLElement, org: OrgInfo, gen: number): void {
  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const titleRow = el("div", "gh-detail-title gh-org-title");
  titleRow.append(orgAvatar(org.avatarUrl, org.login, 28), span(org.name || org.login, ""));
  const meta = el("div", "gh-detail-meta");
  meta.textContent = `@${org.login}`;

  const actions = el("div", "gh-detail-actions");
  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.addEventListener("click", () => window.open(org.htmlUrl, "_blank"));
  const copyBtn = el("button", "mini-btn");
  copyBtn.append(glyph("copy"), span("Copy login"));
  copyBtn.addEventListener("click", () => void copyText(org.login, "Org login copied."));
  actions.append(openBtn, copyBtn);

  head.append(titleRow, meta, actions);
  detail.appendChild(head);

  if (org.description) {
    const d = el("div", "gh-body-md");
    d.textContent = org.description;
    detail.appendChild(d);
  }

  // Sub-tabs: Repositories · Teams · Members.
  const subBar = el("div", "gh-subtabs");
  const content = el("div", "gh-subcontent");
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
  content.replaceChildren(loadingState());
  const retry = (): void => void renderSubTab(content, org, id, gen);

  if (id === "repos") {
    let repos: OrgRepo[];
    try {
      repos = await host.invoke("orgs:repos", org);
    } catch (e) {
      if (isStale(org, gen)) return;
      content.replaceChildren(
        errorState("Couldn't load repositories", cleanErr(e) || "GitHub request failed.", retry),
      );
      return;
    }
    if (isStale(org, gen)) return;
    content.replaceChildren();
    if (repos.length === 0) {
      content.appendChild(
        emptyState("No repositories", "This organization has no repositories you can see."),
      );
      return;
    }
    for (const r of repos) renderRepoRow(content, r);
    return;
  }

  if (id === "teams") {
    let teams: OrgTeam[];
    try {
      teams = await host.invoke("orgs:teams", org);
    } catch (e) {
      if (isStale(org, gen)) return;
      content.replaceChildren(
        errorState("Couldn't load teams", cleanErr(e) || "GitHub request failed.", retry),
      );
      return;
    }
    if (isStale(org, gen)) return;
    content.replaceChildren();
    if (teams.length === 0) {
      content.appendChild(
        emptyState("No teams", "This organization has no teams visible to you."),
      );
      return;
    }
    for (const t of teams) renderTeamRow(content, t);
    return;
  }

  // members
  let members: OrgMember[];
  try {
    members = await host.invoke("orgs:members", org);
  } catch (e) {
    if (isStale(org, gen)) return;
    content.replaceChildren(
      errorState("Couldn't load members", cleanErr(e) || "GitHub request failed.", retry),
    );
    return;
  }
  if (isStale(org, gen)) return;
  content.replaceChildren();
  if (members.length === 0) {
    content.appendChild(
      emptyState("No members", "No public members are visible for this organization."),
    );
    return;
  }
  for (const u of members) renderMemberRow(content, u);
}

// ── Row builders ──────────────────────────────────────────────────────────────

function renderRepoRow(content: HTMLElement, r: OrgRepo): void {
  const row = el("button", "list-row gh-org-repo");
  row.appendChild(glyph(r.fork ? "repo-forked" : "repo"));
  const m = el("div", "row-meta");
  const t = el("div", "row-meta-title");
  t.textContent = r.name;
  const sub = el("div", "row-meta-sub");
  const bits = [r.private ? "private" : "public"];
  if (r.language) bits.push(r.language);
  if (r.stargazersCount) bits.push(`★ ${r.stargazersCount}`);
  if (r.archived) bits.push("archived");
  const when = relTimeISO(r.pushedAt);
  if (when) bits.push(`updated ${when}`);
  sub.textContent = bits.join(" · ");
  m.append(t, sub);
  row.appendChild(m);
  if (r.description) row.title = r.description;
  // Clicking a repo opens it on GitHub (read v1 — no local clone yet).
  row.addEventListener("click", () => window.open(r.htmlUrl, "_blank"));
  content.appendChild(row);
}

function renderTeamRow(content: HTMLElement, t: OrgTeam): void {
  const row = el("button", "list-row gh-org-team");
  row.appendChild(glyph(t.privacy === "secret" ? "lock" : "organization"));
  const m = el("div", "row-meta");
  const ttl = el("div", "row-meta-title");
  ttl.textContent = t.name;
  const sub = el("div", "row-meta-sub");
  sub.textContent = t.description || `@${t.slug}${t.privacy ? " · " + t.privacy : ""}`;
  m.append(ttl, sub);
  row.appendChild(m);
  if (t.htmlUrl) row.addEventListener("click", () => window.open(t.htmlUrl, "_blank"));
  content.appendChild(row);
}

function renderMemberRow(content: HTMLElement, u: OrgMember): void {
  const row = el("button", "list-row gh-org-member");
  row.appendChild(orgAvatar(u.avatarUrl, u.login, 20));
  const m = el("div", "row-meta");
  const t = el("div", "row-meta-title");
  t.textContent = u.login;
  m.appendChild(t);
  row.appendChild(m);
  row.addEventListener("click", () => window.open(u.htmlUrl, "_blank"));
  content.appendChild(row);
}
