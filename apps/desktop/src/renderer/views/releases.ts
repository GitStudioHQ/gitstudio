// GitHub Releases — the section view, on the section-page system
// (docs/desktop-redesign.md): a full-width list (Releases | Tags segment) whose
// release rows navigate to a full-page detail (routed via `target.number` = the
// release id) with rendered notes + assets in the content column and the
// release's facts in the rail. Tags open a lightweight peek (commit info +
// draft-a-release), matching how refs peek everywhere else in the app.
//
// Full CRUD: New release, Edit, Delete (confirmed) — the multi-field form is a
// local modal on the shared .modal-* CSS.

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  relTime,
  absTime,
  relTimeISO,
  absTimeISO,
  copyText,
  skeletonList,
  errorState,
  emptyState,
  cleanErr,
  groupLabel,
  openMenu,
  statBit,
  statePill,
  runBusy,
} from "../ui";
import { peek as cachePeek, gget, bust } from "../cache";
import { plural } from "../textFit";
import { toast, confirmDialog, openModal, formWithRetry } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { wireProseNav } from "../proseNav";
import { openPeek } from "../peek";
import {
  segmented,
  detailPage,
  blankable,
  ghGate,
  ghHeader,
  personChip,
  propSection,
  searchField,
  secRow,
  sectionList,
  type GhGate,
  type SectionNav,
  type SectionRender,
  type SectionTarget,
} from "./common";
import { mdEditor } from "../mdEditor";
import { wireDraft } from "../draftStore";
import type { CommitDetailsPayload, ReleaseInfo, ReleaseInput, TagInfo } from "../../shared/ipc";

/** Which sub-list the section shows. Module-scoped so it survives re-renders. */
let releaseTab: "releases" | "tags" = "releases";
/** The list page's live search query — survives list ⇄ detail round trips. */
let query = "";

