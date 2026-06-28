// The GitHub "Projects" section: a two-pane view — a master list of the repo's
// Projects (v2) on the left, and the selected project's board (columns grouped
// by its Status field, with movable cards) on the right.
//
// It mirrors the PR/Issue section exactly (gh-view / gh-list / gh-detail / gh-row
// / gh-detail-*), then adds the board (gh-board / gh-col / gh-card). Reads throw →
// errorState + Retry; the move mutation toasts + re-renders. The whole view
// re-renders by calling renderProjects again; module-local `selectedProjectId`
// makes the list auto-reselect the project the user was on, so a move reloads its
// board with the card in its new column — the same refresh-after-mutation UX the
// PR view gets from re-running showPullRequestsView.

import { host } from "../bridge";
import {
  el,
  span,
  glyph,
  pill,
  relTimeISO,
  absTimeISO,
  loadingState,
  skeletonList,
  errorState,
  emptyState,
  openMenu,
  cleanErr,
  ghRow,
  statePill,
  type MenuItem,
} from "../ui";
import { toast } from "../dialogs";
import { ghGate, ghHeader, type SectionRender } from "./common";
import type { ProjectBoard, ProjectInfo, ProjectItem } from "../../shared/ipc";

// Which project the user last opened. Survives a re-render so a move (or refresh)
// re-selects it and reloads its board in place. `undefined` = nothing opened yet.
let selectedProjectId: string | undefined;

export const renderProjects: SectionRender = (wrap, nav) => {
  void renderProjectsAsync(wrap, nav);
};

async function renderProjectsAsync(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const gate = await ghGate(wrap, nav, true);
  if (!gate) return;

  const refresh = (): void => renderProjects(wrap, nav);

  const header = ghHeader("Projects", gate.login, refresh);
  const view = el("div", "gh-view");
  view.appendChild(header);
  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail gh-board-detail");
  body.append(listEl, detail);
  view.appendChild(body);
  wrap.replaceChildren(view);
  const idleEmpty = (): void => {
    detail.replaceChildren(
      emptyState(
        "Projects",
        "Select a project to see its board, with cards grouped by Status.",
        { icon: "project", hint: "Tip: open one to move cards between columns or jump to an item on GitHub." },
      ),
    );
  };
  idleEmpty();

  listEl.replaceChildren(skeletonList(5));
  let projects: ProjectInfo[];
  try {
    projects = await host.invoke("project:list", undefined);
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load projects", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }
  header.setCount?.(projects.length);
  listEl.replaceChildren();
  if (projects.length === 0) {
    selectedProjectId = undefined;
    listEl.appendChild(
      emptyState("No projects", "No GitHub Projects (v2) are linked to this repository.", {
        icon: "project",
      }),
    );
    return;
  }

  const select = (p: ProjectInfo, row: HTMLElement): void => {
    listEl.querySelectorAll(".gh-row.active").forEach((n) => n.classList.remove("active"));
    row.classList.add("active");
    selectedProjectId = p.id;
    void showProjectBoard(detail, p, refresh);
  };

  let toReselect: { p: ProjectInfo; row: HTMLElement } | undefined;
  projects.forEach((p, i) => {
    const lead = el("span", "gh-lead-icon gh-lead-merged");
    lead.appendChild(glyph("project"));
    const when = relTimeISO(p.updatedAt);
    const row = ghRow({
      lead,
      title: p.title,
      titleSuffix: p.closed ? [statePill("Closed", "closed")] : [],
      meta:
        `#${p.number} · ${p.itemCount} item${p.itemCount === 1 ? "" : "s"}` +
        (when ? ` · updated ${when}` : ""),
      metaTitle: p.updatedAt ? `Updated ${absTimeISO(p.updatedAt)}` : undefined,
      ariaLabel: `Project #${p.number}: ${p.title}`,
    });
    row.addEventListener("click", () => select(p, row));
    listEl.appendChild(row);
    if (p.id === selectedProjectId) toReselect = { p, row };
    else if (i === 0 && !toReselect && selectedProjectId === undefined) {
      // Auto-select the first project so the board isn't a void on first load.
      select(p, row);
    }
  });
  // After a mutation-driven re-render, reopen the project the user was on.
  if (toReselect) select(toReselect.p, toReselect.row);
}

/**
 * The detail pane: a header (title + meta + "Open on GitHub") above a horizontal
 * scroller of columns — one per Status option, plus a leading "No Status" bucket
 * for unset items. Projects with no Status single-select field fall back to a
 * single "All items" column.
 */
async function showProjectBoard(
  detail: HTMLElement,
  p: ProjectInfo,
  refresh: () => void,
): Promise<void> {
  detail.replaceChildren(loadingState());
  let board: ProjectBoard;
  try {
    board = await host.invoke("project:board", p.id);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load board", cleanErr(e) || "GitHub request failed.", () =>
        void showProjectBoard(detail, p, refresh),
      ),
    );
    return;
  }
  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = p.title;
  const meta = el("div", "gh-detail-meta");
  meta.textContent =
    `#${p.number} · ${board.items.length} item${board.items.length === 1 ? "" : "s"}` +
    `${board.field ? "" : " · no Status field"}`;
  const actions = el("div", "gh-detail-actions");
  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.title = "Open this project on github.com";
  openBtn.addEventListener("click", () => window.open(p.url, "_blank"));
  actions.appendChild(openBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  // Columns = Status options, with a leading "No Status" bucket. With no Status
  // field, a single "All items" column holds everything.
  const columns: { id: string | null; name: string }[] = board.field
    ? [{ id: null, name: "No Status" }, ...board.field.options.map((o) => ({ id: o.id, name: o.name }))]
    : [{ id: null, name: "All items" }];

  const boardEl = el("div", "gh-board");
  for (const col of columns) {
    const items = board.items.filter((it) => (board.field ? it.statusOptionId === col.id : true));
    const colEl = el("div", "gh-col");
    const colHead = el("div", "gh-col-head");
    const colName = el("span", "gh-col-name");
    colName.textContent = col.name;
    colName.title = col.name;
    colHead.append(colName, pill(String(items.length)));
    colEl.appendChild(colHead);
    const colBody = el("div", "gh-col-body");
    if (items.length === 0) {
      colBody.appendChild(el("div", "gh-col-empty"));
    }
    for (const it of items) {
      colBody.appendChild(projectCard(p, board, it, refresh));
    }
    colEl.appendChild(colBody);
    boardEl.appendChild(colEl);
  }
  detail.appendChild(boardEl);
}

