// Repositories — everything you have, and everything you could have.
//
// This used to live in two places that each told half the story: a card in
// Settings listing local clones, and a dropdown on the top bar for switching
// between the handful you had opened. Neither answered the question people
// actually arrive with, which is "where is my work, and how do I get to it".
//
// So: one destination, two sides.
//
//   LOCAL   — grouped by the folder it was found in, because that is how
//             people think about it ("the client stuff is in ~/work"). Folders
//             are added here, and the app adds them itself whenever you open
//             or clone something (see main.ts rememberRepoFolder), so a repo
//             you cloned from a terminal months ago is simply present.
//
//   REMOTE  — your repositories, the ones you collaborate on, and every
//             organisation you belong to, with one click to clone. A remote
//             repo you already have on disk says "Open" instead of "Clone",
//             because offering to clone something twice is how you end up with
//             two copies and no idea which one you edited.
//
// The clone destination is the app's configured folder by default, with the
// other tracked folders and a one-off picker a click away — the point being
// that the common case is one click and the uncommon case is still on screen.

import { el, span, glyph, openMenu, avatar, emptyState, relTimeISO, copyText } from "../ui";
import type { MenuItem } from "../ui";
import { toast, confirmDialog } from "../dialogs";
import { didUndoable } from "../undo";
import { openCloneDialog } from "../cloneDialog";
import { host } from "../bridge";
import { editorItems, hasEditor, loadEditors, openInButton, REVEAL_LABEL } from "../openIn";
import { repoStateBits, repoStateWords } from "../repoState";
import { gget, bust } from "../cache";
import {
  ghHeader,
  sectionList,
  secRow,
  segmented,
  searchField,
  whereChip,
  wireStickyHeads,
  type StickyList,
  type SectionRender,
  type SectionNav,
} from "./common";
import type { EditorsView, GhRepoBrief, LocalCopy, LocalRepoStatus, RepoFolder } from "../../shared/ipc";
import { MAX_LOCAL_REPOS } from "../../shared/repoGrouping";
import { splitBand } from "../../shared/repoGrouping";
import { middlePath, openPath, openLocalCopy, localCopyIndex } from "../localCopy";
import { plural } from "../textFit";

type Side = "local" | "remote";

/** Which side was last on screen — kept across visits, like every other view. */
let side: Side = "local";
let query = "";
/** Set by the mounted view so its empty state can clear the box it is about. */
let clearFilter: () => void = () => {};

export const renderRepositories: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const head = ghHeader("Repositories", undefined, () => void refresh(true));
  const tools = el("div", "gh-head-tools");

  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("folder-opened"), span("Open…"));
  openBtn.title = "Open a repository from anywhere on this machine";
  openBtn.addEventListener("click", () => void openFromDisk(nav));

  const addBtn = el("button", "mini-btn");
  addBtn.append(glyph("new-folder"), span("Add folder…"));
  addBtn.title = "Track a folder so every repository inside it is listed here";
  addBtn.addEventListener("click", () => void addFolder(refresh));

  // "open and clone buttons and menus can be part of the same screens" — this
  // screen had Open and per-row Clone but no way to clone a URL somebody sent
  // you, which is how most clones actually start. The screen that is about
  // repositories should be able to get one.
  const cloneBtn = el("button", "mini-btn");
  cloneBtn.append(glyph("repo-clone"), span("Clone…"));
  cloneBtn.title = "Clone a repository from a URL";
  cloneBtn.addEventListener("click", () =>
    openCloneDialog((root) => {
      bust("repos");
      void host.invoke("repo:openPath", root).then((info) => {
        if (info) nav("code");
      });
    }),
  );

  const seg = segmented<Side>({
    options: [
      { value: "local", label: "On this machine", icon: "device-desktop" },
      { value: "remote", label: "On GitHub", icon: "cloud" },
    ],
    value: side,
    ariaLabel: "Which repositories to show",
    onChange: (v) => {
      side = v;
      void refresh();
    },
  });

  const search = searchField({
    placeholder: "Filter repositories…",
    initial: query,
    onInput: (v) => {
      query = v;
      void refresh();
    },
  });
  clearFilter = (): void => {
    query = "";
    const input = search.querySelector("input");
    if (input) input.value = "";
    void refresh();
  };

  // The verbs go in the shared wrapper, which is what pins them to the right
  // while the segment and the filter stay beside the title.
  const verbs = el("div", "gh-head-verbs");
  verbs.append(openBtn, cloneBtn, addBtn);
  tools.append(seg, search, verbs);
  const { view, listEl } = sectionList();
  // `sectionList` hands back a shell and a list and leaves the assembly to the
  // caller — the same order every other section uses.
  head.querySelector(".gh-acct")?.before(tools);
  if (!tools.isConnected) head.appendChild(tools);
  view.append(head, listEl);
  // A pinned head has to LOOK pinned. Both tabs' heads pin in this one
  // scroller, and listEl outlives every repaint, so one call covers both.
  wireStickyHeads(listEl, ".repo-owner-head, .repo-folder-head");
  wrap.replaceChildren(view);

  // Only the latest paint may write the list. Switching to "On GitHub" and
  // straight back left the GitHub request running; it answered a second later
  // and painted GitHub's repositories under "On this machine" (#32).
  let paintGen = 0;
  async function refresh(force = false): Promise<void> {
    const gen = ++paintGen;
    const current = (): boolean => gen === paintGen && listEl.isConnected;
    if (force) bust("repos");
    // The count filler and the column measure belong to the paint that set
    // them; a new paint (either side) starts without either.
    (listEl as RepoList).fillCounts = undefined;
    (listEl as RepoList).realign = undefined;
    listEl.replaceChildren(el("div", "skeleton"));
    try {
      if (side === "local") await paintLocal(listEl, nav, refresh, current);
      else await paintRemote(listEl, nav, refresh, current);
    } catch (e) {
      if (!current()) return;
      listEl.replaceChildren(
        emptyState("Couldn’t list repositories", String((e as Error)?.message ?? e), { icon: "warning" }),
      );
    }
    if (!current()) return;
    // Repositories, not checkouts: a worktree row renders (it is openable)
    // but the page's number must agree with the band heads below it.
    head.setCount?.(listEl.querySelectorAll(".sec-row:not([data-worktree])").length);
    // New head elements every paint, and a repaint fires no scroll event.
    (listEl as StickyList).syncSticky?.();
  }

  await refresh();
}

/** 1284 → "1.3k", 121000 → "121k" — a star count you can read at a glance. */
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** The q a row must match, lowercased once. */
function matches(hay: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || hay.toLowerCase().includes(q);
}

// ── local ──────────────────────────────────────────────────────────────────