/** Human file size for release assets. */
/** Tag an element with an extra class and return it — for column widths. */
function withClass(node: HTMLElement, cls: string): HTMLElement {
  node.classList.add(cls);
  return node;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** The section's router, so nested builders can leave for another view — the
 *  release composer is a page of its own now, not a modal over this one. */
let sectionNav: SectionNav | undefined;

export const renderReleases: SectionRender = (wrap, nav, target) => {
  sectionNav = nav;
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  const refresh = (): void => {
    bust("release");
    renderReleases(wrap, nav, target);
  };
  const gate = await ghGate(wrap, nav, true, refresh);
  if (!gate) return;

  if (target?.number != null) {
    showReleaseDetailPage(wrap, nav, target.number, target.from);
    return;
  }
  await listPage(wrap, nav, gate);
}

// ── The list page (Releases | Tags) ──────────────────────────────────────────

async function listPage(wrap: HTMLElement, nav: SectionNav, gate: GhGate): Promise<void> {
  const refresh = (): void => {
    bust("release");
    renderReleases(wrap, nav);
  };

  const { view, listEl } = sectionList();
  const header = ghHeader("Releases", gate.login, refresh);

  const tools = el("div", "gh-head-tools");
  const seg = segmented<"releases" | "tags">({
    options: [
      { value: "releases", label: "Releases" },
      { value: "tags", label: "Tags" },
    ],
    value: releaseTab,
    ariaLabel: "Releases view",
    onChange: (v) => {
      releaseTab = v;
      renderReleases(wrap, nav);
    },
  });

  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("plus"), span("New release"));
  newBtn.title = "Draft a new release";
  newBtn.addEventListener("click", () => sectionNav?.("releasenew"));

  tools.append(seg, newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: releaseTab === "releases" ? "Search releases…" : "Search tags…",
      initial: query,
      onInput: (q) => {
        query = q;
        rerenderList();
      },
    }),
  );

  // ── data ──
  let releases: ReleaseInfo[] | undefined =
    releaseTab === "releases" ? cachePeek("release:list", undefined) : undefined;
  let tags: TagInfo[] | undefined =
    releaseTab === "tags" ? cachePeek("release:tags", undefined) : undefined;
  if ((releaseTab === "releases" && !releases) || (releaseTab === "tags" && !tags)) {
    listEl.replaceChildren(skeletonList(5));
  }

  const buildReleaseRow = (rel: ReleaseInfo, latestId: number | undefined): HTMLElement => {
    const lead = el("span", "gh-lead-icon gh-lead-merged");
    lead.appendChild(glyph("tag"));

    const suffix: HTMLElement[] = [];
    if (rel.draft) suffix.push(statePill("Draft", "draft"));
    if (rel.prerelease) suffix.push(statePill("Pre-release", "prerelease"));
    if (!rel.draft && rel.id === latestId) suffix.push(statePill("Latest", "latest"));

    // The meta cluster packs right-to-left, so an unpublished draft (no assets,
    // no downloads) used to shove its tag and author 90px right of every other
    // row's. Each datum keeps its column and goes invisible instead of absent.
    const downloads = rel.assets.reduce((sum, a) => sum + (a.downloadCount || 0), 0);
    const meta: HTMLElement[] = [
      span(rel.tagName, "sec-mono rel-tag"),
      blankable(span(rel.author?.login ?? "", "rel-author"), !!rel.author?.login),
      withClass(
        blankable(statBit("file", rel.assets.length, "", "assets"), rel.assets.length > 0),
        // NOT "rel-assets" — that name already belongs to the detail page's
        // vertical asset list (`flex-direction: column`), which stacked this
        // row's file icon over its number and pushed the digit onto the row's
        // bottom border.
        "rel-asset-count",
      ),
      // Download counts run from "12" to "1,240"; without a floor the column
      // moved every element to its LEFT by the difference.
      withClass(
        blankable(statBit("cloud-download", downloads), downloads > 0),
        "rel-downloads",
      ),
    ];

    const row = secRow({
      lead,
      title: rel.name || rel.tagName,
      titleSuffix: suffix,
      meta,
      time: rel.publishedAt ? relTimeISO(rel.publishedAt) : "draft",
      timeTitle: rel.publishedAt ? `Published ${absTimeISO(rel.publishedAt)}` : "Unpublished draft",
      ariaLabel: `Release ${rel.name || rel.tagName}`,
      onOpen: () => nav("releases", { number: rel.id }),
    });
    row.dataset.num = String(rel.id);
    return row;
  };

  const buildTagRow = (t: TagInfo): HTMLElement =>
    secRow({
      lead: (() => {
        const s = el("span", "gh-lead-icon is-muted");
        s.appendChild(glyph("tag"));
        return s;
      })(),
      title: t.name,
      meta: [span(t.sha.slice(0, 7), "sec-mono")],
      ariaLabel: `Tag ${t.name}`,
      onOpen: () => openTagPeek(t, nav, refresh),
    });

  const rerenderList = (): void => {
    const q = query.toLowerCase();
    listEl.replaceChildren();
    if (releaseTab === "releases") {
      if (!releases) return;
      if (releases.length === 0) {
        listEl.appendChild(
          emptyState("No releases yet", "Publish your first release to share builds and notes.", {
            icon: "tag",
            action: { label: "New release", icon: "plus", onClick: () => sectionNav?.("releasenew") },
          }),
        );
        return;
      }
      // "Latest" is the newest published, NON-PRE-RELEASE release — github.com's
      // own rule. Taking the first non-draft awarded the badge to a release
      // candidate whenever one was newest, so the list pointed at the RC instead
      // of the build people are actually running. "Which version is current?" is
      // the question this badge exists to answer.
      const latestId = releases.find((r) => !r.draft && !r.prerelease)?.id;
      const items = q
        ? releases.filter((rel) => `${rel.name} ${rel.tagName}`.toLowerCase().includes(q))
        : releases;
      // AFTER the filter, and with both numbers: the pill used to advertise
      // the unfiltered total directly above a "No matching …" empty state.
      header.setCount?.(items.length, releases.length);
      if (items.length === 0) {
        listEl.appendChild(emptyState("No matching releases", `Nothing matches “${query}”.`, { icon: "search", anchor: "inline" }));
        return;
      }
      for (const rel of items) listEl.appendChild(buildReleaseRow(rel, latestId));
    } else {
      if (!tags) return;
      if (tags.length === 0) {
        listEl.appendChild(emptyState("No tags", "This repository has no git tags yet.", { icon: "tag" }));
        return;
      }
      const items = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags;
      header.setCount?.(items.length, tags.length);
      if (items.length === 0) {
        listEl.appendChild(emptyState("No matching tags", `Nothing matches “${query}”.`, { icon: "search", anchor: "inline" }));
        return;
      }
      for (const t of items) listEl.appendChild(buildTagRow(t));
    }
  };

  if (releases || tags) rerenderList();

  try {
    if (releaseTab === "releases") {
      const fresh = await gget("release:list", undefined, 30000);
      if (!view.isConnected) return;
      releases = fresh;
    } else {
      const fresh = await gget("release:tags", undefined, 30000);
      if (!view.isConnected) return;
      tags = fresh;
    }
    rerenderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!releases && !tags) {
      listEl.replaceChildren(
        errorState(
          releaseTab === "releases" ? "Couldn't load releases" : "Couldn't load tags",
          cleanErr(e) || "GitHub request failed.",
          refresh,
        ),
      );
    }
  }
}

