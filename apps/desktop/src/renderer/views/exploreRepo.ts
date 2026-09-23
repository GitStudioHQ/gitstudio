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

import { fileLines } from "../textFit";
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
  copyText,
} from "../ui";
import { renderMarkdown } from "../markdown";
import { highlightCode } from "../highlight";
import { resolveRelative, wireProseNav } from "../proseNav";

/**
 * Where a browsed repo's relative images live: raw.githubusercontent.com, at
 * the ref on screen, beside the document. `../` is resolved here because the
 * raw host serves nothing for a path that still contains it.
 */
function rawImageResolver(fullName: string, ref: string | undefined, baseDir: string) {
  return (rel: string): string =>
    `https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(ref ?? "HEAD")}/` +
    resolveRelative(baseDir, rel.replace(/^\.\//, ""));
}
import { openGhRepoInApp, openGhRepoChooseLocation } from "../ghOpen";
import { openCloneDialog } from "../cloneDialog";
import { fuzzyScore } from "../commandPalette";
import { parseRepoRoute, repoRouteId, type RepoRoute } from "../exploreRoutes";
import { detailPage, propSection, propAddBtn, whereChip, type SectionNav } from "./common";
import { peek } from "../cache";
import { findLocalCopy, localCopyIndex, middlePath, openLocalCopy } from "../localCopy";
import { isEmptyRepoMessage } from "../../shared/githubStates";
import type { GhRepoBranch, GhRepoEntry, GhRepoFile, LocalCopy, OrgRepoDetail } from "../../shared/ipc";

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
  const goto = (o: { path?: string; ref?: string; kind?: "tree" | "blob" | "commits" }): void =>
    nav("explore", { id: repoRouteId({ fullName, ref, ...o }) });

  // ── do I already have this repository? ──
  //
  // Every one of this page's 656 lines used to render the same way whether the
  // repository was a stranger's or the very one you had open: the same header,
  // the same rail, the same "Open in GitStudio" primary — which, standing in
  // the repo you already had open, did literally nothing but toast.
  //
  // Answered synchronously first, so the header paints correct rather than
  // correcting itself under the cursor. Both lists that link here prime this
  // cache, so it is warm on the normal path; disk then confirms.
  const key = fullName.toLowerCase();
  let local: LocalCopy | undefined = localCopyIndex(peek("repos:local", undefined) ?? []).get(key);
  let dirty = 0;

  // ── top bar ──
  // TWO REAL BUTTONS, not one button wrapping two spans.
  //
  // It was a <button> whose halves were <span>s carrying the click handlers, so
  // the button itself had none: focusing it and pressing Enter dispatched a
  // click on the BUTTON, matched no handler, and did nothing at all. The
  // primary action on this page was unreachable from the keyboard. Same shape
  // as `.openin` in the top bar — a group of two buttons sharing an edge.
  const openBtn = el("div", "det-split");
  openBtn.setAttribute("role", "group");
  const openMain = el("button", "btn btn-primary det-split-main") as HTMLButtonElement;
  const openMore = el("button", "btn btn-primary det-split-more") as HTMLButtonElement;
  openMore.appendChild(glyph("chevron-down"));
  // aria-label, not `title`: a native tooltip fights the dropdown this opens,
  // hanging a grey box over the menu you just asked for.
  openMore.setAttribute("aria-haspopup", "menu");
  openBtn.append(openMain, openMore);

  // Where a clone would land, so the button and the progress card that follows
  // it say the same words. Absent if settings cannot be read — better to drop
  // the clause than to name a folder we are guessing at.
  let cloneDir = "";
  void gget("settings:get", undefined, 60_000)
    .then((st) => {
      cloneDir = st.cloneDir ?? "";
      if (openMain.isConnected) paintOpen();
    })
    .catch(() => {});

  /**
   * ONE label used to cover three different outcomes.
   *
   * "Open in GitStudio" downloaded the whole repository into a folder you never
   * chose when you had no copy; reopened an existing clone when you did; and,
   * on the repository you already had open, returned early in the main process
   * without emitting anything at all — a dead click that toasted success.
   *
   * Three states, three labels, three handlers. State 3 also takes the local
   * route instead of an IPC round trip, which is what stops the dead click.
   */
  const setMain = (icon: string, label: string, title: string, onClick: () => void): void => {
    openMain.replaceChildren(glyph(icon), span(label));
    openMain.title = title;
    openMain.onclick = onClick;
    openBtn.setAttribute("aria-label", title);
  };

  const paintOpen = (): void => {
    if (!local) {
      setMain(
        "cloud-download",
        "Clone and open",
        cloneDir
          ? `Clones ${fullName} into ${cloneDir}, then opens it here.`
          : `Clones ${fullName} and opens it here.`,
        () => openGhRepoInApp(fullName),
      );
    } else if (local.current) {
      setMain(
        dirty ? "request-changes" : "code",
        dirty ? "Go to the changes" : "Go to the code",
        `Go to ${local.name} in GitStudio`,
        () => nav(dirty ? "changes" : "code"),
      );
    } else {
      const elsewhere = local;
      setMain("folder", "Open this clone", `Open ${middlePath(elsewhere.root)}`, () =>
        void openLocalCopy(fullName, elsewhere, nav),
      );
    }
    const held = local;
    openMore.onclick = (e): void => {
      e.stopPropagation();
      openMenu(
        openMore,
        held
          ? [
              // Cloning stays reachable, but BY NAME. An unlabelled "Clone…"
              // offered on the repository you are standing in is exactly the
              // ambiguity the open/changes prompt was added to kill.
              {
                label: "Open this clone",
                sub: middlePath(held.root),
                icon: "repo",
                onClick: () => void openLocalCopy(fullName, held, nav),
              },
              {
                label: "Show in Finder",
                icon: "folder-opened",
                onClick: () => void host.invoke("repos:reveal", held.root),
              },
              {
                label: "Copy clone URL",
                icon: "copy",
                onClick: () =>
                  void copyText(`https://github.com/${fullName}.git`, "Clone URL copied."),
              },
              { separator: true },
              {
                label: "Clone another copy…",
                icon: "repo-clone",
                onClick: () =>
                  openCloneDialog((root) => void host.invoke("repo:openPath", root), {
                    url: `https://github.com/${fullName}.git`,
                  }),
              },
            ]
          : [
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
            ],
      );
    };
    openMore.setAttribute("aria-label", `More ways to open ${fullName}`);
  };
  paintOpen();

  const ghBtn = el("button", "mini-btn gh-icon-btn");
  ghBtn.appendChild(glyph("link-external"));
  ghBtn.title = "Open this repository on GitHub";
  ghBtn.setAttribute("aria-label", ghBtn.title);
  ghBtn.addEventListener("click", () =>
    window.open(`https://github.com/${fullName}`, "_blank", "noopener"),
  );

  // The history of a repository nobody has cloned. Read-only by nature — there
  // is nothing on disk to check out — so it is a LIST, not the graph.
  const commitsBtn = el("button", "mini-btn" + (kind === "commits" ? " is-on" : ""));
  commitsBtn.append(glyph("history"), span("Commits"));
  commitsBtn.title = "Read this repository's commits";
  commitsBtn.addEventListener("click", () =>
    goto(kind === "commits" ? { path: "", kind: "tree" } : { path: "", kind: "commits" }),
  );

  const gotoBtn = el("button", "mini-btn");
  gotoBtn.append(glyph("search"), span("Go to file"));
  gotoBtn.title = "Fuzzy-search every file in this repository";
  gotoBtn.addEventListener("click", () => void openGoToFile(fullName, ref, (p) => goto({ path: p, kind: "blob" })));

  // Filled in from the repo detail once it lands (the rail fetches it anyway).
  let defaultBranchLabel = "default branch";
  let defaultBranchName: string | undefined;
  const refBtn = el("button", "mini-btn explore-ref-btn");
  // "default branch" described the KIND of thing selected rather than the
  // selection; the rail says the default is "main", so the button said one
  // thing and the rail another.
  refBtn.append(glyph("git-branch"), span(ref ?? defaultBranchLabel, "explore-ref-name"), glyph("chevron-down"));
  refBtn.title = "Switch branch";
  refBtn.addEventListener("click", () =>
    // `kind` too. It was the ONLY one of the seven goto call sites that dropped
    // it, and `repoRouteId` defaults a missing kind to "tree" — so switching
    // the branch while READING A FILE turned a blob route into a tree route at
    // the file's own path. The title fell back to the repo name, the file body
    // was replaced by a directory listing, and the breadcrumb presented the
    // file as the current folder. Worse against the real API than in the
    // fixture: `listRepoDir` normalises the contents endpoint's single-object
    // answer with `Array.isArray(raw) ? raw : [raw]`, so the "folder" renders
    // exactly one row — the file, listed inside itself.
    void openRefMenu(refBtn, fullName, ref, (r) => goto({ ref: r, path, kind }), defaultBranchName),
  );

  // The page had no title at all — the only place the repo was named was 13px
  // of breadcrumb in the toolbar.
  let whereTag = whereChip(local ? "local" : "remote");
  const { view, main, rail } = detailPage({
    // The app calls this view "Search" everywhere else; "Explore" is a name it
    // no longer uses anywhere the reader can see.
    backLabel: "Search",
    crumb: fullName,
    crumbTag: whereTag,
    onBack,
    actions: [refBtn, commitsBtn, gotoBtn, ghBtn, openBtn],
  });
  wrap.replaceChildren(view);

  // ── Location: the one section that answers "can I write here?" ──
  //
  // It is built here rather than inside the repo-detail fetch, and handed to
  // the rail renderer to keep, because that fetch 404s on exactly the
  // repositories where the question matters most — a private or org-restricted
  // one — and its failures are silently swallowed.
  // A STABLE node the rail keeps across repaints, holding a freshly built
  // section each time. `det-loc` is a marker for the checks; it needs no CSS.
  const locRoot = el("div", "det-prop det-loc");
  const buildLocation = (): void => {
    const loc = propSection("Location");
    // A column of facts, not a wrapped row of chips.
    loc.body.classList.add("det-prop-facts");
    loc.body.appendChild(whereChip(local ? "local" : "remote"));
    if (local) {
      const pathEl = span(middlePath(local.root), "sec-mono");
      pathEl.title = local.root;
      loc.body.appendChild(pathEl);
    }
    const note = !local
      ? "Read-only — nothing of this is on your disk."
      : local.current
        ? "This is the repository you have open."
        : dirty
          ? `${dirty} uncommitted ${dirty === 1 ? "file" : "files"} waiting there.`
          : "";
    if (note) loc.body.appendChild(span(note, "det-prop-none"));
    // Clean vs dirty is ONE rule, stated once: dirty goes to the changes, clean
    // goes to the code. The rail button, the header primary and the open prompt
    // all follow it.
    const held = local;
    loc.body.appendChild(
      !held
        ? propAddBtn("Clone it here", () => openGhRepoChooseLocation(fullName), "repo-clone")
        : held.current
          ? propAddBtn(
              dirty ? "Go to the changes" : "Go to the code",
              () => nav(dirty ? "changes" : "code"),
              dirty ? "request-changes" : "code",
            )
          : propAddBtn("Open this clone", () => void openLocalCopy(fullName, held, nav), "folder-opened"),
    );
    locRoot.className = `${loc.root.className} det-loc`;
    locRoot.replaceChildren(...loc.root.childNodes);
  };
  buildLocation();
  rail.appendChild(locRoot);

  /** Header tag, Location rail and primary button, all from the same answer. */
  const repaintWhere = (): void => {
    const next = whereChip(local ? "local" : "remote");
    whereTag.replaceWith(next);
    whereTag = next;
    buildLocation();
    paintOpen();
  };

  // Disk confirms what the cache guessed. Nothing repaints when the answer is
  // "still no copy" — the page already says so.
  void (async () => {
    const found = await findLocalCopy(fullName).catch(() => undefined);
    if (!view.isConnected) return;
    if (!found && !local) return;
    local = found?.copy;
    dirty = found?.dirty ?? 0;
    repaintWhere();
  })();

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
  // On a FILE page the biggest words on screen used to be the repository's —
  // the same string the toolbar crumb above it already said — while the file
  // you had opened appeared only in that crumb. A page is titled by its subject.
  if (kind === "blob" && path) {
    const fileName = path.split("/").pop() ?? path;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    // A blob route three clicks deep was indistinguishable from the Code
    // view's read-only file over your own checkout. The mark says which world
    // the file is in before you read a line of it.
    const eyebrow = el("div", "explore-repo-eyebrow");
    eyebrow.append(glyph(local ? "folder" : "globe"), span(dir ? `${fullName} / ${dir}` : fullName));
    pageHead.appendChild(eyebrow);
    h1.appendChild(span(fileName));
  } else {
    h1.append(span(`${ownerName}/`, "explore-repo-owner"), span(repoName ?? fullName));
  }
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
      renderRepoRail(rail, d, fullName, nav, locRoot);
      // Name the branch the button is actually on.
      if (d.defaultBranch) defaultBranchName = d.defaultBranch;
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
    // Passed down explicitly rather than read from a module-level `let`: these
    // read AFTER an await, so hopping quickly between two repositories would
    // otherwise let one page answer with the other's copy.
    if (kind === "commits") await renderCommits(content, fullName, ref, local);
    else if (kind === "blob" && path)
      await renderFile(content, fullName, path, ref, goto, local, nav);
    else await renderDir(content, fullName, path, ref, goto);
  } catch (e) {
    if (!content.isConnected) return;
    // A repository with no commits is not a failed read — it is what the
    // repository IS, and every endpoint this page uses says so rather than
    // answering an empty list (see shared/githubStates). Painting "Couldn't
    // read this repository" over it accused the app of a fault it did not have
    // and sent people to github.com to find out we were wrong. Report #13.
    if (isEmptyRepoMessage(cleanErr(e))) {
      content.replaceChildren(
        emptyState(
          "This repository is empty",
          `Nothing has been pushed to ${fullName} yet, so there is nothing to read here.`,
          { icon: "repo" },
        ),
      );
      return;
    }
    content.replaceChildren(
      errorState(
        "Couldn't read this repository",
        browseHint(fullName, e),
        () => renderRepoPage(wrap, nav, route, onBack),
      ),
    );
  }
}