/** One board card: a state dot + title + number/author/updated meta + a type pill,
 *  plus a kebab to move/open the item. Clicking the body opens the issue/PR. */
function projectCard(
  p: ProjectInfo,
  board: ProjectBoard,
  it: ProjectItem,
  refresh: () => void,
): HTMLElement {
  const card = el("div", "gh-card");

  const top = el("div", "gh-card-top");
  const stateKey = it.state ? it.state.toLowerCase() : "";
  const dot = el("span", `gh-check-dot gh-state-${stateKey || "none"}`);
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
  sub.textContent = [num, it.author && `@${it.author}`, when].filter(Boolean).join(" · ");
  card.appendChild(sub);

  const typePill = pill(
    it.type === "PULL_REQUEST" ? "PR" : it.type === "DRAFT_ISSUE" ? "Draft" : "Issue",
  );
  card.appendChild(typePill);

  // Whole-card click opens the underlying issue/PR (drafts have no url).
  if (it.url) {
    const url = it.url;
    card.classList.add("clickable");
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.addEventListener("click", () => window.open(url, "_blank"));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        window.open(url, "_blank");
      }
    });
  }
  return card;
}

/** Kebab menu: "Open on GitHub" + "Move to → <Status option>" (the write path). */
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
  const field = board.field;
  if (field) {
    if (items.length) items.push({ separator: true, label: "Move to" });
    // "No Status" target (clears the field).
    items.push({
      label: "No Status",
      current: it.statusOptionId === null,
      onClick: () => void projectMoveItem(p, field.id, it, null, refresh),
    });
    for (const opt of field.options) {
      items.push({
        label: opt.name,
        current: it.statusOptionId === opt.id,
        onClick: () => void projectMoveItem(p, field.id, it, opt.id, refresh),
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
): Promise<void> {
  if (it.statusOptionId === optionId) return; // no-op
  try {
    const r = await host.invoke("project:moveItem", {
      projectId: p.id,
      itemId: it.id,
      fieldId,
      optionId,
    });
    if (!r.ok) {
      toast(r.message ?? "Couldn't move the item.", "error");
      return;
    }
    toast("Moved item.", "success");
    // Re-render the whole section; selectedProjectId reselects this project,
    // reloading its board with the new Status in place.
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't move the item.", "error");
  }
}