async function paintLocal(
  listEl: HTMLElement,
  nav: SectionNav,
  refresh: () => Promise<void>,
  current: () => boolean,
): Promise<void> {
  // The editors come in the SAME wait as the rows, so every row paints with
  // its final controls: a split button that arrived afterwards would push the
  // Open beside it sideways under the pointer.
  const [folders, copies, truncated, editors] = await Promise.all([
    gget("repos:folders", undefined, 5000),
    gget("repos:local", undefined, 5000),
    gget("repos:scanTruncated", undefined, 5000).catch(() => false),
    loadEditors(),
  ]);
  if (!current()) return;

  // A pure join. Every question about where a repository lives — which folder
  // claims it, which directory inside that folder, whether a tracked folder is
  // itself inside another one — was answered in the main process, on real
  // paths, in the same pass that produced the counts. There is no path
  // arithmetic left here; the previous version's `parentOf(root) ===
  // folder.path` is what put nineteen of this machine's twenty-seven
  // repositories under a heading claiming they came from somewhere else.
  const rows: HTMLElement[] = [];

  // A tracked folder nested inside another renders as a GROUP in that one's
  // band, not as a band of its own — so it keeps the alphabetical place its
  // path gives it, and its parent's count includes it.
  const bands = folders.filter((f) => !f.nestedIn);
  const trackedGroups = new Map<string, RepoFolder>();
  for (const f of folders) {
    if (f.nestedIn) trackedGroups.set(`${f.nestedIn}\u0000${f.group ?? ""}`, f);
  }

  for (const band of bands) {
    const mine = copies.filter((c) => c.band === band.path);
    const { loose, groups } = splitBand(band.path, mine, (c) => c.group ?? "");

    // Filtering hides what does not match, but never the band itself while
    // nothing is typed: "I added this and nothing appeared" is a question the
    // screen has to answer rather than leave you guessing at.
    const shownLoose = loose.filter(matchesCopy);
    const shownGroups = groups
      .map((g) => ({ ...g, items: g.items.filter(matchesCopy) }))
      .filter((g) => g.items.length > 0);
    // The filtered number the head prints beside "of M repositories" — M
    // excludes worktrees, so N must too or a filter can read "5 of 3".
    const isRepo = (c: LocalCopy): boolean => !c.worktreeOf;
    const shown =
      shownLoose.filter(isRepo).length +
      shownGroups.reduce((n, g) => n + g.items.filter(isRepo).length, 0);
    if (query.trim() && !shown) continue;

    rows.push(folderHeader(band, refresh, query.trim() ? shown : undefined));
    if (!shown && !query.trim()) {
      const none = el("div", "repo-folder-empty");
      none.textContent = band.missing
        ? "This folder is gone. Stop tracking it, or put it back."
        : "No repositories in this folder yet.";
      rows.push(none);
      continue;
    }

    // The plain repositories first, at the band's own indent and outside every
    // fold — "there are plain repos there" was half of what was reported, and
    // burying them under the projects would answer only the other half.
    for (const c of shownLoose) rows.push(localRow(c, nav, refresh, "band", editors));

    for (const g of shownGroups) {
      const tracked = trackedGroups.get(`${band.path}\u0000${g.label}`);
      const head = groupHead(g.label, g.path, g.items.length, tracked, refresh);
      rows.push(head);
      const folded = !query.trim() && isFolded(g.path);
      for (const c of g.items) {
        const row = localRow(c, nav, refresh, "group", editors);
        // Folding HIDES rather than removes: the page's own count must not
        // report that repositories ceased to exist because a folder was
        // closed, and list navigation already skips anything with no
        // offsetParent.
        if (folded) row.hidden = true;
        row.dataset.group = g.path;
        rows.push(row);
      }
      applyFoldState(head, g.path, folded);
    }
  }

  // Anything inside none of the tracked folders — a repository opened once
  // from a folder the app declined to remember, like the home directory
  // itself. On this machine that is now nothing at all, which is the point.
  const loose = copies.filter((c) => !c.band && matchesCopy(c));
  if (loose.length) {
    rows.push(groupLabel("Opened from elsewhere"));
    for (const c of loose) rows.push(localRow(c, nav, refresh, "loose", editors));
  }

  // The scan stops at a cap, and a capped list must not present itself as an
  // inventory — that's how a machine with 350 repositories reads "300" with a
  // straight face. Only ever a NOTE at the bottom: everything above is real.
  if (truncated && !query.trim()) {
    const capped = el("div", "repo-scan-capped");
    capped.textContent =
      `The scan stops at ${MAX_LOCAL_REPOS} repositories — there may be more. ` +
      "Tracking fewer, more specific folders keeps this list complete.";
    rows.push(capped);
  }

  if (!rows.length) {
    listEl.replaceChildren(
      query.trim()
        ? emptyState("Nothing matches", `No repository matches “${query.trim()}”.`, {
            // Clears the FILTER. This reloaded the entire application — the
            // heaviest possible response to a text box having the wrong four
            // characters in it, throwing away every other piece of state on the
            // way.
            secondary: { label: "Clear filter", onClick: () => clearFilter() },
          })
        : emptyState(
            "No repositories yet",
            "Add a folder you keep repositories in, or clone one from GitHub.",
          ),
    );
    return;
  }
  listEl.replaceChildren(...rows);
  alignActions(listEl, current);

  // The change counts, AFTER the list is on screen — "which of these has work
  // in it" must never hold the list up for a git process per repository.
  const fill = countFiller(listEl, current);
  (listEl as RepoList).fillCounts = fill;
  void fill();
}

/** How many roots one `repos:localStatus` request carries: main answers at
 *  most this many (STATUS_ROOTS_CAP) and drops the rest. */
const STATUS_BATCH = 16;

/** The list, carrying what the paint on screen left behind for a folder that
 *  unfolds: the count filler, to ask about the rows it has just revealed, and
 *  the column measure, since hidden rows could not be measured. */
type RepoList = HTMLElement & { fillCounts?: () => Promise<void>; realign?: () => void };

/** A row's accessible name before any counts were added to it. */
const baseLabels = new WeakMap<HTMLElement, string>();

/**
 * Fill in "●3 ↑1 ↓2" for the rows this paint RENDERED — not a folded
 * folder's (they are asked for when it opens), not a missing clone (git has
 * nothing to say about a folder that is gone) — in batches the main process
 * will answer whole.
 *
 * Every write is guarded by `current()`: a newer paint owns the list, and its
 * rows carry the same roots, so an answer that arrives late for THIS paint
 * would otherwise land in them — older than what they already show.
 */
function countFiller(listEl: HTMLElement, current: () => boolean): () => Promise<void> {
  const asked = new Set<string>();
  return async () => {
    const todo = [...listEl.querySelectorAll<HTMLElement>(".repo-row[data-root]")]
      .filter((r) => !r.hidden && r.dataset.missing === undefined)
      .map((r) => r.dataset.root ?? "")
      .filter((root) => root && !asked.has(root));
    for (const root of todo) asked.add(root);
    for (let i = 0; i < todo.length; i += STATUS_BATCH) {
      if (!current()) return;
      const batch = todo.slice(i, i + STATUS_BATCH);
      let status: Record<string, LocalRepoStatus | undefined>;
      try {
        status = await gget("repos:localStatus", batch, 10_000);
      } catch {
        continue; // a bonus, never a failure — the rows already say what you have
      }
      if (!current()) return;
      for (const root of batch) paintCounts(listEl, root, status?.[root]);
    }
  };
}

