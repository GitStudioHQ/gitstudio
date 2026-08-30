// The GitHub "Projects" section: pick a project from a searchable dropdown in the
// title bar, and its board (columns grouped by the Status field, with movable
// cards) fills the whole pane below — no left list pane, so the board gets the
// full width.
//
// Cards move two ways: DRAG one onto another column (optimistic — the card
// lands instantly and reverts on failure), or the kebab's "Move to" menu (the
// keyboard path). Issues peek in a slide-over drawer hosting the full live
// issue detail; PRs open their full workspace. Reads go through the SWR cache;
// the move mutation toasts + busts.

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  pill,
  relTimeISO,
  loadingState,
  errorState,
  emptyState,
  openMenu,
  cleanErr,
  type MenuItem,
} from "../ui";
import { peek as cachePeek, gget, bust } from "../cache";
import { toast } from "../dialogs";
import { holdBackground, registerLayer, ownsEscape } from "../overlays";
import { ghGate, ghHeader, headerPicker, type SectionRender, type SectionNav } from "./common";
import { renderIssueDetailInto } from "./issues";
import type { ProjectBoard, ProjectInfo, ProjectItem } from "../../shared/ipc";

// Which project the user last opened. Survives a re-render so a move (or refresh)
// re-selects it and reloads its board in place. `undefined` = nothing opened yet.
let selectedProjectId: string | undefined;

export const renderProjects: SectionRender = (wrap, nav) => {
  void renderProjectsAsync(wrap, nav);
};

async function renderProjectsAsync(wrap: HTMLElement, nav: SectionNav): Promise<void> {
  const refresh = (): void => {
    bust("project");
    renderProjects(wrap, nav);
  };
  const gate = await ghGate(wrap, nav, true, refresh);
  if (!gate) return;

  const header = ghHeader("Projects", gate.login, refresh);
  const view = el("div", "gh-view");
  view.appendChild(header);
  // One full-width pane: the selected project's board lives here.
  const board = el("div", "gh-detail gh-board-detail gh-solo");
  view.appendChild(board);
  wrap.replaceChildren(view);

  let projects: ProjectInfo[] | undefined = cachePeek("project:list", undefined);
  if (!projects) board.replaceChildren(loadingState());
  try {
    projects = await gget("project:list", undefined, 30000);
  } catch (e) {
    if (!view.isConnected) return;
    if (!projects) {
      board.replaceChildren(
        errorState("Couldn't load projects", cleanErr(e) || "GitHub request failed.", refresh),
      );
      return;
    }
  }
  if (!view.isConnected || !projects) return;
  header.setCount?.(projects.length);

  if (projects.length === 0) {
    selectedProjectId = undefined;
    board.replaceChildren(
      emptyState("No projects", "No GitHub Projects (v2) are linked to this repository.", {
        icon: "project",
      }),
    );
    return;
  }

  const all = projects;
  const select = (p: ProjectInfo): void => {
    selectedProjectId = p.id;
    picker.set(glyph("project"), p.title);
    void showProjectBoard(board, p, refresh, nav);
  };

  // The bar-level picker: a searchable dropdown of every project. Choosing one
  // loads its board full-width below.
  const picker = headerPicker({
    onOpen: (anchor) => {
      const items: MenuItem[] = all.map((p) => ({
        label: p.title,
        sub:
          `#${p.number} · ${p.itemCount} item${p.itemCount === 1 ? "" : "s"}` +
          (p.closed ? " · closed" : ""),
        icon: "project",
        current: p.id === selectedProjectId,
        onClick: () => select(p),
      }));
      openMenu(anchor, items, { searchable: true });
    },
  });
  header.querySelector(".gh-head-titlewrap")?.appendChild(picker.el);

  // Reopen the project the user was on (else the first) so the board is never a void.
  const initial = all.find((p) => p.id === selectedProjectId) ?? all[0];
  select(initial);
}

/**
 * The board: a header (title + meta + "Open on GitHub") above a horizontal
 * scroller of columns — one per Status option, plus a leading "No Status" bucket
 * for unset items. Projects with no Status single-select field fall back to a
 * single "All items" column. Columns are drop targets; cards are draggable.
 */
