// The Pull Requests section — a full, GitHub-grade PR workspace on the
// section-page system (docs/desktop-redesign.md): a full-width list page whose
// rows navigate to a full-page detail (routed via `target.number`), with the
// PR's properties in an inline-editable right rail and Conversation / Commits /
// Pipelines / Files sub-tabs in the content column. The Files tab widens to the
// whole window (the rail hides) — diffs get the space they deserve.
//
// Everything routes through `host.invoke` against the typed IPC contract. Reads
// that fail render an errorState with Retry; every mutation disables its
// trigger, confirms destructive ops, toasts success/error, busts the SWR cache
// and re-renders the affected surface.

import { host } from "../bridge";
import { peek as cachePeek, gget, bust, prime } from "../cache";
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
  avatar,
  labelChip,
  statBit,
  statePill,
  stateLead,
} from "../ui";
import { toast, confirmDialog, promptInline, editForm, openModal } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { openAssistantTab, aiEnabled } from "../aiAssist";
import { DiffPanel } from "../diffPanel";
import {
  associationBadge,
  facetBar,
  harvestValues,
  swatch,
  type FacetState,
  associationLabel,
  reactionRow,
  avatarStack,
  capNotice,
  detailPage,
  ghGate,
  ghHeader,
  LIST_CAPS,
  peoplePickerModal,
  personChip,
  propAddBtn,
  propNone,
  propSection,
  searchField,
  secRow,
  sectionList,
  type GhGate,
  type SectionRender,
  type SectionNav,
  type SectionTarget,
} from "./common";
import { wireProseNav } from "../proseNav";
import { openPeek } from "../peek";
import { memberCard } from "./orgs";
import type {
  BranchRef,
  FileDiff,
  PrComment,
  PrDetail,
  PrFile,
  PrReviewEvent,
  PrReviewThread,
  PullRequest,
  ReactionSummary,
  RepoCollaborator,
  RepoLabel,
} from "../../shared/ipc";

// Persist the active sub-tab across re-renders so a comment / state change keeps
// the user on the tab they were reading.
let activeSubTab = "conversation";
/** The section's router, captured at mount so detail components (branch chips,
 *  author profile, check rows) can navigate — mirrors the other module state. */
let sectionNav: SectionNav | undefined;
// The file selected within the Files tab, persisted so re-rendering the detail
// (after a mutation) keeps the same diff open.
let activeFilePath: string | undefined;
/** Which PR the detail page last showed — tab state resets when it changes. */
let lastDetailNumber: number | undefined;
/** The list page's live search query — survives list ⇄ detail round trips. */
let query = "";
/** Client-side PR facets, kept across list ⇄ detail round trips. */
const prFacets: FacetState = {};
/** Unsent comment drafts, per PR — navigating away must never eat one. */
const commentDrafts = new Map<number, string>();

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

/** The PR's display state: merged beats closed beats draft beats open. */
function prKind(pr: PullRequest): "open-pr" | "draft" | "merged" | "closed" {
  if (pr.mergedAt) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.draft) return "draft";
  return "open-pr";
}
function prKindLabel(kind: ReturnType<typeof prKind>): string {
  return kind === "open-pr" ? "Open" : kind === "draft" ? "Draft" : kind === "merged" ? "Merged" : "Closed";
}

export const renderPrs: SectionRender = (wrap, nav, target) => {
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  sectionNav = nav;
  // A re-render replaces the whole view subtree — drop any live Monaco diff from
  // the previous render so it can't leak or write into detached DOM.
  disposePrDiff();
  const refresh = (): void => {
    bust("pr");
    renderPrs(wrap, nav, target);
  };
  const gate = await ghGate(wrap, nav, true, refresh);
  if (!gate) return;

  if (target?.number != null) {
    showDetailPage(wrap, nav, target.number);
    return;
  }
  await listPage(wrap, nav, gate);
}

// ── The list page ────────────────────────────────────────────────────────────