/** Write one repository's counts into its row's reserved slot. */
function paintCounts(listEl: HTMLElement, root: string, st: LocalRepoStatus | undefined): void {
  const row = listEl.querySelector<HTMLElement>(`.repo-row[data-root="${cssEscape(root)}"]`);
  const slot = row?.querySelector<HTMLElement>(".repo-state");
  if (!row || !slot) return;
  slot.replaceChildren(...repoStateBits(st));
  const words = repoStateWords(st);
  const base = baseLabels.get(row) ?? row.getAttribute("aria-label") ?? "";
  row.setAttribute("aria-label", words ? `${base}, ${words}` : base);
}

/** Does this copy survive the filter box? Its PATH counts too — searching
 *  "yugo" for a repository in ~/Developer/Yugo used to match nothing. */
function matchesCopy(c: LocalCopy): boolean {
  return matches(`${c.name} ${c.origin ?? ""} ${c.root}`);
}

// ── folding ────────────────────────────────────────────────────────────────
//
// Groups fold, and default OPEN. A screen that hides twenty-one of his
// twenty-seven repositories on first paint is the "where did my work go"
// report waiting to be filed; compression is something to ask for, not
// something to be given. "Collapse all projects" in the band menu is the one
// click that asks for it, and the choice sticks.

const FOLD_KEY = "gitstudio.repos.folded";

/** Folded group paths, read once per session and written on every change. */
let foldedPaths: Set<string> | null = null;

function folded(): Set<string> {
  if (foldedPaths) return foldedPaths;
  try {
    const raw = window.localStorage.getItem(FOLD_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    foldedPaths = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    foldedPaths = new Set(); // private window, cleared storage, malformed — open
  }
  return foldedPaths;
}

function isFolded(path: string): boolean {
  return folded().has(path);
}

function setFolded(path: string, on: boolean): void {
  const set = folded();
  if (on) set.add(path);
  else set.delete(path);
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify([...set]));
  } catch {
    /* the fold still applies for this session */
  }
}

/** Put a head and its rows into a state without repainting the list.
 *
 *  Never through refresh(): that replaces the list's children, which drops
 *  focus to <body> and restarts keyboard navigation at row 0 — a teleport,
 *  for a control whose whole job is to keep your place. */
function applyFoldState(head: HTMLElement, path: string, on: boolean): void {
  head.setAttribute("aria-expanded", on ? "false" : "true");
  // The chevron ROTATES; it is not a different glyph. `.repo-group-chevron` has
  // carried a transform transition since the day it was written, and the rest
  // of the app folds this way (.list-group-head, .outputs-group).
  head.classList.toggle("is-folded", on);
  const list = head.parentElement;
  if (!list) return;
  for (const row of list.querySelectorAll<HTMLElement>(`.sec-row[data-group="${cssEscape(path)}"]`)) {
    row.hidden = on;
  }
  // Rows a fold kept hidden were never asked about, nor measured; now they
  // are on screen.
  if (!on) {
    void (list as RepoList).fillCounts?.();
    (list as RepoList).realign?.();
  }
}

/** A path is not a CSS identifier — it has slashes, dots and spaces in it. */
function cssEscape(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

/** Owner sections share the local fold store, whose every key is an absolute
 *  path — an "owner:" prefix cannot collide with one. Nor can "@me" collide
 *  with a real owner: "@" is not legal in a GitHub login, and a login is unique
 *  across users AND organisations. The old grouping key also must never reach a
 *  data- attribute: the CSS tokenizer rewrites U+0000 to U+FFFD, so
 *  applyFoldState's [data-group="…"] would silently match no rows and folding
 *  would hide nothing. */
function ownerFoldKey(mine: boolean, owner: string): string {
  return mine ? "owner:@me" : `owner:${owner}`;
}

/**
 * A directory the scan found inside a tracked folder.
 *
 * Not a band: a band is a place you named, this is a place that was found.
 * The difference is carried by the class, the font and the indent rather than
 * by a label saying so — and by what it offers, which is what you can do to a
 * folder you have not asked the app to watch: look at it, copy it, or start
 * watching it.
 *
 * `tracked` is set when this directory IS a tracked folder in its own right,
 * which happens on any machine where a repository has been opened (that tracks
 * its parent). It then keeps its place in the list and gains the band's chip
 * and its full menu, rather than being torn out into a band of its own.
 */
function groupHead(
  label: string,
  path: string,
  count: number,
  tracked: RepoFolder | undefined,
  refresh: () => Promise<void>,
): HTMLElement {
  const h = el("div", "repo-group-head");
  h.dataset.group = path;
  h.setAttribute("role", "button");
  h.tabIndex = 0;

  const chevron = glyph("chevron-down");
  chevron.classList.add("repo-group-chevron");
  h.appendChild(chevron);
  h.appendChild(glyph("folder"));

  const name = span(label, "repo-group-name");
  name.title = path;
  h.appendChild(name);
  h.appendChild(span(String(count), "repo-group-count"));
  if (tracked) h.appendChild(span("tracked", "repo-folder-chip"));

  h.appendChild(el("span", "repo-folder-spring"));

  const more = el("button", "mini-btn gh-icon-btn repo-folder-menu");
  more.appendChild(glyph("ellipsis"));
  more.title = `Manage ${label}`;
  more.setAttribute("aria-label", more.title);
  more.setAttribute("aria-haspopup", "menu");
  more.addEventListener("click", (e) => {
    // The menu is not the fold. Without this, reaching for either does both.
    e.stopPropagation();
    openMenu(
      more,
      tracked
        ? folderMenu(tracked, refresh)
        : [
            {
              label: "Show in Finder",
              icon: "folder-opened",
              onClick: () => void host.invoke("repos:reveal", path),
            },
            {
              label: "Copy path",
              icon: "copy",
              onClick: () => void copyText(path, "Path copied."),
            },
            { separator: true },
            {
              label: "Track this folder",
              sub: "Watch it for new repositories",
              icon: "eye",
              onClick: () => void trackFolder(path, refresh),
            },
          ],
    );
  });
  h.appendChild(more);

  const toggle = (): void => {
    const next = !isFolded(path);
    setFolded(path, next);
    applyFoldState(h, path, next);
    (h.closest(".sec-list") as StickyList | null)?.syncSticky?.();
  };
  h.addEventListener("click", toggle);
  h.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== h) return; // the menu button keeps its own keys
    e.preventDefault();
    toggle();
  });
  return h;
}

/** Start watching a directory the scan found — the group menu's one verb. */
async function trackFolder(path: string, refresh: () => Promise<void>): Promise<void> {
  await host.invoke("repos:addFolderPath", path);
  bust("repos");
  await refresh();
  didUndoable(`Now watching ${path.split("/").pop()}.`, {
    label: "Stop watching it",
    undo: async () => {
      await host.invoke("repos:removeFolder", path);
      bust("repos");
    },
    after: refresh,
  });
}

function groupLabel(text: string): HTMLElement {
  // A category, not a folder: no icon, and CSS gives its label the icon
  // column's offset so it starts on the same x as every other band's path.
  const h = el("div", "repo-folder-head is-label");
  h.appendChild(span(text, "repo-folder-path"));
  return h;
}

