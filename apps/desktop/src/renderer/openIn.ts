// "Open in <editor>" — the one control, built once, used wherever a repository
// is on screen: the Code page header, the Home hero, a repository row's menu.
//
// A split button: the primary half opens the DEFAULT editor (the one Settings
// marks, else the first shown), the chevron lists every shown editor plus the
// two things that are not editors but belong in the same menu — reveal the
// folder, copy its path. With nothing detected the primary half becomes the
// menu itself, and the menu says how to add an editor.

import { host } from "./bridge";
import { gget, bust } from "./cache";
import { el, span, glyph, openMenu, copyText } from "./ui";
import type { MenuItem } from "./ui";
import { toast } from "./dialogs";
import type { EditorsView, EditorView } from "../shared/ipc";

/** Fired by Settings after any editor preference changes; every mounted
 *  Open-in control re-reads on the next paint. */
export const EDITORS_CHANGED = "gs:editors-changed";

export function bustEditors(): void {
  bust("editors:list");
  window.dispatchEvent(new Event(EDITORS_CHANGED));
}

export async function loadEditors(): Promise<EditorsView> {
  try {
    return await gget("editors:list", undefined, 30_000);
  } catch {
    return { editors: [] };
  }
}

async function open(id: string, root?: string, name?: string): Promise<void> {
  try {
    const r = await host.invoke("editors:open", { id, root });
    if (!r.ok) toast(r.message ?? "Couldn't open the editor.", "error");
    else if (name) toast(`Opening in ${name}…`, "info");
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't open the editor.", "error");
  }
}

const isMac = navigator.platform.toLowerCase().includes("mac");
const isWin = navigator.platform.toLowerCase().startsWith("win");
export const REVEAL_LABEL = isMac ? "Reveal in Finder" : isWin ? "Show in Explorer" : "Show in file manager";

/** Is there an editor to open anything in? A control whose only possible
 *  answer is "No editors found" is not worth a place on every row. */
export function hasEditor(view: EditorsView): boolean {
  return view.editors.some((e) => e.shown);
}

/** Just the editor rows — for a menu that already has its own reveal / copy
 *  rows (a repository row's kebab). */
export function editorItems(view: EditorsView, root: string | undefined, nav?: (view: string) => void): MenuItem[] {
  const shown = view.editors.filter((e) => e.shown);
  const items: MenuItem[] = shown.map((e) => ({
    label: e.name,
    sub: e.isDefault ? "Your favourite" : undefined,
    iconEl: editorMark(e),
    title: e.location,
    onClick: () => void open(e.id, root, e.name),
  }));
  if (shown.length === 0) {
    items.push({
      label: "No editors found",
      sub: "Add one in Settings ▸ Editors",
      icon: "info",
      onClick: () => nav?.("settings"),
    });
  }
  return items;
}

/** The whole menu for a given root — the editors, then the folder itself. */
export function openInItems(
  view: EditorsView,
  root: string | undefined,
  nav?: (view: string) => void,
): MenuItem[] {
  const items = editorItems(view, root, nav);
  items.push({ separator: true });
  items.push({
    label: REVEAL_LABEL,
    icon: "folder-opened",
    onClick: () => void host.invoke("editors:reveal", { root }),
  });
  if (root) {
    items.push({
      label: "Copy path",
      icon: "copy",
      onClick: () => void copyText(root, "Copied the repository path."),
    });
  }
  if (nav) {
    items.push({ separator: true });
    items.push({ label: "Choose editors…", icon: "gear", sub: "Which ones show here", onClick: () => nav("settings") });
  }
  return items;
}

function editorIcon(e: EditorView): string {
  return e.via === "custom" ? "terminal" : "code";
}

/** The editor's own icon, as the OS draws it. Falls back to a glyph for a
 *  custom command, which is a command line and has no application icon. */
export function editorMark(e: EditorView): HTMLElement {
  if (!e.icon) return glyph(editorIcon(e));
  const img = document.createElement("img");
  img.className = "editor-mark";
  img.src = e.icon;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  return img;
}

export interface OpenInOptions {
  /** The folder to open; undefined means the current repository. */
  root?: () => string | undefined;
  /** Compact: a single button ("Open in Cursor ▾") rather than a split pair. */
  compact?: boolean;
  nav?: (view: string) => void;
  /**
   * Sized for a list ROW: the halves are the row's own `.row-btn`s, so the
   * control keeps the height and rhythm of the Open beside it (Repositories,
   * #32). The mini-btn pair is a toolbar control and stood a head taller.
   */
  row?: boolean;
  /**
   * The editors, already read. A row that paints with them has its final
   * label ("VSCode") from the first frame; one that loads them afterwards
   * paints "Open in…" and then changes width under the pointer.
   */
  editors?: EditorsView;
}

