// The full-page in-app repository browser — any GitHub repo, without cloning.
//
// The peek-based browser (repoBrowser.ts) is a glance: a stack of cards, good
// for "what's in here?". This is the other half Anton asked for — a real place
// to READ a repository: routed breadcrumbs, a ref switcher, go-to-file across
// the whole tree, README and file contents rendered the way the Code view
// renders them, and the actions (open, clone here, clone elsewhere) sitting in
// the top bar the whole time.
//
// Everything is a routed `target.id` micro-path, so ⌘[ / Esc walk the trail:
//   repo/<owner>/<name>                 the repo root
//   repo/<owner>/<name>/tree/<ref>/<path…>
//   repo/<owner>/<name>/blob/<ref>/<path…>

import { host } from "../bridge";
import { gget } from "../cache";
import { toast } from "../dialogs";
import {
  cleanErr,
  el,
  emptyState,
  errorState,
  fileIcon,
  formatBytes,
  glyph,
  openMenu,
  relTimeISO,
  skeletonList,
  span,
} from "../ui";
import { renderMarkdown } from "../markdown";
import { highlightCode } from "../highlight";
import { resolveRelative, wireProseNav } from "../proseNav";
import { openGhRepoInApp, openGhRepoChooseLocation } from "../ghOpen";
import { openCloneDialog } from "../cloneDialog";
import { fuzzyScore } from "../commandPalette";
import { parseRepoRoute, repoRouteId, type RepoRoute } from "../exploreRoutes";
import { detailPage, propSection, type SectionNav } from "./common";
import type { GhRepoBranch, GhRepoEntry, GhRepoFile, OrgRepoDetail } from "../../shared/ipc";

// The routing vocabulary is pure and lives in ../exploreRoutes (node-tested);
// re-exported here so callers have one import site for "the repo page".
export { parseRepoRoute, repoRouteId, type RepoRoute } from "../exploreRoutes";

/** Render an Explore repository page into `wrap`. */
export function renderRepoPage(
  wrap: HTMLElement,
  nav: SectionNav,
  route: RepoRoute,
  onBack: () => void,
): void {
  void mount(wrap, nav, route, onBack);
}