function folderHeader(
  folder: RepoFolder,
  refresh: () => Promise<void>,
  shown?: number,
): HTMLElement {
  const h = el("div", "repo-folder-head" + (folder.missing ? " is-missing" : ""));
  h.appendChild(glyph(folder.isCloneDir ? "root-folder" : "folder"));
  const path = span(folder.display, "repo-folder-path");
  path.title = folder.path;
  h.appendChild(path);
  // What the band HOLDS, not what renders directly under it: a reader counting
  // the rows below a head is counting everything in the folder, groups
  // included. While filtering it says both, because "3 repositories" over
  // three of twenty-seven is a different fact than the same words unfiltered.
  const total = folder.containedCount;
  const n = span(
    shown === undefined
      ? total === 1
        ? "1 repository"
        : `${total} repositories`
      : `${shown} of ${total} repositories`,
    "repo-folder-count",
  );
  h.appendChild(n);
  if (folder.isCloneDir) {
    // Named, not just implied: this is where a one-click clone lands.
    const chip = el("button", "repo-folder-chip is-clone");
    chip.textContent = "clones land here";
    chip.title = "New clones go here unless you choose somewhere else — click to change it";
    chip.addEventListener("click", () => void moveCloneFolder(folder, refresh));
    h.appendChild(chip);
  }
  if (folder.missing) h.appendChild(span("missing", "repo-folder-chip is-warn"));

  const spring = el("span", "repo-folder-spring");
  h.appendChild(spring);

  // ONE menu, with words in it.
  //
  // This row used to carry up to three icon-only buttons — a folder, a
  // different folder, and an ×  — which between them meant "show in Finder",
  // "make this the clone folder" and "stop tracking", and said none of it
  // unless you hovered. The owner's read was that the folders could not be
  // managed at all, and on the clone folder he was right: it had no menu, no
  // remove, and no way to get the directory GitStudio had made in his home
  // folder back out of it.
  const more = el("button", "mini-btn gh-icon-btn repo-folder-menu");
  more.appendChild(glyph("ellipsis"));
  more.title = `Manage ${folder.display}`;
  more.setAttribute("aria-label", more.title);
  more.setAttribute("aria-haspopup", "menu");
  more.addEventListener("click", () => openMenu(more, folderMenu(folder, refresh)));
  h.appendChild(more);
  return h;
}

/** What you can do to a tracked folder. */
function folderMenu(folder: RepoFolder, refresh: () => Promise<void>): MenuItem[] {
  const items: MenuItem[] = [];
  if (!folder.missing) {
    items.push({
      label: "Show in Finder",
      icon: "folder-opened",
      onClick: () => void host.invoke("repos:reveal", folder.path),
    });
  }
  items.push({
    label: "Copy path",
    icon: "copy",
    onClick: () => void copyText(folder.path, "Path copied."),
  });
  items.push({ separator: true });

  // Scoped to THIS band, by path, because the bands and their groups are
  // siblings in one flat list — there is no per-band element to query inside.
  // Querying the whole document meant "Collapse all projects" in one tracked
  // folder's menu also collapsed every project in every other tracked folder,
  // and the "N folders" subtitle counted all of them, so the menu said out
  // loud that it was about to overreach and did it anyway.
  const groupsInBand = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(".repo-group-head")].filter((g) =>
      (g.dataset.group ?? "").startsWith(`${folder.path}/`),
    );
  const mine = groupsInBand();
  if (mine.length > 1) {
    const allFolded = mine.every((g) => isFolded(g.dataset.group ?? ""));
    items.push({
      label: allFolded ? "Expand all projects" : "Collapse all projects",
      sub: `${mine.length} folders`,
      icon: allFolded ? "unfold" : "fold",
      onClick: () => {
        // In place, never through a repaint: replacing the list drops focus to
        // <body> and restarts keyboard navigation at the first row.
        for (const g of groupsInBand()) {
          const path = g.dataset.group ?? "";
          setFolded(path, !allFolded);
          applyFoldState(g, path, !allFolded);
        }
      },
    });
    items.push({ separator: true });
  }
  if (folder.isCloneDir) {
    items.push({
      label: "Move the clone folder…",
      sub: "Choose where new clones land",
      icon: "root-folder",
      onClick: () => void moveCloneFolder(folder, refresh),
    });
    if (!folder.isDefaultCloneDir) {
      items.push({
        label: "Use the default folder",
        sub: "~/GitStudio",
        icon: "discard",
        onClick: () => void setCloneDir(null, folder, refresh),
      });
    }
    // The one the owner actually asked for: get this directory out of my home
    // folder. Offered only when it holds nothing — deleting a folder with
    // repositories in it is not something a menu item should be able to do —
    // and the main process re-checks, so a race ends in a message, not a loss.
    const repos = folder.containedCount;
    const checkouts = folder.containedAnyCount - repos;
    const holds =
      repos && checkouts
        ? `${repos === 1 ? "1 repository" : `${repos} repositories`} and ${checkouts === 1 ? "a worktree" : `${checkouts} worktrees`} are in it`
        : repos
          ? `${repos === 1 ? "1 repository is" : `${repos} repositories are`} in it`
          : checkouts
            ? `${checkouts === 1 ? "1 worktree is" : `${checkouts} worktrees are`} in it`
            : "";
    items.push({
      label: "Delete this folder",
      sub: holds || "It's empty — nothing is lost",
      icon: "trash",
      danger: true,
      // `containedAnyCount`, never `repoCount` or even `containedCount`. A
      // folder whose repositories all sit one level down reports zero DIRECT
      // ones, and a folder holding only WORKTREES reports zero repositories —
      // but trashing it eats those checkouts all the same. The guard counts
      // everything; the label says what kind.
      disabled: folder.containedAnyCount > 0 || folder.missing,
      title: folder.containedAnyCount
        ? "Move or delete what's inside it first"
        : `Delete ${folder.display} from disk`,
      onClick: () => void deleteEmptyFolder(folder, refresh),
    });
  } else {
    if (!folder.missing) {
      items.push({
        label: "Clone new repositories here",
        sub: "Makes this the clone folder",
        icon: "root-folder",
        onClick: () => void setCloneDir(folder.path, folder, refresh),
      });
    }
    items.push({
      label: "Stop tracking",
      sub: "Nothing on disk is touched",
      icon: "eye-closed",
      danger: true,
      onClick: () => void stopTracking(folder, refresh),
    });
  }
  return items;
}

async function moveCloneFolder(folder: RepoFolder, refresh: () => Promise<void>): Promise<void> {
  const picked = await host.invoke("clone:pickDir", { defaultPath: folder.path });
  if (!picked) return;
  await setCloneDir(picked, folder, refresh);
}

/** Point clones somewhere else — and be able to point them back. */
async function setCloneDir(
  next: string | null,
  _was: RepoFolder,
  refresh: () => Promise<void>,
): Promise<void> {
  // Where clones land RIGHT NOW, read before changing it.
  //
  // The first version worked this out from the folder the menu was opened on,
  // which is only the clone folder when you are moving the clone folder. Point
  // clones at ~/Code from ~/Code's own menu and the "previous" value was ~/Code
  // — so Undo set the setting to what it had just been changed to and reported
  // success. The previous value is a fact about the SETTING, not about the row.
  const before = await currentCloneDir();
  const r = await host.invoke("settings:update", { cloneDir: next });
  bust("repos");
  await refresh();
  didUndoable(`New clones will land in ${r.cloneDirDisplay}.`, {
    label: "Put the clone folder back",
    undo: async () => {
      // `null` restores the built-in default, which is what it meant on the
      // way in too.
      await host.invoke("settings:update", { cloneDir: before });
      bust("repos");
    },
    after: refresh,
  });
}