/**
 * The commits on a ref, for a repository you have not cloned.
 *
 * Deliberately a plain list and not the commit graph: the API hands back no
 * lanes and no diffstat, and inventing either would be a drawing of history
 * rather than history. What it can honestly show is who, what and when — and
 * the sha, which opens on github.com because there is no local object to read.
 */
async function renderCommits(
  content: HTMLElement,
  fullName: string,
  ref: string | undefined,
  have: LocalCopy | undefined,
): Promise<void> {
  const commits = await gget("ghrepo:commits", { fullName, ref }, 60_000);
  if (!content.isConnected) return;
  if (!commits.length) {
    content.replaceChildren(
      emptyState("No commits", `Nothing has been committed on ${ref ?? "the default branch"} yet.`),
    );
    return;
  }
  const list = el("div", "explore-commits");
  for (const c of commits) {
    const row = el("a", "explore-commit") as HTMLAnchorElement;
    row.href = `https://github.com/${fullName}/commit/${c.sha}`;
    row.target = "_blank";
    row.rel = "noopener";
    row.title = `Open ${c.shortSha} on GitHub`;
    const who = el("span", "explore-commit-av");
    if (c.avatarUrl) {
      const img = document.createElement("img");
      img.src = `${c.avatarUrl}${c.avatarUrl.includes("?") ? "&" : "?"}s=40`;
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      who.appendChild(img);
    } else {
      who.textContent = (c.author || "?").slice(0, 1).toUpperCase();
    }
    const text = el("span", "explore-commit-text");
    const subj = el("span", "explore-commit-subject");
    subj.textContent = c.subject;
    const meta = el("span", "explore-commit-meta");
    meta.textContent = c.login ?? c.author;
    if (c.date) meta.append(span("·", "explore-commit-dot"), span(relTimeISO(c.date)));
    text.append(subj, meta);
    const sha = el("span", "explore-commit-sha");
    sha.textContent = c.shortSha;
    row.append(who, text, sha);
    list.appendChild(row);
  }
  // Said plainly rather than implied: this is the recent history, not all of it.
  const note = el("div", "explore-commits-note");
  note.textContent =
    commits.length >= 50
      ? have
        ? "The 50 most recent commits. Open your copy to read the whole history."
        : "The 50 most recent commits. Clone the repository to read its whole history."
      : `${commits.length} commit${commits.length === 1 ? "" : "s"}.`;
  list.appendChild(note);
  content.replaceChildren(list);
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
      // The README sits at the repo root, so its relative images anchor there.
      prose.innerHTML = renderMarkdown(readme.text, 0, {
        resolveImage: rawImageResolver(fullName, ref, ""),
      });
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
  have: LocalCopy | undefined,
  nav: SectionNav,
): Promise<void> {
  const file: GhRepoFile = await gget("ghrepo:file", { fullName, path, ref }, 60_000);
  if (!content.isConnected) return;
  content.replaceChildren();
  const name = path.split("/").pop() ?? path;

  if (file.binary || file.truncated) {
    content.appendChild(
      emptyState(
        file.binary ? "Binary file" : "File too large to preview",
        `${name}${file.size ? ` · ${formatBytes(file.size)}` : ""} — open it on GitHub, or ` +
          (have ? "open your copy to read it here." : "clone the repository to read it here."),
        {
          icon: file.binary ? "file-binary" : "file",
          // Advising a clone of something already on disk is advice you cannot
          // take. With a copy, the way out is one click, not a second download.
          ...(have
            ? {
                action: {
                  label: "Open your copy",
                  icon: "repo",
                  onClick: () => void openLocalCopy(fullName, have, nav),
                },
              }
            : {}),
        },
      ),
    );
    return;
  }

  // Markdown reads as prose (like the README); everything else as code.
  if (/\.mdx?$/i.test(name)) {
    const prose = el("div", "gh-body-md explore-file-prose");
    try {
      // Images anchor at the file's FOLDER — `path` here is the file itself.
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      prose.innerHTML = renderMarkdown(file.text, 0, {
        resolveImage: rawImageResolver(fullName, ref, dir),
      });
      const [owner, repo] = fullName.split("/", 2);
      wireProseNav(prose, undefined, { owner, repo }, (rel) => {
        // Against the file's FOLDER, not the file. `resolveRelative` takes a
        // base DIRECTORY — which `path` is on the README path above, but here
        // `path` is the file itself, so "./api.md" beside docs/guide.md
        // resolved to docs/guide.md/api.md. Every relative link inside a
        // markdown file pointed one level too deep.
        const target = resolveRelative(path.split("/").slice(0, -1).join("/"), rel);
        goto({ path: target, kind: /\.[A-Za-z0-9]{1,8}$/.test(target) ? "blob" : "tree" });
      });
    } catch {
      prose.textContent = file.text;
    }
    content.appendChild(prose);
    return;
  }

  const lines = fileLines(file.text);
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
  locRoot: HTMLElement,
): void {
  // Location is kept, not rebuilt: it is the one section that must survive the
  // detail fetch failing, which is exactly what happens on a private repo.
  rail.replaceChildren(locRoot);
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
  defaultBranch?: string,
): Promise<void> {
  let branches: GhRepoBranch[] = [];
  try {
    branches = await gget("ghrepo:branches", fullName, 120_000);
  } catch (e) {
    // An empty repository has no branches; that is the answer, not a failure.
    if (!isEmptyRepoMessage(cleanErr(e))) {
      toast(cleanErr(e) || "Couldn't list branches.", "error");
      return;
    }
  }
  // GitHub lists an empty repository's branches as `[]`. An empty menu reads
  // as a control that did nothing; say what is true instead.
  if (!branches.length) {
    openMenu(anchor, [
      {
        label: "No branches yet",
        sub: `nothing has been pushed to ${fullName}`,
        icon: "info",
        disabled: true,
        onClick: () => {},
      },
    ]);
    return;
  }
  // The default branch is one of these branches, not a separate thing. Listing
  // it as its own row above the list meant `main` appeared twice — once ticked
  // as "Default branch" and once, three rows down, under its own name and not
  // ticked, which reads as two different branches with the same content.
  const def = defaultBranch;
  const selected = current ?? def;
  openMenu(
    anchor,
    branches.map((b) => ({
      label: b.name,
      sub: b.name === def ? "default" : undefined,
      icon: selected === b.name ? "check" : "git-branch",
      current: selected === b.name,
      onClick: () => pick(b.name === def ? undefined : b.name),
    })),
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
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-autocomplete", "list");
  const listEl = el("div", "gotofile-list");
  listEl.setAttribute("role", "listbox");
  listEl.id = "gs-gotofile-list";
  input.setAttribute("aria-controls", listEl.id);
  const note = el("div", "gotofile-note");
  note.textContent = "Loading the file list…";
  card.append(input, listEl, note);

  openModal((c) => {
    close = c;
    return { card, focusEl: input, label: `Go to file in ${fullName}`, onClose: () => {} };
  });

  let paths: string[] = [];
  /** loading · ready · failed. The list, the note and the combobox's own
   *  aria-expanded all read from this. A failure used to write one line into
   *  the note and `return` BEFORE the keyboard was wired — leaving a focused,
   *  live-looking search field where every keystroke, arrow and Enter did
   *  nothing, and no way back but Escape and reopening. */
  let state: "loading" | "ready" | "failed" = "loading";
  let failure = "";

  // Which row Enter will open. Without one, ↑/↓ were dead keys and Enter fired
  // the top row while nothing on screen said the top row was special — a picker
  // with 40 identical options and an invisible cursor.
  let sel = 0;
  const rows = (): HTMLElement[] => [...listEl.querySelectorAll<HTMLElement>(".gotofile-row")];
  const paint = (): void => {
    const rs = rows();
    if (!rs.length) return;
    sel = Math.max(0, Math.min(rs.length - 1, sel));
    rs.forEach((r, i) => {
      r.classList.toggle("is-sel", i === sel);
      r.setAttribute("aria-selected", String(i === sel));
    });
    rs[sel].scrollIntoView({ block: "nearest" });
    if (!rs[sel].id) rs[sel].id = `gs-gotofile-${sel}`;
    input.setAttribute("aria-activedescendant", rs[sel].id);
  };

  const render = (): void => {
    if (state !== "ready") {
      listEl.replaceChildren();
      input.removeAttribute("aria-activedescendant");
      input.setAttribute("aria-expanded", "false");
      if (state === "failed") {
        // The third door on to an empty repository, after the page body and
        // the peek browser. "Couldn't list the files" blames the app for a
        // repository that simply has none.
        listEl.appendChild(
          isEmptyRepoMessage(failure)
            ? emptyState("This repository is empty", "There are no files to go to yet.", {
                icon: "repo",
                anchor: "inline",
              })
            : errorState("Couldn't list the files", failure, () => void load()),
        );
      }
      return;
    }
    input.setAttribute("aria-expanded", "true");
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
    sel = 0;
    for (const p of ranked) {
      const row = el("button", "gotofile-row");
      row.setAttribute("role", "option");
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
      input.removeAttribute("aria-activedescendant");
      return;
    }
    paint();
  };
  /** Retryable, and safe to lose the race with a dismissal. */
  const load = async (): Promise<void> => {
    state = "loading";
    failure = "";
    note.textContent = "Loading the file list…";
    note.removeAttribute("role");
    note.classList.remove("is-error");
    render();
    try {
      const res = await gget("ghrepo:paths", { fullName, ref }, 300_000);
      if (!card.isConnected) return;
      paths = res.paths;
      state = "ready";
      note.textContent = res.truncated
        ? `Searching ${paths.length.toLocaleString()} of ${res.total.toLocaleString()} files — this repository's tree is too large to index fully.`
        : `${paths.length.toLocaleString()} ${paths.length === 1 ? "file" : "files"}`;
    } catch (e) {
      if (!card.isConnected) return;
      state = "failed";
      failure = cleanErr(e) || "GitHub couldn't list this repository's files.";
      if (isEmptyRepoMessage(failure)) {
        // A state, said once in the list above — not an error to paint red and
        // announce as an alert under it.
        note.textContent = "0 files";
      } else {
        note.textContent = failure;
        note.setAttribute("role", "alert");
        note.classList.add("is-error");
      }
    }
    render();
    input.focus();
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    const rs = rows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rs.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + rs.length) % rs.length;
      paint();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      sel = e.key === "Home" ? 0 : rs.length - 1;
      paint();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      rs[sel]?.click();
    }
  });
  void load();
}
