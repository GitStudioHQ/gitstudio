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

import { el, span, glyph, openMenu, avatar, emptyState, relTimeISO } from "../ui";
import { toast } from "../dialogs";
import { host } from "../bridge";
import { gget, bust } from "../cache";
import {
  ghHeader,
  sectionList,
  secRow,
  segmented,
  searchField,
  type SectionRender,
  type SectionNav,
} from "./common";
import type { GhRepoBrief, LocalCopy, RepoFolder } from "../../shared/ipc";

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

  tools.append(seg, search, openBtn, addBtn);
  const { view, listEl } = sectionList();
  // `sectionList` hands back a shell and a list and leaves the assembly to the
  // caller — the same order every other section uses.
  head.querySelector(".gh-acct")?.before(tools);
  if (!tools.isConnected) head.appendChild(tools);
  view.append(head, listEl);
  wrap.replaceChildren(view);

  async function refresh(force = false): Promise<void> {
    if (force) bust("repos");
    listEl.replaceChildren(el("div", "skeleton"));
    try {
      if (side === "local") await paintLocal(listEl, nav, refresh);
      else await paintRemote(listEl, nav, refresh);
    } catch (e) {
      listEl.replaceChildren(
        emptyState("Couldn’t list repositories", String((e as Error)?.message ?? e), { icon: "warning" }),
      );
    }
    head.setCount?.(listEl.querySelectorAll(".sec-row").length);
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
): Promise<void> {
  const [folders, copies] = await Promise.all([
    gget("repos:folders", undefined, 5000),
    gget("repos:local", undefined, 5000),
  ]);

  const rows: HTMLElement[] = [];
  const placed = new Set<string>();

  for (const folder of folders) {
    const inFolder = copies.filter((c) => parentOf(c.root) === normalize(folder.path));
    inFolder.forEach((c) => placed.add(c.root));
    const shown = inFolder.filter((c) => matches(`${c.name} ${c.origin ?? ""} ${c.root}`));
    // A folder with nothing MATCHING is hidden while filtering, but a folder
    // with nothing IN it still shows — "I added this and nothing appeared" is
    // a question the screen should answer rather than leave you guessing.
    if (query.trim() && !shown.length) continue;
    rows.push(folderHeader(folder, refresh));
    if (!shown.length) {
      const none = el("div", "repo-folder-empty");
      none.textContent = folder.missing
        ? "This folder is gone. Stop tracking it, or put it back."
        : "No repositories in this folder yet.";
      rows.push(none);
      continue;
    }
    for (const c of shown) rows.push(localRow(c, nav, refresh));
  }

  // Anything reached from somewhere untracked — a recent you opened once from
  // a folder the app declined to remember, like ~ itself.
  const loose = copies.filter((c) => !placed.has(c.root) && matches(`${c.name} ${c.origin ?? ""}`));
  if (loose.length) {
    rows.push(groupLabel("Opened from elsewhere"));
    for (const c of loose) rows.push(localRow(c, nav, refresh));
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
}

function normalize(p: string): string {
  return p.replace(/\/+$/, "");
}

function parentOf(root: string): string {
  return normalize(root.slice(0, root.lastIndexOf("/")));
}

function groupLabel(text: string): HTMLElement {
  const h = el("div", "repo-folder-head");
  h.appendChild(span(text, "repo-folder-path"));
  return h;
}

function folderHeader(folder: RepoFolder, refresh: () => Promise<void>): HTMLElement {
  const h = el("div", "repo-folder-head" + (folder.missing ? " is-missing" : ""));
  h.appendChild(glyph(folder.isCloneDir ? "root-folder" : "folder"));
  const path = span(folder.display, "repo-folder-path");
  path.title = folder.path;
  h.appendChild(path);
  const n = span(
    folder.repoCount === 1 ? "1 repository" : `${folder.repoCount} repositories`,
    "repo-folder-count",
  );
  h.appendChild(n);
  if (folder.isCloneDir) {
    // Named, not just implied: this is where a one-click clone lands, and it
    // is the reason this folder has no "stop tracking".
    const chip = el("button", "repo-folder-chip is-clone");
    chip.textContent = "clones land here";
    chip.title = "New clones go here unless you choose somewhere else — click to change it";
    chip.addEventListener("click", async () => {
      const picked = await host.invoke("clone:pickDir", { defaultPath: folder.path });
      if (!picked) return;
      const r = await host.invoke("settings:update", { cloneDir: picked });
      bust("repos");
      toast(`New clones will land in ${r.cloneDirDisplay}.`, "success");
      await refresh();
    });
    h.appendChild(chip);
  }
  if (folder.missing) h.appendChild(span("missing", "repo-folder-chip is-warn"));

  const spring = el("span", "repo-folder-spring");
  h.appendChild(spring);

  const reveal = el("button", "mini-btn gh-icon-btn");
  reveal.appendChild(glyph("folder-opened"));
  reveal.title = "Show this folder in Finder";
  reveal.setAttribute("aria-label", `Show ${folder.display} in Finder`);
  reveal.addEventListener("click", () => void host.invoke("repos:reveal", folder.path));
  h.appendChild(reveal);

  // "a defaulted repos dir you can assign" — assignable HERE, on the screen that
  // is about repositories, rather than only in Settings under different words.
  // Which folder new clones land in is a fact about this list, and the place to
  // change a fact is where it is stated.
  if (!folder.isCloneDir && !folder.missing) {
    const mk = el("button", "mini-btn gh-icon-btn");
    mk.appendChild(glyph("root-folder"));
    mk.title = `Make ${folder.display} the folder new clones land in`;
    mk.setAttribute("aria-label", mk.title);
    mk.addEventListener("click", async () => {
      const r = await host.invoke("settings:update", { cloneDir: folder.path });
      bust("repos");
      toast(`New clones will land in ${r.cloneDirDisplay}.`, "success");
      await refresh();
    });
    h.appendChild(mk);
  }
  if (!folder.isCloneDir) {
    const stop = el("button", "mini-btn gh-icon-btn");
    stop.appendChild(glyph("close"));
    stop.title = "Stop tracking this folder (nothing is deleted)";
    stop.setAttribute("aria-label", `Stop tracking ${folder.display}`);
    stop.addEventListener("click", async () => {
      await host.invoke("repos:removeFolder", folder.path);
      bust("repos");
      toast(`Stopped tracking ${folder.display}.`, "success");
      await refresh();
    });
    h.appendChild(stop);
  }
  return h;
}

function localRow(c: LocalCopy, nav: SectionNav, refresh: () => Promise<void>): HTMLElement {
  const chips: HTMLElement[] = [];
  if (c.origin) chips.push(span(c.origin, "repo-origin sec-mono"));
  const pills: HTMLElement[] = [];
  if (c.current) pills.push(span("open", "gh-pill is-current"));
  if (c.missing) pills.push(span("missing", "gh-pill is-warn"));

  const actions: HTMLElement[] = [];
  if (!c.missing && !c.current) {
    const open = el("button", "row-btn");
    open.textContent = "Open";
    open.setAttribute("aria-label", `Open ${c.name}`);
    open.addEventListener("click", () => void openPath(c.root, nav));
    actions.push(open);
  }
  const more = el("button", "row-btn lv-menu-btn");
  more.setAttribute("aria-label", `More actions for ${c.name}`);
  more.setAttribute("aria-haspopup", "menu");
  more.appendChild(glyph("ellipsis"));
  more.addEventListener("click", () => {
    const items: Array<{ label: string; icon?: string; danger?: boolean; onClick: () => void }> = [
      {
        label: "Show in Finder",
        icon: "folder-opened",
        onClick: () => void host.invoke("repos:reveal", c.root),
      },
      {
        label: "Copy path",
        icon: "copy",
        onClick: () => void navigator.clipboard?.writeText(c.root),
      },
    ];
    if (c.recent) {
      items.push({
        label: "Forget",
        icon: "eye-closed",
        onClick: async () => {
          await host.invoke("repos:removeRecent", c.root);
          bust("repos");
          await refresh();
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
          const r = await host.invoke("repos:trash", c.root);
          if (!r.ok) {
            toast(r.message ?? "Couldn't move it to the Trash.", "error");
            return;
          }
          bust("repos");
          toast(`Moved ${c.name} to the Trash.`, "success");
          await refresh();
        },
      });
    }
    openMenu(more, items);
  });
  actions.push(more);

  return secRow({
    lead: glyph(c.current ? "check" : "repo"),
    title: c.name,
    titleSuffix: pills,
    chips,
    meta: [],
    time: "",
    actions,
    ariaLabel: [c.name, c.origin, c.current ? "currently open" : "", c.missing ? "missing" : ""]
      .filter(Boolean)
      .join(", "),
    onOpen: () => {
      if (!c.missing && !c.current) void openPath(c.root, nav);
    },
  });
}

async function openPath(root: string, nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:openPath", root);
  if (info) nav("changes");
}

async function openFromDisk(nav: SectionNav): Promise<void> {
  const info = await host.invoke("repo:open", undefined);
  if (info) {
    bust("repos");
    nav("changes");
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
): Promise<void> {
  const [repos, copies, folders] = await Promise.all([
    gget("github:repos", undefined, 30_000),
    gget("repos:local", undefined, 5000),
    gget("repos:folders", undefined, 30_000),
  ]);

  // "Do I already have this?" answered by ORIGIN, not by folder name — a repo
  // cloned into a differently-named directory is still the same repo, and
  // offering to clone it again is how you end up with two copies.
  const have = new Map<string, LocalCopy>();
  for (const c of copies) if (c.origin) have.set(c.origin.toLowerCase(), c);

  const shown = repos.filter((r) => matches(`${r.fullName} ${r.description ?? ""} ${r.language ?? ""}`));
  if (!shown.length) {
    listEl.replaceChildren(
      emptyState(
        query.trim() ? "Nothing matches" : "No repositories",
        query.trim()
          ? `No repository of yours matches “${query.trim()}”.`
          : "Repositories you own, collaborate on, or share through an organisation appear here.",
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
  const groups = new Map<string, { label: string; kind: "mine" | "org" | "shared"; rows: GhRepoBrief[] }>();
  for (const r of shown) {
    const key = r.mine ? "\u0000mine" : r.owner;
    const g =
      groups.get(key) ??
      {
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

  const out: HTMLElement[] = [];
  for (const g of sorted) {
    out.push(ownerHeader(g.label, g.kind, g.rows.length));
    for (const r of g.rows) {
      out.push(remoteRow(r, have.get(r.fullName.toLowerCase()), folders, nav, refresh));
    }
  }
  listEl.replaceChildren(...out);
}

/** The band above each owner's repositories, saying WHY they are yours to see. */
function ownerHeader(label: string, kind: "mine" | "org" | "shared", n: number): HTMLElement {
  const h = el("div", "repo-owner-head");
  h.appendChild(glyph(kind === "mine" ? "person" : kind === "org" ? "organization" : "people"));
  h.appendChild(span(label, "repo-folder-path"));
  h.appendChild(span(n === 1 ? "1 repository" : `${n} repositories`, "repo-folder-count"));
  if (kind !== "mine") {
    const why = span(kind === "org" ? "organisation" : "shared with you", "repo-folder-chip");
    why.title =
      kind === "org"
        ? "You can see these because you belong to this organisation"
        : "You have access to these as a collaborator";
    h.appendChild(why);
  }
  return h;
}

function remoteRow(
  r: GhRepoBrief,
  local: LocalCopy | undefined,
  folders: RepoFolder[],
  nav: SectionNav,
  refresh: () => Promise<void>,
): HTMLElement {
  const pills: HTMLElement[] = [];
  if (r.private) pills.push(span("private", "gh-pill"));
  if (r.fork) pills.push(span("fork", "gh-pill"));

  const chips: HTMLElement[] = [];
  if (r.description) chips.push(span(r.description, "repo-desc"));

  const meta: HTMLElement[] = [];
  if (r.language) meta.push(span(r.language, "repo-lang"));
  if (r.stars) {
    const s = span("", "repo-stars");
    // 121000 is not a number anyone reads; 121k is. Same rule the Explore
    // footer already follows.
    s.append(glyph("star-full"), span(compactCount(r.stars)));
    s.title = `${r.stars.toLocaleString()} stars`;
    meta.push(s);
  }

  const actions: HTMLElement[] = [];
  if (local) {
    // Already here. Say WHERE, and offer the thing you actually want.
    const open = el("button", "row-btn");
    open.textContent = "Open";
    open.title = `Already cloned at ${local.root}`;
    open.setAttribute("aria-label", `Open ${r.fullName}`);
    open.addEventListener("click", () => void openPath(local.root, nav));
    actions.push(open);
    pills.push(span("on this machine", "gh-pill is-have"));
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
      const items = folders.map((f) => ({
        label: f.isCloneDir ? `${f.display} (default)` : f.display,
        icon: f.isCloneDir ? "root-folder" : "folder",
        onClick: () => void cloneInto(r, f.path, clone, nav, refresh),
      }));
      items.push({
        label: "Choose a folder…",
        icon: "new-folder",
        onClick: () => void cloneInto(r, undefined, clone, nav, refresh, true),
      });
      openMenu(where, items);
    });
    actions.push(where);
  }

  return secRow({
    lead: avatar(`https://github.com/${r.owner}.png?size=48`, r.owner, 18),
    title: r.fullName,
    titleSuffix: pills,
    chips,
    meta,
    time: relTimeISO(r.updatedAt),
    actions,
    ariaLabel: [r.fullName, r.private ? "private" : "", local ? "already on this machine" : ""]
      .filter(Boolean)
      .join(", "),
    onOpen: () => {
      if (local) void openPath(local.root, nav);
    },
  });
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
    if (info) nav("changes");
    else await refresh();
  } catch (e) {
    toast(String((e as Error)?.message ?? e) || `Couldn't clone ${r.fullName}.`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}