async function mount(
  wrap: HTMLElement,
  nav: SectionNav,
  route: RepoRoute,
  onBack: () => void,
): Promise<void> {
  const { fullName, path, ref, kind } = route;
  const goto = (o: { path?: string; ref?: string; kind?: "tree" | "blob" }): void =>
    nav("explore", { id: repoRouteId({ fullName, ref, ...o }) });

  // ── top bar ──
  const openBtn = el("button", "btn btn-primary det-split");
  const openMain = el("span", "det-split-main");
  openMain.append(glyph("folder-library"), span("Open in GitStudio"));
  openMain.addEventListener("click", () => openGhRepoInApp(fullName));
  const openMore = el("span", "det-split-more");
  openMore.appendChild(glyph("chevron-down"));
  openMore.title = "More ways to open this repository";
  openMore.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(openBtn, [
      {
        label: "Choose location…",
        icon: "folder-opened",
        onClick: () => openGhRepoChooseLocation(fullName),
      },
      {
        label: "Clone…",
        icon: "repo-clone",
        onClick: () =>
          openCloneDialog((root) => void host.invoke("repo:openPath", root), {
            url: `https://github.com/${fullName}.git`,
          }),
      },
    ]);
  });
  openBtn.append(openMain, openMore);

  const ghBtn = el("button", "mini-btn gh-icon-btn");
  ghBtn.appendChild(glyph("link-external"));
  ghBtn.title = "Open this repository on GitHub";
  ghBtn.setAttribute("aria-label", ghBtn.title);
  ghBtn.addEventListener("click", () =>
    window.open(`https://github.com/${fullName}`, "_blank", "noopener"),
  );

  const gotoBtn = el("button", "mini-btn");
  gotoBtn.append(glyph("search"), span("Go to file"));
  gotoBtn.title = "Fuzzy-search every file in this repository";
  gotoBtn.addEventListener("click", () => void openGoToFile(fullName, ref, (p) => goto({ path: p, kind: "blob" })));

  // Filled in from the repo detail once it lands (the rail fetches it anyway).
  let defaultBranchLabel = "default branch";
  const refBtn = el("button", "mini-btn explore-ref-btn");
  // "default branch" described the KIND of thing selected rather than the
  // selection; the rail says the default is "main", so the button said one
  // thing and the rail another.
  refBtn.append(glyph("git-branch"), span(ref ?? defaultBranchLabel, "explore-ref-name"), glyph("chevron-down"));
  refBtn.title = "Switch branch";
  refBtn.addEventListener("click", () => void openRefMenu(refBtn, fullName, ref, (r) => goto({ ref: r, path })));

  // The page had no title at all — the only place the repo was named was 13px
  // of breadcrumb in the toolbar.
  const { view, main, rail } = detailPage({
    backLabel: "Explore",
    crumb: fullName,
    onBack,
    actions: [refBtn, gotoBtn, ghBtn, openBtn],
  });
  wrap.replaceChildren(view);

  // ── breadcrumbs: every segment is a routed nav, so ⌘[ walks the trail ──
  if (path) {
    const crumbs = el("div", "explore-crumbs");
    const rootBtn = el("button", "explore-crumb");
    rootBtn.textContent = fullName.split("/")[1] ?? fullName;
    rootBtn.addEventListener("click", () => goto({ path: "", kind: "tree" }));
    crumbs.appendChild(rootBtn);
    const parts = path.split("/");
    parts.forEach((seg, i) => {
      crumbs.appendChild(span("/", "explore-crumb-sep"));
      const last = i === parts.length - 1;
      if (last) {
        crumbs.appendChild(span(seg, "explore-crumb is-current"));
        return;
      }
      const b = el("button", "explore-crumb");
      b.textContent = seg;
      const upto = parts.slice(0, i + 1).join("/");
      b.addEventListener("click", () => goto({ path: upto, kind: "tree" }));
      crumbs.appendChild(b);
    });
    main.appendChild(crumbs);
  }

  // The page named itself only in 13px of toolbar breadcrumb.
  const pageHead = el("div", "explore-repo-head");
  const h1 = el("h1", "explore-repo-title");
  const [ownerName, repoName] = fullName.split("/", 2);
  h1.append(span(`${ownerName}/`, "explore-repo-owner"), span(repoName ?? fullName));
  pageHead.appendChild(h1);
  main.appendChild(pageHead);

  const content = el("div", "explore-repo-content");
  content.appendChild(skeletonList(6));
  main.appendChild(content);

  // ── the rail: what this repository IS ──
  void (async () => {
    try {
      const d: OrgRepoDetail = await gget("orgs:repoDetail", fullName, 120_000);
      if (!rail.isConnected) return;
      renderRepoRail(rail, d, fullName, nav);
      // Name the branch the button is actually on.
      if (!ref && d.defaultBranch) {
        defaultBranchLabel = d.defaultBranch;
        const nameEl = refBtn.querySelector(".explore-ref-name");
        if (nameEl) nameEl.textContent = d.defaultBranch;
      }
    } catch {
      /* the rail is context, never the point — silence beats a broken column */
    }
  })();

  // ── the body: a directory, or a file ──
  try {
    if (kind === "blob" && path) await renderFile(content, fullName, path, ref, goto);
    else await renderDir(content, fullName, path, ref, goto);
  } catch (e) {
    if (!content.isConnected) return;
    content.replaceChildren(
      errorState(
        "Couldn't read this repository",
        browseHint(fullName, e),
        () => renderRepoPage(wrap, nav, route, onBack),
      ),
    );
  }
}

/** GitHub's 404 on an org repo usually means OAuth-app access is restricted —
 *  say that instead of a bare "Not Found", which sends people to the browser. */
function browseHint(fullName: string, e: unknown): string {
  const msg = cleanErr(e) || "GitHub request failed.";
  if (/not found/i.test(msg)) {
    const owner = fullName.split("/")[0];
    return `${msg}\n\nIf this repository is private or belongs to ${owner}, the organization may restrict OAuth app access — an owner can approve GitStudio in the org's settings.`;
  }
  return msg;
}

// ── directory ────────────────────────────────────────────────────────────────

async function renderDir(
  content: HTMLElement,
  fullName: string,
  path: string,
  ref: string | undefined,
  goto: (o: { path?: string; ref?: string; kind?: "tree" | "blob" }) => void,
): Promise<void> {
  const entries = await gget("ghrepo:tree", { fullName, path, ref }, 60_000);
  if (!content.isConnected) return;
  content.replaceChildren();

  const list = el("div", "explore-tree");
  for (const entry of entries) list.appendChild(entryRow(entry, goto));
  if (!entries.length) {
    list.appendChild(emptyState("Empty folder", "Nothing here at this ref.", { icon: "folder" }));
  }
  content.appendChild(list);

  // The README belongs under the root listing, rendered with THE prose system.
  if (!path) {
    const readme = await host.invoke("ghrepo:readme", { fullName, ref }).catch(() => undefined);
    if (!readme || !content.isConnected) return;
    const card = el("div", "explore-readme");
    const head = el("div", "explore-readme-head");
    head.append(glyph("book"), span(readme.name));
    const prose = el("div", "gh-body-md");
    try {
      prose.innerHTML = renderMarkdown(readme.text);
      const [owner, repo] = fullName.split("/", 2);
      // #123 and github.com links resolve against THIS repo; relative links
      // navigate inside the page instead of leaving the app.
      wireProseNav(prose, undefined, { owner, repo }, (rel) => {
        const target = resolveRelative(path, rel);
        goto({ path: target, kind: /\.[A-Za-z0-9]{1,8}$/.test(target) ? "blob" : "tree" });
      });
    } catch {
      prose.textContent = readme.text;
    }
    card.append(head, prose);
    content.appendChild(card);
  }
}