async function listPage(wrap: HTMLElement, nav: SectionNav, gate: GhGate): Promise<void> {
  const refresh = (): void => {
    bust("pr");
    renderPrs(wrap, nav);
  };

  const { view, listEl } = sectionList();
  const header = ghHeader("Pull Requests", gate.login, refresh);
  const tools = el("div", "gh-head-tools");
  const facetSlot = el("div", "gh-facet-slot");
  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("git-pull-request"), span("New PR"));
  newBtn.title = "Open a new pull request";
  newBtn.addEventListener("click", () => void openCreatePr(refresh));
  tools.append(facetSlot, newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  let prs: PullRequest[] | undefined = cachePeek("pr:list", undefined);
  if (!prs) listEl.replaceChildren(skeletonList(5));

  const buildRow = (pr: PullRequest): HTMLElement => {
    const kind = prKind(pr);
    const meta: HTMLElement[] = [];
    if (typeof pr.additions === "number" || typeof pr.deletions === "number") {
      const stat = el("span", "sec-diffstat");
      if (typeof pr.additions === "number") stat.appendChild(span(`+${pr.additions}`, "add"));
      if (typeof pr.deletions === "number") stat.appendChild(span(`−${pr.deletions}`, "del"));
      meta.push(stat);
    }
    if (typeof pr.comments === "number" && pr.comments > 0) meta.push(statBit("comment", pr.comments));
    if (pr.user?.login) meta.push(avatarStack([{ login: pr.user.login, avatarUrl: pr.user.avatarUrl }], 1));
    const row = secRow({
      lead: stateLead(kind),
      num: `#${pr.number}`,
      title: pr.title,
      titleSuffix: [
        ...(pr.draft ? [statePill("Draft", "draft")] : []),
        // A PR from a fork runs someone else's branch through your CI — a fact
        // worth seeing in the LIST, not only after you open it.
        ...(pr.headRepoFullName ? [forkChip(pr.headRepoFullName)] : []),
      ],
      chips: pr.labels.map((l) => labelChip(l.name, l.color)),
      meta,
      time: relTimeISO(pr.updatedAt),
      timeTitle: pr.updatedAt ? `Updated ${absTimeISO(pr.updatedAt)}` : undefined,
      ariaLabel: `Pull request #${pr.number}: ${pr.title}`,
      onOpen: () => nav("prs", { number: pr.number }),
    });
    row.dataset.num = String(pr.number);
    return row;
  };

  const matches = (pr: PullRequest, q: string): boolean => {
    const hay = `${pr.title} #${pr.number} ${pr.head.ref} ${pr.base.ref} ${pr.user?.login ?? ""} ${pr.labels
      .map((l) => l.name)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  };

  // Client-side facets: the PR list is one fetch of open PRs, so narrowing it
  // is honest filtering of what's already here — no re-fetch, no cache key.
  const facets = facetBar<PullRequest>({
    specs: [
      {
        key: "author",
        label: "Author",
        icon: "account",
        anyLabel: "Anyone",
        harvest: (items) => {
          const seen = new Map<string, string | null>();
          for (const pr of items) if (pr.user && !seen.has(pr.user.login)) seen.set(pr.user.login, pr.user.avatarUrl);
          return [...seen].map(([login, avatarUrl]) => ({
            value: login,
            label: `@${login}`,
            iconEl: () => avatar(login, avatarUrl, 18),
          }));
        },
        predicate: (pr, v) => pr.user?.login === v,
      },
      {
        key: "label",
        label: "Label",
        icon: "tag",
        anyLabel: "All labels",
        harvest: (items) => {
          const seen = new Map<string, string>();
          for (const pr of items) for (const l of pr.labels) if (!seen.has(l.name)) seen.set(l.name, l.color);
          return [...seen].map(([name, color]) => ({ value: name, iconEl: () => swatch(color) }));
        },
        predicate: (pr, v) => pr.labels.some((l) => l.name === v),
      },
      {
        key: "base",
        label: "Base",
        icon: "git-branch",
        anyLabel: "Any base",
        harvest: harvestValues<PullRequest>((pr) => pr.base.ref),
        predicate: (pr, v) => pr.base.ref === v,
      },
      {
        key: "draft",
        label: "State",
        icon: "git-pull-request",
        anyLabel: "Any state",
        options: [
          { value: "ready", label: "Ready for review", icon: "git-pull-request" },
          { value: "draft", label: "Draft", icon: "git-pull-request-draft" },
          { value: "fork", label: "From a fork", icon: "repo-forked" },
        ],
        predicate: (pr, v) =>
          v === "draft" ? pr.draft : v === "fork" ? !!pr.headRepoFullName : !pr.draft,
      },
    ],
    state: prFacets,
    items: prs ?? [],
    onChange: () => renderList(),
  });
  facetSlot.replaceChildren(facets.el);

  const renderList = (): void => {
    if (!prs) return;
    facets.sync(prs);
    header.setCount?.(prs.length);
    const q = query.toLowerCase();
    const items = prs.filter((pr) => facets.passes(pr) && (q ? matches(pr, q) : true));
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
    if (items.length === 0) {
      const empty = emptyState(
        "No matching pull requests",
        query ? `Nothing matches “${query}”.` : "No pull request matches these filters.",
        { icon: "search" },
      );
      if (facets.activeCount() > 0) {
        const clear = el("button", "btn btn-soft list-empty-action");
        clear.append(glyph("clear-all"), span("Clear filters"));
        clear.addEventListener("click", () => facets.clear());
        empty.appendChild(clear);
      }
      listEl.appendChild(empty);
      return;
    }
    for (const pr of items) listEl.appendChild(buildRow(pr));
    const cap = capNotice(prs.length, LIST_CAPS.prs);
    if (cap) listEl.appendChild(cap);
  };

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search pull requests…",
      initial: query,
      onInput: (q) => {
        query = q;
        renderList();
      },
    }),
  );

  if (prs) renderList();

  try {
    const fresh = await gget("pr:list", undefined, 15000);
    if (!view.isConnected) return;
    prs = fresh;
    renderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!prs) {
      listEl.replaceChildren(
        errorState("Couldn't load pull requests", cleanErr(e) || "GitHub request failed.", refresh),
      );
    }
  }
}

// ── The detail page ──────────────────────────────────────────────────────────

function showDetailPage(wrap: HTMLElement, nav: SectionNav, n: number): void {
  sectionNav = nav;
  disposePrDiff();
  // A DIFFERENT PR starts on Conversation with no file pre-selected — the
  // module-scoped tab used to leak: open PR B and land on PR A's Files tab.
  if (lastDetailNumber !== n) {
    lastDetailNumber = n;
    activeSubTab = "conversation";
    activeFilePath = undefined;
  }
  const back = (): void => nav("prs", { list: true });
  const reload = (): void => {
    bust("pr");
    showDetailPage(wrap, nav, n);
  };

  const { view, main, rail, topActions } = detailPage({
    backLabel: "Pull Requests",
    crumb: `#${n}`,
    onBack: back,
  });
  main.appendChild(skeletonList(4, false));
  wrap.replaceChildren(view);

  // While CI is PENDING, quietly re-fetch and repaint when something changed —
  // the checks pill and Pipelines tab keep themselves honest. Stands down while
  // the Files tab is open (a repaint would tear down the Monaco diff mid-read).
  let lastSig = "";
  const schedulePoll = (current: PrDetail): void => {
    if (current.checks !== "pending") return;
    window.setTimeout(() => {
      if (!view.isConnected) return;
      if (activeSubTab === "files") {
        schedulePoll(current);
        return;
      }
      host
        .invoke("pr:detail", n)
        .then((fresh) => {
          if (!view.isConnected || !fresh) return;
          prime("pr:detail", n, fresh);
          const sig = JSON.stringify(fresh);
          if (sig !== lastSig) {
            lastSig = sig;
            buildDetail({ view, main, rail, topActions, d: fresh, nav, reload });
          }
          schedulePoll(fresh);
        })
        .catch(() => schedulePoll(current)); // transient failure — keep watching
    }, 15000);
  };

  void (async () => {
    let d: PrDetail | undefined;
    try {
      d = await gget("pr:detail", n, 8000);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState("Couldn't load this pull request", cleanErr(e) || "GitHub request failed.", reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!d) {
      main.replaceChildren(emptyState("Pull request unavailable", "This pull request couldn't be loaded."));
      return;
    }
    lastSig = JSON.stringify(d);
    buildDetail({ view, main, rail, topActions, d, nav, reload });
    schedulePoll(d);
  })();
}

