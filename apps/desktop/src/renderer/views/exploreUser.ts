// An account page in Explore — a person or an organization, as a full page.
//
// GitHub's own profile answers "who is this and what do they work on?"; the
// peek card only ever answered the first half. This page carries the profile
// rail (bio, company, location, links, counts) beside the thing you actually
// came for: their repositories, each one openable HERE — plus the orgs they
// belong to, which is how you discover the next place to look.
//
// Routed as `user/<login>` or `org/<login>`. Both render the same page: GitHub
// returns the same profile shape for either, and `type` tells us which words
// to use.

import { gget } from "../cache";
import {
  avatar,
  cleanErr,
  el,
  emptyState,
  errorState,
  glyph,
  relTimeISO,
  skeletonList,
  span,
} from "../ui";
import { openGhRepoInApp, openGhRepoChooseLocation } from "../ghOpen";
import { repoRouteId } from "../exploreRoutes";
import { detailPage, propSection, searchField, type SectionNav } from "./common";
import type { GhUserInfo, OrgInfo, OrgRepo } from "../../shared/ipc";

export { parseAccountTarget } from "../exploreRoutes";

export function renderAccountPage(
  wrap: HTMLElement,
  nav: SectionNav,
  login: string,
  onBack: () => void,
): void {
  void mount(wrap, nav, login, onBack);
}

async function mount(
  wrap: HTMLElement,
  nav: SectionNav,
  login: string,
  onBack: () => void,
): Promise<void> {
  const ghBtn = el("button", "mini-btn gh-icon-btn");
  ghBtn.appendChild(glyph("link-external"));
  ghBtn.title = `Open @${login} on GitHub`;
  ghBtn.setAttribute("aria-label", ghBtn.title);
  ghBtn.addEventListener("click", () =>
    window.open(`https://github.com/${login}`, "_blank", "noopener"),
  );

  const { view, main, rail } = detailPage({
    backLabel: "Explore",
    crumb: `@${login}`,
    onBack,
    actions: [ghBtn],
  });
  wrap.replaceChildren(view);

  const content = el("div", "explore-repo-content");
  content.appendChild(skeletonList(6));
  main.appendChild(content);

  // ── the profile rail ──
  void (async () => {
    try {
      const u: GhUserInfo = await gget("github:userInfo", login, 300_000);
      if (!rail.isConnected) return;
      renderProfileRail(rail, u, nav);
      const head = el("div", "explore-account-head");
      head.append(avatar(u.login, u.avatarUrl, 44));
      const names = el("div", "explore-account-names");
      const title = el("h1", "explore-account-title");
      title.textContent = u.name || u.login;
      names.appendChild(title);
      if (u.name) names.appendChild(span(`@${u.login}`, "explore-account-login"));
      names.appendChild(
        span(u.type === "Organization" ? "Organization" : "Person", "gh-pill explore-pill"),
      );
      head.appendChild(names);
      main.insertBefore(head, content);
      if (u.bio) {
        const bio = el("p", "explore-account-bio");
        bio.textContent = u.bio;
        main.insertBefore(bio, content);
      }
    } catch {
      /* the profile is context; the repo list below is the point */
    }
  })();

  // ── their repositories ──
  try {
    const repos: OrgRepo[] = await gget("users:repos", login, 120_000);
    if (!content.isConnected) return;
    content.replaceChildren();
    if (!repos.length) {
      content.appendChild(
        emptyState("No public repositories", `@${login} hasn't published any.`, { icon: "repo" }),
      );
      return;
    }

    let filter = "";
    const list = el("div", "explore-tree");
    const paint = (): void => {
      const q = filter.toLowerCase();
      const shown = q
        ? repos.filter((r) => `${r.name} ${r.description ?? ""}`.toLowerCase().includes(q))
        : repos;
      list.replaceChildren();
      if (!shown.length) {
        list.appendChild(span("No repository matches that.", "gotofile-empty"));
        return;
      }
      for (const r of shown) list.appendChild(repoRow(r, nav));
    };
    const head = el("div", "explore-account-repos-head");
    head.append(span(`${repos.length} repositories`, "explore-account-count"));
    head.appendChild(
      searchField({
        placeholder: "Filter repositories…",
        onInput: (q) => {
          filter = q;
          paint();
        },
      }),
    );
    content.append(head, list);
    paint();
  } catch (e) {
    if (!content.isConnected) return;
    content.replaceChildren(
      errorState(
        "Couldn't load repositories",
        cleanErr(e) || "GitHub request failed.",
        () => renderAccountPage(wrap, nav, login, onBack),
      ),
    );
  }
}

