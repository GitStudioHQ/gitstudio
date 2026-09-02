// Issues — the repo-scoped GitHub Issues section, on the section-page system
// (docs/desktop-redesign.md): a full-width list page whose rows navigate to a
// full-page detail (routed via `target.number`, so ⌘[/Esc walk back like a
// browser), with the issue's properties in an inline-editable right rail.
//
// Self-contained: it renders into the `wrap` it's handed and re-renders through
// the section router. Every mutation disables its trigger, toasts the result,
// busts the SWR cache and re-fetches so the UI stays authoritative.

import { host } from "../bridge";
import { peek as cachePeek, gget, bust, cacheScope } from "../cache";
import {
  avatar,
  cleanErr,
  el,
  emptyState,
  errorState,
  glyph,
  labelChip,
  openMenu,
  relTimeISO,
  absTimeISO,
  skeletonList,
  span,
  statBit,
  issueStateKind,
  stateLead,
  statePill,
} from "../ui";
import { confirmDialog, promptInline, toast, formWithRetry} from "../dialogs";
import { renderMarkdown } from "../markdown";
import { wireProseNav } from "../proseNav";
import { openPeek } from "../peek";
import { memberCard } from "./orgs";
import { aiChip, openAssistantTab, streamInto, aiEnabled } from "../aiAssist";
import {
  associationBadge,
  blankable,
  facetBar,
  harvestValues,
  segmented,
  swatch,
  type FacetSpec,
  type FacetState,
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
import type {
  IssueDetail,
  IssueInfo,
  MilestoneInfo,
  ReactionSummary,
  RepoCollaborator,
  RepoLabel,
} from "../../shared/ipc";

// ── Section state (module-level so it survives list ⇄ detail round trips) ────

let issueState: "open" | "closed" | "all" = "open";
/** Client-side facets over the loaded list (shared facetBar vocabulary). */
const issueFacets: FacetState = {};
/** The live text query — kept so Back from a detail restores the search. */
let query = "";
/**
 * Unsent comment drafts, per issue — navigating away must never eat one.
 *
 * Keyed by REPO and number. Keyed by number alone, a draft written on issue #31
 * in one repository was handed to issue #31 in the next one you opened —
 * pre-filled into its composer, ready to send to strangers. Numbers collide
 * across repos constantly; the low ones always do.
 */
const commentDrafts = new Map<string, string>();
const draftKey = (n: number): string => `${cacheScope()}#${n}`;

// ── Small DOM builders ───────────────────────────────────────────────────────

/** One timeline card: the issue body (first) or a comment. Markdown body. */
function commentCard(
  author: string,
  action: string,
  body: string,
  createdAt: string,
  extra: {
    /** Later than createdAt ⇒ show an "edited" marker, like GitHub. */
    updatedAt?: string;
    association?: string;
    reactions?: ReactionSummary;
  } = {},
): HTMLElement {
  const card = el("div", "gh-comment");
  const hd = el("div", "gh-comment-head");
  const who = el("span", "gh-comment-author");
  who.append(avatar(author, `https://github.com/${author}.png`, 18), span(author));
  hd.append(who);
  const badge = associationBadge(extra.association);
  if (badge) hd.appendChild(badge);
  // "3 days ago" alone cannot answer "before or after the release?" — the exact
  // time is one hover away rather than nowhere.
  const when = span(`${action} · ${relTimeISO(createdAt)}`, "gh-comment-when");
  when.title = absTimeISO(createdAt);
  hd.appendChild(when);
  // A comment edited after posting is a different artifact from what people
  // replied to — GitHub says so, and silence here has burned readers.
  if (extra.updatedAt && extra.updatedAt !== createdAt) {
    const ed = span("edited", "gh-comment-edited");
    ed.title = `Edited ${absTimeISO(extra.updatedAt)}`;
    hd.appendChild(ed);
  }
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
  const reactions = reactionRow(extra.reactions);
  if (reactions) card.appendChild(reactions);
  return card;
}

// ── The section view ─────────────────────────────────────────────────────────

/** The section's router, so a detail page nested inside it can leave for
 *  another view — the issue composer is a page of its own now, not a modal. */
let sectionNav: SectionNav | undefined;

export const renderIssues: SectionRender = (wrap, nav, target) => {
  sectionNav = nav;
  void mount(wrap, nav, target);
};

async function mount(wrap: HTMLElement, nav: SectionNav, target?: SectionTarget): Promise<void> {
  const refresh = (): void => {
    bust("issue");
    renderIssues(wrap, nav, target);
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
    bust("issue");
    renderIssues(wrap, nav);
  };

  const { view, listEl } = sectionList();
  const header = ghHeader("Issues", gate.login, refresh);

  // Toolbar: state segment · facets · New Issue (search rides in the titlewrap).
  const tools = el("div", "gh-head-tools");
  const seg = segmented<"open" | "closed" | "all">({
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
      { value: "all", label: "All" },
    ],
    value: issueState,
    ariaLabel: "Issue state",
    onChange: (v) => {
      issueState = v;
      renderIssues(wrap, nav);
    },
  });

  const facetSlot = el("div", "gh-facet-slot");
  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("add"), span("New issue"));
  newBtn.addEventListener("click", () => nav("issuenew"));
  tools.append(seg, facetSlot, newBtn);
  header.querySelector(".gh-acct")?.before(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  // ── data: paint from cache instantly, revalidate in the background ──
  let issues: IssueInfo[] | undefined = cachePeek("issue:list", { state: issueState });
  if (!issues) listEl.replaceChildren(skeletonList(6));

  const buildRow = (it: IssueInfo): HTMLElement => {
    // One order across every list: who wrote it, who owns it, then the counts.
    const meta: HTMLElement[] = [];
    if (it.user) meta.push(avatarStack([it.user], 1, 18, "Author"));
    // Reserved even when empty, so the author avatar keeps its column on rows
    // that happen to have no assignee.
    meta.push(blankable(avatarStack(it.assignees, 3, 18, "Assignee"), it.assignees.length > 0));
    // Rendered even at zero (blanked, not omitted): the meta cluster packs
    // right-to-left, so an absent count used to slide the avatars into the
    // column where every other row shows its comments.
    meta.push(blankable(statBit("comment", it.comments), it.comments > 0));
    const row = secRow({
      lead: stateLead(issueStateKind(it.state, it.stateReason)),
      num: `#${it.number}`,
      title: it.title,
      // The leading slash-circle icon already says "not planned" two glyphs
      // away; a pill repeating it was the same fact twice on one row. The icon
      // carries the words in its tooltip instead.
      titleSuffix: [],
      chips: it.labels.map((l) => labelChip(l.name, l.color)),
      meta,
      // The list arrives sorted by LAST UPDATED, so the date column has to be
      // the updated date. It showed — and its tooltip labelled — the CREATED
      // date, which made the order look arbitrary: a two-year-old issue
      // commented on this morning sat at the top reading "opened 2 years ago".
      // Both dates are in the tooltip; only one can be the sorted column.
      time: relTimeISO(it.updatedAt),
      timeTitle: it.updatedAt
        ? `Updated ${absTimeISO(it.updatedAt)}` +
          (it.createdAt ? `\nOpened ${absTimeISO(it.createdAt)}` : "")
        : undefined,
      ariaLabel: `Issue #${it.number}: ${it.title}`,
      onOpen: () => nav("issues", { number: it.number }),
    });
    row.dataset.num = String(it.number);
    return row;
  };

  const matches = (it: IssueInfo, q: string): boolean => {
    const hay = `${it.title} #${it.number} ${it.user?.login ?? ""} ${it.labels
      .map((l) => l.name)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  };
  const passesFacets = (it: IssueInfo): boolean => facets.passes(it);
  const facetsActive = (): boolean => facets.activeCount() > 0;

  const renderList = (): void => {
    if (!issues) return;
    // Re-harvest before painting: the bar is built before the first fetch
    // lands, and a facet menu that offers nothing is worse than no facet.
    facets.sync(issues);
    const q = query.toLowerCase();
    const items = issues.filter((it) => passesFacets(it) && (q ? matches(it, q) : true));
    header.setCount?.(items.length, issues.length);
    listEl.replaceChildren();
    if (issues.length === 0) {
      const emptyCopy: Record<typeof issueState, { title: string; desc: string; icon: string }> = {
        open: {
          title: "No open issues",
          desc: "You're all caught up — there's nothing open to triage right now.",
          icon: "issue-opened",
        },
        closed: {
          title: "No closed issues",
          desc: "Closed issues will show here once you close some.",
          icon: "issue-closed",
        },
        all: {
          title: "No issues yet",
          desc: "This repo has no issues. Open the first one to start tracking work.",
          icon: "issue-opened",
        },
      };
      const c = emptyCopy[issueState];
      listEl.appendChild(
        emptyState(
          c.title,
          c.desc,
          issueState === "closed"
            ? { icon: c.icon }
            : {
                icon: c.icon,
                action: { label: "New issue", icon: "add", onClick: () => nav("issuenew") },
              },
        ),
      );
      return;
    }
    if (items.length === 0) {
      const desc = query ? `Nothing matches “${query}”.` : "No issues match the active filters.";
      listEl.appendChild(
        emptyState("No matching issues", desc, {
          icon: "search",
          anchor: "inline",
          secondary:
            facets.activeCount() > 0
              ? { label: "Clear filters", icon: "clear-all", onClick: () => facets.clear() }
              : undefined,
        }),
      );
      return;
    }
    for (const it of items) listEl.appendChild(buildRow(it));
    const cap = capNotice(issues.length, LIST_CAPS.issues);
    if (cap) listEl.appendChild(cap);
  };

  // ── facets: one shared bar (label / assignee / milestone / author / reason) ──
  // Repo labels are fetched so the menu can offer labels no loaded issue uses;
  // everything else is harvested from what's on screen, which is honest —
  // these are CLIENT-side facets over the fetched page.
  let repoLabels: RepoLabel[] = [];
  void gget("issue:labels", undefined, 60000)
    .then((ls) => {
      repoLabels = ls;
      facets.sync(issues ?? []);
    })
    .catch(() => {
      /* best-effort — the label facet falls back to in-list label names */
    });

  // Only meaningful for closed issues, so it is left out entirely on the Open
  // tab rather than offered as a filter that can only ever match zero rows.
  const closedReasonSpec: FacetSpec<IssueInfo> = {
    key: "reason",
    label: "Closed as",
    icon: "circle-slash",
    anyLabel: "Any reason",
    options: [
      { value: "completed", label: "Completed", icon: "issue-closed" },
      { value: "not_planned", label: "Not planned", icon: "circle-slash" },
    ],
    predicate: (it, v) =>
      v === "completed"
        ? it.state === "closed" && it.stateReason !== "not_planned"
        : it.stateReason === "not_planned",
  };

  const facets = facetBar<IssueInfo>({
    specs: [
      {
        key: "label",
        label: "Label",
        icon: "tag",
        anyLabel: "All labels",
        harvest: (items) => {
          const seen = new Map<string, string>();
          for (const l of repoLabels) seen.set(l.name, l.color);
          for (const it of items) for (const l of it.labels) if (!seen.has(l.name)) seen.set(l.name, l.color);
          return [...seen].map(([name, color]) => ({ value: name, iconEl: () => swatch(color) }));
        },
        predicate: (it, v) => it.labels.some((l) => l.name === v),
      },
      {
        key: "assignee",
        label: "Assignee",
        icon: "person",
        anyLabel: "Anyone",
        harvest: (items) => {
          const seen = new Map<string, string | null>();
          for (const it of items) for (const a of it.assignees) if (!seen.has(a.login)) seen.set(a.login, a.avatarUrl);
          return [...seen].map(([login, avatarUrl]) => ({
            value: login,
            label: `@${login}`,
            iconEl: () => avatar(login, avatarUrl, 18),
          }));
        },
        predicate: (it, v) => it.assignees.some((a) => a.login === v),
      },
      {
        key: "milestone",
        label: "Milestone",
        icon: "milestone",
        anyLabel: "Any milestone",
        harvest: harvestValues<IssueInfo>((it) => it.milestone?.title),
        predicate: (it, v) => it.milestone?.title === v,
      },
      {
        key: "author",
        label: "Author",
        icon: "account",
        anyLabel: "Anyone",
        harvest: (items) => {
          const seen = new Map<string, string | null>();
          for (const it of items) if (it.user && !seen.has(it.user.login)) seen.set(it.user.login, it.user.avatarUrl);
          return [...seen].map(([login, avatarUrl]) => ({
            value: login,
            label: `@${login}`,
            iconEl: () => avatar(login, avatarUrl, 18),
          }));
        },
        predicate: (it, v) => it.user?.login === v,
      },
      // Only meaningful for closed issues, so it is hidden entirely on the Open
      // tab rather than offered there as a filter that can only ever match zero
      // rows. GitHub calls this "closed as"; "Reason" said nothing next to the
      // Open/Closed/All segment.
      ...(issueState === "open" ? [] : [closedReasonSpec]),
    ],
    state: issueFacets,
    items: issues ?? [],
    onChange: () => renderList(),
  });
  facetSlot.replaceChildren(facets.el);

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: "Search issues…",
      initial: query,
      onInput: (q) => {
        query = q;
        renderList();
      },
    }),
  );

  if (issues) renderList(); // instant paint from cache

  try {
    const fresh = await gget("issue:list", { state: issueState }, 15000);
    if (!view.isConnected) return;
    issues = fresh;
    renderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!issues) {
      listEl.replaceChildren(
        errorState("Couldn't load issues", cleanErr(e) || "GitHub request failed.", refresh),
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
  // Back goes where you CAME from. Inbox and My Work both open items that live
  // in this section, so without this the bar read "← Issues", the rail
  // switched under you, and Escape dropped you in a list you had never opened.
  const back = (): void => nav(from?.view ?? "issues", { list: true });
  const reload = (): void => {
    bust("issue");
    showDetailPage(wrap, nav, n, from);
  };

  const { view, main, rail, topActions } = detailPage({
    backLabel: from?.label ?? "Issues",
    crumb: `#${n}`,
    pageLabel: `Issue #${n}`,
    onBack: back,
  });
  main.appendChild(skeletonList(4, false));
  wrap.replaceChildren(view);

  void (async () => {
    let d: IssueDetail | undefined;
    try {
      d = await gget("issue:detail", n, 8000);
    } catch (e) {
      if (!view.isConnected) return;
      main.replaceChildren(
        errorState("Couldn't load issue", cleanErr(e) || "GitHub request failed.", reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!d) {
      main.replaceChildren(emptyState("Issue unavailable", "This issue couldn't be loaded."));
      return;
    }
    buildDetail({ main, rail, topActions, d, nav, reload });
  })();
}

/**
 * Render a single issue's full detail into any container — used by the Projects
 * board's slide-over drawer, so you never leave the board to read or reply to
 * one. The drawer has no rail: properties render as a compact inline strip.
 */
export async function renderIssueDetailInto(
  container: HTMLElement,
  number: number,
  nav: SectionNav,
  /** Called whenever something in here CHANGED the issue — closing it,
   *  relabelling it, assigning it. The Projects board hosts this detail in a
   *  drawer, and the card behind the drawer went on reading "open" after the
   *  issue was closed in front of it, because nothing told the board. */
  onMutated?: () => void,
): Promise<void> {
  const reload = (): void => {
    bust("issue");
    onMutated?.();
    void renderIssueDetailInto(container, number, nav, onMutated);
  };
  container.replaceChildren(skeletonList(4, false));
  let d: IssueDetail | undefined;
  try {
    d = await gget("issue:detail", number, 8000);
  } catch (e) {
    container.replaceChildren(
      errorState("Couldn't load issue", cleanErr(e) || "GitHub request failed.", reload),
    );
    return;
  }
  if (!container.isConnected) return;
  if (!d) {
    container.replaceChildren(emptyState("Issue unavailable", "This issue couldn't be loaded."));
    return;
  }
  const main = el("div", "det-main det-main-drawer");
  container.replaceChildren(main);
  buildDetail({ main, rail: null, topActions: null, d, nav, reload });
}

interface DetailCtx {
  main: HTMLElement;
  /** null = drawer variant (compact inline props instead of the rail). */
  rail: HTMLElement | null;
  /** null = drawer variant (actions render above the title instead). */
  topActions: HTMLElement | null;
  d: IssueDetail;
  nav: SectionNav;
  reload: () => void;
}

function buildDetail(ctx: DetailCtx): void {
  const { main, rail, d, nav, reload } = ctx;
  const it = d.issue;
  main.replaceChildren();
  rail?.replaceChildren();

  // Bounded AI context (issue + most-recent comments).
  const aiCtx = (): string => {
    const MAX_COMMENTS = 20;
    const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s);
    const recent = d.comments.slice(-MAX_COMMENTS);
    const omitted = d.comments.length - recent.length;
    const comments = recent.map((c) => `${c.author?.login ?? "?"}: ${clip(c.body, 1500)}`).join("\n\n");
    const omittedNote = omitted > 0 ? `(${omitted} earlier comment${omitted === 1 ? "" : "s"} omitted)\n\n` : "";
    return `Issue: ${it.title}\n\n${clip(it.body ?? "", 4000)}${comments ? `\n\nComments:\n${omittedNote}${comments}` : ""}`;
  };

  // ── action cluster (detail top bar; drawer renders it above the title) ──
  const actions: HTMLElement[] = [];

  const analyzeBtn = el("button", "mini-btn ai-mini");
  analyzeBtn.hidden = true;
  analyzeBtn.append(glyph("sparkle"), span("Analyze"));
  analyzeBtn.addEventListener("click", () =>
    openAssistantTab({
      title: `Analyze #${it.number}`,
      goal: `Analyze this GitHub issue. Summarize the problem, the likely root cause, and a concrete suggested approach. Be concise and use Markdown.\n\n${aiCtx()}`,
      nav,
    }),
  );
  void aiEnabled().then((ok) => (analyzeBtn.hidden = !ok));
  actions.push(analyzeBtn);

  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("edit"), span("Edit"));
  editBtn.addEventListener("click", () => sectionNav?.("issuenew", { number: it.number }));
  actions.push(editBtn);

  const closing = it.state === "open";
  const stateBtn = el("button", closing ? "btn btn-primary" : "mini-btn");
  stateBtn.append(glyph(closing ? "issue-closed" : "issue-opened"), span(closing ? "Close issue" : "Reopen"));
  stateBtn.addEventListener("click", () =>
    void changeState(it.number, closing ? "closed" : "open", stateBtn, reload),
  );
  actions.push(stateBtn);

  // The de-emphasized escape hatch: everything above is doable in-app.
  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = "Open this issue on GitHub";
  openBtn.setAttribute("aria-label", openBtn.title);
  openBtn.addEventListener("click", () => window.open(it.htmlUrl, "_blank"));
  actions.push(openBtn);

  if (ctx.topActions) {
    ctx.topActions.replaceChildren(...actions);
  } else {
    const bar = el("div", "det-tb-actions det-drawer-actions");
    bar.append(...actions);
    main.appendChild(bar);
  }

  // ── title block ──
  const titleRow = el("div", "det-title-row");
  const stKind = issueStateKind(it.state, it.stateReason);
  titleRow.appendChild(
    statePill(
      stKind === "open" ? "Open" : stKind === "not-planned" ? "Closed as not planned" : "Closed",
      stKind,
    ),
  );
  const h = el("h1", "det-title");
  h.append(span(it.title), span(`  #${it.number}`, "det-title-num"));
  titleRow.appendChild(h);
  main.appendChild(titleRow);

  const sub = el("div", "det-sub");
  const author = it.user?.login;
  if (author) {
    const chip = el("button", "gh-meta-author");
    chip.append(avatar(author, it.user?.avatarUrl ?? null, 18), span(author));
    chip.title = `View @${author}'s profile`;
    chip.addEventListener("click", () =>
      openPeek(memberCard({ login: author, avatarUrl: it.user?.avatarUrl ?? null, htmlUrl: `https://github.com/${author}` })),
    );
    sub.appendChild(chip);
  }
  const subText = el("span");
  subText.textContent = `opened ${relTimeISO(it.createdAt)} · ${it.comments} comment${it.comments === 1 ? "" : "s"}`;
  subText.title = absTimeISO(it.createdAt);
  sub.appendChild(subText);
  main.appendChild(sub);

  // ── properties (rail on the page; inline strip in the drawer) ──
  const labelsEdit = (anchor: HTMLElement): void => void labelsMenu(anchor, it, reload);
  const assigneesEdit = (): void => void editAssignees(it, d.assignees, reload);
  const milestoneEdit = (anchor: HTMLElement): void => void milestoneMenu(anchor, it, reload);

  if (rail) {
    const assignProp = propSection("Assignees", { onEdit: assigneesEdit, editTitle: "Edit assignees" });
    if (d.assignees.length) {
      const byLogin = new Map(it.assignees.map((a) => [a.login, a]));
      for (const login of d.assignees) {
        assignProp.body.appendChild(
          personChip(login, byLogin.get(login)?.avatarUrl, () =>
            openPeek(memberCard({ login, avatarUrl: byLogin.get(login)?.avatarUrl ?? null, htmlUrl: `https://github.com/${login}` })),
          ),
        );
      }
    } else {
      assignProp.body.appendChild(propAddBtn("Assign", assigneesEdit));
    }

    const labelProp = propSection("Labels", { onEdit: labelsEdit, editTitle: "Edit labels" });
    if (it.labels.length) {
      for (const l of it.labels) labelProp.body.appendChild(labelChip(l.name, l.color));
    } else {
      labelProp.body.appendChild(propAddBtn("Add labels", () => labelsEdit(labelProp.root)));
    }

    // Who closed it, when, and WHY — the three questions a closed issue raises
    // and the app used to answer with silence.
    if (it.state === "closed" && (it.closedBy || it.closedAt)) {
      const closedProp = propSection(
        it.stateReason === "not_planned" ? "Closed as not planned" : "Closed",
      );
      const cb = it.closedBy;
      if (cb) {
        closedProp.body.appendChild(
          personChip(cb.login, cb.avatarUrl, () =>
            openPeek(memberCard({ login: cb.login, avatarUrl: cb.avatarUrl, htmlUrl: `https://github.com/${cb.login}` })),
          ),
        );
      }
      if (it.closedAt) {
        const when = span(relTimeISO(it.closedAt), "det-prop-when");
        when.title = absTimeISO(it.closedAt);
        closedProp.body.appendChild(when);
      }
      rail.appendChild(closedProp.root);
    }

    const msProp = propSection("Milestone", { onEdit: milestoneEdit, editTitle: "Set milestone" });
    if (it.milestone) {
      const m = el("span", "det-milestone");
      m.append(glyph("milestone"), span(it.milestone.title));
      msProp.body.appendChild(m);
    } else {
      msProp.body.appendChild(propAddBtn("Set milestone", () => milestoneEdit(msProp.root)));
    }

    const about = propSection("About");
    const fact = (k: string, iso: string): HTMLElement => {
      const row = el("div", "det-fact");
      const v = el("span", "det-fact-v");
      v.textContent = relTimeISO(iso);
      v.title = absTimeISO(iso);
      row.append(span(k, "det-fact-k"), v);
      return row;
    };
    about.body.classList.add("det-prop-facts");
    about.body.append(fact("Created", it.createdAt), fact("Updated", it.updatedAt));

    rail.append(assignProp.root, labelProp.root, msProp.root, about.root);
  } else {
    // Drawer: one compact strip under the title.
    const strip = el("div", "det-inline-props");
    for (const l of it.labels) strip.appendChild(labelChip(l.name, l.color));
    if (d.assignees.length) {
      const byLogin = new Map(it.assignees.map((a) => [a.login, a]));
      strip.appendChild(avatarStack(d.assignees.map((login) => ({ login, avatarUrl: byLogin.get(login)?.avatarUrl }))));
    }
    if (it.milestone) {
      const m = el("span", "det-milestone");
      m.append(glyph("milestone"), span(it.milestone.title));
      strip.appendChild(m);
    }
    if (strip.childElementCount) main.appendChild(strip);
  }

  // ── timeline ──
  const timeline = el("div", "gh-subcontent");
  // Prose nav is scoped to the timeline: titles and rail properties are NOT
  // prose, and the linkifier must never touch them (it once underlined the
  // whole h1 by grabbing the "#31" suffix).
  wireProseNav(timeline, nav);
  timeline.appendChild(
    commentCard(it.user?.login ?? "author", "opened this issue", it.body ?? "", it.createdAt, {
      association: it.authorAssociation,
      reactions: it.reactions,
    }),
  );
  for (const c of d.comments) {
    timeline.appendChild(
      commentCard(c.author?.login ?? "unknown", "commented", c.body, c.createdAt, {
        updatedAt: c.updatedAt,
        association: c.authorAssociation,
        reactions: c.reactions,
      }),
    );
  }
  main.appendChild(timeline);

  // ── composer ──
  const composer = el("div", "gh-composer");
  const ta = document.createElement("textarea");
  ta.className = "gh-composer-input";
  ta.placeholder = "Leave a comment…";
  ta.rows = 4;
  ta.value = commentDrafts.get(draftKey(it.number)) ?? "";
  ta.addEventListener("input", () => {
    if (ta.value.trim()) commentDrafts.set(draftKey(it.number), ta.value);
    else commentDrafts.delete(draftKey(it.number));
  });
  const crow = el("div", "gh-composer-actions");
  const send = el("button", "btn btn-primary") as HTMLButtonElement;
  send.append(glyph("comment"), span("Comment"));
  const syncSend = (): void => {
    const ready = ta.value.trim().length > 0;
    send.disabled = !ready;
    send.title = ready ? "Post this comment" : "Write something first";
  };
  ta.addEventListener("input", syncSend);
  // ⌘Enter posts, which the shortcut sheet has been promising and neither
  // composer implemented — so the one keystroke people reach for after
  // typing a comment did nothing at all, on both detail pages.
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (!send.disabled) send.click();
  });
  syncSend();
  send.addEventListener("click", () => void postComment(it.number, ta, send, reload));
  const draftChip = aiChip("Draft a reply", () =>
    void streamInto(
      "assist",
      { description: `Draft a concise, helpful reply comment for this GitHub issue. Output only the comment text.\n\n${aiCtx()}` },
      ta,
      draftChip as HTMLButtonElement,
    ),
  );
  draftChip.hidden = true;
  void aiEnabled().then((ok) => (draftChip.hidden = !ok));
  crow.append(draftChip, send);
  composer.append(ta, crow);
  main.appendChild(composer);
}