// ── The tag peek (commit info + deliberate actions) ──────────────────────────

/** A tag's lightweight drill-in: what it points at (from the LOCAL clone, when
 *  fetched) + Draft release / View in Commits / Copy SHA. */
function openTagPeek(t: TagInfo, nav: SectionNav, refresh: () => void): void {
  openPeek({
    icon: "tag",
    title: t.name,
    subtitle: t.sha ? `at ${t.sha.slice(0, 7)}` : undefined,
    actions: [
      {
        label: "Copy SHA",
        icon: "copy",
        onClick: () => void copyText(t.sha, "Tag SHA copied."),
      },
      {
        label: "View in Commits",
        icon: "git-commit",
        title: "Open this tag's commit",
        onClick: (ctx) => {
          ctx.close();
          nav("commit", { sha: t.sha });
        },
      },
      {
        label: "Draft release",
        icon: "plus",
        primary: true,
        title: `Draft a new release from ${t.name}`,
        onClick: (ctx) => {
          ctx.close();
          sectionNav?.("releasenew", { ref: t.name });
        },
      },
    ],
    async render(body) {
      // The tag's commit, read from the local clone — the sha comes from GitHub,
      // so an unfetched tag simply isn't inspectable yet (a state, not an error).
      let d: CommitDetailsPayload | undefined;
      try {
        d = t.sha ? await host.invoke("commit:details", t.sha) : undefined;
      } catch {
        d = undefined;
      }
      body.replaceChildren();
      if (!d) {
        // The copy told you to fetch and then offered no way to do it — an
        // instruction with no affordance is a dead end.
        body.appendChild(
          emptyState(
            "Commit not in the local clone",
            "Fetch from the remote to inspect what this tag points at.",
            {
              icon: "cloud-download",
              action: {
                label: "Fetch",
                icon: "sync",
                onClick: () => {
                  void host
                    .invoke("sync:fetch", undefined)
                    .then(() => {
                      toast("Fetched. Reopen the tag to inspect its commit.", "success");
                    })
                    .catch((e) => toast(cleanErr(e) || "Fetch failed.", "error"));
                },
              },
            },
          ),
        );
        return;
      }
      const card = el("div", "gh-tag-commit-card");
      const subj = el("div", "gh-tag-commit-subject");
      subj.textContent = d.subject;
      const who = el("div", "gh-tag-commit-meta");
      who.textContent = `${d.author} · ${relTime(d.authorDate)} · ${d.files.length} file${d.files.length === 1 ? "" : "s"} changed`;
      who.title = absTime(d.authorDate);
      card.append(subj, who);
      if (d.body) {
        const msg = el("pre", "gh-tag-commit-body");
        msg.textContent = d.body;
        card.appendChild(msg);
      }
      body.appendChild(card);
    },
  });
}

// ── The release detail page ──────────────────────────────────────────────────

