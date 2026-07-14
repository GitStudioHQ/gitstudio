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
import { toast, confirmDialog, promptInline, editForm } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { openAssistantTab, aiEnabled } from "../aiAssist";
import { DiffPanel } from "../diffPanel";
import { ghGate, ghHeader, ghTwoPane, peoplePickerModal, searchField, trapTab, type SectionRender, type SectionNav, type SectionTarget } from "./common";
import type {
  BranchRef,
  FileDiff,
  PrComment,
  PrDetail,
  PrFile,
  PrReviewThread,
  PullRequest,
  RepoCollaborator,
  RepoLabel,
} from "../../shared/ipc";

// Persist the active sub-tab across re-renders so a comment / state change keeps
// the user on the tab they were reading.
let activeSubTab = "conversation";
// The file selected within the Files tab, persisted so re-rendering the detail
// (after a mutation) keeps the same diff open.
let activeFilePath: string | undefined;

// ── Monaco diff lifecycle (self-contained; we can't touch renderer.ts) ─────────
//
// The Files tab mounts a shared Monaco DiffPanel. renderer.ts disposes Monaco
// surfaces it knows about via `activeMonacoView`, but it never sees one we create
// inside a section view — so we own this panel's whole lifecycle. We dispose it:
//   • when a different file / PR / sub-tab is selected (the content re-renders),
//   • when the PR view itself re-renders (start of mount),
//   • when our surface is detached from the DOM (navigating to another section) —
//     caught by a MutationObserver so the editor never leaks.
let prDiffPanel: DiffPanel | undefined;
let prDiffDetachObs: MutationObserver | undefined;

function disposePrDiff(): void {
  prDiffDetachObs?.disconnect();
  prDiffDetachObs = undefined;
  prDiffPanel?.dispose();
  prDiffPanel = undefined;
}

/** Tear the diff down automatically once its surface leaves the document (e.g. a
 *  route change replaces the view host) so the Monaco editor never lingers. */
