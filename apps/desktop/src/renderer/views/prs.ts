// The Pull Requests section view — a full, GitHub-grade two-pane PR workspace.
//
// Left: the open-PR list. Right: the selected PR's detail with Conversation /
// Commits / Pipelines / Files sub-tabs and the full action cluster (Checkout,
// Approve, Review ▾, Mark ready, Merge ▾, Open on GitHub, ⋯). The header carries
// a primary "New PR" action that opens a multi-field create modal.
//
// Everything routes through `host.invoke` against the typed IPC contract. Reads
// that fail render an errorState with Retry; every mutation disables its trigger,
// confirms destructive ops, toasts success/error, and re-renders the affected
// surface (the list and/or the detail) — never the local git graph, since none
// of these PR API writes touch the working tree.

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
  copyText,
  cleanErr,
  openMenu,
  ghRow,
  avatar,
  labelChip,
  statBit,
  statePill,
  stateLead,
} from "../ui";
import { toast, confirmDialog, promptInline } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { ghGate, ghHeader, ghTwoPane, searchField, trapTab, type SectionRender } from "./common";
import type {
  BranchRef,
  PrComment,
  PrDetail,
  PullRequest,
  RepoCollaborator,
} from "../../shared/ipc";

// Persist the active sub-tab across re-renders so a comment / state change keeps
// the user on the tab they were reading.
let activeSubTab = "conversation";

export const renderPrs: SectionRender = (wrap, nav) => {
  void mount(wrap, nav);
};

const refresher = (wrap: HTMLElement, nav: (view: string) => void) => () => renderPrs(wrap, nav);