function showReleaseDetailPage(
  wrap: HTMLElement,
  nav: SectionNav,
  id: number,
  /** Where this was opened FROM. The Inbox opens releases, and back and Escape
   *  belong to the Inbox — not to whichever section owns the subject. Same
   *  contract Issues and PRs already honour. */
  from?: { view: string; label: string },
): void {
  const back = (): void => nav(from?.view ?? "releases", { list: true });
  const reload = (): void => {
    bust("release");
    showReleaseDetailPage(wrap, nav, id, from);
  };

  const { view, main, rail, topActions } = detailPage({
    backLabel: from?.label ?? "Releases",
    onBack: back,
  });
  main.appendChild(skeletonList(4, false));
  wrap.replaceChildren(view);

  void (async () => {
    let full: ReleaseInfo | undefined;
    try {
      full = await gget("release:detail", id, 15000);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState("Couldn't load the release", cleanErr(e) || "GitHub request failed.", reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!full) {
      main.replaceChildren(emptyState("Release unavailable", "This release couldn't be loaded."));
      return;
    }
    buildReleaseDetail({ main, rail, topActions, rel: full, nav, reload, back });
  })();
}

interface ReleaseDetailCtx {
  main: HTMLElement;
  rail: HTMLElement;
  topActions: HTMLElement;
  rel: ReleaseInfo;
  nav: SectionNav;
  reload: () => void;
  back: () => void;
}

function buildReleaseDetail(ctx: ReleaseDetailCtx): void {
  const { main, rail, topActions, rel, nav, reload, back } = ctx;
  main.replaceChildren();
  rail.replaceChildren();
  wireProseNav(main, nav);

  // ── top-bar actions ──
  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("pencil"), span("Edit"));
  editBtn.title = "Edit this release";
  editBtn.addEventListener("click", () => sectionNav?.("releasenew", { number: rel.id }));

  const moreBtn = el("button", "mini-btn gh-icon-btn");
  moreBtn.append(glyph("ellipsis"));
  moreBtn.title = "More actions";
  moreBtn.addEventListener("click", () =>
    openMenu(moreBtn, [
      { label: "Copy link", icon: "copy", onClick: () => void copyText(rel.htmlUrl, "Copied release link.") },
      // A draft page said "unpublished draft" and then offered Edit, Copy link,
      // Delete and Open on GitHub — every action except the one the word
      // "draft" exists to prompt.
      ...(rel.draft
        ? [
            { separator: true },
            {
              label: "Publish release",
              icon: "rocket",
              title: `Publish ${rel.tagName} — it becomes visible to everyone`,
              onClick: () => void publishRelease(rel, moreBtn, reload),
            },
          ]
        : []),
      { separator: true },
      {
        label: "Delete release",
        icon: "trash",
        onClick: () => void deleteRelease(rel, moreBtn, back),
      },
    ]),
  );

  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = "Open this release on GitHub";
  openBtn.setAttribute("aria-label", openBtn.title);
  openBtn.addEventListener("click", () => window.open(rel.htmlUrl, "_blank"));

  topActions.replaceChildren(editBtn, moreBtn, openBtn);

  // ── title block ──
  const titleRow = el("div", "det-title-row");
  // The list marks a release with every badge that applies — Pre-release AND
  // Latest, say — and this page reduced all of it to one, so opening a row you
  // had picked out as "Pre-release" showed you a release labelled "Published".
  // Same pills, same rules, computed from the same list.
  const pills = el("div", "det-title-pills");
  if (rel.draft) pills.appendChild(statePill("Draft", "draft"));
  if (rel.prerelease) pills.appendChild(statePill("Pre-release", "prerelease"));
  if (!rel.draft && !rel.prerelease) pills.appendChild(statePill("Published", "latest"));
  titleRow.appendChild(pills);
  // "Latest" is a property of the LIST, not of one release, so it needs the
  // list to answer — from cache, without blocking the page on a request.
  void gget("release:list", undefined, 30000)
    .then((all) => {
      if (!pills.isConnected) return;
      if (!rel.draft && !rel.prerelease && all.find((r) => !r.draft && !r.prerelease)?.id === rel.id) {
        pills.appendChild(statePill("Latest", "latest"));
      }
    })
    .catch(() => {
      /* offline — the other pills still tell the truth */
    });
  const h = el("h1", "det-title");
  h.textContent = rel.name || rel.tagName;
  titleRow.appendChild(h);
  main.appendChild(titleRow);

  const sub = el("div", "det-sub");
  const tagChip = el("button", "gh-branch-chip");
  tagChip.append(glyph("tag"), span(rel.tagName));
  tagChip.title = "Copy the tag name";
  tagChip.addEventListener("click", () => void copyText(rel.tagName, "Tag name copied."));
  sub.appendChild(tagChip);
  const when = el("span");
  when.textContent = rel.publishedAt
    ? `published ${relTimeISO(rel.publishedAt)}`
    : "unpublished draft";
  if (rel.publishedAt) when.title = absTimeISO(rel.publishedAt);
  sub.appendChild(when);
  main.appendChild(sub);

  // ── notes ──
  if (rel.body && rel.body.trim()) {
    const notes = el("div", "gh-body-md");
    notes.innerHTML = renderMarkdown(rel.body);
    main.appendChild(notes);
  } else {
    main.appendChild(emptyState("No release notes", "This release has no description."));
  }

  // ── assets (download / upload / delete — no browser round-trips) ──
  const assetsHead = el("div", "rel-assets-head");
  assetsHead.appendChild(groupLabel(`Assets (${rel.assets.length})`));
  const uploadBtn = el("button", "mini-btn");
  uploadBtn.append(glyph("cloud-upload"), span("Upload assets…"));
  uploadBtn.title = "Attach local files to this release";
  uploadBtn.addEventListener("click", () => void uploadAssets(rel, uploadBtn, reload));
  assetsHead.appendChild(uploadBtn);
  main.appendChild(assetsHead);
  if (rel.assets.length) {
    const list = el("div", "rel-assets");
    for (const a of rel.assets) {
      // The row is a DIV, not a button. It used to be a <button> with the
      // delete <button> nested inside it, which is invalid: the outer row's
      // accessible name swallows the inner control ("Download x" absorbing
      // "Delete x from this release"), assistive tech cannot reach the inner
      // one, and a single click can dispatch on both. The download is now the
      // row's own trailing action, and delete is its sibling.
      const row = el("div", "list-row is-clickable rel-asset-row");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.appendChild(glyph("package"));
      const m = el("div", "row-meta");
      const t = el("div", "row-meta-title");
      t.textContent = a.label || a.name;
      const subT = el("div", "row-meta-sub");
      // Grouped like every other count in the app — the rail above this list already
      // wrote the same figure as "48,200" while these rows wrote "48200".
      subT.textContent = `${fmtBytes(a.size)} · ${plural(a.downloadCount, "download")}`;
      m.append(t, subT);
      row.append(m);
      const download = (): void => void window.open(a.downloadUrl, "_blank");
      const acts = el("span", "rel-asset-acts");
      const del = el("button", "icon-btn rel-asset-del");
      del.appendChild(glyph("trash"));
      del.title = `Delete ${a.name} from this release`;
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void deleteAsset(a.id, a.name, del, reload);
      });
      const dl = el("button", "icon-btn rel-asset-dl");
      dl.appendChild(glyph("cloud-download"));
      dl.title = `Download ${a.name}`;
      dl.setAttribute("aria-label", dl.title);
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        download();
      });
      acts.append(del, dl);
      row.appendChild(acts);
      row.setAttribute("aria-label", `Download ${a.name}`);
      row.title = `Download ${a.name}`;
      row.addEventListener("click", download);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          download();
        }
      });
      list.appendChild(row);
    }
    main.appendChild(list);
  } else {
    const none = el("div", "rel-assets-none");
    none.textContent = "No assets on this release yet.";
    main.appendChild(none);
  }

  // ── rail ──
  const tagProp = propSection("Tag");
  const tagBtn = el("button", "det-mono-btn");
  tagBtn.append(glyph("copy"), span(rel.tagName));
  tagBtn.title = "Copy the tag name";
  tagBtn.addEventListener("click", () => void copyText(rel.tagName, "Tag name copied."));
  tagProp.body.appendChild(tagBtn);

  const authorProp = propSection("Author");
  if (rel.author?.login) {
    authorProp.body.appendChild(personChip(rel.author.login, rel.author.avatarUrl));
  } else {
    authorProp.body.appendChild(span("—", "det-prop-none"));
  }

  const about = propSection("About");
  about.body.classList.add("det-prop-facts");
  const fact = (k: string, v: string, title?: string): HTMLElement => {
    const row = el("div", "det-fact");
    const val = el("span", "det-fact-v");
    val.textContent = v;
    if (title) val.title = title;
    row.append(span(k, "det-fact-k"), val);
    return row;
  };
  if (rel.targetCommitish) about.body.appendChild(fact("Target", rel.targetCommitish));
  about.body.appendChild(fact("Assets", String(rel.assets.length)));
  const downloads = rel.assets.reduce((sum, a) => sum + (a.downloadCount || 0), 0);
  if (downloads > 0) about.body.appendChild(fact("Downloads", downloads.toLocaleString()));
  about.body.appendChild(fact("Created", relTimeISO(rel.createdAt), absTimeISO(rel.createdAt)));
  if (rel.publishedAt) {
    about.body.appendChild(fact("Published", relTimeISO(rel.publishedAt), absTimeISO(rel.publishedAt)));
  }

  rail.append(tagProp.root, authorProp.root, about.root);
}