function watchDiffDetach(surface: HTMLElement): void {
  prDiffDetachObs?.disconnect();
  const obs = new MutationObserver(() => {
    if (!surface.isConnected) disposePrDiff();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  prDiffDetachObs = obs;
}

export const renderPrs: SectionRender = (wrap, nav, target) => {
  void mount(wrap, nav, target);
};

const refresher = (wrap: HTMLElement, nav: SectionNav) => () => renderPrs(wrap, nav);

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  // A re-render replaces the whole view subtree — drop any live Monaco diff from
  // the previous render so it can't leak or write into detached DOM.
  disposePrDiff();
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
    row.dataset.num = String(pr.number);
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

  // Deep-link: open a specific PR on entry (e.g. from the project board) rather
  // than the auto-selected first — keep it in-app, never open GitHub.
  if (target?.number != null) autoSelected = true;
  renderList(prs);
  if (target?.number != null) {
    const n = target.number;
    const inList = prs.find((pr) => pr.number === n);
    const row = listEl.querySelector(`[data-num="${n}"]`) as HTMLElement | null;
    if (inList && row) {
      select(inList, row);
      row.scrollIntoView({ block: "nearest" });
    } else {
      // Not in the current list (e.g. a closed PR) — fetch it and open its detail.
      void (async () => {
        try {
          const d = await host.invoke("pr:detail", n);
          if (d) void showDetail(detailEl, d.pr, refresh);
        } catch {
          /* leave the idle empty state if the PR can't be loaded */
        }
      })();
    }
  }
}

// ── Detail panel ──────────────────────────────────────────────────────────────

async function showDetail(
  detail: HTMLElement,
  pr: PullRequest,
  refreshList: () => void,
): Promise<void> {
  // Switching PRs (or reloading this one) must drop the prior file's Monaco diff.
  disposePrDiff();
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
  // Title + an inline edit (pencil) affordance, mirroring the Issues view.
  const titleRow = el("div", "gh-detail-titlerow");
  titleRow.style.display = "flex";
  titleRow.style.alignItems = "center";
  titleRow.style.gap = "8px";
  const h = el("div", "gh-detail-title");
  h.textContent = full.title;
  h.style.flex = "1 1 auto";
  h.style.minWidth = "0";
  const editTitleBtn = el("button", "mini-btn gh-icon-btn gh-title-edit");
  editTitleBtn.append(glyph("pencil"));
  editTitleBtn.title = "Edit title & description";
  editTitleBtn.setAttribute("aria-label", "Edit pull request title and description");
  editTitleBtn.addEventListener("click", () => void doEdit(detail, full, refreshList));
  titleRow.append(h, editTitleBtn);

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
  head.append(titleRow, meta, actions);
  detail.appendChild(head);

  // Live label chips (data already on the PR) with an inline "edit labels" pill.
  const labelRow = el("div", "gh-detail-labels");
  for (const l of full.labels) labelRow.appendChild(labelChip(l.name, l.color));
  const editLabels = el("button", "mini-btn gh-icon-btn gh-inline-edit");
  editLabels.append(glyph("tag"));
  editLabels.title = "Edit labels";
  editLabels.setAttribute("aria-label", "Edit labels");
  editLabels.addEventListener("click", () => void doLabels(editLabels, detail, full, refreshList));
  labelRow.appendChild(editLabels);
  detail.appendChild(labelRow);

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
    // Leaving the Files tab tears the Monaco diff down (only Files mounts one).
    if (activeSubTab === "files" && id !== "files") disposePrDiff();
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
  // A closed/merged PR can't be merged — disable rather than letting the user
  // open the menu and hit a confusing error toast.
  const mergeable = full.state === "open" && !full.draft;
  (mergeBtn as HTMLButtonElement).disabled = !mergeable;
  mergeBtn.title = mergeable
    ? "Merge this pull request"
    : full.draft
      ? "Mark the draft ready before merging"
      : "This pull request is closed";
  mergeBtn.addEventListener("click", () => {
    if (!mergeable) return;
    openMenu(mergeBtn, [
      { label: "Create a merge commit", icon: "git-merge", onClick: () => void doMerge(full.number, "merge", refreshList) },
      { label: "Squash and merge", icon: "git-commit", onClick: () => void doMerge(full.number, "squash", refreshList) },
      { label: "Rebase and merge", icon: "git-compare", onClick: () => void doMerge(full.number, "rebase", refreshList) },
    ]);
  });

  // "Update branch" — merge the latest base into the PR head. We don't know the
  // behind-state here, so it's always shown for an open, non-draft PR; a no-op
  // (already up to date) just toasts the API's verbatim message. It sits in the
  // merge area as a secondary action, left of the primary Merge button.
  let updateBtn: HTMLElement | undefined;
  if (full.state === "open") {
    updateBtn = el("button", "mini-btn");
    updateBtn.append(glyph("git-merge"), span("Update branch"));
    updateBtn.title = "Merge the latest changes from the base branch into this PR";
    const ub = updateBtn;
    updateBtn.addEventListener("click", () => void doUpdateBranch(full.number, reload, refreshList, ub));
  }

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
        label: "Edit title & description",
        icon: "pencil",
        onClick: () => void doEdit(detail, full, refreshList),
      },
      { separator: true },
      {
        label: "Labels",
        icon: "tag",
        onClick: () => void doLabels(moreBtn, detail, full, refreshList),
      },
      {
        label: "Assignees",
        icon: "person",
        onClick: () => void doAssignees(moreBtn, detail, full, refreshList),
      },
      {
        label: "Request reviewers",
        icon: "organization",
        onClick: () => void doRequestReviewers(full.number),
      },
      {
        label: "Re-request review",
        icon: "sync",
        onClick: () => void doRequestReviewers(full.number, true),
      },
      { separator: true },
      {
        label: "Update branch",
        icon: "git-merge",
        onClick: () => void doUpdateBranch(full.number, reload, refreshList),
      },
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
      { label: "Open on GitHub", icon: "link-external", onClick: () => window.open(full.htmlUrl, "_blank") },
    ]),
  );

  // ✨ AI: explain / review the PR's diff, or draft a comment — each opens a
  // conversational chat tab in the footer. Hidden until a model is connected.
  const aiBtn = el("button", "mini-btn ai-mini");
  aiBtn.hidden = true;
  aiBtn.append(glyph("sparkle"), span("AI"), glyph("chevron-down"));
  // Use the commit SHAs, not the branch names: a PR's head branch usually isn't a
  // local ref (you'd have origin/<branch>), but the SHA resolves whenever the
  // object has been fetched — so the diff is exact when it can be gathered at all.
  const diffCmd = `git diff ${full.base.sha}..${full.head.sha}`;
  aiBtn.addEventListener("click", () =>
    openMenu(aiBtn, [
      {
        label: "Explain this PR",
        icon: "comment",
        onClick: () =>
          openAssistantTab({
            title: `Explain PR #${full.number}`,
            goal: `Explain pull request #${full.number} ("${full.title}"). Run \`${diffCmd}\` to see the changes, then give a clear, structured summary of what it changes and why it matters.`,
          }),
      },
      {
        label: "Review this PR",
        icon: "search",
        onClick: () =>
          openAssistantTab({
            title: `Review PR #${full.number}`,
            goal: `Review pull request #${full.number} ("${full.title}") for correctness bugs, security issues and risky changes. Run \`${diffCmd}\` to see the diff. Be specific and cite files.`,
          }),
      },
      { separator: true },
      {
        label: "Draft a comment",
        icon: "comment",
        onClick: () =>
          openAssistantTab({
            title: `Draft · PR #${full.number}`,
            goal: `Draft a concise, constructive review comment for pull request #${full.number}. Output just the comment text.\n\nTitle: ${full.title}\n\n${full.body ?? ""}`,
          }),
      },
    ]),
  );
  void aiEnabled().then((ok) => (aiBtn.hidden = !ok));

  actions.append(
    checkoutBtn,
    approveBtn,
    reviewBtn,
    ...(readyBtn ? [readyBtn] : []),
    aiBtn,
    ...(updateBtn ? [updateBtn] : []),
    mergeBtn,
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
    // ── Files = a real master/detail review surface ──────────────────────────
    content.replaceChildren();
    const files = d?.files ?? [];
    if (files.length === 0) {
      content.appendChild(emptyState("No files changed", "This PR doesn't change any files."));
      return;
    }
    renderFilesTab(content, full, files);
  }
}