/** The configured clone folder, or null when it is the built-in default. */
async function currentCloneDir(): Promise<string | null> {
  const folders = await host.invoke("repos:folders", undefined);
  const clone = folders.find((f) => f.isCloneDir);
  return clone && !clone.isDefaultCloneDir ? clone.path : null;
}

async function stopTracking(folder: RepoFolder, refresh: () => Promise<void>): Promise<void> {
  await host.invoke("repos:removeFolder", folder.path);
  bust("repos");
  await refresh();
  didUndoable(`Stopped tracking ${folder.display}.`, {
    label: `Track ${folder.display} again`,
    undo: async () => {
      await host.invoke("repos:addFolderPath", folder.path);
      bust("repos");
    },
    after: refresh,
  });
}

async function deleteEmptyFolder(folder: RepoFolder, refresh: () => Promise<void>): Promise<void> {
  const r = await host.invoke("repos:deleteEmptyFolder", folder.path);
  if (!r.ok) {
    toast(r.message ?? "Couldn't delete that folder.", "error");
    return;
  }
  bust("repos");
  await refresh();
  // No undo entry: re-creating an empty directory would restore the folder but
  // not the fact that it was there, and offering "undo" for something that
  // leaves no trace to restore is theatre. It says what happened instead.
  toast(`Deleted ${folder.display}. It comes back the next time you clone.`, "success");
}

/**
 * Where a row sits, which decides two things: its indent, and whether the path
 * column still earns the 220px it takes.
 *
 * `band`   — directly in a tracked folder, at the band's own indent.
 * `group`  — inside a project folder found in one, indented a step further.
 * `loose`  — inside no tracked folder at all.
 */
type Place = "band" | "group" | "loose";

function localRow(
  c: LocalCopy,
  nav: SectionNav,
  refresh: () => Promise<void>,
  place: Place = "loose",
  editors: EditorsView = { editors: [] },
): HTMLElement {
  // No chips. The origin used to sit in the chip cluster, which follows the
  // NAME — and since the name flexes, every row started its origin at a
  // different x: five rows, five columns, 26px apart. Both the origin and the
  // path are answers to "which copy is this", so they belong together in the
  // fixed-width cluster on the right, where they line up.
  const pills: HTMLElement[] = [];
  if (c.current) pills.push(span("open", "gh-pill is-current"));
  if (c.missing) pills.push(span("missing", "gh-pill is-warn"));
  if (c.worktreeOf) {
    const wt = span("worktree", "gh-pill is-worktree");
    const of = c.worktreeOf.split("/").pop() || c.worktreeOf;
    wt.title = `A linked worktree of ${of} — another checkout of that repository, not a separate one`;
    pills.push(wt);
  }

  // THE ORIGIN SITS WITH THE NAME. Pinned against the far edge in the meta
  // cluster, behind a spring that grows, it sat ~470px from the name on a
  // 1280px window — and the SHORTER the name, the further away it was — so the
  // two facts that identify one row could not be read as one.
  // It goes FIRST, before the state pills: the title's column floor is what
  // makes the origin's left edge a column, and a pill in front of it would
  // break that column on the few rows that carry one.
  const titleSuffix: HTMLElement[] = [];
  if (c.origin) {
    const origin = span(c.origin, "repo-origin repo-origin-col sec-mono");
    origin.title = c.origin;
    titleSuffix.push(origin);
  }
  titleSuffix.push(...pills);

  const meta: HTMLElement[] = [];
  // The path column, only where nothing above the row already says it. Under a
  // head reading "Yugo", beside a title reading "backend", "…/Yugo/backend" is
  // the same fact for the third time — and it costs 220px the name and the
  // origin would rather have. A loose row has no head naming its location, so
  // it keeps it.
  if (place === "loose") {
    const where = span(middlePath(c.root), "repo-path sec-mono");
    where.title = c.root;
    meta.push(where);
  }
  // The change counts' place, reserved at paint: they arrive a moment later
  // (see countFiller), and a slot that only appeared then would shove the
  // columns to its left sideways. Empty for a clean or unreadable repository.
  meta.push(el("span", "repo-state"));

  const actions: HTMLElement[] = [];
  if (!c.missing && !c.current) {
    const open = el("button", "row-btn");
    open.textContent = "Open";
    open.setAttribute("aria-label", `Open ${c.name}`);
    open.addEventListener("click", () => void openPath(c.root, nav));
    actions.push(open);
  }
  // "A quicker way to open the repository in the editor — a button next to
  // Open instead of the three dots" (#32). The same split button the top bar
  // and Home carry, sized for the row. Not on a clone whose folder is gone,
  // and not at all without an editor: a control whose only answer is "No
  // editors found" does not earn a place on every row (the … menu still says
  // how to add one).
  const split = !c.missing && hasEditor(editors);
  if (split) {
    actions.push(openInButton({ root: () => c.root, nav: (v) => nav(v), row: true, editors }));
  }
  const more = el("button", "row-btn lv-menu-btn");
  more.setAttribute("aria-label", `More actions for ${c.name}`);
  more.setAttribute("aria-haspopup", "menu");
  more.appendChild(glyph("ellipsis"));
  more.addEventListener("click", async () => {
    // The editors are the split button's now — its chevron lists every one,
    // one control to the left. Listing them here too made two adjacent menus
    // open with the same rows. Without the button (no editor found) this menu
    // is still where "Add one in Settings" is said.
    const menuEditors: MenuItem[] =
      split || c.missing ? [] : [...editorItems(await loadEditors(), c.root, nav), { separator: true }];
    const items: MenuItem[] = [
      ...menuEditors,
      {
        label: REVEAL_LABEL,
        icon: "folder-opened",
        onClick: () => void host.invoke("repos:reveal", c.root),
      },
      {
        label: "Copy path",
        icon: "copy",
        onClick: () => void copyText(c.root, "Path copied."),
      },
    ];
    if (c.recent) {
      items.push({
        label: "Forget",
        sub: "Removes it from this list only",
        icon: "eye-closed",
        onClick: async () => {
          await host.invoke("repos:removeRecent", c.root);
          bust("repos");
          await refresh();
          didUndoable(`Forgot ${c.name}.`, {
            label: `Remember ${c.name}`,
            undo: async () => {
              await host.invoke("repos:restoreRecent", c.root);
              bust("repos");
            },
            after: refresh,
          });
        },
      });
    }
    // Trash ONLY for clones the app made. Everything else on this screen was
    // put there by somebody else, and deleting it is not this app's business.
    if (c.managed && !c.current) {
      items.push({
        label: "Move to Trash…",
        icon: "trash",
        danger: true,
        onClick: async () => {
          // The ellipsis promises a dialog, and there was none: one click sent
          // a whole working copy to the Trash. The undo below is a good safety
          // net but it is not a substitute for being asked — the folder can
          // hold uncommitted work, which is the one thing git cannot get back,
          // and a menu item next to "Copy path" should not be able to take it.
          const ok = await confirmDialog({
            title: `Move ${c.name} to the Trash?`,
            message:
              `The folder at ${c.root} goes to the Trash, including anything in it ` +
              `that has not been committed. You can put it back straight afterwards, ` +
              `or from the Trash later.`,
            confirmLabel: "Move to Trash",
            danger: true,
          });
          if (!ok) return;
          const r = await host.invoke("repos:trash", c.root);
          if (!r.ok) {
            toast(r.message ?? "Couldn't move it to the Trash.", "error");
            return;
          }
          bust("repos");
          await refresh();
          // Undo only when the app knows WHERE it went. When it doesn't, say
          // where to look instead of offering a button that would fail —
          // an undo you cannot honour is worse than none.
          if (r.trashed) {
            didUndoable(`Moved ${c.name} to the Trash.`, {
              label: `Put ${c.name} back`,
              undo: async () => {
                const back = await host.invoke("repos:untrash", { from: r.trashed!, to: c.root });
                if (!back.ok) return back.message ?? "Couldn't put it back.";
                // The list is cached; without this the folder is back on disk
                // and absent from the screen, which reads as a failed undo.
                bust("repos");
                return undefined;
              },
              after: refresh,
            });
          } else {
            toast(`Moved ${c.name} to the Trash — recover it from there.`, "success");
          }
        },
      });
    }
    openMenu(more, items);
  });
  actions.push(more);

  const row = secRow({
    lead: glyph(c.current ? "check" : "repo"),
    title: c.name,
    titleSuffix,
    meta,
    // No `time`: nothing on this screen has one, and `time: ""` still rendered
    // the slot (secRow branches on `!== undefined`), reserving an empty 58px
    // .sec-row-time column on every local row.
    actions,
    ariaLabel: [c.name, c.origin, c.current ? "currently open" : "", c.missing ? "missing" : ""]
      .filter(Boolean)
      .join(", "),
    onOpen: () => {
      if (!c.missing && !c.current) void openPath(c.root, nav);
    },
  });
  baseLabels.set(row, row.getAttribute("aria-label") ?? c.name);
  if (c.worktreeOf) row.dataset.worktree = "1";
  if (c.missing) row.dataset.missing = "1";
  // Tagged so the stylesheet can give the NAME priority over the
  // description beside it — see .repo-row in app.css, and so the indent can be
  // driven by where the row actually sits.
  row.classList.add("repo-row", `is-${place}`);
  // The absolute path stops being visible on a banded row, so it must stay
  // REACHABLE: the tooltip is now the only place it appears, and data-root is
  // how a check names a row without depending on which columns rendered.
  row.dataset.root = c.root;
  row.title = c.root;
  return row;
}