async function mount(wrap: HTMLElement, nav: (view: string) => void): Promise<void> {
  const gate = await ghGate(wrap, nav, true);
  if (!gate) return;
  const refresh = refresher(wrap, nav);

  const header = ghHeader("Pull Requests", gate.login, refresh);
  // A primary "New PR" action lives left of the account cluster in the head row.
  const newBtn = el("button", "mini-btn gh-head-action");
  newBtn.append(glyph("git-pull-request"), span("New PR"));
  newBtn.title = "Open a new pull request";
  newBtn.addEventListener("click", () => void openCreatePr(refresh));
  const acct = header.querySelector(".gh-acct");
  if (acct) acct.before(newBtn);
  else header.appendChild(newBtn);

  const { view, listEl, detailEl } = ghTwoPane();
  wrap.replaceChildren(header, view);
  const idleEmpty = (): void => {
    detailEl.replaceChildren(
      emptyState(
        "Pull requests",
        "Select a pull request to read its description, review the diff, and check CI.",
        { icon: "git-pull-request", hint: "Tip: open one to approve, merge, or check out the branch." },
      ),
    );
  };
  idleEmpty();

  listEl.replaceChildren(skeletonList(5));
  let prs: PullRequest[];
  try {
    prs = await host.invoke("pr:list", undefined);
  } catch (e) {
    listEl.replaceChildren(
      errorState("Couldn't load pull requests", cleanErr(e) || "GitHub request failed.", refresh),
    );
    return;
  }
  header.setCount?.(prs.length);
  listEl.replaceChildren();
  if (prs.length === 0) {
    listEl.appendChild(
      emptyState("No open pull requests", "You're all caught up — nothing to review right now.", {
        icon: "git-pull-request",
        action: { label: "New pull request", icon: "git-pull-request", onClick: () => void openCreatePr(refresh) },
      }),
    );
    return;
  }

  const select = (pr: PullRequest, row: HTMLElement): void => {
    listEl.querySelectorAll(".gh-row.active").forEach((n) => n.classList.remove("active"));
    row.classList.add("active");
    void showDetail(detailEl, pr, refresh);
  };

  const buildRow = (pr: PullRequest): HTMLElement => {
    const kind = pr.draft ? "draft" : "open-pr";
    const chips = pr.labels.map((l) => labelChip(l.name, l.color));
    const stats: HTMLElement[] = [];
    if (typeof pr.comments === "number" && pr.comments > 0) stats.push(statBit("comment", pr.comments));
    if (typeof pr.additions === "number") stats.push(statBit("", `+${pr.additions}`, "add"));
    if (typeof pr.deletions === "number") stats.push(statBit("", `−${pr.deletions}`, "del"));
    const updated = relTimeISO(pr.updatedAt);
    const row = ghRow({
      lead: stateLead(kind),
      title: pr.title,
      titleSuffix: pr.draft ? [statePill("Draft", "draft")] : [],
      meta: `#${pr.number} ${pr.head.ref} → ${pr.base.ref} · ${pr.user?.login ?? "unknown"}${updated ? ` · ${updated}` : ""}`,
      metaTitle: pr.updatedAt ? `Updated ${absTimeISO(pr.updatedAt)}` : undefined,
      chips,
      stats,
      ariaLabel: `Pull request #${pr.number}: ${pr.title}`,
    });
    row.addEventListener("click", () => select(pr, row));
    return row;
  };

  // Case-insensitive match over the fields a user would search by.
  const matches = (pr: PullRequest, q: string): boolean => {
    const hay = `${pr.title} #${pr.number} ${pr.head.ref} ${pr.base.ref} ${pr.user?.login ?? ""} ${pr.labels
      .map((l) => l.name)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  };

  let autoSelected = false;
  const renderList = (items: PullRequest[], q = ""): void => {
    listEl.replaceChildren();
    if (items.length === 0) {
      listEl.appendChild(
        emptyState("No matching pull requests", `Nothing matches “${q}”.`, { icon: "search" }),
      );
      return;
    }
    for (const pr of items) listEl.appendChild(buildRow(pr));
    // Auto-select the first PR once (initial render) so the detail isn't a void;
    // don't hijack the selection on every keystroke while filtering.
    if (!autoSelected) {
      autoSelected = true;
      const first = items[0];
      const firstRow = listEl.firstElementChild as HTMLElement | null;
      if (first && firstRow) select(first, firstRow);
    }
  };

  // A header search/filter — on the LEFT, next to the title (client-side, instant).
  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search pull requests…",
      onInput: (q) => renderList(q ? prs.filter((pr) => matches(pr, q.toLowerCase())) : prs, q),
    }),
  );

  renderList(prs);
}

// ── Detail panel ──────────────────────────────────────────────────────────────

async function showDetail(
  detail: HTMLElement,
  pr: PullRequest,
  refreshList: () => void,
): Promise<void> {
  detail.replaceChildren(loadingState());
  let d: PrDetail | undefined;
  try {
    d = await host.invoke("pr:detail", pr.number);
  } catch (e) {
    detail.replaceChildren(
      errorState("Couldn't load this pull request", cleanErr(e) || "GitHub request failed.", () =>
        void showDetail(detail, pr, refreshList),
      ),
    );
    return;
  }
  const full = d?.pr ?? pr;
  detail.replaceChildren();

  const head = el("div", "gh-detail-head");
  const h = el("div", "gh-detail-title");
  h.textContent = full.title;
  const meta = el("div", "gh-detail-meta");
  const statePill = pill(full.draft ? "draft" : full.state);
  statePill.classList.add(full.draft ? "gh-state-draft" : `gh-state-${full.state}`);
  meta.append(
    statePill,
    span(`  #${full.number}`),
    span(`  ${full.user?.login ?? ""}`),
    span(`  ${full.head.ref} → ${full.base.ref}`),
  );
  if (d) meta.appendChild(span(`  ${d.files.length} file${d.files.length === 1 ? "" : "s"}`));
  if (d?.checks) {
    const c = pill(`checks: ${d.checks}`);
    c.classList.add(`gh-checks-${d.checks}`);
    meta.append(span("  "), c);
  }

  const actions = buildActions(detail, full, d, refreshList);
  head.append(h, meta, actions);
  detail.appendChild(head);

  // Sub-tabs: Conversation · Commits · Pipelines · Files (mirrors github.com).
  const subBar = el("div", "gh-subtabs");
  const content = el("div", "gh-subcontent");
  const subDefs = [
    { id: "conversation", label: "Conversation", icon: "comment-discussion" },
    { id: "commits", label: "Commits", icon: "git-commit" },
    { id: "checks", label: "Pipelines", icon: "play" },
    { id: "files", label: d ? `Files (${d.files.length})` : "Files", icon: "code" },
  ];
  const subBtns: HTMLElement[] = [];
  const selectSub = (id: string): void => {
    activeSubTab = id;
    for (const b of subBtns) b.classList.toggle("active", b.dataset.sub === id);
    void renderSubTab(content, full, d, id);
  };
  for (const t of subDefs) {
    const b = el("button", "gh-subtab");
    b.dataset.sub = t.id;
    b.append(glyph(t.icon), span(t.label));
    b.addEventListener("click", () => selectSub(t.id));
    subBtns.push(b);
    subBar.appendChild(b);
  }
  detail.append(subBar, content);
  selectSub(subDefs.some((s) => s.id === activeSubTab) ? activeSubTab : "conversation");
}