async function showProjectBoard(
  detail: HTMLElement,
  p: ProjectInfo,
  refresh: () => void,
  nav: SectionNav,
): Promise<void> {
  let board: ProjectBoard | undefined = cachePeek("project:board", p.id);
  if (!board) detail.replaceChildren(loadingState());
  try {
    board = await gget("project:board", p.id, 15000);
  } catch (e) {
    if (!board) {
      detail.replaceChildren(
        errorState("Couldn't load board", cleanErr(e) || "GitHub request failed.", () =>
          void showProjectBoard(detail, p, refresh, nav),
        ),
      );
      return;
    }
  }
  if (!detail.isConnected || !board || selectedProjectId !== p.id) return;
  const b = board;
  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = p.title;
  const meta = el("div", "gh-detail-meta");
  meta.textContent =
    `#${p.number} · ${b.items.length} item${b.items.length === 1 ? "" : "s"}` +
    `${b.field ? "" : " · no Status field"}`;
  const actions = el("div", "gh-detail-actions");
  // Labelled, like the Organizations header: a lone unlabelled glyph on its own
  // row is a guess, and this is the page's only action.
  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("GitHub"));
  openBtn.title = "Open this project on github.com";
  openBtn.addEventListener("click", () => window.open(p.url, "_blank"));
  actions.appendChild(openBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  // Columns = Status options, with a leading "No Status" bucket. With no Status
  // field, a single "All items" column holds everything.
  const columns: { id: string | null; name: string }[] = b.field
    ? [{ id: null, name: "No status" }, ...b.field.options.map((o) => ({ id: o.id, name: o.name }))]
    : [{ id: null, name: "All items" }];

  const itemsById = new Map(b.items.map((it) => [it.id, it]));
  const cardsById = new Map<string, HTMLElement>();
  const cols = new Map<string | null, { el: HTMLElement; body: HTMLElement; count: HTMLElement }>();

  /** Keep each column's count pill honest after an optimistic move. */
  const syncCounts = (): void => {
    for (const [, c] of cols) {
      c.count.textContent = String(c.body.querySelectorAll(".gh-card").length);
    }
  };

  /** The optimistic drop: land the card in the target column immediately, then
   *  confirm with the API; revert (full re-render) + toast on failure. */
  const dropItem = async (itemId: string, targetId: string | null): Promise<void> => {
    const field = b.field;
    if (!field) return;
    const it = itemsById.get(itemId);
    const card = cardsById.get(itemId);
    const target = cols.get(targetId);
    if (!it || !card || !target || it.statusOptionId === targetId) return;
    const fromId = it.statusOptionId;
    target.body.appendChild(card);
    it.statusOptionId = targetId;
    syncCounts();
    card.classList.add("is-moving");
    try {
      const r = await host.invoke("project:moveItem", {
        projectId: p.id,
        itemId: it.id,
        fieldId: field.id,
        optionId: targetId,
      });
      if (!r.ok) {
        toast(r.message ?? "Couldn't move the item.", "error");
        it.statusOptionId = fromId;
        void showProjectBoard(detail, p, refresh, nav); // revert to the truth
        return;
      }
      card.classList.remove("is-moving");
      bust("project"); // the next board read refetches the confirmed state
    } catch (e) {
      toast(cleanErr(e) || "Couldn't move the item.", "error");
      it.statusOptionId = fromId;
      void showProjectBoard(detail, p, refresh, nav);
    }
  };

  const boardEl = el("div", "gh-board");
  for (const col of columns) {
    const items = b.items.filter((it) => (b.field ? it.statusOptionId === col.id : true));
    // An empty bucket is still a drop target, but it must not claim an equal
    // quarter of the board: "No status · 0" was a 400px column of nothing
    // beside three columns holding the actual work.
    const colEl = el("div", "gh-col" + (items.length === 0 ? " is-empty" : ""));
    const colHead = el("div", "gh-col-head");
    const colName = el("span", "gh-col-name");
    colName.textContent = col.name;
    colName.title = col.name;
    const count = pill(String(items.length));
    colHead.append(colName, count);
    colEl.appendChild(colHead);
    const colBody = el("div", "gh-col-body");
    // The empty placeholder is ALWAYS present (CSS shows it via :only-child), so
    // a column emptied by a drag keeps a visible drop zone.
    colBody.appendChild(el("div", "gh-col-empty"));
    for (const it of items) {
      colBody.insertBefore(
        projectCard(p, b, it, refresh, nav, cardsById),
        colBody.querySelector(".gh-col-empty"),
      );
    }
    colEl.appendChild(colBody);
    cols.set(col.id, { el: colEl, body: colBody, count });

    // Drop target wiring (only meaningful with a Status field to write to).
    if (b.field) {
      colEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        colEl.classList.add("is-drop");
      });
      colEl.addEventListener("dragleave", (e) => {
        if (!colEl.contains(e.relatedTarget as Node)) colEl.classList.remove("is-drop");
      });
      colEl.addEventListener("drop", (e) => {
        e.preventDefault();
        colEl.classList.remove("is-drop");
        const id = e.dataTransfer?.getData("text/plain");
        if (id) void dropItem(id, col.id);
      });
    }
    boardEl.appendChild(colEl);
  }
  detail.appendChild(boardEl);
  syncCounts();
}

