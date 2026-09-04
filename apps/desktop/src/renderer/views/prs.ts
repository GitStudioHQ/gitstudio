// The Pull Requests section — a full, GitHub-grade PR workspace on the
// section-page system (docs/desktop-redesign.md): a full-width list page whose
// rows navigate to a full-page detail (routed via `target.number`), with the
// PR's properties in an inline-editable right rail and Conversation / Commits /
// Checks / Files sub-tabs in the content column. The Files tab widens to the
// whole window (the rail hides) — diffs get the space they deserve.
//
// Everything routes through `host.invoke` against the typed IPC contract. Reads
// that fail render an errorState with Retry; every mutation disables its
// trigger, confirms destructive ops, toasts success/error, busts the SWR cache
// and re-renders the affected surface.

import { host } from "../bridge";
import { mdEditor } from "../mdEditor";
import { peek as cachePeek, gget, bust, prime, cacheScope } from "../cache";
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
 commonDir,} from "../ui";
import { toast, confirmDialog, promptInline, openModal, formWithRetry } from "../dialogs";
import { renderMarkdown } from "../markdown";
import { openAssistantTab, aiEnabled } from "../aiAssist";
import { DiffPanel } from "../diffPanel";
import {
  associationBadge,
  blankable,
  facetBar,
  harvestValues,
  segmented,
  swatch,
  type FacetState,
  associationLabel,
  reactionRow,
  avatarStack,
  capNotice,
  commitList,
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
  disposeOnDetach,
  type GhGate,
  type SectionRender,
  type SectionNav,
  type SectionTarget,
  subTabs,
  checkStateLabel,
  checkIcon,
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
  ReactionContent,
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
/** Which PRs to fetch. GitHub has no "merged" state — merged PRs arrive under
 *  `closed` carrying `mergedAt` — so "merged" asks for closed and narrows here. */
let prState: "open" | "closed" | "merged" | "all" = "open";
/** Client-side PR facets, kept across list ⇄ detail round trips. */
const prFacets: FacetState = {};
/**
 * Unsent comment drafts, per PR — navigating away must never eat one.
 *
 * Keyed by REPO and number. Keyed by number alone, a draft written on PR #31
 * in one repository was handed to PR #31 in the next one you opened —
 * pre-filled into its composer, ready to send to strangers. Numbers collide
 * across repos constantly; the low ones always do.
 */
const commentDrafts = new Map<string, string>();
const draftKey = (n: number): string => `${cacheScope()}#${n}`;
/**
 * Unsent inline replies, per review thread.
 *
 * Resolving ANY thread reloads the file's whole thread panel, which rebuilds
 * every card from scratch — so a reply half-written in one thread vanished
 * because a different thread was resolved. Same rule as the composer above:
 * text the user typed is not the app's to throw away on a repaint.
 */
const replyDrafts = new Map<string, string>();

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
/** Cancels the detach watch below. */
let stopPrDiffWatch: (() => void) | undefined;

function disposePrDiff(): void {
  stopPrDiffWatch?.();
  stopPrDiffWatch = undefined;
  prDiffPanel?.dispose();
  prDiffPanel = undefined;
}

/**
 * Tear the diff down once its surface leaves the document (a route change
 * replacing the view host), so the Monaco editor never lingers.
 *
 * It watches the WHOLE document for any mutation, so it fires constantly — and
 * it used to call `disposePrDiff()` on behalf of whatever panel happened to be
 * current, clearing `prDiffPanel` even when the surface it was watching was not
 * the live one. After that every `prDiffPanel !== panel` guard in the load path
 * was true and the tab stayed blank forever, in both modes, until another file
 * was picked. It disposes only the panel it was created for, and only while
 * that panel is still the live one.
 */
function watchDiffDetach(surface: HTMLElement, panel: DiffPanel): void {
  stopPrDiffWatch?.();
  stopPrDiffWatch = disposeOnDetach(surface, () => {
    // Only the panel this watch was created for, and only while it is still the
    // live one — see the note above.
    if (prDiffPanel !== panel) return;
    disposePrDiff();
  });
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
    showDetailPage(wrap, nav, target.number, target.from);
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
  // Pull Requests was permanently open-only while Issues had a state control
  // one rail item away. "Merged" is a fourth option because it is the state
  // people actually look for, even though GitHub does not have it.
  const stateSeg = segmented<"open" | "closed" | "merged" | "all">({
    options: [
      { value: "open", label: "Open" },
      { value: "merged", label: "Merged" },
      { value: "closed", label: "Closed" },
      { value: "all", label: "All" },
    ],
    value: prState,
    ariaLabel: "Pull request state",
    onChange: (v) => {
      prState = v;
      renderPrs(wrap, nav);
    },
  });
  const facetSlot = el("div", "gh-facet-slot");
  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("git-pull-request"), span("New PR"));
  newBtn.title = "Open a new pull request";
  newBtn.addEventListener("click", () => void openCreatePr(refresh));
  tools.append(stateSeg, facetSlot, newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  const fetchState = prState === "merged" ? "closed" : prState;
  let prs: PullRequest[] | undefined = cachePeek("pr:list", { state: fetchState });
  if (!prs) listEl.replaceChildren(skeletonList(5));

  const buildRow = (pr: PullRequest): HTMLElement => {
    const kind = prKind(pr);
    // One order across every list: who wrote it, who owns it, then the counts.
    const meta: HTMLElement[] = [];
    if (pr.user) meta.push(avatarStack([pr.user], 1, 18, "Author"));
    meta.push(blankable(avatarStack(pr.assignees ?? [], 3, 18, "Assignee"), !!pr.assignees?.length));
    if (typeof pr.additions === "number" || typeof pr.deletions === "number") {
      const stat = el("span", "sec-diffstat");
      if (typeof pr.additions === "number") stat.appendChild(span(`+${pr.additions}`, "add"));
      if (typeof pr.deletions === "number") stat.appendChild(span(`−${pr.deletions}`, "del"));
      meta.push(stat);
    }
    meta.push(blankable(statBit("comment", pr.comments ?? 0), (pr.comments ?? 0) > 0));

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

  /** Narrows the fetched page to the segment. "Closed" means closed-and-not-
   *  merged, so Merged and Closed are disjoint rather than one containing the
   *  other — which is what people mean when they pick one. */
  const stateMatches = (pr: PullRequest): boolean => {
    if (prState === "merged") return !!pr.mergedAt;
    if (prState === "closed") return pr.state === "closed" && !pr.mergedAt;
    return true;
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
      // Was called "State" and contained no states — draft-ness and where the
      // head branch lives are two different questions, and neither is a state.
      {
        key: "draft",
        label: "Review",
        icon: "git-pull-request",
        anyLabel: "Ready and draft",
        options: [
          { value: "ready", label: "Ready for review", icon: "git-pull-request" },
          { value: "draft", label: "Draft", icon: "git-pull-request-draft" },
        ],
        predicate: (pr, v) => (v === "draft" ? pr.draft : !pr.draft),
      },
      {
        key: "origin",
        label: "Origin",
        icon: "repo-forked",
        anyLabel: "Anywhere",
        options: [
          { value: "same", label: "This repository", icon: "repo" },
          { value: "fork", label: "From a fork", icon: "repo-forked" },
        ],
        predicate: (pr, v) => (v === "fork" ? !!pr.headRepoFullName : !pr.headRepoFullName),
      },
    ],
    state: prFacets,
    items: prs ?? [],
    onChange: () => renderList(),
  });
  facetSlot.replaceChildren(facets.el);

  const renderList = (): void => {
    if (!prs) return;
    const inSegment = prs.filter(stateMatches);
    // Harvested from the SEGMENT, not the superset behind it. Merged and Closed
    // come from one "closed" fetch, so on Merged the Author menu listed
    // everyone who has a closed pull request and the Label menu every label on
    // one — options that filter the visible list down to nothing, offered as if
    // they were choices.
    facets.sync(inSegment);
    const q = query.toLowerCase();
    // The SEGMENT's own set is the total. `prs` is a superset — Merged and
    // Closed are fetched together — so counting against it put the badge in its
    // narrowed "N of M" form, with the accent and the "N shown of M loaded"
    // tooltip, on a segment where no filter was set at all: "0 of 5" above
    // "No closed pull requests". The "of" is a statement that something is
    // being filtered OUT, and picking a segment is not filtering.
    const items = inSegment.filter((pr) => facets.passes(pr) && (q ? matches(pr, q) : true));
    header.setCount?.(items.length, inSegment.length);
    listEl.replaceChildren();
    // The empty state has to answer the question the SEGMENT asked. It was
    // hardcoded to the open-state copy, so "Closed" reported "No open pull
    // requests — you're all caught up", which is about a different set entirely.
    // Same table Issues already uses.
    const emptyCopy: Record<typeof prState, { title: string; desc: string; icon: string }> = {
      open: {
        title: "No open pull requests",
        desc: "You're all caught up — nothing to review right now.",
        icon: "git-pull-request",
      },
      merged: {
        title: "No merged pull requests",
        desc: "Merged pull requests will show here once some land.",
        icon: "git-merge",
      },
      closed: {
        title: "No closed pull requests",
        desc: "Pull requests closed without merging will show here.",
        icon: "git-pull-request-closed",
      },
      all: {
        title: "No pull requests yet",
        desc: "This repo has none. Open the first one to propose a change.",
        icon: "git-pull-request",
      },
    };
    const ec = emptyCopy[prState];
    if (prs.length === 0) {
      listEl.appendChild(
        emptyState(ec.title, ec.desc, {
          icon: ec.icon,
          // Only offer to open one where opening one is the natural next step.
          action:
            prState === "open" || prState === "all"
              ? { label: "New pull request", icon: "git-pull-request", onClick: () => void openCreatePr(refresh) }
              : undefined,
        }),
      );
      return;
    }
    if (items.length === 0) {
      // Nothing filtered it — the segment did. Blaming filters that are not set
      // ("0 of 5 … matches these filters") sends people hunting for a control
      // that is already clear.
      const bySegment = facets.activeCount() === 0 && !query;
      listEl.appendChild(
        emptyState(
          bySegment ? ec.title : "No matching pull requests",
          bySegment
            ? ec.desc
            : query
              ? `Nothing matches “${query}”.`
              : "No pull request matches these filters.",
          {
            icon: bySegment ? ec.icon : "search",
          // A filtered-empty list answers a question the toolbar asked, so it
          // sits beside that control; a segment-empty one is the whole view's
          // state and gets the hero — same rule the Inbox uses. Forcing
          // `inline` here also hid the segment icon we just picked, since
          // `.is-inline` drops the badge.
          anchor: bySegment ? "hero" : "inline",
          secondary: facets.activeCount() > 0
            ? { label: "Clear filters", icon: "clear-all", onClick: () => facets.clear() }
            : undefined,
          },
        ),
      );
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
    const fresh = await gget("pr:list", { state: fetchState }, 15000);
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

function showDetailPage(
  wrap: HTMLElement,
  nav: SectionNav,
  n: number,
  from?: { view: string; label: string },
): void {
  sectionNav = nav;
  disposePrDiff();
  // A DIFFERENT PR starts on Conversation with no file pre-selected — the
  // module-scoped tab used to leak: open PR B and land on PR A's Files tab.
  if (lastDetailNumber !== n) {
    lastDetailNumber = n;
    activeSubTab = "conversation";
    activeFilePath = undefined;
  }
  // Back goes where you CAME from — see the note in issues.ts.
  const back = (): void => nav(from?.view ?? "prs", { list: true });
  const reload = (): void => {
    bust("pr");
    showDetailPage(wrap, nav, n, from);
  };

  const { view, main, rail, topActions } = detailPage({
    backLabel: from?.label ?? "Pull Requests",
    crumb: `#${n}`,
    // What the NEXT page's back button calls this one. Without it, leaving for
    // a pipeline and pressing back read "← Pull requests" and landed on the
    // list rather than the pull request you were reading.
    pageLabel: `Pull Request #${n}`,
    onBack: back,
  });
  main.appendChild(skeletonList(4, false));
  wrap.replaceChildren(view);

  // While CI is PENDING, quietly re-fetch and repaint when something changed —
  // the checks pill and Checks tab keep themselves honest. Stands down while
  // the Files tab is open (a repaint would tear down the Monaco diff mid-read).
  let lastSig = "";
  /** What the CI poll watches: the check state and the counts its sub-tab
   *  labels are built from. Everything else changing is not a reason to throw
   *  the page away and rebuild it. */
  const pollSig = (d: PrDetail): string =>
    JSON.stringify([
      d.checks,
      d.pr.state,
      d.pr.draft,
      d.pr.mergedAt ?? null,
      d.pr.closedAt ?? null,
      d.pr.comments ?? 0,
      d.pr.reviewComments ?? 0,
      d.files.length,
    ]);

  const schedulePoll = (current: PrDetail): void => {
    if (current.checks !== "pending") return;
    window.setTimeout(() => {
      if (!view.isConnected) return;
      if (activeSubTab === "files") {
        schedulePoll(current);
        return;
      }
      // Never rebuild the page out from under someone who is typing in it. The
      // rebuild moves focus to the top of the new DOM, so a comment written
      // across two 15-second ticks lost the caret mid-sentence — and the
      // keystrokes after it went nowhere.
      const focused = document.activeElement;
      if (focused && view.contains(focused) && /^(TEXTAREA|INPUT)$/.test(focused.tagName)) {
        schedulePoll(current);
        return;
      }
      host
        .invoke("pr:detail", n)
        .then((fresh) => {
          if (!view.isConnected || !fresh) return;
          prime("pr:detail", n, fresh);
          // Compare only what this poll EXISTS to watch. Signing the whole
          // detail meant any unrelated field — an `updatedAt` bump from someone
          // else's comment — rebuilt the entire page, scroll and all, every 15
          // seconds on a busy PR.
          const sig = pollSig(fresh);
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
    lastSig = pollSig(d);
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

  // Approving is a public, named act on someone else's work, and this button
  // used to post it on the first click — 8px from a button that merely opens a
  // menu, with a second "Approve" inside that menu doing the same thing. Both
  // now open the review modal with APPROVE preselected, which is also where the
  // review body the modal exists for finally gets used.
  const approveBtn = el("button", "mini-btn");
  approveBtn.append(glyph("check"), span("Approve"));
  approveBtn.title = "Approve this pull request — opens the review composer";
  approveBtn.addEventListener("click", () => void doReview(full.number, "APPROVE", approveBtn, reload));

  const reviewBtn = el("button", "mini-btn");
  reviewBtn.append(glyph("comment"), span("Review"), glyph("chevron-down"));
  reviewBtn.title = "Submit a review";
  reviewBtn.addEventListener("click", () =>
    openMenu(reviewBtn, [
      { label: "Comment", icon: "comment", onClick: () => void doReview(full.number, "COMMENT", reviewBtn, reload) },
      { label: "Request changes", icon: "request-changes", onClick: () => void doReview(full.number, "REQUEST_CHANGES", reviewBtn, reload) },
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
      { label: "Edit title & description", icon: "pencil", onClick: () => sectionNav?.("predit", { number: full.number }) },
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
  editTitleBtn.addEventListener("click", () => sectionNav?.("predit", { number: full.number }));
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
  const content = el("div", "gh-subcontent");
  const subDefs = [
    { id: "conversation", label: "Conversation", icon: "comment-discussion" },
    { id: "commits", label: `Commits${typeof full.commits === "number" ? ` (${full.commits})` : ""}`, icon: "git-commit" },
    { id: "checks", label: "Checks", icon: "play" },
    // The tab's count is the PR's OWN total, not the length of the page we
    // happened to fetch. GitHub caps the files response, so the two disagreed
    // on the same screen: the rail read 412 and this tab read 300.
    { id: "files", label: `Files (${full.changedFiles ?? d.files.length})`, icon: "code" },
  ];
  content.id = "gs-pr-subpanel";
  const tabs = subTabs({
    tabs: subDefs,
    ariaLabel: "Pull request sections",
    panel: content,
    onSelect: (id) => {
      if (activeSubTab === "files" && id !== "files") disposePrDiff();
      activeSubTab = id;
      // Files mode: the rail hides and the content column stretches to the full
      // window — a review surface, not a document.
      view.classList.toggle("det-files-mode", id === "files");
      void renderSubTab(content, full, d, id, reload, nav);
    },
  });
  const selectSub = tabs.select;
  main.append(tabs.el, content);

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
  const requestBtn = propAddBtn("Request review", () => void doRequestReviewers(full.number));
  reviewersProp.body.appendChild(requestBtn);
  // GitHub drops a reviewer from `requestedReviewers` the moment they SUBMIT,
  // so this section listed only the people who had not answered yet — and told
  // you each of them had "not yet submitted". Anyone who had actually approved
  // or requested changes appeared nowhere in the rail at all, which is the one
  // question the rail exists to answer. The conversation carries their verdicts;
  // it is fetched through the cache the Conversation tab already fills, so this
  // costs nothing when that tab loads.
  void gget("pr:conversation", full.number, 30_000)
    .then((conv) => {
      if (!reviewersProp.body.isConnected) return;
      // Only a person's LATEST verdict counts — GitHub shows the same.
      const latest = new Map<string, string>();
      for (const c of conv) {
        if (c.kind !== "review" || !c.state) continue;
        const st = c.state.toUpperCase();
        if (st === "COMMENTED" || st === "DISMISSED") continue;
        latest.set(c.author, st);
      }
      if (!latest.size) return;
      const pending = new Set((full.requestedReviewers ?? []).map((r) => r.login));
      for (const [login, state] of latest) {
        if (pending.has(login)) continue; // still waiting on a re-review
        const approved = state === "APPROVED";
        const chip = personChip(login, `https://github.com/${login}.png`, () =>
          openPeek(memberCard({ login, avatarUrl: null, htmlUrl: `https://github.com/${login}` })),
        );
        chip.classList.add(approved ? "is-approved" : "is-blocking");
        chip.title = `@${login} — ${approved ? "approved" : "requested changes"}`;
        chip.append(glyph(approved ? "check" : "request-changes"));
        reviewersProp.body.insertBefore(chip, requestBtn);
      }
    })
    .catch(() => {
      /* offline — the requested reviewers above are still true */
    });

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
    // Humanised, like every other status in the app. This pill sat one column
    // from a Checks tab that says "Passed"/"Running" and read a raw lowercase
    // `success` / `pending`.
    c.textContent = checkStateLabel(d.checks);
    c.title = "Open the Checks tab";
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
  // GitHub caps the files response, so `d.files.length` is what we FETCHED —
  // it read "300" on a 412-file PR while the Files tab said something else.
  // `changedFiles` is the PR's own count; fall back only when it is absent.
  about.body.appendChild(
    fact(
      "Files changed",
      String(full.changedFiles ?? d.files.length),
      full.changedFiles != null && full.changedFiles !== d.files.length
        ? `${d.files.length} of ${full.changedFiles} loaded`
        : undefined,
    ),
  );
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
  nav: SectionNav,
): Promise<void> {
  content.replaceChildren(loadingState());
  // Who is reading, so a comment offers only what this account may do.
  const viewerLogin = await gget("github:status", undefined, 30_000)
    .then((st) => st.login)
    .catch(() => undefined);
  if (id === "conversation") {
    let conv: PrComment[] = [];
    let convFailed: unknown;
    try {
      conv = await gget("pr:conversation", full.number, 30_000);
    } catch (e) {
      // The description still renders, so this is not fatal — but a timeline
      // that silently stays empty is the app claiming the discussion is empty.
      // Said, not swallowed.
      convFailed = e;
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
          createdAt: full.createdAt,
          onQuote: (t) => quoteIntoPr(t, full.user?.login),
          // A pull request IS an issue to the reactions endpoint, so its body
          // reacts by PR number.
          onReact: (content, on) => void togglePrReaction("issue", full.number, content, on, reload),
        }),
      );
    }
    if (convFailed) {
      // Between the description and the composer, where the discussion would
      // have been — so it reads as "this part is missing", not as "there is
      // nothing here".
      timeline.appendChild(
        errorState(
          "Couldn't load the discussion",
          cleanErr(convFailed) || "GitHub request failed.",
          reload,
        ),
      );
    }
    for (const c of conv) {
      timeline.appendChild(
        commentCard(c.author, undefined, c.body, c.kind === "review" ? c.state : undefined, {
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          association: c.authorAssociation,
          reactions: c.reactions,
          // Only a plain comment: a REVIEW is a different object at a different
          // endpoint, and offering Edit on one would fail at the request.
          comment:
            c.kind === "comment" && c.id
              ? { id: c.id, htmlUrl: c.htmlUrl, mine: c.author === viewerLogin, reload }
              : undefined,
          onQuote: (t) => quoteIntoPr(t, c.author),
          onReact:
            c.kind === "comment" && c.id
              ? (content, on) => void togglePrReaction("comment", c.id!, content, on, reload)
              : undefined,
        }),
      );
    }
    if ((!full.body || !full.body.trim()) && conv.length === 0) {
      timeline.appendChild(emptyState("No conversation yet", "No description or comments on this PR."));
    }
    content.appendChild(timeline);

    // A real composer (not a prompt) — same pattern as the Issues detail.
    const composer = el("div", "gh-composer");
    // The same editor the issue composer and the New Issue form use — see the
    // note there. A PR reply is the single most-written box in this app and it
    // was the only one with no preview and no formatting.
    const ed = mdEditor({
      value: commentDrafts.get(draftKey(full.number)) ?? "",
      placeholder: "Leave a comment…",
      rows: 3,
      label: `Comment on pull request #${full.number}`,
      onInput: (v) => {
        if (v.trim()) commentDrafts.set(draftKey(full.number), v);
        else commentDrafts.delete(draftKey(full.number));
        syncSend();
      },
      onSubmit: () => {
        if (!send.disabled) send.click();
      },
    });
    const ta = ed.textarea;
    livePrComposer = ed;
    const crow = el("div", "gh-composer-actions");
    const send = el("button", "btn btn-primary") as HTMLButtonElement;
    send.append(glyph("comment"), span("Comment"));
    // An empty composer used to leave this button in full accent, and clicking
    // it answered with a toast telling you off. A button that cannot do
    // anything should look like it cannot do anything.
    const syncSend = (): void => {
      const ready = ed.get().trim().length > 0;
      send.disabled = !ready;
      send.title = ready ? "Post this comment" : "Write something first";
    };
    syncSend();
    send.addEventListener("click", () => void doComment(full.number, ta, send, reload));
    crow.appendChild(send);
    composer.append(ed.root, crow);
    content.appendChild(composer);
  } else if (id === "commits") {
    let commits;
    try {
      commits = await host.invoke("pr:commits", full.number);
    } catch (e) {
      if (activeSubTab !== id) return;
      // `reload` is in scope and was simply never passed, so a failed read had
      // no way back short of leaving the pull request and returning.
      content.replaceChildren(
        errorState("Couldn't load commits", cleanErr(e) || "GitHub request failed.", reload),
      );
      return;
    }
    if (activeSubTab !== id) return;
    content.replaceChildren();
    if (commits.length === 0) {
      content.appendChild(emptyState("No commits", "This PR has no commits yet."));
      return;
    }
    // The SHARED list — the same rows Compare draws, grouped by day, with the
    // author's face, the body behind a disclosure, a copyable sha and a badge
    // on a signed or a merge commit. Every one of those except the avatar was
    // already in this response and thrown away in the client mapper.
    content.appendChild(
      commitList(
        commits.map((c) => ({
          sha: c.sha,
          shortSha: c.shortSha,
          subject: c.message,
          body: c.body,
          author: c.author,
          login: c.login,
          avatarUrl: c.avatarUrl,
          date: c.date ? Math.floor(Date.parse(c.date) / 1000) : 0,
          verified: c.verified,
          isMerge: c.isMerge,
        })),
        {
          // The COMMIT, not the graph. This used to eject you out of the pull
          // request into a graph row that shows no files at all.
          onOpen: (sha) => nav("commit", { sha }),
          onCopy: (sha) => void copyText(sha, "Copied the full SHA."),
        },
      ),
    );
  } else if (id === "checks") {
    let checks;
    try {
      checks = await host.invoke("pr:checks", full.number);
    } catch (e) {
      if (activeSubTab !== id) return;
      content.replaceChildren(
        errorState("Couldn't load checks", cleanErr(e) || "GitHub request failed.", reload),
      );
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
      const dot = checkIcon(state);
      const name = el("span", "gh-check-name");
      name.textContent = c.name;
      const st = el("span", "gh-check-state");
      st.textContent = checkStateLabel(state);
      row.append(dot, name, st);
      if (c.detailsUrl) {
        // A row only claims to be clickable when there is somewhere to go. The
        // rest used to carry the same pointer cursor and hover as the linked
        // ones and swallow the click.
        row.classList.add("is-link");
        // A failing check is a question about a LOG, so a check that names a
        // job goes straight to that log's page — not to the run page, which
        // would put a list of jobs between you and the thing you clicked, and
        // would make Back mean "Actions" instead of the pull request you left.
        // External CI keeps the browser.
        const gha = /\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/.exec(c.detailsUrl);
        row.title = gha ? "Open the run's logs in-app" : "Open check details";
        row.addEventListener("click", () => {
          if (gha) {
            const jobId = gha[2] ? Number(gha[2]) : undefined;
            const runId = Number(gha[1]);
            if (jobId != null) sectionNav?.("joblog", { number: runId, jobId });
            else sectionNav?.("actions", { number: runId });
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

  // GitHub sends WORDS; the CSS and the reader both want git's letters. Taking
  // the first character collapses "removed" and "renamed" onto the same "R" —
  // so a deleted file and a moved one rendered identically, in the same amber,
  // on the one screen where telling them apart is the point. "changed" and
  // "copied" land on C and are equally wrong.
  const STATUS_LETTER: Record<string, string> = {
    added: "A",
    removed: "D",
    modified: "M",
    renamed: "R",
    copied: "C",
    changed: "M",
    unchanged: "M",
  };
  // The directory every changed file shares, shown ONCE above the list.
  //
  // The row already leads with the filename and trails the directory, but the
  // directory is left-truncated by CSS — so nine files under one folder gave
  // three different elisions of the same prefix ("…src/renderer/views",
  // "…rc/renderer/views", "…top/src/renderer") and no way to tell whether two
  // rows were even in the same place. Folding the shared part leaves the
  // distinguishing part short enough to show whole.
  const shared = commonDir(files.map((f) => f.filename));
  if (shared) {
    const head = el("div", "pr-files-prefix");
    head.append(glyph("folder"), span(shared));
    head.title = `Every file in this pull request is under ${shared}`;
    list.appendChild(head);
  }

  for (const f of files) {
    const letter = STATUS_LETTER[f.status.toLowerCase()] ?? f.status.charAt(0).toUpperCase();
    const row = el("button", `file-row status-${letter}`);
    (row as HTMLButtonElement).type = "button";
    const st = el("span", "file-status");
    st.textContent = letter;
    // Lead with the FILE NAME and trail the directory, the way Changes and
    // Compare already do. This list showed one raw rtl-truncated path per row,
    // so in a 268px column every row read "…/components/" and the name you were
    // actually looking for was the part that got cut.
    const rest = f.filename.slice(shared.length);
    const cut = rest.lastIndexOf("/");
    const meta = el("span", "dc-file-meta");
    meta.appendChild(span(cut < 0 ? rest : rest.slice(cut + 1), "dc-file-name"));
    if (cut > 0) meta.appendChild(span(rest.slice(0, cut), "dc-file-dir"));
    // The FULL path in the tooltip, including the folded prefix — the header
    // says where you are, but a row still has to be able to answer on its own.
    meta.title = f.previousFilename
      ? `${f.previousFilename} → ${f.filename}`
      : f.filename;
    const adds = el("span", "gh-adds");
    adds.textContent = `+${f.additions} −${f.deletions}`;
    row.append(st, meta, adds);
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
  // The diff arrives over the network. `new DiffPanel(surface)` paints NOTHING,
  // so the pane sat blank for the whole round trip — and every guard below is a
  // bare `if (prDiffPanel !== panel) return`, so anything that superseded this
  // open left the blank there permanently, with no message. Say what is
  // happening from the first frame.
  panel.showEmpty(`Loading ${f.filename}…`, { title: "Reading the diff", kind: "waiting" });
  watchDiffDetach(surface, panel);

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
    panel.showEmpty(cleanErr(e) || "GitHub did not return this file's diff.", { kind: "error" });
    threadsSlot.replaceChildren();
    return;
  }
  if (prDiffPanel !== panel) return; // a newer file was opened mid-fetch
  if (!diff) {
    panel.showEmpty("GitHub reports no textual changes in this file.", { kind: "none" });
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

  // The panel FOLDS. It used to take 42% of the pane unconditionally, so the
  // diff — the reason the Files tab exists — got 354px of a 913px window even
  // on a file with nothing to discuss. It opens by itself when this file has an
  // unresolved thread, which is the case where the comment is the point.
  const unresolved = mine.filter((t) => !t.isResolved).length;
  const open = unresolved > 0;
  slot.classList.toggle("is-open", open);

  const head = el("button", "pr-threads-head") as HTMLButtonElement;
  head.setAttribute("aria-expanded", String(open));
  const chevron = glyph(open ? "chevron-down" : "chevron-right");
  const title = span(
    mine.length === 0
      ? "No comments on this file"
      : unresolved
        ? `Review comments (${unresolved} open of ${mine.length})`
        : `Review comments (${mine.length}, all resolved)`,
    "pr-threads-title",
  );
  head.append(chevron, glyph("comment-discussion"), title);
  head.title = open ? "Hide the review comments" : "Show the review comments";
  slot.appendChild(head);

  const bodyEl = el("div", "pr-threads-body");
  bodyEl.hidden = !open;
  const addBtn = el("button", "mini-btn pr-threads-add");
  addBtn.append(glyph("comment"), span("Add a comment"));
  addBtn.title = "Comment on a line of this file";
  addBtn.addEventListener("click", () => void addInlineComment(full.number, f.filename, addBtn, reloadFile));
  const tools = el("div", "pr-threads-tools");
  tools.appendChild(addBtn);
  bodyEl.appendChild(tools);

  head.addEventListener("click", () => {
    const now = bodyEl.hidden === true;
    bodyEl.hidden = !now;
    slot.classList.toggle("is-open", now);
    head.setAttribute("aria-expanded", String(now));
    head.title = now ? "Hide the review comments" : "Show the review comments";
    head.replaceChildren(glyph(now ? "chevron-down" : "chevron-right"), glyph("comment-discussion"), title);
  });

  if (mine.length === 0) {
    const none = el("div", "pr-threads-empty");
    none.textContent = "No inline comments on this file yet.";
    bodyEl.appendChild(none);
  } else {
    for (const t of mine) bodyEl.appendChild(threadCard(full.number, t, reloadFile));
  }
  slot.appendChild(bodyEl);
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
  ta.value = replyDrafts.get(t.id) ?? "";
  ta.addEventListener("input", () => {
    if (ta.value.trim()) replyDrafts.set(t.id, ta.value);
    else replyDrafts.delete(t.id);
  });
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
  extra: {
    association?: string;
    reactions?: ReactionSummary;
    createdAt?: string;
    updatedAt?: string;
    /** A plain comment can be edited, deleted, quoted and linked, exactly as on
     *  an issue — it is the same object at the same endpoint. A REVIEW cannot:
     *  different object, different endpoint, and the view offers less rather
     *  than offering something that would fail. */
    comment?: { id: number; htmlUrl?: string; mine: boolean; reload: () => void };
    onQuote?: (body: string) => void;
    onReact?: (content: ReactionContent, on: boolean) => void;
  } = {},
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
  // The conversation carried NO time at all — a wall of comments with no way to
  // tell a reply from last October from one posted an hour ago.
  if (extra.createdAt) {
    const when = span(relTimeISO(extra.createdAt), "gh-comment-when");
    when.title = absTimeISO(extra.createdAt);
    hd.appendChild(when);
  }
  // A comment edited after posting is a different artifact from what people
  // replied to. The issue thread has said so for a while; this one did not.
  if (extra.updatedAt && extra.createdAt && extra.updatedAt !== extra.createdAt) {
    const ed = span("edited", "gh-comment-edited");
    ed.title = `Edited ${absTimeISO(extra.updatedAt)}`;
    hd.appendChild(ed);
  }
  if (extra.comment || extra.onQuote) {
    hd.appendChild(el("span", "gh-comment-spring"));
    const more = el("button", "mini-btn gh-icon-btn gh-comment-menu");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-label", `Actions for ${author}'s comment`);
    more.appendChild(glyph("ellipsis"));
    more.addEventListener("click", () => {
      const items: Array<{ label: string; icon?: string; danger?: boolean; onClick: () => void }> = [];
      if (extra.onQuote) items.push({ label: "Quote reply", icon: "quote", onClick: () => extra.onQuote?.(body) });
      const c = extra.comment;
      if (c?.htmlUrl) {
        items.push({ label: "Copy link", icon: "link", onClick: () => void navigator.clipboard?.writeText(c.htmlUrl!) });
      }
      // Yours only — see the note on the issue side. Offering Edit on somebody
      // else's comment buys a 403 at Save and a confirm dialog for a delete
      // that cannot happen.
      if (c && c.mine) {
        items.push({ label: "Edit", icon: "edit", onClick: () => void editPrComment(c.id, body, card, c.reload) });
        items.push({
          label: "Delete…",
          icon: "trash",
          danger: true,
          onClick: () => void deletePrComment(c.id, c.reload),
        });
      }
      openMenu(more, items);
    });
    hd.appendChild(more);
  }
  card.appendChild(hd);
  if (body && body.trim()) {
    const bd = el("div", "gh-body-md");
    bd.innerHTML = renderMarkdown(body);
    card.appendChild(bd);
  }
  const reactions = reactionRow(extra.reactions, extra.onReact);
  if (reactions) card.appendChild(reactions);
  return card;
}

/** The reply box on screen, so Quote reply has somewhere to land. */
let livePrComposer: { get(): string; set(v: string): void; focus(): void } | undefined;

function quoteIntoPr(body: string, author?: string | null): void {
  if (!livePrComposer) return;
  const quoted = body
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const prefix = author ? `@${author} said:\n` : "";
  const existing = livePrComposer.get().trim();
  livePrComposer.set(`${existing ? `${existing}\n\n` : ""}${prefix}${quoted}\n\n`);
  livePrComposer.focus();
}

/** Edit in place — the same gesture, the same endpoint, as on an issue. */
async function editPrComment(id: number, body: string, card: HTMLElement, reload: () => void): Promise<void> {
  const bd = card.querySelector<HTMLElement>(".gh-body-md");
  if (!bd) return;
  const was = bd.innerHTML;
  const ed = mdEditor({ value: body, rows: 6, label: "Edit comment" });
  const row = el("div", "gh-composer-actions");
  const save = el("button", "btn btn-primary") as HTMLButtonElement;
  save.textContent = "Save";
  const cancel = el("button", "mini-btn");
  cancel.textContent = "Cancel";
  row.append(save, cancel);
  const wrap = el("div", "gh-comment-edit");
  wrap.append(ed.root, row);
  bd.replaceChildren(wrap);
  ed.focus();
  cancel.addEventListener("click", () => {
    bd.innerHTML = was;
  });
  save.addEventListener("click", async () => {
    const next = ed.get().trim();
    if (!next) {
      toast("A comment cannot be empty — delete it instead.", "info");
      return;
    }
    save.disabled = true;
    try {
      const r = await host.invoke("issue:editComment", { id, body: next });
      if (!r.ok) {
        toast(r.message ?? "Couldn’t save the edit.", "error");
        save.disabled = false;
        return;
      }
      toast("Comment updated.", "success");
      reload();
    } catch (e) {
      toast(cleanErr(e) || "Couldn’t save the edit.", "error");
      save.disabled = false;
    }
  });
}

async function deletePrComment(id: number, reload: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: "Delete this comment?",
    message: "It will be removed from the pull request on GitHub. This cannot be undone.",
    confirmLabel: "Delete comment",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await host.invoke("issue:deleteComment", id);
    if (!r.ok) {
      toast(r.message ?? "Couldn’t delete the comment.", "error");
      return;
    }
    toast("Comment deleted.", "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn’t delete the comment.", "error");
  }
}

/** Add or remove one of your reactions on a PR or one of its comments. */
async function togglePrReaction(
  subject: "issue" | "comment",
  id: number,
  content: ReactionContent,
  on: boolean,
  reload: () => void,
): Promise<void> {
  try {
    const r = await host.invoke("issue:react", { subject, id, content, on });
    if (!r.ok) {
      toast(r.message ?? "Couldn’t change the reaction.", "error");
      return;
    }
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn’t change the reaction.", "error");
  }
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
  // A review is the longest thing anyone writes in this app, and it used to be
  // collected, the card closed, and only THEN sent — so a rejected submit
  // answered several paragraphs of considered feedback with a toast over an
  // empty screen, with no way back to the text. `formWithRetry` re-opens the
  // card carrying exactly what was written, and says why inside it.
  (btn as HTMLButtonElement).disabled = true;
  try {
    await formWithRetry<{ event: PrReviewEvent; body: string }>(
      (seed, error) => reviewModal(n, seed?.event ?? event, seed?.body ?? "", error),
      async (choice) => {
        try {
          const r = await host.invoke("pr:review", {
            number: n,
            event: choice.event,
            body: choice.body || undefined,
          });
          if (!r.ok) return r.message ?? "Couldn't submit the review.";
        } catch (e) {
          return cleanErr(e) || "Couldn't submit the review.";
        }
        toast(`Review submitted on PR #${n}.`, "success");
        reload();
        return undefined;
      },
    );
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
  initialBody = "",
  error?: string,
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
      ta.value = initialBody;
      card.appendChild(ta);
      // Why the last attempt failed, shown WITH the text it failed on — a toast
      // over a closed card told you nothing you could act on.
      if (error) {
        const note = el("div", "modal-note-error");
        note.textContent = error;
        card.appendChild(note);
      }

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
        // A route change (a window focus counts) must not take a written review.
        hasUnsavedWork: () => ta.value.trim() !== initialBody.trim(),
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
    commentDrafts.delete(draftKey(n));
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

/*
 * `doEdit` used to open `editForm` here: a modal with a title box and a body
 * box, and — unlike the issue form — no draft, so Escape took everything
 * written. It is `views/issueCompose.ts` now, routed as "predit".
 */


/** A toggle-menu of the repo's labels (current ones checked) → pr:setLabels. */
async function doLabels(anchor: HTMLElement, pr: PullRequest, reload: () => void): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await gget("pr:labels", undefined, 60000);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load labels.", "error");
    return;
  }
  // Optional-chained, but only as belt and braces: in the app `pr:labels` goes
  // through `withRepo`, which either returns the handler's array or throws an
  // ExpectedError — it cannot resolve undefined. It was the HARNESS that had no
  // fixture for this channel and answered undefined, so reading `.length` threw
  // into the unhandled-rejection boundary and the picker could not be opened in
  // a test at all. Which is why the real defect below — a request fired per
  // tick — had never been checked.
  if (!repoLabels?.length) {
    toast("This repo has no labels defined.", "info");
    return;
  }
  // The SAME control as the issue's, which it was not: because these items were
  // plain (not `checkable`), openMenu took the close-then-act path, so every
  // tick closed the menu and fired its own request. Labelling something with
  // three labels meant reopening the picker three times and writing three
  // times. Ticks are batched here too, sent once on close — and Escape
  // discards, the way Escape does everywhere else.
  const before = new Set(pr.labels.map((l) => l.name));
  const picked = new Set(before);
  openMenu(
    anchor,
    repoLabels.map((l) => ({
      label: l.name,
      iconEl: swatch(l.color),
      checkable: true,
      current: picked.has(l.name),
      onClick: () => {
        if (picked.has(l.name)) picked.delete(l.name);
        else picked.add(l.name);
      },
    })),
    {
      searchable: repoLabels.length > 8,
      onClose: (reason) => {
        if (reason === "escape") return;
        const same = picked.size === before.size && [...picked].every((x) => before.has(x));
        if (!same) void applyLabels(pr, [...picked], reload);
      },
    },
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
    // Spent, and only now — a failed post keeps the text for the retry.
    replyDrafts.delete(threadId);
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