/**
 * The Files tab: a left file list (master) and a right pane (detail) showing the
 * selected file's real Monaco diff with its inline review threads beneath it.
 * Clicking a file fetches `pr:fileDiff`; the threads come from `pr:reviewThreads`
 * filtered to that file. A composer adds a new inline comment at a chosen line.
 */
function renderFilesTab(content: HTMLElement, full: PullRequest, files: PrFile[]): void {
  const layout = el("div", "pr-files");
  const list = el("div", "pr-files-list gh-files");
  const detail = el("div", "pr-files-detail");
  layout.append(list, detail);
  content.appendChild(layout);
  // Structural layout is applied inline so the master/detail + Monaco surface size
  // correctly even before the integrator adds the polished .pr-files* CSS. Visual
  // theming (borders, colors, radii) is left to those classes.
  layout.style.display = "flex";
  layout.style.gap = "12px";
  layout.style.minHeight = "420px";
  layout.style.height = "60vh";
  list.style.flex = "0 0 240px";
  list.style.overflowY = "auto";
  list.style.minWidth = "0";
  detail.style.flex = "1 1 auto";
  detail.style.minWidth = "0";
  detail.style.display = "flex";
  detail.style.flexDirection = "column";
  detail.style.overflow = "hidden";

  // Threads are (re)fetched on each file open so a just-added comment / resolve
  // shows immediately. A failure is non-fatal — the diff still renders; we just
  // show no existing comments.
  const loadThreads = async (): Promise<PrReviewThread[]> => {
    try {
      return await host.invoke("pr:reviewThreads", full.number);
    } catch {
      return [];
    }
  };

  const rows = new Map<string, HTMLElement>();
  const openFile = (f: PrFile): void => {
    activeFilePath = f.filename;
    for (const [p, r] of rows) r.classList.toggle("active", p === f.filename);
    void showFileDiff(detail, full, f, loadThreads);
  };

  for (const f of files) {
    const letter = f.status.charAt(0).toUpperCase();
    const row = el("button", `file-row status-${letter}`);
    (row as HTMLButtonElement).type = "button";
    const st = el("span", "file-status");
    st.textContent = letter;
    const path = el("span", "file-path");
    // Left-truncate long paths so the filename (the part you read) stays visible.
    path.textContent = f.filename;
    path.title = f.filename;
    path.dir = "rtl";
    const adds = el("span", "gh-adds");
    adds.textContent = `+${f.additions} −${f.deletions}`;
    row.append(st, path, adds);
    row.addEventListener("click", () => openFile(f));
    rows.set(f.filename, row);
    list.appendChild(row);
  }

  // Re-open the previously-viewed file if it's still in the set, else the first.
  const initial = files.find((f) => f.filename === activeFilePath) ?? files[0];
  if (initial) openFile(initial);
}