function entryRow(
  entry: GhRepoEntry,
  goto: (o: { path?: string; kind?: "tree" | "blob" }) => void,
): HTMLElement {
  const row = el("button", "explore-tree-row");
  row.appendChild(glyph(fileIcon(entry.name, entry.type === "dir")));
  row.appendChild(span(entry.name, "explore-tree-name"));
  row.appendChild(el("span", "explore-tree-spring"));
  if (entry.type === "file" && entry.size) {
    row.appendChild(span(formatBytes(entry.size), "explore-tree-size"));
  }
  row.addEventListener("click", () =>
    goto({ path: entry.path, kind: entry.type === "dir" ? "tree" : "blob" }),
  );
  return row;
}

// ── file ─────────────────────────────────────────────────────────────────────

async function renderFile(
  content: HTMLElement,
  fullName: string,
  path: string,
  ref: string | undefined,
  goto: (o: { path?: string; kind?: "tree" | "blob" }) => void,
): Promise<void> {
  const file: GhRepoFile = await gget("ghrepo:file", { fullName, path, ref }, 60_000);
  if (!content.isConnected) return;
  content.replaceChildren();
  const name = path.split("/").pop() ?? path;

  if (file.binary || file.truncated) {
    content.appendChild(
      emptyState(
        file.binary ? "Binary file" : "File too large to preview",
        `${name}${file.size ? ` · ${formatBytes(file.size)}` : ""} — open it on GitHub, or clone the repository to read it here.`,
        { icon: file.binary ? "file-binary" : "file" },
      ),
    );
    return;
  }

  // Markdown reads as prose (like the README); everything else as code.
  if (/\.mdx?$/i.test(name)) {
    const prose = el("div", "gh-body-md explore-file-prose");
    try {
      prose.innerHTML = renderMarkdown(file.text);
      const [owner, repo] = fullName.split("/", 2);
      wireProseNav(prose, undefined, { owner, repo }, (rel) => {
        const target = resolveRelative(path, rel);
        goto({ path: target, kind: /\.[A-Za-z0-9]{1,8}$/.test(target) ? "blob" : "tree" });
      });
    } catch {
      prose.textContent = file.text;
    }
    content.appendChild(prose);
    return;
  }

  const lines = file.text.split("\n");
  const box = el("div", "explore-file");
  const gutter = el("div", "explore-file-gutter");
  gutter.textContent = lines.map((_, i) => String(i + 1)).join("\n");
  const pre = el("pre", "explore-file-code");
  const code = el("code", "");
  code.textContent = file.text;
  pre.appendChild(code);
  box.append(gutter, pre);
  content.appendChild(box);
  // Same colorizer the Code view uses — one highlighting story in the app.
  void highlightCode(code, file.text, name);
}

// ── the rail ─────────────────────────────────────────────────────────────────