/**
 * Clicking a repository on the GitHub tab.
 *
 * It used to do NOTHING at all unless you already had the repo cloned, which
 * made the whole list a catalogue you could only read. The two cases are
 * genuinely different questions:
 *
 *  · Not on this machine — browse it in place, the way you would on github.com:
 *    the code, its branches, go-to-file. Cloning is offered there, not demanded
 *    here.
 *  · On this machine WITH uncommitted work — "open" is ambiguous, so ask: the
 *    code, the changes, or your editor. With a clean tree there is nothing to
 *    choose between, so it just opens.
 */
async function openRemoteRepo(
  r: GhRepoBrief,
  local: LocalCopy | undefined,
  nav: SectionNav,
): Promise<void> {
  if (!local || local.missing) {
    nav("explore", { id: `repo/${r.fullName}` });
    return;
  }
  await openLocalCopy(r.fullName, local, nav, {
    onBrowse: () => nav("explore", { id: `repo/${r.fullName}` }),
  });
}

async function openFromDisk(nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:open", undefined);
  if (info) {
    bust("repos");
    nav("code");
  }
}

async function addFolder(refresh: () => Promise<void>): Promise<void> {
  const next = await host.invoke("repos:addFolder", undefined);
  if (!next) return; // cancelled
  bust("repos");
  // …and actually list them. The toast said "its repositories are listed here
  // now" over a list that had not changed, which is the app telling you
  // something it had not done.
  await refresh();
  toast("Tracking that folder — its repositories are listed here now.", "success");
}

// ── remote ─────────────────────────────────────────────────────────────────

async function paintRemote(
  listEl: HTMLElement,
  nav: SectionNav,
  refresh: () => Promise<void>,
  current: () => boolean,
): Promise<void> {
  const [repos, copies, folders, editors] = await Promise.all([
    gget("github:repos", undefined, 30_000),
    gget("repos:local", undefined, 5000),
    gget("repos:folders", undefined, 30_000),
    loadEditors(),
  ]);
  if (!current()) return;

  // "Do I already have this?" answered by ORIGIN, not by folder name — a repo
  // cloned into a differently-named directory is still the same repo, and
  // offering to clone it again is how you end up with two copies.
  //
  // Several copies can share one origin — a worktree, or a folder literally
  // named "trust-globe copy" beside "trust-globe". The last one to be written
  // used to win, and the list arrives name-sorted, so "Open" on the GitHub row
  // for trust-globe opened the COPY. Pick deliberately instead: the one that is
  // open, else one that is not missing, else the shallowest path — and never
  // let a later row silently replace an earlier answer.
  const have = localCopyIndex(copies);

  const shown = repos.filter((r) => matches(`${r.fullName} ${r.description ?? ""} ${r.language ?? ""}`));
  if (!shown.length) {
    listEl.replaceChildren(
      emptyState(
        query.trim() ? "Nothing matches" : "No repositories",
        query.trim()
          ? `No repository of yours matches “${query.trim()}”.`
          : "Repositories you own, collaborate on, or share through an organization appear here.",
      ),
    );
    return;
  }
  // GROUPED BY OWNER, because the three kinds are three different questions.
  //
  // Your own repositories, the organisations you belong to, and the accounts
  // that have shared something with you are not one list — a flat dump of
  // everything mixes "my side project" with "the company monorepo" and with
  // "someone added me to this once", and the only way to find any of them is to
  // already know its name.
  // The owner's UNFILTERED total, so a filtered head can say "2 of 7".
  const totals = new Map<string, number>();
  for (const r of repos) {
    const k = ownerFoldKey(r.mine, r.owner);
    totals.set(k, (totals.get(k) ?? 0) + 1);
  }

  const groups = new Map<
    string,
    { key: string; label: string; kind: "mine" | "org" | "shared"; rows: GhRepoBrief[] }
  >();
  for (const r of shown) {
    const key = ownerFoldKey(r.mine, r.owner);
    const g =
      groups.get(key) ??
      {
        key,
        label: r.mine ? "Your repositories" : r.owner,
        kind: r.mine ? ("mine" as const) : r.ownerType === "Organization" ? ("org" as const) : ("shared" as const),
        rows: [],
      };
    g.rows.push(r);
    groups.set(key, g);
  }
  // Yours first — it is the one you came for — then organisations by name, then
  // the accounts that shared something with you.
  const order = { mine: 0, org: 1, shared: 2 };
  const sorted = [...groups.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label),
  );

  const filtering = !!query.trim();
  const out: HTMLElement[] = [];
  for (const g of sorted) {
    // A section wrapper, so the head pins WITHIN its own owner and is pushed
    // out by the next one. Flat siblings all pin at top:0 in one containing
    // block and simply pile up behind each other, which is why several owners
    // meant several heads stacked in the same few pixels.
    const sec = el("div", "repo-owner-sec");
    // Folds default OPEN, and a FILTER overrides them: a filter that hides its
    // own matches is a filter that lies. Same rule as the local side.
    const isShut = !filtering && isFolded(g.key);
    const head = ownerHeader(g.label, g.kind, g.rows.length, g.key, filtering ? totals.get(g.key) : undefined);
    sec.appendChild(head);
    for (const r of g.rows) {
      const row = remoteRow(r, have.get(r.fullName.toLowerCase()), folders, nav, refresh, editors);
      row.dataset.group = g.key;
      // Hidden, not removed — the page's own count must not report that
      // repositories ceased to exist because a section was closed.
      if (isShut) row.hidden = true;
      sec.appendChild(row);
    }
    applyFoldState(head, g.key, isShut);
    out.push(sec);
  }
  listEl.replaceChildren(...out);
  alignActions(listEl, current);
}