/**
 * Render one file's diff (left = base, right = head) into a shared DiffPanel,
 * with a threads panel beneath it. The DiffPanel is module-owned so it survives
 * re-renders of the threads panel but is disposed by the lifecycle hooks above.
 * `loadThreads` is re-invoked (not the diff) whenever a review action lands, so
 * the comments refresh in place without the Monaco editor flickering.
 */
async function showFileDiff(
  detail: HTMLElement,
  full: PullRequest,
  f: PrFile,
  loadThreads: () => Promise<PrReviewThread[]>,
): Promise<void> {
  // Build the stable shell ONCE per file open: a diff surface + a threads slot.
  const surface = el("div", "diff-surface pr-diff-surface");
  const threadsSlot = el("div", "pr-threads");
  // Structural sizing inline (theming via the classes): the diff fills the upper
  // half, the threads panel scrolls below it.
  surface.style.flex = "1 1 60%";
  surface.style.minHeight = "200px";
  threadsSlot.style.flex = "0 1 auto";
  threadsSlot.style.overflowY = "auto";
  threadsSlot.style.maxHeight = "40%";
  threadsSlot.style.marginTop = "10px";
  detail.replaceChildren(surface, threadsSlot);
  threadsSlot.replaceChildren(loadingState("Loading diff…"));

  // (Re)create the Monaco panel against the fresh surface and arm the detach
  // watcher so it's torn down if the view goes away.
  disposePrDiff();
  const panel = new DiffPanel(surface);
  prDiffPanel = panel;
  watchDiffDetach(surface);

  // Refresh ONLY the threads panel (re-fetch + re-render) after a review action —
  // the diff itself is unchanged, so leave the Monaco editor untouched.
  const refreshThreads = async (): Promise<void> => {
    if (prDiffPanel !== panel) return; // the file/view changed under us
    threadsSlot.replaceChildren(loadingState("Refreshing comments…"));
    const next = await loadThreads();
    if (prDiffPanel !== panel) return;
    renderThreadsPanel(threadsSlot, full, f, next, () => void refreshThreads());
  };

  const threadsReady = loadThreads();

  let diff: FileDiff | undefined;
  try {
    diff = await host.invoke("pr:fileDiff", { number: full.number, path: f.filename });
  } catch (e) {
    // Surface the error inside the diff area; the file list stays usable.
    if (prDiffPanel !== panel) return; // superseded by another open
    panel.showEmpty(cleanErr(e) || "Couldn't load this file's diff.");
    threadsSlot.replaceChildren();
    return;
  }
  if (prDiffPanel !== panel) return; // a newer file was opened mid-fetch
  if (!diff) {
    panel.showEmpty("No diff available for this file.");
  } else {
    panel.showDiff(diff);
  }

  const threads = await threadsReady;
  if (prDiffPanel !== panel) return;
  renderThreadsPanel(threadsSlot, full, f, threads, () => void refreshThreads());
}

/** The inline-review panel beneath a file's diff: existing threads (grouped by
 *  line) with resolve/reply, plus an "Add a comment" affordance. */