function renderRepoRail(
  rail: HTMLElement,
  d: OrgRepoDetail,
  fullName: string,
  nav: SectionNav,
): void {
  rail.replaceChildren();
  const about = propSection("About");
  if (d.description) {
    const p = el("div", "det-prop-text");
    p.textContent = d.description;
    about.body.appendChild(p);
  } else {
    about.body.appendChild(span("No description.", "det-prop-none"));
  }
  rail.appendChild(about.root);

  const stats = propSection("Stats");
  stats.body.classList.add("det-prop-facts");
  const fact = (k: string, v: string): void => {
    const row = el("div", "det-fact");
    row.append(span(k, "det-fact-k"), span(v, "det-fact-v"));
    stats.body.appendChild(row);
  };
  if (d.language) fact("Language", d.language);
  fact("Stars", d.stargazersCount.toLocaleString());
  fact("Forks", d.forksCount.toLocaleString());
  fact("Open issues", d.openIssuesCount.toLocaleString());
  if (d.license) fact("License", d.license);
  if (d.defaultBranch) fact("Default branch", d.defaultBranch);
  if (d.pushedAt) fact("Last push", relTimeISO(d.pushedAt));
  rail.appendChild(stats.root);

  if (d.topics.length) {
    const topics = propSection("Topics");
    for (const t of d.topics.slice(0, 12)) topics.body.appendChild(span(t, "gh-pill explore-topic"));
    rail.appendChild(topics.root);
  }
  if (d.fork || d.archived || d.private) {
    const flags = propSection("Notes");
    if (d.private) flags.body.appendChild(span("private", "gh-pill"));
    if (d.fork) flags.body.appendChild(span("fork", "gh-pill"));
    if (d.archived) flags.body.appendChild(span("archived", "gh-pill"));
    rail.appendChild(flags.root);
  }

  const owner = propSection("Owner");
  const ownerLogin = fullName.split("/")[0];
  // It was a <button> with a pointer cursor and a tooltip promising to open the
  // account, and clicking it did nothing at all. Either a control does its
  // thing or it is not a control.
  const ownerBtn = el("button", "det-person");
  ownerBtn.textContent = ownerLogin;
  ownerBtn.title = `Open ${ownerLogin} in Explore`;
  ownerBtn.setAttribute("aria-label", ownerBtn.title);
  ownerBtn.addEventListener("click", () => nav("explore", { id: `user/${ownerLogin}` }));
  owner.body.appendChild(ownerBtn);
  rail.appendChild(owner.root);
}

// ── ref switcher + go-to-file ────────────────────────────────────────────────

async function openRefMenu(
  anchor: HTMLElement,
  fullName: string,
  current: string | undefined,
  pick: (ref: string | undefined) => void,
): Promise<void> {
  let branches: GhRepoBranch[] = [];
  try {
    branches = await gget("ghrepo:branches", fullName, 120_000);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't list branches.", "error");
    return;
  }
  openMenu(
    anchor,
    [
      {
        label: "Default branch",
        icon: current == null ? "check" : "git-branch",
        onClick: () => pick(undefined),
      },
      { separator: true },
      ...branches.map((b) => ({
        label: b.name,
        icon: current === b.name ? "check" : "git-branch",
        onClick: () => pick(b.name),
      })),
    ],
    { searchable: branches.length > 8 },
  );
}

/** Go-to-file: the whole tree in one request, ranked by the palette's own
 *  fuzzy scorer so it feels identical to ⌘K. Honest when the tree is capped. */
async function openGoToFile(
  fullName: string,
  ref: string | undefined,
  pick: (path: string) => void,
): Promise<void> {
  const { openModal } = await import("../dialogs");
  const card = el("div", "modal-card gotofile-card");
  let close = (): void => {};

  const input = document.createElement("input");
  input.className = "modal-input gotofile-input";
  input.placeholder = "Go to file…";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Go to file");
  const listEl = el("div", "gotofile-list");
  const note = el("div", "gotofile-note");
  note.textContent = "Loading the file list…";
  card.append(input, listEl, note);

  openModal((c) => {
    close = c;
    return { card, focusEl: input, label: `Go to file in ${fullName}`, onClose: () => {} };
  });

  let paths: string[] = [];
  try {
    const res = await gget("ghrepo:paths", { fullName, ref }, 300_000);
    paths = res.paths;
    note.textContent = res.truncated
      ? `Searching ${paths.length.toLocaleString()} of ${res.total.toLocaleString()} files — this repository's tree is too large to index fully.`
      : `${paths.length.toLocaleString()} files`;
  } catch (e) {
    note.textContent = cleanErr(e) || "Couldn't list this repository's files.";
    return;
  }

  const render = (): void => {
    const q = input.value.trim();
    const ranked = q
      ? paths
          .map((p) => ({ p, s: fuzzyScore(q, p) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 40)
          .map((x) => x.p)
      : paths.slice(0, 40);
    listEl.replaceChildren();
    for (const p of ranked) {
      const row = el("button", "gotofile-row");
      row.appendChild(glyph(fileIcon(p.split("/").pop() ?? p)));
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
      if (dir) row.appendChild(span(dir, "gotofile-dir"));
      row.appendChild(span(p.slice(dir.length), "gotofile-name"));
      row.addEventListener("click", () => {
        close();
        pick(p);
      });
      listEl.appendChild(row);
    }
    if (!ranked.length) {
      listEl.appendChild(span("No file matches that.", "gotofile-empty"));
    }
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (listEl.firstElementChild as HTMLElement | null)?.click();
    }
  });
  render();
}