function buildActions(
  detail: HTMLElement,
  full: PullRequest,
  d: PrDetail | undefined,
  refreshList: () => void,
): HTMLElement {
  const actions = el("div", "gh-detail-actions");
  const reload = (): void => void showDetail(detail, full, refreshList);

  const checkoutBtn = el("button", "mini-btn");
  checkoutBtn.append(glyph("git-branch"), span("Checkout"));
  checkoutBtn.title = `Fetch and check out this PR as pr/${full.number}`;
  checkoutBtn.addEventListener("click", () => void doCheckout(full.number, checkoutBtn));

  const approveBtn = el("button", "mini-btn");
  approveBtn.append(glyph("check"), span("Approve"));
  approveBtn.title = "Approve this pull request";
  approveBtn.addEventListener("click", () => void doApprove(full.number, approveBtn, refreshList));

  const reviewBtn = el("button", "mini-btn");
  reviewBtn.append(glyph("comment"), span("Review"), glyph("chevron-down"));
  reviewBtn.title = "Submit a review";
  reviewBtn.addEventListener("click", () =>
    openMenu(reviewBtn, [
      {
        label: "Comment",
        icon: "comment",
        onClick: () => void doReview(full.number, "COMMENT", reviewBtn, refreshList),
      },
      {
        label: "Request changes",
        icon: "request-changes",
        onClick: () => void doReview(full.number, "REQUEST_CHANGES", reviewBtn, refreshList),
      },
      { separator: true },
      {
        label: "Approve",
        icon: "check",
        onClick: () => void doApprove(full.number, approveBtn, refreshList),
      },
    ]),
  );

  // "Mark ready" appears ONLY for drafts.
  let readyBtn: HTMLElement | undefined;
  if (full.draft) {
    readyBtn = el("button", "mini-btn");
    readyBtn.append(glyph("eye"), span("Mark ready"));
    readyBtn.title = "Convert this draft to ready for review";
    const rb = readyBtn;
    readyBtn.addEventListener("click", () => void doMarkReady(full.number, rb, reload, refreshList));
  }

  const mergeBtn = el("button", "btn btn-primary gh-merge-btn");
  mergeBtn.append(glyph("git-merge"), span("Merge"), glyph("chevron-down"));
  mergeBtn.addEventListener("click", () =>
    openMenu(mergeBtn, [
      { label: "Create a merge commit", icon: "git-merge", onClick: () => void doMerge(full.number, "merge", refreshList) },
      { label: "Squash and merge", icon: "git-commit", onClick: () => void doMerge(full.number, "squash", refreshList) },
      { label: "Rebase and merge", icon: "git-compare", onClick: () => void doMerge(full.number, "rebase", refreshList) },
    ]),
  );

  const openBtn = el("button", "mini-btn");
  openBtn.append(glyph("link-external"), span("Open on GitHub"));
  openBtn.addEventListener("click", () => window.open(full.htmlUrl, "_blank"));

  const moreBtn = el("button", "mini-btn gh-icon-btn");
  moreBtn.append(glyph("ellipsis"));
  moreBtn.title = "More actions";
  moreBtn.addEventListener("click", () =>
    openMenu(moreBtn, [
      {
        label: "Add a comment",
        icon: "comment",
        onClick: () => void doComment(full.number, detail, full, refreshList),
      },
      {
        label: "Request reviewers",
        icon: "organization",
        onClick: () => void doRequestReviewers(full.number),
      },
      { separator: true },
      full.state === "open"
        ? {
            label: "Close pull request",
            icon: "git-pull-request-closed",
            onClick: () => void doSetState(full.number, "closed", reload, refreshList),
          }
        : {
            label: "Reopen pull request",
            icon: "git-pull-request",
            onClick: () => void doSetState(full.number, "open", reload, refreshList),
          },
      { separator: true },
      { label: "Copy link", icon: "copy", onClick: () => void copyText(full.htmlUrl, "Copied PR link.") },
    ]),
  );

  actions.append(
    checkoutBtn,
    approveBtn,
    reviewBtn,
    ...(readyBtn ? [readyBtn] : []),
    mergeBtn,
    openBtn,
    moreBtn,
  );
  return actions;
}