interface DetailCtx {
  view: HTMLElement;
  main: HTMLElement;
  rail: HTMLElement;
  topActions: HTMLElement;
  d: PrDetail;
  nav: SectionNav;
  reload: () => void;
}

function buildDetail(ctx: DetailCtx): void {
  const { view, main, rail, topActions, d, nav, reload } = ctx;
  const full = d.pr;
  const kind = prKind(full);
  main.replaceChildren();
  rail.replaceChildren();

  // ── top-bar action cluster ──
  const actions: HTMLElement[] = [];

  // ✨ AI: explain / review the PR's diff, or draft a comment. Hidden until a
  // model is connected. SHAs, not branch names — they resolve once fetched.
  const aiBtn = el("button", "mini-btn ai-mini");
  aiBtn.hidden = true;
  aiBtn.append(glyph("sparkle"), span("AI"), glyph("chevron-down"));
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
  actions.push(aiBtn);

  const checkoutBtn = el("button", "mini-btn");
  checkoutBtn.append(glyph("git-branch"), span("Checkout"));
  checkoutBtn.title = `Fetch and check out this PR as pr/${full.number}`;
  checkoutBtn.addEventListener("click", () => void doCheckout(full.number, checkoutBtn));
  actions.push(checkoutBtn);

  const approveBtn = el("button", "mini-btn");
  approveBtn.append(glyph("check"), span("Approve"));
  approveBtn.title = "Approve this pull request";
  approveBtn.addEventListener("click", () => void doApprove(full.number, approveBtn, reload));

  const reviewBtn = el("button", "mini-btn");
  reviewBtn.append(glyph("comment"), span("Review"), glyph("chevron-down"));
  reviewBtn.title = "Submit a review";
  reviewBtn.addEventListener("click", () =>
    openMenu(reviewBtn, [
      { label: "Comment", icon: "comment", onClick: () => void doReview(full.number, "COMMENT", reviewBtn, reload) },
      { label: "Request changes", icon: "request-changes", onClick: () => void doReview(full.number, "REQUEST_CHANGES", reviewBtn, reload) },
      { separator: true },
      { label: "Approve", icon: "check", onClick: () => void doApprove(full.number, approveBtn, reload) },
    ]),
  );
  if (kind === "open-pr" || kind === "draft") actions.push(approveBtn, reviewBtn);

  // The primary slot: Merge for an open PR, Mark ready for a draft.
  if (kind === "draft") {
    const readyBtn = el("button", "btn btn-primary");
    readyBtn.append(glyph("eye"), span("Mark ready"));
    readyBtn.title = "Convert this draft to ready for review";
    readyBtn.addEventListener("click", () => void doMarkReady(full.number, readyBtn, reload));
    actions.push(readyBtn);
  } else if (kind === "open-pr") {
    const mergeBtn = el("button", "btn btn-primary gh-merge-btn");
    mergeBtn.append(glyph("git-merge"), span("Merge"), glyph("chevron-down"));
    mergeBtn.title = "Merge this pull request";
    mergeBtn.addEventListener("click", () =>
      openMenu(mergeBtn, [
        { label: "Create a merge commit", icon: "git-merge", onClick: () => void doMerge(full.number, "merge", reload) },
        { label: "Squash and merge", icon: "git-commit", onClick: () => void doMerge(full.number, "squash", reload) },
        { label: "Rebase and merge", icon: "git-compare", onClick: () => void doMerge(full.number, "rebase", reload) },
      ]),
    );
    actions.push(mergeBtn);
  }

  const moreBtn = el("button", "mini-btn gh-icon-btn");
  moreBtn.append(glyph("ellipsis"));
  moreBtn.title = "More actions";
  moreBtn.addEventListener("click", () =>
    openMenu(moreBtn, [
      { label: "Edit title & description", icon: "pencil", onClick: () => void doEdit(full, reload) },
      { label: "Update branch", icon: "git-merge", onClick: () => void doUpdateBranch(full.number, reload) },
      { separator: true },
      full.state === "open"
        ? { label: "Close pull request", icon: "git-pull-request-closed", onClick: () => void doSetState(full.number, "closed", reload) }
        : { label: "Reopen pull request", icon: "git-pull-request", onClick: () => void doSetState(full.number, "open", reload) },
      { separator: true },
      { label: "Copy link", icon: "copy", onClick: () => void copyText(full.htmlUrl, "Copied PR link.") },
    ]),
  );
  actions.push(moreBtn);

  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = "Open this pull request on GitHub";
  openBtn.setAttribute("aria-label", openBtn.title);
  openBtn.addEventListener("click", () => window.open(full.htmlUrl, "_blank"));
  actions.push(openBtn);

  topActions.replaceChildren(...actions);

  // ── title block ──
  const titleRow = el("div", "det-title-row");
  titleRow.appendChild(statePill(prKindLabel(kind), kind));
  const h = el("h1", "det-title");
  h.append(span(full.title), span(`  #${full.number}`, "det-title-num"));
  titleRow.appendChild(h);
  const editTitleBtn = el("button", "mini-btn gh-icon-btn det-title-edit");
  editTitleBtn.append(glyph("pencil"));
  editTitleBtn.title = "Edit title & description";
  editTitleBtn.setAttribute("aria-label", "Edit pull request title and description");
  editTitleBtn.addEventListener("click", () => void doEdit(full, reload));
  titleRow.appendChild(editTitleBtn);
  main.appendChild(titleRow);

  const sub = el("div", "det-sub");
  const author = full.user;
  if (author?.login) {
    const who = el("button", "gh-meta-author");
    who.append(avatar(author.login, author.avatarUrl, 18), span(author.login));
    who.title = `View @${author.login}'s profile`;
    who.addEventListener("click", () =>
      openPeek(memberCard({ login: author.login, avatarUrl: author.avatarUrl, htmlUrl: `https://github.com/${author.login}` })),
    );
    sub.appendChild(who);
  }
  const when = el("span");
  when.textContent = `opened ${relTimeISO(full.createdAt)} · updated ${relTimeISO(full.updatedAt)}`;
  when.title = full.updatedAt ? `Updated ${absTimeISO(full.updatedAt)}` : "";
  sub.appendChild(when);
  main.appendChild(sub);

  // ── sub-tabs ──
  const subBar = el("div", "gh-subtabs");
  const content = el("div", "gh-subcontent");
  const subDefs = [
    { id: "conversation", label: "Conversation", icon: "comment-discussion" },
    { id: "commits", label: "Commits", icon: "git-commit" },
    { id: "checks", label: "Pipelines", icon: "play" },
    { id: "files", label: `Files (${d.files.length})`, icon: "code" },
  ];
  const subBtns: HTMLElement[] = [];
  const selectSub = (id: string): void => {
    if (activeSubTab === "files" && id !== "files") disposePrDiff();
    activeSubTab = id;
    for (const b of subBtns) b.classList.toggle("active", b.dataset.sub === id);
    // Files mode: the rail hides and the content column stretches to the full
    // window — a review surface, not a document.
    view.classList.toggle("det-files-mode", id === "files");
    void renderSubTab(content, full, d, id, reload);
  };
  for (const t of subDefs) {
    const b = el("button", "gh-subtab");
    b.dataset.sub = t.id;
    b.append(glyph(t.icon), span(t.label));
    b.addEventListener("click", () => selectSub(t.id));
    subBtns.push(b);
    subBar.appendChild(b);
  }
  main.append(subBar, content);

  // ── property rail ──
  const reviewersProp = propSection("Reviewers", {
    onEdit: () => void doRequestReviewers(full.number),
    editTitle: "Request reviewers",
  });
  // Who was ASKED but hasn't answered — the single most useful thing a PR rail
  // can tell you, and previously invisible (the section only offered "add").
  if (full.requestedReviewers?.length) {
    for (const r of full.requestedReviewers) {
      const chip = personChip(r.login, r.avatarUrl, () =>
        openPeek(memberCard({ login: r.login, avatarUrl: r.avatarUrl, htmlUrl: `https://github.com/${r.login}` })),
      );
      chip.title = `@${r.login} — review requested, not yet submitted`;
      chip.classList.add("is-pending");
      reviewersProp.body.appendChild(chip);
    }
  }
  reviewersProp.body.appendChild(propAddBtn("Request review", () => void doRequestReviewers(full.number)));

  const assignProp = propSection("Assignees", {
    onEdit: () => void doAssignees(full, reload),
    editTitle: "Edit assignees",
  });
  if (full.assignees?.length) {
    for (const a of full.assignees) {
      assignProp.body.appendChild(
        personChip(a.login, a.avatarUrl, () =>
          openPeek(memberCard({ login: a.login, avatarUrl: a.avatarUrl, htmlUrl: `https://github.com/${a.login}` })),
        ),
      );
    }
  } else {
    assignProp.body.appendChild(propAddBtn("Assign", () => void doAssignees(full, reload)));
  }

  const labelProp = propSection("Labels", {
    onEdit: (anchor) => void doLabels(anchor, full, reload),
    editTitle: "Edit labels",
  });
  if (full.labels.length) {
    for (const l of full.labels) labelProp.body.appendChild(labelChip(l.name, l.color));
  } else {
    labelProp.body.appendChild(propAddBtn("Add labels", () => void doLabels(labelProp.root, full, reload)));
  }

  const branchesProp = propSection("Branches");
  const branchChip = (ref: string): HTMLElement => {
    const b = el("button", "gh-branch-chip");
    b.append(glyph("git-branch"), span(ref));
    b.title = `Show ${ref} in Branches`;
    b.addEventListener("click", () => sectionNav?.("branches", { ref }));
    return b;
  };
  const flow = el("span", "gh-meta-flow");
  flow.append(branchChip(full.head.ref), span("→", "gh-meta-arrow"), branchChip(full.base.ref));
  branchesProp.body.appendChild(flow);

  const checksProp = propSection("Checks");
  if (d.checks) {
    const c = el("button", "gh-pill det-checks-pill");
    c.classList.add(`gh-checks-${d.checks}`);
    c.textContent = d.checks;
    c.title = "Open the Pipelines tab";
    c.addEventListener("click", () => selectSub("checks"));
    checksProp.body.appendChild(c);
  } else {
    checksProp.body.appendChild(propNone("No checks"));
  }

  // Who pressed merge — often NOT the author, and the answer to "who shipped
  // this?" that used to require opening github.com.
  const mergedProp = full.mergedBy ? propSection("Merged by") : undefined;
  if (mergedProp && full.mergedBy) {
    const mb = full.mergedBy;
    mergedProp.body.appendChild(
      personChip(mb.login, mb.avatarUrl, () =>
        openPeek(memberCard({ login: mb.login, avatarUrl: mb.avatarUrl, htmlUrl: `https://github.com/${mb.login}` })),
      ),
    );
  }

  const msProp = full.milestone ? propSection("Milestone") : undefined;
  if (msProp && full.milestone) {
    const chip = el("span", "gh-pill det-milestone-chip");
    chip.append(glyph("milestone"), span(full.milestone.title));
    msProp.body.appendChild(chip);
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
  about.body.appendChild(fact("Files changed", String(d.files.length)));
  if (typeof full.additions === "number" || typeof full.deletions === "number") {
    about.body.appendChild(fact("Lines", `+${full.additions ?? 0} −${full.deletions ?? 0}`));
  }
  if (typeof full.commits === "number") about.body.appendChild(fact("Commits", String(full.commits)));
  if (typeof full.reviewComments === "number" && full.reviewComments > 0) {
    about.body.appendChild(fact("Review comments", String(full.reviewComments)));
  }
  if (full.headRepoFullName) {
    // A PR from a fork runs CI from someone else's branch — worth saying out loud.
    about.body.appendChild(fact("From fork", full.headRepoFullName, full.headRepoFullName));
  }
  if (full.authorAssociation && full.authorAssociation !== "NONE") {
    about.body.appendChild(fact("Author is", associationLabel(full.authorAssociation)));
  }
  about.body.appendChild(fact("Created", relTimeISO(full.createdAt), absTimeISO(full.createdAt)));
  about.body.appendChild(fact("Updated", relTimeISO(full.updatedAt), absTimeISO(full.updatedAt)));
  if (full.mergedAt) {
    about.body.appendChild(fact("Merged", relTimeISO(full.mergedAt), absTimeISO(full.mergedAt)));
  } else if (full.closedAt) {
    about.body.appendChild(fact("Closed", relTimeISO(full.closedAt), absTimeISO(full.closedAt)));
  }

  // People → classification → where it lands → how it's doing → the facts.
  rail.append(
    reviewersProp.root,
    assignProp.root,
    ...(mergedProp ? [mergedProp.root] : []),
    labelProp.root,
    ...(msProp ? [msProp.root] : []),
    branchesProp.root,
    checksProp.root,
    about.root,
  );

  selectSub(subDefs.some((s) => s.id === activeSubTab) ? activeSubTab : "conversation");
}

// ── Sub-tab content ──────────────────────────────────────────────────────────

async function renderSubTab(
  content: HTMLElement,
  full: PullRequest,
  d: PrDetail,
  id: string,
  reload: () => void,
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
    const timeline = el("div", "gh-subcontent");
    wireProseNav(timeline, sectionNav);
    if (full.body && full.body.trim()) {
      timeline.appendChild(
        commentCard(full.user?.login ?? "author", "description", full.body, undefined, {
          association: full.authorAssociation,
          reactions: full.reactions,
        }),
      );
    }
    for (const c of conv) {
      timeline.appendChild(commentCard(c.author, undefined, c.body, c.kind === "review" ? c.state : undefined));
    }
    if ((!full.body || !full.body.trim()) && conv.length === 0) {
      timeline.appendChild(emptyState("No conversation yet", "No description or comments on this PR."));
    }
    content.appendChild(timeline);

    // A real composer (not a prompt) — same pattern as the Issues detail.
    const composer = el("div", "gh-composer");
    const ta = document.createElement("textarea");
    ta.className = "gh-composer-input";
    ta.placeholder = "Leave a comment…";
    ta.rows = 3;
    ta.value = commentDrafts.get(full.number) ?? "";
    ta.addEventListener("input", () => {
      if (ta.value.trim()) commentDrafts.set(full.number, ta.value);
      else commentDrafts.delete(full.number);
    });
    const crow = el("div", "gh-composer-actions");
    const send = el("button", "btn btn-primary");
    send.append(glyph("comment"), span("Comment"));
    send.addEventListener("click", () => void doComment(full.number, ta, send, reload));
    crow.appendChild(send);
    composer.append(ta, crow);
    content.appendChild(composer);
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
        // GitHub-Actions checks land on the RUN PAGE with the job's log pane
        // expanded — the full surface, not a modal. External CI keeps the browser.
        const gha = /\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/.exec(c.detailsUrl);
        row.title = gha ? "Open the run's logs in-app" : "Open check details";
        row.addEventListener("click", () => {
          if (gha) {
            const jobId = gha[2] ? Number(gha[2]) : undefined;
            sectionNav?.("actions", { number: Number(gha[1]), jobId });
          } else {
            window.open(c.detailsUrl!, "_blank");
          }
        });
      }
      content.appendChild(row);
    }
  } else {
    // ── Files = the full-width review surface ──
    content.replaceChildren();
    const files = d.files;
    if (files.length === 0) {
      content.appendChild(emptyState("No files changed", "This PR doesn't change any files."));
      return;
    }
    renderFilesTab(content, full, files);
  }
}