/**
 * Every row's verbs take the width of the widest row's, so the columns to
 * their left — the change counts, the language, the time — stay columns.
 *
 * The verbs are right-aligned, so a row with fewer of them (the repository
 * you have open offers no Open; a clone whose folder is gone offers only its
 * menu; on GitHub, a repository you have not cloned has no editor button)
 * used to end its meta cluster further right than its neighbours, and "↑1"
 * sat 50px out of line with the "●3" above it. Measured, not guessed: the
 * editor button is as wide as your editor's name.
 */
function alignActions(listEl: HTMLElement, current: () => boolean): void {
  const measure = (): void => {
    let widest = 0;
    for (const a of listEl.querySelectorAll<HTMLElement>(".repo-row .sec-row-actions")) {
      widest = Math.max(widest, need(a));
    }
    if (widest) listEl.style.setProperty("--repo-actions-w", `${Math.ceil(widest)}px`);
    // Nothing on screen to measure (every folder folded): the stylesheet's
    // floor, never the width the OTHER side's paint left behind.
    else listEl.style.removeProperty("--repo-actions-w");
  };
  measure();
  (listEl as RepoList).realign = () => {
    if (current()) measure();
  };
  // Again once the UI font is in: measured in the fallback face, a row whose
  // editor button says "VSCode" came out 6px narrower than it then drew, and
  // the columns it was meant to line up were 6px out on every such row.
  void document.fonts?.ready.then(() => {
    if (current()) measure();
  });
}

/** What a verbs cluster NEEDS: its controls and the gaps between them. Not
 *  its own width, which the reserved minimum has already floored. */
function need(actions: HTMLElement): number {
  const kids = [...actions.children] as HTMLElement[];
  const shown = kids.filter((k) => k.offsetParent !== null);
  if (!shown.length) return 0;
  const gap = parseFloat(getComputedStyle(actions).columnGap) || 0;
  return shown.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + gap * (shown.length - 1);
}

/** "⌥" on a Mac, "Alt" elsewhere — named in the head's tooltip, which is the
 *  only place the bulk fold is announced. */
const FOLD_ALL_KEY = navigator.platform.toLowerCase().includes("mac") ? "⌥" : "Alt";

/**
 * The band above each owner's repositories: what they are called, why they are
 * yours to see, how many, and a disclosure.
 *
 * It folds with the SAME machinery the local tab's project folders use — same
 * chevron class, same `applyFoldState`, same persisted Set — one "owner:"
 * prefix apart, so the two can never drift into two ways of folding.
 */
function ownerHeader(
  label: string,
  kind: "mine" | "org" | "shared",
  n: number,
  key: string,
  /** The owner's UNFILTERED total — passed only while the filter box has text. */
  total?: number,
): HTMLElement {
  const h = el("div", "repo-owner-head");
  h.dataset.group = key;
  h.setAttribute("role", "button");
  h.tabIndex = 0;
  h.title = `Show or hide ${label} — ${FOLD_ALL_KEY}-click for every owner`;

  // `repo-group-chevron` is not decoration: applyFoldState finds the chevron by
  // that class, so the local project folders and these sections fold through
  // ONE function rather than two that drift.
  const chevron = glyph("chevron-down");
  chevron.classList.add("repo-group-chevron");
  h.appendChild(chevron);

  // A NAME, not a path. This head used `.repo-folder-path`, which is monospace
  // because on the local side it holds `~/Developer` — something you read
  // character by character. A GitHub login in that face reads as one more row.
  h.appendChild(span(label, "repo-owner-name"));

  if (kind !== "mine") {
    const why = span(kind === "org" ? "organization" : "shared with you", "repo-folder-chip");
    why.title =
      kind === "org"
        ? "You can see these because you belong to this organization"
        : "You have access to these as a collaborator";
    h.appendChild(why);
  }

  h.appendChild(el("span", "repo-folder-spring"));

  // The count goes LAST so its right edge is the same on every head — a column
  // the eye runs down. While filtering it says both numbers, because "3
  // repositories" over three of twenty-seven is a different fact from the same
  // words unfiltered; the local band already says it this way.
  h.appendChild(
    span(
      total === undefined
        ? n === 1
          ? "1 repository"
          : `${n} repositories`
        : `${n} of ${total} repositories`,
      "repo-folder-count",
    ),
  );

  const toggle = (all: boolean): void => {
    // NOT h.parentElement — that is the section wrapper now, not the scroller.
    const list = h.closest(".sec-list") as StickyList | null;
    // Asked BEFORE the fold: a head holding the top of the scroller has to
    // still be there afterwards.
    const wasStuck = h.classList.contains("is-stuck");
    const next = !isFolded(key);
    const heads = all ? [...(list ?? document).querySelectorAll<HTMLElement>(".repo-owner-head")] : [h];
    for (const head of heads) {
      const k = head.dataset.group ?? "";
      if (!k) continue;
      setFolded(k, next);
      // In place, never through refresh(): replacing the list's children drops
      // focus to <body> and restarts keyboard navigation at row 0.
      applyFoldState(head, k, next);
    }
    if (!list) return;
    // Its own section is now only as tall as its head, so a folded head cannot
    // pin. Without this the head you just clicked scrolls out from under the
    // pointer. At the list's end this resolves to a no-op, which is also right.
    if (wasStuck) {
      list.scrollTop += h.getBoundingClientRect().top - list.getBoundingClientRect().top;
    }
    list.syncSticky?.();
  };

  h.addEventListener("click", (e) => toggle(e.altKey));
  h.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== h) return; // nothing else on this head takes keys — yet
    e.preventDefault();
    toggle(e.altKey);
  });
  return h;
}