/**
 * The split button. Repaints itself when Settings changes the editor set, and
 * stays mounted across those changes — callers append it once.
 */
/**
 * ONE window listener for every Open-in button in the app, pruned on mount.
 *
 * Each button used to add its own, removing it only when the event next fired
 * and found the button detached. `EDITORS_CHANGED` is dispatched solely by
 * Settings ▸ Editors, so a session that never opens that card never swept: Home
 * and the top bar rebuild their button on every repo open and every route back,
 * and the listeners simply accumulated for the life of the window.
 *
 * Pruning HERE costs nothing on the event and is bounded by the number of live
 * buttons, which is two or three.
 */
const mountedOpenIn: { wrap: HTMLElement; load: () => void }[] = [];
let openInWired = false;

function registerOpenIn(wrap: HTMLElement, load: () => void): void {
  for (let i = mountedOpenIn.length - 1; i >= 0; i--) {
    if (!mountedOpenIn[i].wrap.isConnected) mountedOpenIn.splice(i, 1);
  }
  mountedOpenIn.push({ wrap, load });
  if (openInWired) return;
  openInWired = true;
  window.addEventListener(EDITORS_CHANGED, () => {
    for (const m of mountedOpenIn) {
      if (m.wrap.isConnected) m.load();
    }
  });
}

export function openInButton(opts: OpenInOptions = {}): HTMLElement {
  const wrap = el("div", "openin" + (opts.compact ? " is-compact" : "") + (opts.row ? " is-row" : ""));
  wrap.setAttribute("role", "group");
  const btn = opts.row ? "row-btn" : "mini-btn";

  const primary = el("button", `${btn} openin-primary`) as HTMLButtonElement;
  const mark = el("span", "openin-mark");
  mark.appendChild(glyph("code"));
  const label = span("Open in…", "openin-label");
  primary.append(mark, label);
  const more = el("button", `${btn} openin-more`) as HTMLButtonElement;
  more.appendChild(glyph("chevron-down"));
  more.setAttribute("aria-haspopup", "menu");
  wrap.append(primary, more);

  let view: EditorsView = opts.editors ?? { editors: [] };
  const paint = (): void => {
    // `root` is a GETTER, so it has to be read here rather than when the button
    // was built: this same button lives in the top bar, where it stays mounted
    // while you browse a repository you do NOT have. "Open this repository"
    // then named the wrong one, with nothing on screen to say which.
    const repo = (opts.root?.() ?? "").split("/").filter(Boolean).pop() ?? "this repository";
    wrap.setAttribute("aria-label", `Open ${repo} in an editor`);
    more.setAttribute("aria-label", `More ways to open ${repo}`);
    const def = view.editors.find((e) => e.isDefault && e.shown);
    if (def) {
      // In the top bar the mark IS the label — the editor's own icon says which
      // one better than its name does, and the bar has no room for both.
      mark.replaceChildren(editorMark(def));
      label.textContent = def.name;
      primary.title = def.location ? `Open ${repo} in ${def.name} — ${def.location}` : `Open ${repo} in ${def.name}`;
      // In a row the visible word is only the editor's name, and thirty rows
      // of buttons all called "VSCode" say nothing about which one is which.
      if (opts.row) primary.setAttribute("aria-label", `Open ${repo} in ${def.name}`);
      primary.classList.remove("is-menu");
    } else {
      mark.replaceChildren(glyph("code"));
      label.textContent = "Open in…";
      primary.title = `Open ${repo} in an editor`;
      if (opts.row) primary.setAttribute("aria-label", `Open ${repo} in an editor`);
      primary.classList.add("is-menu");
    }
  };
  const showMenu = (anchor: HTMLElement): void =>
    openMenu(anchor, openInItems(view, opts.root?.(), opts.nav), { align: "end" });

  primary.addEventListener("click", () => {
    const def = view.editors.find((e) => e.isDefault && e.shown);
    if (def) void open(def.id, opts.root?.(), def.name);
    else showMenu(primary);
  });
  more.addEventListener("click", () => showMenu(more));

  const load = (): void => {
    void loadEditors().then((v) => {
      view = v;
      paint();
    });
  };
  // Once now, so the button carries a label naming its repository from the
  // first frame rather than after the editor list comes back.
  paint();
  // Handed the list already, a row has nothing to wait for — it still listens
  // for Settings changing it, like every other one.
  if (!opts.editors) load();
  registerOpenIn(wrap, load);
  return wrap;
}