/** One board card: a state dot + title + number/author/updated meta + a type pill,
 *  plus a kebab to move/open the item. Clicking the body opens the issue/PR;
 *  dragging it onto another column moves it. */
function projectCard(
  p: ProjectInfo,
  board: ProjectBoard,
  it: ProjectItem,
  refresh: () => void,
  nav: SectionNav,
  registry?: Map<string, HTMLElement>,
): HTMLElement {
  const card = el("div", "gh-card");
  registry?.set(it.id, card);

  // Draggable between Status columns (the kebab menu stays as the keyboard path).
  if (board.field) {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", it.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  }

  const top = el("div", "gh-card-top");
  const stateKey = it.state ? it.state.toLowerCase() : "";
  const dot = el("span", `gh-check-dot gh-state-${stateKey || "none"}`);
  // A card wrote its TYPE in words ("Issue", "PR") and its STATE — open, closed,
  // merged, the thing that decides whether it still needs you — as a 9px dot
  // with no label at all. The dot keeps its place; the word joins the sub-line.
  if (stateKey) {
    const stateWord =
      stateKey === "merged" ? "Merged" : stateKey === "closed" ? "Closed" : "Open";
    dot.title = stateWord;
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", stateWord);
  }
  const title = el("div", "gh-card-title");
  title.textContent = it.title;
  top.append(dot, title);

  const kebab = el("button", "gh-card-kebab");
  kebab.setAttribute("aria-label", "Item actions");
  kebab.title = "Item actions";
  kebab.appendChild(glyph("kebab-vertical"));
  kebab.addEventListener("click", (e) => {
    e.stopPropagation();
    projectItemMenu(kebab, p, board, it, refresh);
  });
  top.appendChild(kebab);
  card.appendChild(top);

  const sub = el("div", "gh-card-sub");
  const num = it.number != null ? `#${it.number}` : it.type === "DRAFT_ISSUE" ? "draft" : "";
  const when = relTimeISO(it.updatedAt);
  const stateWord = stateKey
    ? stateKey === "merged"
      ? "merged"
      : stateKey === "closed"
        ? "closed"
        : "open"
    : "";
  sub.textContent = [num, stateWord, it.author && `@${it.author}`, when]
    .filter(Boolean)
    .join(" · ");
  card.appendChild(sub);

  const typePill = pill(
    it.type === "PULL_REQUEST" ? "PR" : it.type === "DRAFT_ISSUE" ? "Draft" : "Issue",
  );
  card.appendChild(typePill);

  // Whole-card click opens the underlying item IN-APP — the project board is part
  // of our ecosystem; you never bounce to github.com to read one. Issues peek in a
  // slide-over drawer right here on the board (read, comment, triage — no screen
  // switch); PRs open their full workspace, where the diff + review tools live.
  // (Draft items live only in the project and have no number, so they stay inert.)
  const canOpen =
    it.number != null && (it.type === "ISSUE" || it.type === "PULL_REQUEST");
  if (canOpen) {
    const num = it.number as number;
    const isPr = it.type === "PULL_REQUEST";
    const open = (): void => {
      if (isPr) nav("prs", { number: num });
      else openIssueDrawer(num, nav, refresh);
    };
    card.classList.add("clickable");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.title = isPr ? `Open pull request #${num}` : `Peek issue #${num}`;
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  }
  return card;
}

/**
 * Peek an issue inline in a right-side slide-over drawer, so the board never has
 * to hand off to the Issues screen to read, comment on, or triage an item. The
 * drawer hosts the full issue detail (body, timeline, composer, action cluster),
 * all of whose mutations re-render inside it. "Open in Issues" escalates to the
 * full-page issue workspace when you want the section around it.
 */
function openIssueDrawer(number: number, nav: SectionNav, onChanged?: () => void): void {
  /** Did anything in the drawer change the issue? Refreshing the board on
   *  every close would re-fetch on a plain read; refreshing on none left a
   *  closed issue showing as open on the card behind. */
  let changed = false;
  const opener = document.activeElement as HTMLElement | null;
  const scrim = el("div", "gh-drawer-scrim");
  const drawer = el("div", "gh-drawer");
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-label", `Issue #${number}`);

  const head = el("div", "gh-drawer-head");
  const eyebrow = el("div", "gh-drawer-eyebrow");
  eyebrow.append(glyph("issue-opened"), span(`Issue #${number}`));
  const headActions = el("div", "gh-drawer-actions");
  const openFull = el("button", "mini-btn");
  openFull.append(glyph("issues"), span("Open in Issues"));
  openFull.title = "Open this issue as a full page in the Issues section";
  const closeBtn = el("button", "gh-drawer-close");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.title = "Close  (Esc)";
  closeBtn.appendChild(glyph("close"));
  headActions.append(openFull, closeBtn);
  head.append(eyebrow, headActions);

  const body = el("div", "gh-detail gh-drawer-body");
  drawer.append(head, body);
  scrim.appendChild(drawer);
  document.body.appendChild(scrim);
  const releaseBackground = holdBackground(scrim);

  let disposed = false;
  const dispose = (restoreFocus = true): void => {
    if (disposed) return;
    disposed = true;
    layer.release();
    releaseBackground();
    document.removeEventListener("keydown", onKey, true);
    scrim.classList.remove("is-open");
    // Let the slide-out play, then remove; restore focus to the card.
    window.setTimeout(() => scrim.remove(), 200);
    if (restoreFocus) opener?.focus?.();
    if (changed) onChanged?.();
  };
  // A route change dismisses this drawer like every other floating layer. It
  // was the one surface that never registered, so navigating away left it
  // hanging over the next view — and now that it makes the page behind it
  // `inert`, a drawer that outlived its own view would have frozen the app.
  const layer = registerLayer(() => dispose(false));
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      // A dialog opened from inside the drawer owns Escape. Without this, one
      // press closed the dialog and took the drawer under it too, discarding
      // whatever the card was showing. Same rule as the peek and the
      // notifications popover; see `ownsEscape`.
      if (!ownsEscape()) return;
      e.preventDefault();
      dispose();
    }
  };
  document.addEventListener("keydown", onKey, true);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) dispose();
  });
  closeBtn.addEventListener("click", () => dispose());
  openFull.addEventListener("click", () => {
    dispose();
    nav("issues", { number });
  });

  requestAnimationFrame(() => scrim.classList.add("is-open"));
  closeBtn.focus();
  void renderIssueDetailInto(body, number, nav, () => {
    changed = true;
  });
}