/**
 * The Files tab: a left file list and the selected file's real Monaco diff with
 * its inline review threads beneath it. Clicking a file fetches `pr:fileDiff`;
 * the threads come from `pr:reviewThreads` filtered to that file. In files mode
 * the whole page column stretches, so the diff gets real height. Layout comes
 * from the .pr-files* CSS — no inline styles.
 */
function renderFilesTab(content: HTMLElement, full: PullRequest, files: PrFile[]): void {
  const layout = el("div", "pr-files");
  const list = el("div", "pr-files-list gh-files");
  const detail = el("div", "pr-files-detail");
  layout.append(list, detail);
  content.appendChild(layout);

  // Threads are (re)fetched on each file open so a just-added comment / resolve
  // shows immediately. A failure is non-fatal — the diff still renders.
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
 * with a threads panel beneath it. `loadThreads` is re-invoked (not the diff)
 * whenever a review action lands, so the comments refresh in place without the
 * Monaco editor flickering.
 */
async function showFileDiff(
  detail: HTMLElement,
  full: PullRequest,
  f: PrFile,
  loadThreads: () => Promise<PrReviewThread[]>,
): Promise<void> {
  const surface = el("div", "diff-surface pr-diff-surface");
  const threadsSlot = el("div", "pr-threads");
  detail.replaceChildren(surface, threadsSlot);
  threadsSlot.replaceChildren(loadingState("Loading diff…"));

  disposePrDiff();
  const panel = new DiffPanel(surface);
  prDiffPanel = panel;
  watchDiffDetach(surface);

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
  const title = span(`Review comments (${mine.length})`, "pr-threads-title");
  head.append(glyph("comment-discussion"), title);
  const addBtn = el("button", "mini-btn pr-threads-add");
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

/** One review thread: a line anchor + its comments + resolve / reply controls. */
function threadCard(prNumber: number, t: PrReviewThread, reloadFile: () => void): HTMLElement {
  const card = el("div", `gh-comment pr-thread${t.isResolved ? " is-resolved" : ""}`);

  const hd = el("div", "gh-comment-head pr-thread-head");
  const anchor = el("span", "pr-thread-anchor");
  anchor.append(glyph("git-commit"), span(t.line != null ? `Line ${t.line}` : "File", "pr-thread-line"));
  hd.appendChild(anchor);
  if (t.isOutdated) hd.appendChild(pill("outdated"));
  const statusPill = pill(t.isResolved ? "resolved" : "open");
  statusPill.classList.add(t.isResolved ? "gh-review-approved" : "gh-thread-open");
  hd.appendChild(statusPill);

  const resolveBtn = el("button", "mini-btn gh-inline-edit pr-thread-resolve");
  resolveBtn.append(glyph(t.isResolved ? "issue-reopened" : "check"), span(t.isResolved ? "Unresolve" : "Resolve"));
  resolveBtn.addEventListener("click", () =>
    void toggleResolve(t.id, !t.isResolved, resolveBtn, reloadFile),
  );
  hd.appendChild(resolveBtn);
  card.appendChild(hd);

  for (const c of t.comments) {
    const cm = el("div", "pr-thread-comment");
    const ch = el("div", "pr-thread-comment-head");
    ch.append(avatar(c.author.login, c.author.avatarUrl, 20), span(c.author.login, "pr-thread-author"));
    if (c.createdAt) {
      const when = span(relTimeISO(c.createdAt), "gh-comment-when");
      when.title = absTimeISO(c.createdAt);
      ch.appendChild(when);
    }
    cm.appendChild(ch);
    const bd = el("div", "gh-body-md pr-thread-body");
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
  const ta = document.createElement("textarea");
  ta.className = "gh-composer-input pr-reply-input";
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

/** "fork" marker naming the head repo — hover for the full owner/repo. */
function forkChip(headRepo: string): HTMLElement {
  const c = el("span", "gh-fork-chip");
  c.append(glyph("repo-forked"), span("fork"));
  c.title = `Head branch lives in ${headRepo}`;
  return c;
}

function commentCard(
  author: string,
  suffix: string | undefined,
  body: string,
  reviewState?: string,
  extra: { association?: string; reactions?: ReactionSummary } = {},
): HTMLElement {
  const card = el("div", "gh-comment");
  const hd = el("div", "gh-comment-head");
  const who = el("span", "gh-comment-author");
  who.append(avatar(author, `https://github.com/${author}.png`, 18), span(suffix ? `${author} · ${suffix}` : author));
  hd.appendChild(who);
  const assoc = associationBadge(extra.association);
  if (assoc) hd.appendChild(assoc);
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
  const reactions = reactionRow(extra.reactions);
  if (reactions) card.appendChild(reactions);
  return card;
}

// ── Mutations (disable trigger → toast → bust cache → re-render) ──────────────

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

async function doApprove(n: number, btn: HTMLElement, reload: () => void): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:approve", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't approve the PR.", "error");
      return;
    }
    toast(`Approved pull request #${n}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't approve the PR.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

/**
 * The review modal — verdict (Comment / Approve / Request changes) + a real
 * multi-line body in ONE surface, GitHub-style, instead of the old one-line
 * prompt. `event` preselects the verdict the caller chose; the user can still
 * change it here. A body is required only for "Request changes".
 */
async function doReview(
  n: number,
  event: PrReviewEvent,
  btn: HTMLElement,
  reload: () => void,
): Promise<void> {
  const choice = await reviewModal(n, event);
  if (!choice) return; // cancelled
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:review", {
      number: n,
      event: choice.event,
      body: choice.body || undefined,
    });
    if (!r.ok) {
      toast(r.message ?? "Couldn't submit the review.", "error");
      return;
    }
    toast(`Review submitted on PR #${n}.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't submit the review.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

const REVIEW_VERDICTS: ReadonlyArray<{ event: PrReviewEvent; label: string; icon: string; hint: string }> = [
  { event: "COMMENT", label: "Comment", icon: "comment", hint: "Feedback without an explicit approval" },
  { event: "APPROVE", label: "Approve", icon: "check", hint: "The change is good to merge" },
  { event: "REQUEST_CHANGES", label: "Request changes", icon: "request-changes", hint: "Must be addressed before merging" },
];

function reviewModal(
  n: number,
  initial: PrReviewEvent,
): Promise<{ event: PrReviewEvent; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    openModal((close) => {
      const finish = (v: { event: PrReviewEvent; body: string } | null): void => {
        if (settled) return;
        settled = true;
        resolve(v);
        close();
      };

      const card = el("div", "modal-card gh-pr-form review-modal");
      const h = el("div", "modal-title");
      h.textContent = `Review pull request #${n}`;
      card.appendChild(h);

      let selected: PrReviewEvent = initial;
      const verdictRows: HTMLElement[] = [];
      const verdicts = el("div", "review-verdicts");
      const syncVerdicts = (): void => {
        verdictRows.forEach((r) => r.classList.toggle("is-selected", r.dataset.event === selected));
        submitLabel.textContent =
          selected === "APPROVE" ? "Approve" : selected === "REQUEST_CHANGES" ? "Request changes" : "Submit review";
      };
      for (const v of REVIEW_VERDICTS) {
        const row = el("button", "review-verdict");
        (row as HTMLButtonElement).type = "button";
        row.dataset.event = v.event;
        const lead = el("span", "review-verdict-lead");
        lead.appendChild(glyph(v.icon));
        const text = el("span", "review-verdict-text");
        const l = el("span", "review-verdict-label");
        l.textContent = v.label;
        const hint = el("span", "review-verdict-hint");
        hint.textContent = v.hint;
        text.append(l, hint);
        row.append(lead, text, glyph("check"));
        row.addEventListener("click", () => {
          selected = v.event;
          syncVerdicts();
        });
        verdictRows.push(row);
        verdicts.appendChild(row);
      }
      card.appendChild(verdicts);

      const ta = document.createElement("textarea");
      ta.className = "gh-form-textarea";
      ta.placeholder = "Leave a review comment… (required for Request changes)";
      ta.rows = 5;
      card.appendChild(ta);

      const actions = el("div", "modal-actions");
      const cancel = el("button", "mini-btn");
      cancel.textContent = "Cancel";
      const ok = el("button", "btn btn-primary modal-ok");
      const submitLabel = span("Submit review");
      ok.appendChild(submitLabel);
      actions.append(cancel, ok);
      card.appendChild(actions);
      syncVerdicts();

      const submit = (): void => {
        const body = ta.value.trim();
        if (!body && selected === "REQUEST_CHANGES") {
          ta.focus();
          toast("A comment is required to request changes.", "error");
          return;
        }
        finish({ event: selected, body });
      };
      cancel.addEventListener("click", () => finish(null));
      ok.addEventListener("click", submit);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      });

      return {
        card,
        focusEl: ta,
        label: `Review pull request #${n}`,
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}

async function doComment(
  n: number,
  ta: HTMLTextAreaElement,
  btn: HTMLElement,
  reload: () => void,
): Promise<void> {
  const body = ta.value.trim();
  if (!body) {
    toast("Write a comment first.", "info");
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  ta.disabled = true;
  try {
    const r = await host.invoke("pr:comment", { number: n, body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't post the comment.", "error");
      return;
    }
    toast(`Commented on PR #${n}.`, "success");
    commentDrafts.delete(n);
    activeSubTab = "conversation";
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't post the comment.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
    ta.disabled = false;
  }
}

async function doSetState(n: number, state: "open" | "closed", reload: () => void): Promise<void> {
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
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the pull request.", "error");
  }
}

async function doMarkReady(n: number, btn: HTMLElement, reload: () => void): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:markReady", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't mark the PR ready.", "error");
      return;
    }
    toast(`PR #${n} is ready for review.`, "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't mark the PR ready.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function doMerge(n: number, method: "merge" | "squash" | "rebase", reload: () => void): Promise<void> {
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
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Merge failed.", "error");
  }
}

/** Request reviewers (or re-request the same set, when `reRequest` is set — the
 *  GitHub re-request just re-POSTs the chosen logins to the same endpoint). */
async function doRequestReviewers(n: number, reRequest = false): Promise<void> {
  let people: RepoCollaborator[] = [];
  try {
    people = await gget("pr:reviewers", undefined, 60000);
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

/** Edit the PR's title + body in one unified form, then PATCH via pr:edit. */
async function doEdit(pr: PullRequest, reload: () => void): Promise<void> {
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
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't edit the pull request.", "error");
  }
}

/** A toggle-menu of the repo's labels (current ones checked) → pr:setLabels. */
async function doLabels(anchor: HTMLElement, pr: PullRequest, reload: () => void): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await gget("pr:labels", undefined, 60000);
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
        void applyLabels(pr, [...next], reload);
      },
    })),
    { searchable: true },
  );
}