function renderThreadsPanel(
  slot: HTMLElement,
  full: PullRequest,
  f: PrFile,
  threads: PrReviewThread[],
  reloadFile: () => void,
): void {
  slot.replaceChildren();
  const mine = threads
    .filter((t) => t.path === f.filename)
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  const head = el("div", "pr-threads-head");
  // Flex row with the add-comment action pushed to the right (structural inline).
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.gap = "8px";
  head.style.margin = "4px 0 8px";
  const title = span(`Review comments (${mine.length})`, "pr-threads-title");
  title.style.fontWeight = "600";
  head.append(glyph("comment-discussion"), title);
  const addBtn = el("button", "mini-btn");
  addBtn.style.marginLeft = "auto";
  addBtn.append(glyph("comment"), span("Add a comment"));
  addBtn.title = "Comment on a line of this file";
  addBtn.addEventListener("click", () => void addInlineComment(full.number, f.filename, addBtn, reloadFile));
  head.appendChild(addBtn);
  slot.appendChild(head);

  if (mine.length === 0) {
    const none = el("div", "pr-threads-empty");
    none.textContent = "No inline comments on this file yet.";
    slot.appendChild(none);
    return;
  }
  for (const t of mine) slot.appendChild(threadCard(full.number, t, reloadFile));
}

/** One review thread: a line anchor + its comments + resolve / reply controls.
 *  Built on the existing `.gh-comment` shell (border / radius) for instant polish,
 *  with `.pr-thread*` hooks the integrator can theme further. */
function threadCard(prNumber: number, t: PrReviewThread, reloadFile: () => void): HTMLElement {
  const card = el("div", `gh-comment pr-thread${t.isResolved ? " is-resolved" : ""}`);
  if (t.isResolved) card.style.opacity = "0.72";

  const hd = el("div", "gh-comment-head pr-thread-head");
  const anchor = el("span", "pr-thread-anchor");
  anchor.append(glyph("git-commit"), span(t.line != null ? `Line ${t.line}` : "File", "pr-thread-line"));
  hd.appendChild(anchor);
  if (t.isOutdated) hd.appendChild(pill("outdated"));
  const statusPill = pill(t.isResolved ? "resolved" : "open");
  statusPill.classList.add(t.isResolved ? "gh-review-approved" : "gh-thread-open");
  hd.appendChild(statusPill);

  const resolveBtn = el("button", "mini-btn gh-inline-edit");
  resolveBtn.style.marginLeft = "auto";
  resolveBtn.append(glyph(t.isResolved ? "issue-reopened" : "check"), span(t.isResolved ? "Unresolve" : "Resolve"));
  resolveBtn.addEventListener("click", () =>
    void toggleResolve(t.id, !t.isResolved, resolveBtn, reloadFile),
  );
  hd.appendChild(resolveBtn);
  card.appendChild(hd);

  for (const c of t.comments) {
    const cm = el("div", "pr-thread-comment");
    cm.style.padding = "8px 12px";
    cm.style.borderTop = "1px solid var(--app-border)";
    const ch = el("div", "pr-thread-comment-head");
    ch.style.display = "flex";
    ch.style.alignItems = "center";
    ch.style.gap = "7px";
    ch.style.marginBottom = "4px";
    ch.append(avatar(c.author.login, c.author.avatarUrl, 20), span(c.author.login, "pr-thread-author"));
    if (c.createdAt) {
      const when = span(relTimeISO(c.createdAt), "gh-comment-when");
      when.title = absTimeISO(c.createdAt);
      ch.appendChild(when);
    }
    cm.appendChild(ch);
    const bd = el("div", "gh-body-md");
    bd.style.margin = "0";
    bd.style.padding = "0";
    if (c.body.trim()) {
      try {
        bd.innerHTML = renderMarkdown(c.body);
      } catch {
        bd.classList.add("code-md-plain");
        bd.textContent = c.body;
      }
    } else {
      bd.classList.add("gh-empty-body");
      bd.textContent = "(no body)";
    }
    cm.appendChild(bd);
    card.appendChild(cm);
  }

  // Reply box (inline) — Enter submits, Shift+Enter for a newline.
  const replyRow = el("div", "pr-thread-reply");
  replyRow.style.display = "flex";
  replyRow.style.gap = "8px";
  replyRow.style.alignItems = "flex-end";
  replyRow.style.padding = "8px 12px";
  replyRow.style.borderTop = "1px solid var(--app-border)";
  const ta = document.createElement("textarea");
  ta.className = "gh-composer-input pr-reply-input";
  ta.style.flex = "1 1 auto";
  ta.placeholder = "Reply…";
  ta.rows = 2;
  const replyBtn = el("button", "btn btn-primary");
  replyBtn.append(span("Reply"));
  replyBtn.addEventListener("click", () => void replyToThread(prNumber, t.id, ta, replyBtn, reloadFile));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void replyToThread(prNumber, t.id, ta, replyBtn, reloadFile);
    }
  });
  replyRow.append(ta, replyBtn);
  card.appendChild(replyRow);
  return card;
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