async function renderSubTab(
  content: HTMLElement,
  full: PullRequest,
  d: PrDetail | undefined,
  id: string,
): Promise<void> {
  content.replaceChildren(loadingState());
  if (id === "conversation") {
    let conv: PrComment[] = [];
    try {
      conv = await host.invoke("pr:conversation", full.number);
    } catch {
      /* the description still renders; the timeline simply stays empty */
    }
    if (activeSubTab !== id) return; // a newer tab was selected mid-fetch
    content.replaceChildren();
    if (full.body && full.body.trim()) {
      content.appendChild(commentCard(full.user?.login ?? "author", "description", full.body, undefined));
    }
    for (const c of conv) {
      content.appendChild(commentCard(c.author, undefined, c.body, c.kind === "review" ? c.state : undefined));
    }
    if ((!full.body || !full.body.trim()) && conv.length === 0) {
      content.appendChild(emptyState("No conversation yet", "No description or comments on this PR."));
    }
  } else if (id === "commits") {
    let commits;
    try {
      commits = await host.invoke("pr:commits", full.number);
    } catch (e) {
      if (activeSubTab !== id) return;
      content.replaceChildren(errorState("Couldn't load commits", cleanErr(e) || "GitHub request failed."));
      return;
    }
    if (activeSubTab !== id) return;
    content.replaceChildren();
    if (commits.length === 0) {
      content.appendChild(emptyState("No commits", "This PR has no commits yet."));
      return;
    }
    for (const c of commits) {
      const row = el("div", "compare-commit");
      const subj = el("div", "cc-subject");
      subj.textContent = c.message;
      const m = el("div", "cc-meta");
      m.textContent = `${c.author} · ${c.shortSha}`;
      row.append(subj, m);
      content.appendChild(row);
    }
  } else if (id === "checks") {
    let checks;
    try {
      checks = await host.invoke("pr:checks", full.number);
    } catch (e) {
      if (activeSubTab !== id) return;
      content.replaceChildren(errorState("Couldn't load checks", cleanErr(e) || "GitHub request failed."));
      return;
    }
    if (activeSubTab !== id) return;
    content.replaceChildren();
    if (checks.length === 0) {
      content.appendChild(emptyState("No checks", "No CI checks reported for this PR's head commit."));
      return;
    }
    for (const c of checks) {
      const row = el("div", "gh-check-row");
      const state = c.conclusion || c.status || "";
      const dot = el("span", `gh-check-dot gh-checks-${state}`);
      const name = el("span", "gh-check-name");
      name.textContent = c.name;
      const st = el("span", "gh-check-state");
      st.textContent = state;
      row.append(dot, name, st);
      if (c.detailsUrl) {
        row.classList.add("is-link");
        row.addEventListener("click", () => window.open(c.detailsUrl!, "_blank"));
      }
      content.appendChild(row);
    }
  } else {
    content.replaceChildren();
    const files = d?.files ?? [];
    if (files.length === 0) {
      content.appendChild(emptyState("No files changed", "This PR doesn't change any files."));
      return;
    }
    const list = el("div", "gh-files");
    for (const f of files) {
      const row = el("div", `file-row status-${f.status.charAt(0).toUpperCase()}`);
      const st = el("span", "file-status");
      st.textContent = f.status.charAt(0).toUpperCase();
      const path = el("span", "file-path");
      path.textContent = f.filename;
      const adds = el("span", "gh-adds");
      adds.textContent = `+${f.additions} −${f.deletions}`;
      row.append(st, path, adds);
      list.appendChild(row);
    }
    content.appendChild(list);
  }
}