function remoteRow(
  r: GhRepoBrief,
  local: LocalCopy | undefined,
  folders: RepoFolder[],
  nav: SectionNav,
  refresh: () => Promise<void>,
  editors: EditorsView = { editors: [] },
): HTMLElement {
  const pills: HTMLElement[] = [];
  if (r.private) pills.push(span("private", "gh-pill"));
  if (r.fork) pills.push(span("fork", "gh-pill"));

  const chips: HTMLElement[] = [];
  if (r.description) {
    const d = span(r.description, "repo-desc");
    // It ellipsizes when the window is narrow; the whole sentence stays
    // reachable rather than becoming unreadable.
    d.title = r.description;
    chips.push(d);
  }

  const meta: HTMLElement[] = [];
  if (r.language) meta.push(span(r.language, "repo-lang"));
  if (r.stars) {
    const s = span("", "repo-stars");
    // 121000 is not a number anyone reads; 121k is. Same rule the Explore
    // footer already follows.
    s.append(glyph("star-full"), span(compactCount(r.stars)));
    s.title = plural(r.stars, "star");
    meta.push(s);
  }

  const actions: HTMLElement[] = [];
  if (local) {
    // Your copy of it, in your editor — the same control the row for this
    // copy carries under "On this machine" (#32). It goes BEFORE the Open ⌄
    // pair, not inside it: every row on this side ends in one verb and its
    // ⌄ (Clone ⌄, Open ⌄), and an editor chevron between Open and its menu
    // put two chevrons side by side that did different things.
    if (!local.missing && hasEditor(editors)) {
      actions.push(openInButton({ root: () => local.root, nav: (v) => nav(v), row: true, editors }));
    }
    // Already here. Say WHERE, and offer the thing you actually want.
    const open = el("button", "row-btn");
    open.textContent = "Open";
    open.title = `Already cloned at ${local.root}`;
    open.setAttribute("aria-label", `Open ${r.fullName}`);
    open.addEventListener("click", () => void openPath(local.root, nav));
    actions.push(open);
    pills.push(whereChip("local"));

    // The same ⌄ its neighbours have. A row you have already cloned used to be
    // the one row on the page with a single verb and no menu — so "show me
    // where this is" and "open it on GitHub" were available for every
    // repository except the ones you actually work in.
    const more = el("button", "row-btn lv-menu-btn");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-label", `More actions for ${r.fullName}`);
    more.appendChild(glyph("chevron-down"));
    more.addEventListener("click", () => {
      openMenu(more, [
        {
          label: "Open",
          sub: middlePath(local.root),
          icon: "repo",
          onClick: () => void openPath(local.root, nav),
        },
        {
          label: "Show in Finder",
          icon: "folder-opened",
          onClick: () => void host.invoke("repos:reveal", local.root),
        },
        { separator: true },
        {
          label: "Open on GitHub",
          icon: "link-external",
          onClick: () => window.open(`https://github.com/${r.fullName}`, "_blank", "noopener"),
        },
        {
          label: "Copy clone URL",
          icon: "copy",
          onClick: () =>
            void copyText(`https://github.com/${r.fullName}.git`, "Clone URL copied."),
        },
      ]);
    });
    actions.push(more);
  } else {
    const clone = el("button", "row-btn") as HTMLButtonElement;
    clone.textContent = "Clone";
    const dest = folders.find((f) => f.isCloneDir);
    clone.title = dest ? `Clone into ${dest.display}` : "Clone this repository";
    clone.setAttribute("aria-label", `Clone ${r.fullName}`);
    clone.addEventListener("click", () => void cloneInto(r, dest?.path, clone, nav, refresh));
    actions.push(clone);

    const where = el("button", "row-btn lv-menu-btn") as HTMLButtonElement;
    where.setAttribute("aria-haspopup", "menu");
    where.setAttribute("aria-label", `Choose where to clone ${r.fullName}`);
    where.appendChild(glyph("chevron-down"));
    where.addEventListener("click", () => {
      // Not a folder the same page says is gone. Offering it is offering a
      // clone that cannot succeed, two rows under the words "This folder is
      // gone".
      const items = folders
        .filter((f) => !f.missing)
        .map((f) => ({
          label: f.isCloneDir ? `${f.display} (default)` : f.display,
          icon: f.isCloneDir ? "root-folder" : "folder",
          onClick: () => void cloneInto(r, f.path, clone, nav, refresh),
        }));
      items.push({
        label: "Choose a folder…",
        icon: "new-folder",
        onClick: () => void cloneInto(r, undefined, clone, nav, refresh, true),
      });
      openMenu(where, [
        ...items,
        { separator: true },
        {
          label: "Open on GitHub",
          icon: "link-external",
          onClick: () => window.open(`https://github.com/${r.fullName}`, "_blank", "noopener"),
        },
        {
          label: "Copy clone URL",
          icon: "copy",
          onClick: () =>
            void copyText(`https://github.com/${r.fullName}.git`, "Clone URL copied."),
        },
      ]);
    });
    actions.push(where);
  }

  const row = secRow({
    // avatar(LOGIN, URL) — passing these the other way round made every
    // fallback tile compute its initials from "https://github.com/…", which is
    // why an owner with no avatar loaded showed "HP".
    lead: avatar(r.owner, `https://github.com/${r.owner}.png?size=48`, 18),
    title: r.fullName,
    titleSuffix: pills,
    chips,
    meta,
    time: relTimeISO(r.updatedAt),
    actions,
    ariaLabel: [r.fullName, r.private ? "private" : "", local ? "already on this machine" : ""]
      .filter(Boolean)
      .join(", "),
    onOpen: () => void openRemoteRepo(r, local, nav),
  });
  // Tagged so the stylesheet can give the NAME priority over the
  // description beside it — see .repo-row in app.css.
  row.classList.add("repo-row");
  return row;
}

async function cloneInto(
  r: GhRepoBrief,
  parent: string | undefined,
  btn: HTMLButtonElement,
  nav: SectionNav,
  refresh: () => Promise<void>,
  pick = false,
): Promise<void> {
  let dest = parent;
  if (pick || !dest) {
    const chosen = await host.invoke("clone:pickDir", { defaultPath: dest });
    if (!chosen) return; // cancelled
    dest = chosen;
  }
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = "Cloning…";
  // A clone of anything real takes long enough that a button reading "Cloning…"
  // and never changing is indistinguishable from one that has hung. The main
  // process already streams progress; nothing was listening to it.
  const off = host.on("clone:progress", (p) => {
    if (typeof p?.percent === "number") btn.textContent = `${Math.round(p.percent)}%`;
    else if (p?.phase) btn.textContent = p.phase;
  });
  try {
    const res = await host.invoke("clone:start", {
      url: r.cloneUrl,
      parentDir: dest,
      name: r.name,
    });
    if (!res.ok || !res.root) {
      toast(res.message ?? `Couldn't clone ${r.fullName}.`, "error");
      return;
    }
    bust("repos");
    toast(`Cloned ${r.fullName}.`, "success");
    // Straight into it — cloning is something you do in order to work, and
    // making you find it again afterwards is a step nobody wants.
    const info = await host.invoke("repo:openPath", res.root);
    if (info) nav("code");
    else await refresh();
  } catch (e) {
    toast(String((e as Error)?.message ?? e) || `Couldn't clone ${r.fullName}.`, "error");
  } finally {
    off?.();
    btn.disabled = false;
    btn.textContent = was;
  }
}