// ── Mutations (disable trigger → toast → bust cache → re-fetch) ──────────────

/** The New-issue flow — exported so the command palette can launch it from
 *  anywhere, not just the Issues toolbar.
 *
 *  It used to open `editForm`, a modal with a title input and a body box. It is
 *  a routed PAGE now (`views/issueCompose.ts`) with a Write/Preview body that
 *  fills the window and a sidebar for labels, assignees and the milestone —
 *  none of which a modal could offer, so all three used to mean a second trip
 *  through the issue's own page AFTER it had been announced. */
export function openNewIssue(nav: SectionNav): void {
  nav("issuenew");
}

async function postComment(
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
    const r = await host.invoke("issue:comment", { number: n, body });
    if (!r.ok) {
      toast(r.message ?? "Couldn't post the comment.", "error");
      return;
    }
    toast("Comment posted.", "success");
    commentDrafts.delete(draftKey(n));
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't post the comment.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
    ta.disabled = false;
  }
}

async function changeState(
  n: number,
  state: "open" | "closed",
  btn: HTMLElement,
  reload: () => void,
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
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the issue.", "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function labelsMenu(anchor: HTMLElement, it: IssueInfo, reload: () => void): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await gget("issue:labels", undefined, 60000);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load labels.", "error");
    return;
  }
  if (repoLabels.length === 0) {
    toast("This repo has no labels defined.", "info");
    return;
  }
  const before = new Set(it.labels.map((l) => l.name));
  const picked = new Set(before);
  // Labelling is a multi-select: tick as many as you mean, and the whole
  // selection is sent once when the menu closes. It used to close — and fire a
  // request — after every single tick.
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
      // Escape DISCARDS. Everything else about this control was right — ticks
      // are batched and sent once, rather than firing a request per tick — but
      // `onClose` ran on every dismissal, so the one key that means "back out"
      // everywhere else in the app was the key that wrote to GitHub. There was
      // no way to change your mind after the first tick.
      onClose: (reason) => {
        if (reason === "escape") return;
        const same = picked.size === before.size && [...picked].every((x) => before.has(x));
        if (!same) void applyLabels(it.number, [...picked], reload);
      },
    },
  );
}