/** Request reviewers (or re-request the same set, when `reRequest` is set — the
 *  GitHub re-request just re-POSTs the chosen logins to the same endpoint). */
async function doRequestReviewers(n: number, reRequest = false): Promise<void> {
  let people: RepoCollaborator[] = [];
  try {
    people = await host.invoke("pr:reviewers", undefined);
  } catch {
    /* fall through to the free-text path */
  }
  const verb = reRequest ? "Re-request review" : "Request reviewers";
  let chosen: string[] | null;
  if (people.length) {
    chosen = await peoplePickerModal({ title: verb, okLabel: reRequest ? "Re-request" : "Request", people, selected: [] });
  } else {
    const raw = await promptInline(
      verb,
      "comma-separated logins, e.g. alice, bob",
      "",
      reRequest ? "Re-request" : "Request",
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
    toast(
      reRequest
        ? `Re-requested review from ${chosen.length} reviewer${chosen.length === 1 ? "" : "s"} on PR #${n}.`
        : `Requested ${chosen.length} reviewer${chosen.length === 1 ? "" : "s"} on PR #${n}.`,
      "success",
    );
  } catch (e) {
    toast(cleanErr(e) || "Couldn't request reviewers.", "error");
  }
}

// ── PR review-depth mutations (edit · labels · assignees · update · inline) ─────

/** Edit the PR's title + body in one unified form, then PATCH via pr:edit. */
async function doEdit(detail: HTMLElement, pr: PullRequest, refreshList: () => void): Promise<void> {
  const res = await editForm({
    title: `Edit pull request #${pr.number}`,
    okLabel: "Save",
    titleValue: pr.title,
    titlePlaceholder: "Pull request title",
    bodyValue: pr.body ?? "",
    bodyPlaceholder: "Describe the change…",
  });
  if (!res) return;
  if (res.title === pr.title && res.body === (pr.body ?? "")) return; // nothing changed
  try {
    const r = await host.invoke("pr:edit", { number: pr.number, title: res.title, body: res.body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't edit the pull request.", "error");
      return;
    }
    toast(`Updated pull request #${pr.number}.`, "success");
    activeSubTab = "conversation"; // the description card reflects the new body
    void showDetail(detail, pr, refreshList);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't edit the pull request.", "error");
  }
}

/** A toggle-menu of the repo's labels (current ones checked) → pr:setLabels. */
async function doLabels(
  anchor: HTMLElement,
  detail: HTMLElement,
  pr: PullRequest,
  refreshList: () => void,
): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await host.invoke("pr:labels", undefined);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load labels.", "error");
    return;
  }
  if (repoLabels.length === 0) {
    toast("This repo has no labels defined.", "info");
    return;
  }
  const current = new Set(pr.labels.map((l) => l.name));
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
        void applyLabels(detail, pr, [...next], refreshList);
      },
    })),
    { searchable: true },
  );
}

async function applyLabels(
  detail: HTMLElement,
  pr: PullRequest,
  labelsList: string[],
  refreshList: () => void,
): Promise<void> {
  try {
    const r = await host.invoke("pr:setLabels", { number: pr.number, labels: labelsList });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update labels.", "error");
      return;
    }
    toast("Labels updated.", "success");
    void showDetail(detail, pr, refreshList);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update labels.", "error");
  }
}