function commentCard(author: string, suffix: string | undefined, body: string, reviewState?: string): HTMLElement {
  const card = el("div", "gh-comment");
  const hd = el("div", "gh-comment-head");
  const who = el("span", "gh-comment-author");
  who.textContent = suffix ? `${author} · ${suffix}` : author;
  hd.appendChild(who);
  if (reviewState) {
    const badge = pill(reviewState.toLowerCase().replace(/_/g, " "));
    badge.classList.add(`gh-review-${reviewState.toLowerCase()}`);
    hd.appendChild(badge);
  }
  card.appendChild(hd);
  if (body && body.trim()) {
    const bd = el("div", "gh-body-md");
    bd.innerHTML = renderMarkdown(body);
    card.appendChild(bd);
  }
  return card;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function doCheckout(n: number, btn: HTMLElement): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:checkout", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't check out the PR.", "error");
      return;
    }
    toast(`Checked out PR #${n} as pr/${n}.`, "success");
  } catch (e) {
    toast(cleanErr(e) || "Couldn't check out the PR.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function doApprove(n: number, btn: HTMLElement, refreshList: () => void): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:approve", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't approve the PR.", "error");
      return;
    }
    btn.replaceChildren(glyph("check"), span("Approved"));
    toast(`Approved pull request #${n}.`, "success");
    refreshList();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't approve the PR.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function doReview(
  n: number,
  event: "COMMENT" | "REQUEST_CHANGES",
  btn: HTMLElement,
  refreshList: () => void,
): Promise<void> {
  const verb = event === "COMMENT" ? "Comment" : "Request changes";
  const body = await promptInline(
    `${verb} on PR #${n}`,
    event === "COMMENT" ? "Leave a comment…" : "Describe the changes you'd like…",
    "",
    "Submit",
    true, // allowEmpty: distinguish an empty submit ("") from a cancel (null)
  );
  if (body === null) return; // cancelled
  if (!body && event === "REQUEST_CHANGES") {
    toast("A comment is required to request changes.", "error");
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:review", { number: n, event, body: body || undefined });
    if (!r.ok) {
      toast(r.message ?? "Couldn't submit the review.", "error");
      return;
    }
    toast(`Review submitted on PR #${n}.`, "success");
    refreshList();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't submit the review.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function doComment(
  n: number,
  detail: HTMLElement,
  pr: PullRequest,
  refreshList: () => void,
): Promise<void> {
  const body = await promptInline(`Comment on PR #${n}`, "Write a comment…", "", "Comment");
  if (!body) return;
  try {
    const r = await host.invoke("pr:comment", { number: n, body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't post the comment.", "error");
      return;
    }
    toast(`Commented on PR #${n}.`, "success");
    // re-render the detail so the Conversation tab reloads with the new comment
    activeSubTab = "conversation";
    void showDetail(detail, pr, refreshList);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't post the comment.", "error");
  }
}

async function doSetState(
  n: number,
  state: "open" | "closed",
  reload: () => void,
  refreshList: () => void,
): Promise<void> {
  if (state === "closed") {
    const ok = await confirmDialog({
      title: `Close pull request #${n}?`,
      message: "This closes the PR on GitHub. You can reopen it afterwards.",
      confirmLabel: "Close PR",
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const r = await host.invoke("pr:setState", { number: n, state });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the pull request.", "error");
      return;
    }
    toast(state === "closed" ? `Closed PR #${n}.` : `Reopened PR #${n}.`, "success");
    reload(); // refetch + re-render the detail so the action cluster flips
    if (state === "closed") refreshList(); // a closed PR leaves the open list
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the pull request.", "error");
  }
}

async function doMarkReady(
  n: number,
  btn: HTMLElement,
  reload: () => void,
  refreshList: () => void,
): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:markReady", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't mark the PR ready.", "error");
      return;
    }
    toast(`PR #${n} is ready for review.`, "success");
    reload(); // the draft pill + "Mark ready" button disappear
    refreshList();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't mark the PR ready.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function doMerge(
  n: number,
  method: "merge" | "squash" | "rebase",
  refreshList: () => void,
): Promise<void> {
  const ok = await confirmDialog({
    title: `Merge pull request #${n}?`,
    message: `This performs a ${method} merge on GitHub and can't be undone here.`,
    confirmLabel: "Merge",
  });
  if (!ok) return;
  try {
    const r = await host.invoke("pr:merge", { number: n, method });
    if (!r.ok) {
      toast(r.message ?? "Merge failed.", "error");
      return;
    }
    toast(`Merged pull request #${n}.`, "success");
    refreshList();
  } catch (e) {
    toast(cleanErr(e) || "Merge failed.", "error");
  }
}