/** Pick local files (native dialog, in MAIN) and upload them as release assets. */
async function uploadAssets(rel: ReleaseInfo, btn: HTMLElement, reload: () => void): Promise<void> {
  const b = btn as HTMLButtonElement;
  b.disabled = true;
  try {
    const r = await host.invoke("release:uploadAssets", { id: rel.id });
    if (!r.ok) {
      // A cancelled picker is a non-event, not an error toast.
      if (!r.expected) toast(r.message ?? "Couldn't upload the assets.", "error");
      return;
    }
    toast(r.message ?? "Assets uploaded.", "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't upload the assets.", "error");
  } finally {
    b.disabled = false;
  }
}

async function deleteAsset(
  id: number,
  name: string,
  btn: HTMLElement,
  reload: () => void,
): Promise<void> {
  const ok = await confirmDialog({
    title: `Delete asset ${name}?`,
    message: "This permanently removes the file from the release on GitHub.",
    confirmLabel: "Delete asset",
    danger: true,
  });
  if (!ok) return;
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("release:deleteAsset", id);
    if (!r.ok) {
      toast(r.message ?? "Couldn't delete the asset.", "error");
      return;
    }
    toast(`Deleted ${name}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't delete the asset.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

// ── CRUD actions ──

/** Draft a new release; `prefillTag` comes from a tag peek. */
async function deleteRelease(rel: ReleaseInfo, btn: HTMLElement, back: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: `Delete release ${rel.name || rel.tagName}?`,
    message: `This permanently deletes the release on GitHub. The git tag ${rel.tagName} is not removed. This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("release:delete", rel.id);
    if (!r.ok) {
      toast(r.message ?? "Couldn't delete the release.", "error");
      return;
    }
    toast(`Deleted release ${rel.name || rel.tagName}.`, "success");
    bust("release");
    back(); // the detail's subject no longer exists — land on the list
  } catch (e) {
    toast(cleanErr(e) || "Couldn't delete the release.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

/*
 * `createRelease`, `editRelease` and `releaseFormDialog` used to live here: a
 * 560px modal card with the release notes squeezed into ~180px of it. They are
 * `views/releaseCompose.ts` now — a routed page, reached through
 * `sectionNav("releasenew")` above.
 */

/** Flip a draft release to published — the action the word "draft" implies. */
async function publishRelease(rel: ReleaseInfo, btn: HTMLElement, reload: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: `Publish ${rel.tagName}?`,
    message:
      "The release becomes visible to everyone with access to the repository, and its assets become downloadable.",
    confirmLabel: "Publish",
  });
  if (!ok) return;
  await runBusy(btn, async () => {
    try {
      const r = await host.invoke("release:update", {
        id: rel.id,
        tagName: rel.tagName,
        name: rel.name ?? undefined,
        body: rel.body ?? undefined,
        prerelease: rel.prerelease,
        draft: false,
      });
      if (!r.ok) {
        toast(r.message ?? "Couldn't publish the release.", "error");
        return;
      }
      toast(`Published ${rel.tagName}.`, "success");
      bust();
      reload();
    } catch (e) {
      toast(cleanErr(e) || "Couldn't publish the release.", "error");
    }
  });
}