/** Edit the PR's assignees via the avatar-rich people picker → pr:setAssignees. */
async function doAssignees(
  anchor: HTMLElement,
  detail: HTMLElement,
  pr: PullRequest,
  refreshList: () => void,
): Promise<void> {
  void anchor;
  let people: RepoCollaborator[] = [];
  try {
    people = await host.invoke("pr:reviewers", undefined);
  } catch {
    /* fall through to the free-text path */
  }
  let assignees: string[] | null;
  if (people.length) {
    assignees = await peoplePickerModal({ title: "Assignees", okLabel: "Save", people, selected: [] });
  } else {
    const csv = await promptInline("Assignees", "comma-separated logins, e.g. octocat, hubot", "", "Save");
    assignees =
      csv === null ? null : csv.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  }
  if (assignees === null) return;
  try {
    const r = await host.invoke("pr:setAssignees", { number: pr.number, assignees });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update assignees.", "error");
      return;
    }
    toast("Assignees updated.", "success");
    void showDetail(detail, pr, refreshList);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update assignees.", "error");
  }
}

/** Merge the latest base into the PR head (pr:updateBranch). */
async function doUpdateBranch(
  n: number,
  reload: () => void,
  refreshList: () => void,
  btn?: HTMLElement,
): Promise<void> {
  if (btn) (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:updateBranch", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the branch.", "error");
      return;
    }
    toast(`Updated PR #${n} with the base branch.`, "success");
    reload(); // the head SHA moved — refetch the detail (files / checks change)
    refreshList();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the branch.", "error");
  } finally {
    if (btn) (btn as HTMLButtonElement).disabled = false;
  }
}

/** Add a new inline review comment: prompt for a line + body → pr:addReviewComment. */
async function addInlineComment(
  n: number,
  path: string,
  btn: HTMLElement,
  reloadFile: () => void,
): Promise<void> {
  const lineRaw = await promptInline(
    `Comment on ${path}`,
    "Line number (on the head side)",
    "",
    "Next",
  );
  if (lineRaw === null) return;
  const line = Number(lineRaw);
  if (!Number.isInteger(line) || line <= 0) {
    toast("Enter a valid line number.", "error");
    return;
  }
  const body = await promptInline(`Comment on ${path}:${line}`, "Leave a review comment…", "", "Comment");
  if (!body) return;
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:addReviewComment", { number: n, path, line, side: "RIGHT", body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't add the comment.", "error");
      return;
    }
    toast("Review comment added.", "success");
    reloadFile(); // re-fetch threads so the new comment shows
  } catch (e) {
    toast(cleanErr(e) || "Couldn't add the comment.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

/** Post a reply into an existing thread → pr:replyThread. */
async function replyToThread(
  n: number,
  threadId: string,
  ta: HTMLTextAreaElement,
  btn: HTMLElement,
  reloadFile: () => void,
): Promise<void> {
  const body = ta.value.trim();
  if (!body) {
    toast("Write a reply first.", "info");
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  ta.disabled = true;
  try {
    const r = await host.invoke("pr:replyThread", { number: n, threadId, body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't post the reply.", "error");
      return;
    }
    toast("Reply posted.", "success");
    reloadFile();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't post the reply.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
    ta.disabled = false;
  }
}

/** Resolve / unresolve a review thread → pr:resolveThread. */
async function toggleResolve(
  threadId: string,
  resolved: boolean,
  btn: HTMLElement,
  reloadFile: () => void,
): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:resolveThread", { threadId, resolved });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the thread.", "error");
      return;
    }
    toast(resolved ? "Thread resolved." : "Thread reopened.", "success");
    reloadFile();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the thread.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

// ── Create-PR flow ────────────────────────────────────────────────────────────

export async function openCreatePr(
  refresh: () => void,
  prefill?: { head?: string; base?: string },
): Promise<void> {
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
  const base =
    (prefill?.base && branches.find((b) => b.name === prefill.base)?.name) ??
    branches.find((b) => b.isDefault)?.name ??
    branches[0].name;
  const head =
    (prefill?.head && branches.find((b) => b.name === prefill.head)?.name) ??
    branches.find((b) => b.name !== base)?.name ??
    branches[0].name;

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