async function applyLabels(n: number, labels: string[], reload: () => void): Promise<void> {
  try {
    const r = await host.invoke("issue:setLabels", { number: n, labels });
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

/** A picker of the repo's milestones (open first, progress as the sub line)
 *  plus a "No milestone" choice to clear. */
async function milestoneMenu(anchor: HTMLElement, it: IssueInfo, reload: () => void): Promise<void> {
  let ms: MilestoneInfo[] = [];
  try {
    ms = await gget("issue:milestones", undefined, 60000);
  } catch (e) {
    toast(cleanErr(e) || "Couldn't load milestones.", "error");
    return;
  }
  if (ms.length === 0) {
    toast("This repo has no milestones defined.", "info");
    return;
  }
  const ordered = [...ms].sort((a, b) => (a.state === b.state ? 0 : a.state === "open" ? -1 : 1));
  openMenu(
    anchor,
    [
      {
        label: "No milestone",
        icon: "circle-slash",
        current: !it.milestone,
        onClick: () => void applyMilestone(it.number, null, reload),
      },
      { separator: true },
      ...ordered.map((m) => {
        const total = m.openIssues + m.closedIssues;
        const progress = total > 0 ? `${m.closedIssues}/${total} closed` : "no issues";
        return {
          label: m.title,
          icon: "milestone",
          current: it.milestone?.number === m.number,
          sub: m.state === "closed" ? `closed · ${progress}` : progress,
          onClick: () => void applyMilestone(it.number, m.number, reload),
        };
      }),
    ],
    { searchable: ordered.length > 8 },
  );
}

async function applyMilestone(n: number, milestone: number | null, reload: () => void): Promise<void> {
  try {
    const r = await host.invoke("issue:setMilestone", { number: n, milestone });
    if (!r.ok) {
      toast(r.message ?? "Couldn't update the milestone.", "error");
      return;
    }
    toast(milestone == null ? "Milestone cleared." : "Milestone updated.", "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || "Couldn't update the milestone.", "error");
  }
}

async function editAssignees(it: IssueInfo, current: string[], reload: () => void): Promise<void> {
  // A searchable, avatar-rich picker of repo collaborators, pre-checked with the
  // current assignees. Falls back to a CSV prompt if the list can't be fetched.
  let people: RepoCollaborator[] = [];
  try {
    people = await gget("pr:reviewers", undefined, 60000);
  } catch {
    /* fall through to the free-text path */
  }
  let assignees: string[] | null;
  if (people.length) {
    assignees = await peoplePickerModal({ title: "Assignees", okLabel: "Save", people, selected: current });
  } else {
    const csv = await promptInline(
      "Assignees",
      "comma-separated logins, e.g. octocat, hubot",
      current.join(", "),
      "Save",
    );
    assignees = csv === null ? null : csv.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  }
  if (assignees === null) return;
  try {
    const r = await host.invoke("issue:setAssignees", { number: it.number, assignees });
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