async function doRequestReviewers(n: number): Promise<void> {
  let people: RepoCollaborator[] = [];
  try {
    people = await host.invoke("pr:reviewers", undefined);
  } catch {
    /* fall through to the free-text path */
  }
  let chosen: string[] | null;
  if (people.length) {
    chosen = await reviewerPickerModal(people);
  } else {
    const raw = await promptInline(
      "Request reviewers",
      "comma-separated logins, e.g. alice, bob",
      "",
      "Request",
    );
    chosen = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  }
  if (!chosen || chosen.length === 0) return;
  try {
    const r = await host.invoke("pr:requestReviewers", { number: n, reviewers: chosen });
    if (!r.ok) {
      toast(r.message ?? "Couldn't request reviewers.", "error");
      return;
    }
    toast(`Requested ${chosen.length} reviewer${chosen.length === 1 ? "" : "s"} on PR #${n}.`, "success");
  } catch (e) {
    toast(cleanErr(e) || "Couldn't request reviewers.", "error");
  }
}

// ── Create-PR flow ────────────────────────────────────────────────────────────

async function openCreatePr(refresh: () => void): Promise<void> {
  let branches: BranchRef[];
  try {
    branches = await host.invoke("pr:branches", undefined);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load branches.", "error");
    return;
  }
  if (branches.length < 2) {
    toast("Need at least two branches to open a pull request.", "error");
    return;
  }
  const base = branches.find((b) => b.isDefault)?.name ?? branches[0].name;
  const head = branches.find((b) => b.name !== base)?.name ?? branches[0].name;

  const res = await createPrModal({ branches, defaultBase: base, defaultHead: head });
  if (!res) return; // cancelled
  if (!res.title.trim()) {
    toast("A title is required.", "error");
    return;
  }
  if (res.head === res.base) {
    toast("Head and base must differ.", "error");
    return;
  }
  try {
    const r = await host.invoke("pr:create", {
      title: res.title.trim(),
      head: res.head,
      base: res.base,
      body: res.body.trim() || undefined,
      draft: res.draft,
    });
    if (!r.ok) {
      toast(r.message ?? "Couldn't create the pull request.", "error");
      return;
    }
    toast(`Created pull request ${r.message ?? ""}.`.trim(), "success");
    refresh();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't create the pull request.", "error");
  }
}