async function applyLabels(pr: PullRequest, labelsList: string[], reload: () => void): Promise<void> {
  try {
    const r = await host.invoke("pr:setLabels", { number: pr.number, labels: labelsList });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update labels.", "error");
      return;
    }
    toast("Labels updated.", "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update labels.", "error");
  }
}

/** Edit the PR's assignees via the avatar-rich people picker → pr:setAssignees. */
async function doAssignees(pr: PullRequest, reload: () => void): Promise<void> {
  let people: RepoCollaborator[] = [];
  try {
    people = await gget("pr:reviewers", undefined, 60000);
  } catch {
    /* fall through to the free-text path */
  }
  const current = (pr.assignees ?? []).map((a) => a.login);
  let assignees: string[] | null;
  if (people.length) {
    assignees = await peoplePickerModal({ title: "Assignees", okLabel: "Save", people, selected: current });
  } else {
    const csv = await promptInline("Assignees", "comma-separated logins, e.g. octocat, hubot", current.join(", "), "Save");
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
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update assignees.", "error");
  }
}

/** Merge the latest base into the PR head (pr:updateBranch). */
async function doUpdateBranch(n: number, reload: () => void, btn?: HTMLElement): Promise<void> {
  if (btn) (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("pr:updateBranch", n);
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the branch.", "error");
      return;
    }
    toast(`Updated PR #${n} with the base branch.`, "success");
    reload(); // the head SHA moved — refetch the detail (files / checks change)
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
    bust("pr");
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
    openModal((close) => {
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

      cancel.addEventListener("click", close);
      ok.addEventListener("click", () => {
        settled = true;
        resolve({
          title: title.value,
          head: head.sel.value,
          base: base.sel.value,
          body: body.value,
          draft: draft.checked,
        });
        close();
      });
      return {
        card,
        focusEl: title,
        label: "New pull request",
        onClose: () => {
          if (!settled) resolve(null);
        },
      };
    });
  });
}
