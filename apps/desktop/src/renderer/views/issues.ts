// Issues — the repo-scoped GitHub Issues section.
//
// A two-pane view (list ⟷ detail) mirroring the Pull Requests surface: a header
// with an open/closed filter + "New Issue", a list of issue rows with label
// chips, and a rich detail pane (markdown body, comment timeline, composer, and
// the full CRUD action cluster — edit, labels, assignees, close/reopen).
//
// Self-contained: it renders into the `wrap` it's handed and re-renders by
// calling itself, so all state survives a refresh. Every mutation disables its
// trigger, toasts the result, and re-fetches so the UI stays authoritative.

import { host } from "../bridge";
import {
  avatar,
  cleanErr,
  el,
  emptyState,
  errorState,
  ghRow,
  glyph,
  labelChip,
  loadingState,
  openMenu,
  pill,
  relTimeISO,
  absTimeISO,
  skeletonList,
  span,
  statBit,
  stateLead,
} from "../ui";
import { confirmDialog, promptInline, toast } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { ghGate, ghHeader, searchField, type SectionRender } from "./common";
import type { IssueDetail, IssueInfo, RepoLabel } from "../../shared/ipc";

/** The open/closed filter, persisted across re-renders within the section. */
let issueState: "open" | "closed" = "open";

// ── Small DOM builders ───────────────────────────────────────────────────────

/** One timeline card: the issue body (first) or a comment. Markdown body. */
function commentCard(author: string, action: string, body: string, createdAt: string): HTMLElement {
  const card = el("div", "gh-comment");
  const hd = el("div", "gh-comment-head");
  const who = span(author, "");
  hd.append(who, span(`${action} · ${relTimeISO(createdAt)}`, "gh-comment-when"));
  card.appendChild(hd);
  const bd = el("div", "gh-body-md");
  if (body.trim()) {
    // renderMarkdown is escape-first (XSS-safe); guard anyway and fall back to
    // plain text if it ever throws — matches the Code-view README render.
    try {
      bd.innerHTML = renderMarkdown(body);
    } catch {
      bd.classList.add("code-md-plain");
      bd.textContent = body;
    }
  } else {
    bd.classList.add("gh-empty-body");
    bd.textContent = "No description provided.";
  }
  card.appendChild(bd);
  return card;
}

// ── The section view ─────────────────────────────────────────────────────────