// ── Self-contained multi-field modals (own overlay + Esc / outside-click) ──────

interface CreatePrResult {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

function createPrModal(opts: {
  branches: BranchRef[];
  defaultBase: string;
  defaultHead: string;
}): Promise<CreatePrResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = el("div", "modal-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "New pull request");
    const card = el("div", "modal-card gh-pr-form");
    const h = el("div", "modal-title");
    h.textContent = "New pull request";

    const mkSelect = (label: string, selected: string): { row: HTMLElement; sel: HTMLSelectElement } => {
      const row = el("label", "gh-form-row");
      row.append(span(label, "gh-form-label"));
      const sel = document.createElement("select");
      sel.className = "gh-form-select";
      for (const b of opts.branches) {
        const o = document.createElement("option");
        o.value = b.name;
        o.textContent = b.name + (b.isDefault ? "  (default)" : "");
        if (b.name === selected) o.selected = true;
        sel.appendChild(o);
      }
      row.appendChild(sel);
      return { row, sel };
    };
    const head = mkSelect("Compare (head)", opts.defaultHead);
    const base = mkSelect("Into (base)", opts.defaultBase);

    const titleRow = el("label", "gh-form-row");
    titleRow.append(span("Title", "gh-form-label"));
    const title = document.createElement("input");
    title.className = "modal-input";
    title.placeholder = "Pull request title";
    titleRow.appendChild(title);

    const bodyRow = el("label", "gh-form-row");
    bodyRow.append(span("Description", "gh-form-label"));
    const body = document.createElement("textarea");
    body.className = "gh-form-textarea";
    body.placeholder = "Describe the change… (optional)";
    body.rows = 5;
    bodyRow.appendChild(body);

    const draftRow = el("label", "gh-form-check");
    const draft = document.createElement("input");
    draft.type = "checkbox";
    draftRow.append(draft, span("Create as draft"));

    const actions = el("div", "modal-actions");
    const cancel = el("button", "mini-btn");
    cancel.textContent = "Cancel";
    const ok = el("button", "btn btn-primary modal-ok");
    ok.append(span("Create pull request"));
    actions.append(cancel, ok);
    card.append(h, head.row, base.row, titleRow, bodyRow, draftRow, actions);

    const finish = (v: CreatePrResult | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
        return;
      }
      trapTab(e, card);
    };
    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", () =>
      finish({
        title: title.value,
        head: head.sel.value,
        base: base.sel.value,
        body: body.value,
        draft: draft.checked,
      }),
    );
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => title.focus(), 0);
  });
}

function reviewerPickerModal(people: RepoCollaborator[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = el("div", "modal-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Request reviewers");
    const card = el("div", "modal-card gh-pr-form");
    const h = el("div", "modal-title");
    h.textContent = "Request reviewers";
    const list = el("div", "gh-reviewer-list");
    const boxes: { login: string; cb: HTMLInputElement }[] = [];
    for (const p of people) {
      const row = el("label", "gh-form-check");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      row.append(cb, span("@" + p.login));
      list.appendChild(row);
      boxes.push({ login: p.login, cb });
    }
    const actions = el("div", "modal-actions");
    const cancel = el("button", "mini-btn");
    cancel.textContent = "Cancel";
    const ok = el("button", "btn btn-primary modal-ok");
    ok.append(span("Request"));
    actions.append(cancel, ok);
    card.append(h, list, actions);
    const finish = (v: string[] | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
        return;
      }
      trapTab(e, card);
    };
    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", () => finish(boxes.filter((b) => b.cb.checked).map((b) => b.login)));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => (boxes[0]?.cb ?? ok).focus(), 0);
  });
}