function repoRow(r: OrgRepo, nav: SectionNav): HTMLElement {
  const row = el("div", "explore-tree-row explore-account-repo");
  const open = el("button", "explore-account-repo-main");
  open.appendChild(glyph(r.private ? "lock" : r.fork ? "repo-forked" : "repo"));
  const body = el("div", "explore-row-body");
  const head = el("div", "explore-row-head");
  head.appendChild(span(r.name, "sec-row-title"));
  if (r.archived) head.appendChild(span("archived", "gh-pill explore-pill"));
  body.appendChild(head);
  if (r.description) {
    const d = el("div", "explore-desc");
    d.textContent = r.description;
    body.appendChild(d);
  }
  open.appendChild(body);
  open.addEventListener("click", () => nav("explore", { id: repoRouteId({ fullName: r.fullName }) }));
  row.appendChild(open);

  const meta = el("span", "sec-row-meta");
  if (r.language) meta.appendChild(span(r.language, "explore-lang"));
  if (r.stargazersCount > 0) {
    const s = span("", "explore-stat");
    s.append(glyph("star-full"), span(r.stargazersCount.toLocaleString()));
    meta.appendChild(s);
  }
  if (r.pushedAt) meta.appendChild(span(relTimeISO(r.pushedAt), "sec-row-time"));
  row.appendChild(meta);

  const acts = el("div", "row-actions");
  const mk = (label: string, title: string, run: () => void): HTMLElement => {
    const b = el("button", "row-btn");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  };
  acts.append(
    mk("Open", `Clone ${r.fullName} if needed, then open it`, () => openGhRepoInApp(r.fullName)),
    mk("Choose location…", "Pick the folder it's cloned into", () =>
      openGhRepoChooseLocation(r.fullName),
    ),
  );
  row.appendChild(acts);
  return row;
}

function renderProfileRail(rail: HTMLElement, u: GhUserInfo, nav: SectionNav): void {
  rail.replaceChildren();

  const facts = propSection("Profile");
  facts.body.classList.add("det-prop-facts");
  const fact = (k: string, v: string): void => {
    const row = el("div", "det-fact");
    row.append(span(k, "det-fact-k"), span(v, "det-fact-v"));
    facts.body.appendChild(row);
  };
  if (u.company) fact("Company", u.company);
  if (u.location) fact("Location", u.location);
  fact("Repositories", u.publicRepos.toLocaleString());
  fact("Followers", u.followers.toLocaleString());
  if (u.type !== "Organization") fact("Following", u.following.toLocaleString());
  if (u.createdAt) fact("Joined", relTimeISO(u.createdAt));
  rail.appendChild(facts.root);

  const links: Array<[string, string, string]> = [];
  if (u.blog) links.push(["link", u.blog, u.blog.startsWith("http") ? u.blog : `https://${u.blog}`]);
  if (u.twitter) links.push(["twitter", `@${u.twitter}`, `https://twitter.com/${u.twitter}`]);
  if (u.email) links.push(["mail", u.email, `mailto:${u.email}`]);
  if (links.length) {
    const linkProp = propSection("Links");
    for (const [icon, label, href] of links) {
      const b = el("button", "gh-link explore-account-link");
      b.append(glyph(icon), span(label));
      b.title = href;
      b.addEventListener("click", () => window.open(href, "_blank", "noopener"));
      linkProp.body.appendChild(b);
    }
    rail.appendChild(linkProp.root);
  }

  // Orgs load separately — a slow membership call must not hold the profile.
  if (u.type !== "Organization") {
    const orgProp = propSection("Organizations");
    orgProp.body.appendChild(span("…", "det-prop-none"));
    rail.appendChild(orgProp.root);
    void gget("users:orgs", u.login, 300_000)
      .then((orgs: OrgInfo[]) => {
        if (!orgProp.body.isConnected) return;
        orgProp.body.replaceChildren();
        if (!orgs.length) {
          orgProp.body.appendChild(span("None public.", "det-prop-none"));
          return;
        }
        for (const o of orgs) {
          // Same dead chip as the repo page's OWNER: it looked and read like a
          // door and opened onto nothing.
          const chip = el("button", "det-person");
          chip.append(avatar(o.login, o.avatarUrl, 20), span(o.login));
          chip.title = `Explore ${o.login}`;
          chip.setAttribute("aria-label", chip.title);
          chip.addEventListener("click", () => nav("explore", { id: `org/${o.login}` }));
          orgProp.body.appendChild(chip);
        }
      })
      .catch(() => {
        if (orgProp.body.isConnected) orgProp.body.replaceChildren(span("Unavailable.", "det-prop-none"));
      });
  }
}