export const renderIssues: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const refresh = (): void => renderIssues(wrap, nav);

  const gate = await ghGate(wrap, nav, true);
  if (!gate) return;

  // Shell: gh-view → header (+ tools) → gh-body (list | detail).
  const view = el("div", "gh-view");
  const header = ghHeader("Issues", gate.login, refresh);

  // Right-side cluster in the header: state filter + New Issue.
  const tools = el("div", "gh-head-tools");
  const filter = el("button", "mini-btn");
  filter.textContent = issueState === "open" ? "Open" : "Closed";
  filter.title = "Toggle open / closed issues";
  filter.addEventListener("click", () => {
    issueState = issueState === "open" ? "closed" : "open";
    refresh();
  });
  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("add"), span("New Issue"));
  newBtn.addEventListener("click", () => void newIssue(wrap, nav));
  tools.append(filter, newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.appendChild(header);

  const body = el("div", "gh-body");
  const listEl = el("div", "gh-list");
  const detail = el("div", "gh-detail");
  body.append(listEl, detail);
  view.appendChild(body);
  wrap.replaceChildren(view);
  const idleEmpty = (): void => {
    detail.replaceChildren(
      emptyState(
        "Issues",
        "Select an issue to read its description, comment, manage labels and assignees, or close it.",
        {
          icon: "issue-opened",
          hint: "Tip: use the Open / Closed toggle to switch which issues you're browsing.",
        },
      ),
    );
  };
  idleEmpty();

  // Load the list (the API filters by state — the Open/Closed toggle drives it).
  listEl.replaceChildren(skeletonList(5));
  let issues: IssueInfo[];
  try {
    issues = await host.invoke("issue:list", { state: issueState });
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load issues", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }

  header.setCount?.(issues.length);
  listEl.replaceChildren();
  if (issues.length === 0) {
    idleEmpty();
    listEl.appendChild(
      emptyState(
        issueState === "open" ? "No open issues" : "No closed issues",
        issueState === "open"
          ? "You're all caught up — there's nothing open to triage right now."
          : "Closed issues will show here once you close some.",
        issueState === "open"
          ? {
              icon: "issue-opened",
              action: { label: "New issue", icon: "add", onClick: () => void newIssue(wrap, nav) },
            }
          : { icon: "issue-closed" },
      ),
    );
    return;
  }

  const select = (it: IssueInfo, row: HTMLElement): void => {
    listEl.querySelectorAll(".gh-row.active").forEach((n) => n.classList.remove("active"));
    row.classList.add("active");
    void showDetail(detail, it.number, wrap, nav);
  };

  const buildRow = (it: IssueInfo): HTMLElement => {
    const chips = it.labels.map((l) => labelChip(l.name, l.color));
    const stats: HTMLElement[] = [];
    if (it.comments > 0) stats.push(statBit("comment", it.comments));
    // A small trailing avatar cluster for up to three assignees.
    if (it.assignees.length) {
      const cluster = el("span", "gh-row-assignees");
      for (const a of it.assignees.slice(0, 3)) cluster.appendChild(avatar(a.login, a.avatarUrl, 18));
      stats.push(cluster);
    }
    const author = it.user?.login ?? "unknown";
    const row = ghRow({
      lead: stateLead(it.state === "closed" ? "closed" : "open"),
      title: it.title,
      meta: `#${it.number} · ${author} · opened ${relTimeISO(it.createdAt)}`,
      metaTitle: it.createdAt ? `Opened ${absTimeISO(it.createdAt)}` : undefined,
      chips,
      stats,
      ariaLabel: `Issue #${it.number}: ${it.title}`,
    });
    row.addEventListener("click", () => select(it, row));
    return row;
  };

  // Case-insensitive match over the fields a user would search by.
  const matches = (it: IssueInfo, q: string): boolean => {
    const hay = `${it.title} #${it.number} ${it.user?.login ?? ""} ${it.labels
      .map((l) => l.name)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  };

  let autoSelected = false;
  const renderList = (items: IssueInfo[], q = ""): void => {
    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.appendChild(
        emptyState("No matching issues", `Nothing matches “${q}”.`, { icon: "search" }),
      );
      return;
    }
    for (const it of items) listEl.appendChild(buildRow(it));
    // Auto-select the first issue once (initial render) so the detail isn't a
    // void; don't hijack the selection on every keystroke while filtering.
    if (!autoSelected) {
      autoSelected = true;
      const first = items[0];
      const firstRow = listEl.firstElementChild as HTMLElement | null;
      if (first && firstRow) select(first, firstRow);
    }
  };

  // A header search/filter over the loaded list (client-side, instant).
  tools.insertBefore(
    searchField({
      placeholder: "Search issues…",
      onInput: (q) => renderList(q ? issues.filter((it) => matches(it, q.toLowerCase())) : issues, q),
    }),
    tools.firstChild,
  );

  renderList(issues);
}

// ── Detail pane ──────────────────────────────────────────────────────────────

async function showDetail(
  detail: HTMLElement,
  n: number,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  const reload = (): void => void showDetail(detail, n, wrap, nav);

  detail.replaceChildren(loadingState());
  let d: IssueDetail | undefined;
  try {
    d = await host.invoke("issue:detail", n);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load issue", cleanErr(e) || "GitHub request failed.", reload),
    );
    return;
  }
  if (!d) {
    detail.replaceChildren(emptyState("Issue unavailable", "This issue couldn't be loaded."));
    return;
  }
  const it = d.issue;
  const assignees = d.assignees;
  detail.replaceChildren();

  // Head: title + meta + actions.
  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = it.title;

  const meta = el("div", "gh-detail-meta");
  const statePill = pill(it.state === "open" ? "Open" : "Closed");
  statePill.classList.add(it.state === "open" ? "gh-issue-open" : "gh-issue-closed");
  meta.append(
    statePill,
    document.createTextNode(
      `  #${it.number} · ${it.user?.login ?? ""} · ${it.comments} comment${
        it.comments === 1 ? "" : "s"
      } · ${relTimeISO(it.createdAt)}`,
    ),
  );

  const actions = el("div", "gh-detail-actions");

  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("edit"), span("Edit"));
  editBtn.addEventListener("click", () => void editIssue(detail, it, wrap, nav));

  const labelsBtn = el("button", "mini-btn");
  labelsBtn.append(glyph("tag"), span("Labels"));
  labelsBtn.addEventListener("click", () => void labelsMenu(labelsBtn, detail, it, wrap, nav));

  const assignBtn = el("button", "mini-btn");
  assignBtn.append(glyph("organization"), span("Assignees"));
  assignBtn.addEventListener("click", () => void editAssignees(detail, it, assignees, wrap, nav));

  const closing = it.state === "open";
  const stateBtn = el("button", "mini-btn");
  stateBtn.append(glyph(closing ? "issue-closed" : "issue-opened"), span(closing ? "Close" : "Reopen"));
  stateBtn.addEventListener("click", () =>
    void changeState(detail, it.number, closing ? "closed" : "open", stateBtn, wrap, nav),
  );

  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.addEventListener("click", () => window.open(it.htmlUrl, "_blank"));

  actions.append(editBtn, labelsBtn, assignBtn, stateBtn, openBtn);
  head.append(h, meta, actions);
  detail.appendChild(head);

  // Live label chips.
  if (it.labels.length) {
    const labelRow = el("div", "gh-detail-labels");
    for (const l of it.labels) labelRow.appendChild(labelChip(l.name, l.color));
    detail.appendChild(labelRow);
  }
  // Assignee chips.
  if (assignees.length) {
    const aRow = el("div", "gh-detail-assignees");
    aRow.appendChild(span("Assigned:", "gh-assign-label"));
    for (const login of assignees) aRow.appendChild(pill(`@${login}`));
    detail.appendChild(aRow);
  }

  // Timeline: the body as the first card, then each comment.
  const timeline = el("div", "gh-subcontent");
  timeline.appendChild(
    commentCard(it.user?.login ?? "author", "opened this issue", it.body ?? "", it.createdAt),
  );
  for (const c of d.comments) {
    timeline.appendChild(commentCard(c.author?.login ?? "unknown", "commented", c.body, c.createdAt));
  }
  detail.appendChild(timeline);

  // Comment composer.
  const composer = el("div", "gh-composer");
  const ta = document.createElement("textarea");
  ta.className = "gh-composer-input";
  ta.placeholder = "Leave a comment…";
  ta.rows = 4;
  const crow = el("div", "gh-composer-actions");
  const send = el("button", "btn btn-primary");
  send.append(glyph("comment"), span("Comment"));
  send.addEventListener("click", () => void postComment(detail, it.number, ta, send, wrap, nav));
  crow.appendChild(send);
  composer.append(ta, crow);
  detail.appendChild(composer);
}

// ── Mutations (disable trigger → toast → re-fetch) ───────────────────────────

async function newIssue(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const title = await promptInline("New issue", "Issue title", "", "Next");
  if (!title) return;
  // Body is optional — the user can cancel the 2nd step and still create.
  const bodyRaw = await promptInline("Issue description (optional)", "Describe the issue…", "", "Create");
  try {
    const r = await host.invoke("issue:create", { title, body: bodyRaw ?? "" });
    if (!r.ok) {
      toast(r.message ?? "Couldn't create the issue.", "error");
      return;
    }
    toast(r.number ? `Opened issue #${r.number}.` : "Issue created.", "success");
    issueState = "open";
    renderIssues(wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't create the issue.", "error");
  }
}

async function postComment(
  detail: HTMLElement,
  n: number,
  ta: HTMLTextAreaElement,
  btn: HTMLElement,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  const body = ta.value.trim();
  if (!body) {
    toast("Write a comment first.", "info");
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  ta.disabled = true;
  try {
    const r = await host.invoke("issue:comment", { number: n, body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't post the comment.", "error");
      return;
    }
    toast("Comment posted.", "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't post the comment.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
    ta.disabled = false;
  }
}

async function changeState(
  detail: HTMLElement,
  n: number,
  state: "open" | "closed",
  btn: HTMLElement,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  if (state === "closed") {
    const ok = await confirmDialog({
      title: `Close issue #${n}?`,
      message: "This closes the issue on GitHub.",
      confirmLabel: "Close issue",
    });
    if (!ok) return;
  }
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("issue:setState", { number: n, state });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the issue.", "error");
      return;
    }
    toast(state === "closed" ? `Closed issue #${n}.` : `Reopened issue #${n}.`, "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the issue.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function editIssue(
  detail: HTMLElement,
  it: IssueInfo,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  const title = await promptInline("Edit title", "Issue title", it.title, "Next");
  if (title === null) return;
  // allowEmpty: "" means "clear the body"; null means the body step was cancelled
  // (keep the existing body).
  const body = await promptInline("Edit description", "Describe the issue…", it.body ?? "", "Save", true);
  const finalBody = body === null ? it.body ?? "" : body;
  if (finalBody === (it.body ?? "") && title === it.title) return; // nothing changed
  try {
    const r = await host.invoke("issue:edit", {
      number: it.number,
      title,
      body: finalBody,
    });
    if (!r.ok) {
      toast(r.message ?? "Couldn't edit the issue.", "error");
      return;
    }
    toast("Issue updated.", "success");
    await showDetail(detail, it.number, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't edit the issue.", "error");
  }
}

async function labelsMenu(
  anchor: HTMLElement,
  detail: HTMLElement,
  it: IssueInfo,
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await host.invoke("issue:labels", undefined);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load labels.", "error");
    return;
  }
  if (repoLabels.length === 0) {
    toast("This repo has no labels defined.", "info");
    return;
  }
  const current = new Set(it.labels.map((l) => l.name));
  openMenu(
    anchor,
    repoLabels.map((l) => ({
      label: l.name,
      icon: "tag",
      current: current.has(l.name),
      onClick: () => {
        const next = new Set(current);
        if (next.has(l.name)) next.delete(l.name);
        else next.add(l.name);
        void applyLabels(detail, it.number, [...next], wrap, nav);
      },
    })),
  );
}

async function applyLabels(
  detail: HTMLElement,
  n: number,
  labels: string[],
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  try {
    const r = await host.invoke("issue:setLabels", { number: n, labels });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update labels.", "error");
      return;
    }
    toast("Labels updated.", "success");
    await showDetail(detail, n, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update labels.", "error");
  }
}

async function editAssignees(
  detail: HTMLElement,
  it: IssueInfo,
  current: string[],
  wrap: HTMLElement,
  nav: (view: string) => void,
): Promise<void> {
  const csv = await promptInline(
    "Assignees",
    "comma-separated logins, e.g. octocat, hubot",
    current.join(", "),
    "Save",
  );
  if (csv === null) return;
  const assignees = csv
    .split(",")
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
  try {
    const r = await host.invoke("issue:setAssignees", { number: it.number, assignees });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update assignees.", "error");
      return;
    }
    toast("Assignees updated.", "success");
    await showDetail(detail, it.number, wrap, nav);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update assignees.", "error");
  }
}