/** Kebab menu: "Open on GitHub" + "Move to → <Status option>" (the keyboard
 *  path for what drag-and-drop does with the pointer). */
function projectItemMenu(
  anchor: HTMLElement,
  p: ProjectInfo,
  board: ProjectBoard,
  it: ProjectItem,
  refresh: () => void,
): void {
  const items: MenuItem[] = [];
  if (it.url) {
    const url = it.url;
    items.push({ label: "Open on GitHub", icon: "link-external", onClick: () => window.open(url, "_blank") });
  }
  const card = anchor.closest(".gh-card") as HTMLElement | null;
  const field = board.field;
  if (field) {
    if (items.length) items.push({ separator: true, label: "Move to" });
    // "No Status" target (clears the field).
    items.push({
      label: "No status",
      current: it.statusOptionId === null,
      onClick: () => void projectMoveItem(p, field.id, it, null, refresh, card),
    });
    for (const opt of field.options) {
      items.push({
        label: opt.name,
        current: it.statusOptionId === opt.id,
        onClick: () => void projectMoveItem(p, field.id, it, opt.id, refresh, card),
      });
    }
  }
  if (!items.length) {
    items.push({ label: "No actions available", disabled: true });
  }
  openMenu(anchor, items);
}

/** Move an item's Status, then re-render the section (mutation → toast → refresh). */
async function projectMoveItem(
  p: ProjectInfo,
  fieldId: string,
  it: ProjectItem,
  optionId: string | null,
  refresh: () => void,
  card?: HTMLElement | null,
): Promise<void> {
  if (it.statusOptionId === optionId) return; // no-op
  // Lock + dim the card while the move is in flight so it's clear it's working.
  card?.classList.add("is-moving");
  try {
    const r = await host.invoke("project:moveItem", {
      projectId: p.id,
      itemId: it.id,
      fieldId,
      optionId,
    });
    if (!r.ok) {
      card?.classList.remove("is-moving");
      toast(r.message ?? "Couldn't move the item.", "error");
      return;
    }
    toast("Moved item.", "success");
    // Re-render the whole section; selectedProjectId reselects this project,
    // reloading its board with the new Status in place (which replaces the card).
    refresh();
  } catch (e) {
    card?.classList.remove("is-moving");
    toast(cleanErr(e) || "Couldn't move the item.", "error");
  }
}
