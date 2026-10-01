// Issues — the repo-scoped GitHub Issues section, on the section-page system
// (docs/desktop-redesign.md): a full-width list page whose rows navigate to a
// full-page detail (routed via `target.number`, so ⌘[/Esc walk back like a
// browser), with the issue's properties in an inline-editable right rail.
//
// Self-contained: it renders into the `wrap` it's handed and re-renders through
// the section router. Every mutation disables its trigger, toasts the result,
// busts the SWR cache and re-fetches so the UI stays authoritative.

import * as l10n from "@vscode/l10n";
import { host } from "../bridge";
import type { MenuItem } from "../ui";
import { createSearchScheduler } from "../searchDebounce";
import { mdEditor } from "../mdEditor";
import { peek as cachePeek, gget, bust, cacheScope } from "../cache";
import { perTab } from "../tabState";
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
  copyText,
} from "../ui";
import { confirmDialog, promptInline, toast, formWithRetry} from "../dialogs";
import { renderMarkdown } from "../markdown";
import { wireProseNav } from "../proseNav";
import { openPeek } from "../peek";
import { memberCard } from "./orgs";
import { openExternalItem } from "./notifications";
import { aiChip, openAssistantTab, streamInto, aiEnabled } from "../aiAssist";
import {
  associationBadge,
  blankable,
  facetBar,
  harvestValues,
  segmented,
  wireToolsWrap,
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
  IssueComment,
  ReactionContent,
  ReactionSummary,
  TimelineEvent,
  RepoCollaborator,
  RepoLabel,
} from "../../shared/ipc";

// ── Section state (kept so it survives list ⇄ detail round trips) ───────────

/** The list order. "updated" is what the API returns; the rest are re-sorts of
 *  the loaded page — said honestly by the button, which names the order rather
 *  than pretending to be a server query. */
type IssueSort = "updated" | "newest" | "oldest" | "commented" | "reactions";

/**
 * What the Issues section remembers, for ONE tab (issue #32; see
 * tabState.ts).
 *
 * All of it is ABOUT a repository: a `label:"needs-triage"` query, a state
 * segment, a sort, a set of facet ticks, the search hits GitHub sent back. At
 * module scope it was the window's, reset whenever another repository's
 * Issues mounted — and with tabs every tab keeps its own Issues page alive. A
 * kept page's search box still showed its own query while its next repaint (a
 * sort, a facet, the revalidation) read whatever the last tab had left, its
 * GitHub search hits included: ANOTHER repository's issues, one click from
 * opening #28 in the wrong repository.
 */
interface IssuesTabState {
  issueState: "open" | "closed" | "all";
  issueSort: IssueSort;
  /** Client-side facets over the loaded list (shared facetBar vocabulary). */
  issueFacets: FacetState;
  /** The live text query — kept so Back from a detail restores the search. */
  query: string;
  /**
   * What GitHub returned for the current query, or null when the list on screen
   * is the locally-filtered one.
   *
   * The box does two things at once, deliberately. Typing filters what is
   * already loaded INSTANTLY, because that costs nothing and is usually the
   * answer. A moment later the same query goes to `/search/issues`, which
   * reaches past the 300 most recently updated and is the only path on which
   * `author:@me`, `no:assignee` or `label:"…"` mean anything at all. When that
   * lands it replaces the list, and the header says which of the two you are
   * looking at — a search that quietly searched a subset is the defect this
   * exists to fix, so it must never be ambiguous which one answered.
   */
  serverHits: IssueInfo[] | null;
  serverNote: string;
}

/** A reply box, as Quote reply needs it. */
type ReplyBox = { get(): string; set(v: string): void; focus(): void };
const issuesTab = perTab<IssuesTabState>(() => ({
  issueState: "open",
  issueSort: "updated",
  issueFacets: {},
  query: "",
  serverHits: null,
  serverNote: "",
}));

/** Drop a comment into the reply box as a markdown quote, the way GitHub does:
 *  the body prefixed with "> ", the author credited, and the cursor after it.
 *
 *  The box is the one on the SAME page as the comment, handed in by it. It was
 *  "the reply box on screen", a module global the last detail page built set —
 *  another tab's, or the Inbox's, whose box nobody could see (issue #32). */
function quoteInto(liveComposer: ReplyBox | undefined, body: string, author?: string | null): void {
  if (!liveComposer) return;
  const quoted = body
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const prefix = author ? `${l10n.t("@{0} said:", author)}\n` : "";
  const existing = liveComposer.get().trim();
  liveComposer.set(`${existing ? `${existing}\n\n` : ""}${prefix}${quoted}\n\n`);
  liveComposer.focus();
}

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
    /**
     * The comment's own id and a way to refresh. Present on comments, absent
     * on the issue body — which is edited through the composer page, not here.
     * Without it the card renders exactly as it always did.
     */
    comment?: { id: number; htmlUrl?: string; mine: boolean; reload: () => void };
    /** Drop the body into the reply box, quoted. */
    onQuote?: (body: string) => void;
    /** The issue body reacts to the ISSUE, not to a comment — a different
     *  endpoint, so the caller supplies it rather than this inferring it. */
    onIssueReact?: (content: ReactionContent, on: boolean) => Promise<boolean> | void;
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
    const ed = span(l10n.t("edited"), "gh-comment-edited");
    ed.title = l10n.t("Edited {0}", absTimeISO(extra.updatedAt));
    hd.appendChild(ed);
  }
  // Everything a comment can do, in the place GitHub puts it. The id has been
  // delivered on every comment since this view was written and thrown away by
  // it, so editing, deleting, quoting and copying a link were all unreachable
  // — five comment cards with zero buttons between them.
  if (extra.comment || extra.onQuote) {
    const spring = el("span", "gh-comment-spring");
    hd.appendChild(spring);
    const more = el("button", "mini-btn gh-icon-btn gh-comment-menu");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-label", l10n.t("Actions for {0}'s comment", author));
    more.appendChild(glyph("ellipsis"));
    more.addEventListener("click", () => {
      const items: Array<{ label: string; icon?: string; danger?: boolean; onClick: () => void }> = [];
      if (extra.onQuote) {
        items.push({
          label: l10n.t("Quote reply"),
          icon: "quote",
          onClick: () => extra.onQuote?.(body),
        });
      }
      const c = extra.comment;
      if (c?.htmlUrl) {
        items.push({
          label: l10n.t("Copy link"),
          icon: "link",
          onClick: () => void copyText(c.htmlUrl!, l10n.t("Link copied.")),
        });
      }
      // YOUR comment only. These were offered on everyone's: Edit opened the
      // editor, let you type, and failed at Save with a 403; Delete raised a
      // confirm saying "this cannot be undone" about something that could not
      // be done at all. An action you are not allowed to take should not be on
      // the menu, not merely fail politely afterwards.
      if (c && c.mine) {
        items.push({
          label: l10n.t("Edit"),
          icon: "edit",
          onClick: () => void editComment(c.id, body, card, c.reload),
        });
        items.push({
          label: l10n.t("Delete…"),
          icon: "trash",
          danger: true,
          onClick: () => void deleteComment(c.id, c.reload),
        });
      }
      openMenu(more, items, { align: "end" });
    });
    hd.appendChild(more);
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
    bd.textContent = l10n.t("No description provided.");
  }
  card.appendChild(bd);
  const react = extra.comment
    ? (content: ReactionContent, on: boolean) => toggleReaction("comment", extra.comment!.id, content, on)
    : extra.onIssueReact;
  const reactions = reactionRow(extra.reactions, react);
  if (reactions) card.appendChild(reactions);
  return card;
}

/**
 * Edit in place, in the same editor the composer uses.
 *
 * Not a modal: a comment is edited where it sits, so you can still read what
 * you are replying to and what came before it. Cancel restores the rendered
 * body without a request.
 */
async function editComment(
  id: number,
  body: string,
  card: HTMLElement,
  reload: () => void,
): Promise<void> {
  const bd = card.querySelector<HTMLElement>(".gh-body-md");
  if (!bd) return;
  const was = bd.innerHTML;
  const ed = mdEditor({ value: body, rows: 6, label: l10n.t("Edit comment") });
  const row = el("div", "gh-composer-actions");
  const save = el("button", "btn btn-primary") as HTMLButtonElement;
  save.textContent = l10n.t("Save");
  const cancel = el("button", "mini-btn");
  cancel.textContent = l10n.t("Cancel");
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
      toast(l10n.t("A comment cannot be empty — delete it instead."), "info");
      return;
    }
    save.disabled = true;
    try {
      const r = await host.invoke("issue:editComment", { id, body: next });
      if (!r.ok) {
        toast(r.message ?? l10n.t("Couldn’t save the edit."), "error");
        save.disabled = false;
        return;
      }
      toast(l10n.t("Comment updated."), "success");
      reload();
    } catch (e) {
      toast(cleanErr(e) || l10n.t("Couldn’t save the edit."), "error");
      save.disabled = false;
    }
  });
}

/**
 * Add or remove one of your reactions.
 *
 * Answers whether it STUCK; the strip has already drawn the change and puts
 * itself back on `false`. It does not reload: refetching the issue and
 * repainting every comment, the timeline and the rail to move one number by one
 * is what made a single click read as a whole-screen flash.
 */
async function toggleReaction(
  subject: "issue" | "comment",
  id: number,
  content: ReactionContent,
  on: boolean,
): Promise<boolean> {
  try {
    const r = await host.invoke("issue:react", { subject, id, content, on });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn’t change the reaction."), "error");
      return false;
    }
    return true;
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn’t change the reaction."), "error");
    return false;
  }
}

/** Delete, after asking — GitHub has no undo for this. */
async function deleteComment(id: number, reload: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: l10n.t("Delete this comment?"),
    message: l10n.t("It will be removed from the issue on GitHub. This cannot be undone."),
    confirmLabel: l10n.t("Delete comment"),
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await host.invoke("issue:deleteComment", id);
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn’t delete the comment."), "error");
      return;
    }
    toast(l10n.t("Comment deleted."), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn’t delete the comment."), "error");
  }
}

/**
 * One non-comment event, drawn as a quiet line rather than a card.
 *
 * A card is for something somebody wrote. "mira-holt added the bug label" is
 * bookkeeping — it belongs in the reading order, because a thread that skips it
 * loses the plot, but it must not compete with the writing around it.
 */
function timelineEvent(ev: TimelineEvent, nav: SectionNav): HTMLElement {
  const row = el("div", "gh-event");
  const who = ev.actor ?? l10n.t("somebody");
  const icons: Record<TimelineEvent["kind"], string> = {
    closed: "issue-closed",
    reopened: "issue-reopened",
    labeled: "tag",
    unlabeled: "tag",
    assigned: "person",
    unassigned: "person",
    renamed: "edit",
    milestoned: "milestone",
    demilestoned: "milestone",
    locked: "lock",
    unlocked: "unlock",
    referenced: "git-commit",
    "cross-referenced": "references",
    "marked-duplicate": "copy",
  };
  const notPlanned = ev.kind === "closed" && ev.reason === "not_planned";
  // A not-planned close draws the slash the pill and the list lead draw —
  // the completed check-circle said the opposite of the text beside it.
  const g = glyph(notPlanned ? "circle-slash" : (icons[ev.kind] ?? "circle-small"));
  g.classList.add("gh-event-icon");
  if (ev.kind === "closed") g.classList.add(notPlanned ? "is-muted" : "is-done");
  if (ev.kind === "reopened") g.classList.add("is-open");
  row.appendChild(g);

  const text = el("span", "gh-event-text");
  const add = (t: string, cls?: string): void => {
    text.appendChild(span(t, cls));
  };
  add(who, "gh-event-actor");
  switch (ev.kind) {
    case "closed":
      add(ev.reason === "not_planned" ? l10n.t(" closed this as not planned") : l10n.t(" closed this"));
      break;
    case "reopened":
      add(l10n.t(" reopened this"));
      break;
    case "labeled":
    case "unlabeled":
      add(ev.kind === "labeled" ? l10n.t(" added the ") : l10n.t(" removed the "));
      if (ev.label) {
        const chip = span(ev.label.name, "gh-label");
        chip.style.setProperty("--label", `#${ev.label.color}`);
        text.appendChild(chip);
      }
      add(l10n.t(" label"));
      break;
    case "assigned":
    case "unassigned":
      // "assigned themselves" reads better than "x assigned x", and it is the
      // most common assignment there is.
      if (ev.assignee && ev.assignee === ev.actor)
        add(ev.kind === "assigned" ? l10n.t(" self-assigned this") : l10n.t(" unassigned themselves"));
      else
        add(
          ev.kind === "assigned"
            ? l10n.t(" assigned {0}", ev.assignee ?? l10n.t("someone"))
            : l10n.t(" unassigned {0}", ev.assignee ?? l10n.t("someone")),
        );
      break;
    case "renamed":
      add(l10n.t(" changed the title"));
      if (ev.rename) {
        const from = span(ev.rename.from, "gh-event-was");
        from.title = ev.rename.from;
        text.append(
          span(l10n.t(" from ")),
          from,
          span(l10n.t(" to ")),
          span(ev.rename.to, "gh-event-now"),
        );
      }
      break;
    case "milestoned":
      add(l10n.t(" added this to {0}", ev.milestone ?? l10n.t("a milestone")));
      break;
    case "demilestoned":
      add(l10n.t(" removed this from {0}", ev.milestone ?? l10n.t("a milestone")));
      break;
    case "locked":
      add(l10n.t(" locked the conversation"));
      break;
    case "unlocked":
      add(l10n.t(" unlocked the conversation"));
      break;
    case "marked-duplicate":
      add(l10n.t(" marked this as a duplicate"));
      break;
    case "referenced":
      add(l10n.t(" referenced this in "));
      if (ev.source) add(ev.source.ref, "gh-event-ref sec-mono");
      break;
    case "cross-referenced": {
      add(l10n.t(" mentioned this in "));
      const src = ev.source;
      if (src) {
        // WHICH repository mentioned it. A cross-reference very often comes
        // from another project, and the label was always a bare "#12" whose
        // click routed into the repository you were reading — so a mention
        // from somewhere else opened this repository's issue 12, an unrelated
        // conversation, with nothing having said otherwise. A foreign one now
        // names its repository and goes to github.com, which is the only place
        // that page exists.
        const here = cachePeek("github:status", undefined)?.repo;
        const mine = here ? `${here.owner}/${here.repo}` : undefined;
        const foreign = !!src.repo && !!mine && src.repo !== mine;
        const label = foreign ? `${src.repo}${src.ref}` : src.ref;
        const link = el("button", "gh-event-link");
        link.textContent = `${label}${src.title ? ` ${src.title}` : ""}`;
        link.title = foreign
          ? src.title
            ? l10n.t("{0} — read {1}", src.title, label)
            : l10n.t("read {0}", label)
          : (src.title ?? src.ref);
        link.addEventListener("click", () => {
          const num = Number(src.ref.replace("#", ""));
          if (!Number.isFinite(num)) return;
          // Another project's thread has no page in this app, but it does have
          // a reader — the same one the Inbox uses for an item from a
          // repository you have not opened.
          if (foreign && src.repo) {
            const [owner, repo] = src.repo.split("/");
            void openExternalItem({
              owner,
              repo,
              number: num,
              kind: src.kind === "pr" ? "pull" : "issue",
              htmlUrl: src.url ?? `https://github.com/${src.repo}/issues/${num}`,
            });
            return;
          }
          nav(src.kind === "pr" ? "prs" : "issues", { number: num });
        });
        text.appendChild(link);
      }
      break;
    }
  }
  row.appendChild(text);
  const when = span(relTimeISO(ev.createdAt), "gh-event-when");
  when.title = absTimeISO(ev.createdAt);
  row.appendChild(when);
  return row;
}

// ── The section view ─────────────────────────────────────────────────────────

export const renderIssues: SectionRender = (wrap, nav, target) => {
  // The router is passed DOWN, not parked in a module global. It was: the
  // global was assigned only by renderIssues, so a detail page opened from
  // anywhere else — the Inbox, My Work, a deep link — left it undefined and
  // every Edit button on that page was a dead click with `?.` swallowing it.
  // `buildDetail` already destructures `nav`; the four readers use that.
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
  const S = issuesTab();
  const refresh = (): void => {
    bust("issue");
    renderIssues(wrap, nav);
  };

  const { view, listEl } = sectionList();
  const header = ghHeader(l10n.t("Issues"), gate.login, refresh);

  // Toolbar: state segment · facets · New Issue (search rides in the titlewrap).
  const tools = el("div", "gh-head-tools");
  // Counts on the tabs, when they are KNOWN — a state whose list is in cache
  // labels its tab "Closed (45)"; one that has never been fetched stays a bare
  // word rather than showing a number that is a guess. GitHub can afford the
  // counts because its page is server-rendered; this app can afford honesty.
  const countFor = (st: "open" | "closed"): string => {
    const cached = cachePeek("issue:list", { state: st });
    return cached ? ` (${cached.length})` : "";
  };
  const seg = segmented<"open" | "closed" | "all">({
    options: [
      { value: "open", label: l10n.t("Open{0}", countFor("open")) },
      { value: "closed", label: l10n.t("Closed{0}", countFor("closed")) },
      { value: "all", label: l10n.t("All") },
    ],
    value: S.issueState,
    ariaLabel: l10n.t("Issue state"),
    onChange: (v) => {
      S.issueState = v;
      renderIssues(wrap, nav);
    },
  });

  const facetSlot = el("div", "gh-facet-slot");

  // The order, named. The list always HAD one (the API's updated-desc) but
  // nothing said so, and there was no way to ask the questions a sort answers:
  // what is oldest and still open, what has everyone piled onto.
  const SORT_LABELS: Record<IssueSort, string> = {
    updated: l10n.t("Recently updated"),
    newest: l10n.t("Newest"),
    oldest: l10n.t("Oldest"),
    commented: l10n.t("Most commented"),
    reactions: l10n.t("Most reactions"),
  };
  const sortBtn = el("button", "mini-btn gh-sort-btn");
  const sortLabel = span(SORT_LABELS[S.issueSort]);
  sortBtn.append(glyph("sort-precedence"), sortLabel, glyph("chevron-down"));
  sortBtn.title = l10n.t("Change the list order");
  sortBtn.setAttribute("aria-haspopup", "menu");
  sortBtn.addEventListener("click", () =>
    openMenu(
      sortBtn,
      (Object.keys(SORT_LABELS) as IssueSort[]).map((k) => ({
        label: SORT_LABELS[k],
        current: k === S.issueSort,
        onClick: () => {
          S.issueSort = k;
          sortLabel.textContent = SORT_LABELS[k];
          renderList();
        },
      })),
    ),
  );

  const newBtn = el("button", "btn btn-primary gh-new-btn");
  newBtn.append(glyph("add"), span(l10n.t("New issue")));
  newBtn.addEventListener("click", () => nav("issuenew"));
  const verbs = el("div", "gh-head-verbs");
  verbs.append(sortBtn, newBtn);
  tools.append(seg, facetSlot, verbs);
  header.querySelector(".gh-acct")?.before(tools);
  wireToolsWrap(tools);
  view.append(header, listEl);
  wrap.replaceChildren(view);

  // ── data: paint from cache instantly, revalidate in the background ──
  let issues: IssueInfo[] | undefined = cachePeek("issue:list", { state: S.issueState });
  if (!issues) listEl.replaceChildren(skeletonList(6));

  const buildRow = (it: IssueInfo): HTMLElement => {
    // One order across every list: who wrote it, who owns it, then the counts.
    const meta: HTMLElement[] = [];
    if (it.user) meta.push(avatarStack([it.user], 1, 18, l10n.t("Author")));
    // Reserved even when empty, so the author avatar keeps its column on rows
    // that happen to have no assignee.
    meta.push(blankable(avatarStack(it.assignees, 3, 18, l10n.t("Assignee")), it.assignees.length > 0));
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
      // The milestone rides with the labels — the left-packed cluster — and
      // NOT the meta columns: those pack right-to-left into aligned columns,
      // and a variable-width chip in there pushed every avatar on its row out
      // of the column the other rows kept.
      chips: [
        ...it.labels.map((l) => labelChip(l.name, l.color)),
        ...(it.milestone ? [milestoneChip(it.milestone.title)] : []),
      ],
      meta,
      // The list arrives sorted by LAST UPDATED, so the date column has to be
      // the updated date. It showed — and its tooltip labelled — the CREATED
      // date, which made the order look arbitrary: a two-year-old issue
      // commented on this morning sat at the top reading "opened 2 years ago".
      // Both dates are in the tooltip; only one can be the sorted column.
      time: relTimeISO(it.updatedAt),
      timeTitle: it.updatedAt
        ? it.createdAt
          ? `${l10n.t("Updated {0}", absTimeISO(it.updatedAt))}\n${l10n.t("Opened {0}", absTimeISO(it.createdAt))}`
          : l10n.t("Updated {0}", absTimeISO(it.updatedAt))
        : undefined,
      ariaLabel: l10n.t("Issue #{0}: {1}", it.number, it.title),
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

  /** A line under the header saying WHICH set is on screen. */
  const noteEl = el("div", "gh-search-note");
  noteEl.hidden = true;
  // Above the rows, below the header — it is about the list, so it sits with it.
  listEl.before(noteEl);
  const setSearchNote = (text: string): void => {
    noteEl.textContent = text;
    noteEl.hidden = !text;
  };

  const searcher = createSearchScheduler((q, gen) => {
    void (async () => {
      try {
        const res = await host.invoke("issue:search", { query: q, state: S.issueState });
        if (!searcher.isCurrent(gen) || !view.isConnected || S.query.trim() !== q) return;
        S.serverHits = res.items;
        S.serverNote = res.incomplete
          ? l10n.t("{0} from GitHub — it gave up early, so there may be more", res.items.length)
          : res.totalCount > res.items.length
            ? l10n.t("{0} of {1} matching issues on GitHub", res.items.length, res.totalCount)
            : res.items.length === 1
              ? l10n.t("1 matching issue on GitHub")
              : l10n.t("{0} matching issues on GitHub", res.items.length);
        renderList();
      } catch {
        // Leave the local filter on screen and say so, rather than emptying
        // the list because the network hiccuped.
        if (!searcher.isCurrent(gen) || !view.isConnected) return;
        S.serverHits = null;
        S.serverNote = l10n.t("Couldn’t reach GitHub — showing matches from the issues already loaded");
        renderList();
      }
    })();
  }, { delayMs: 450, minChars: 2 });

  const renderList = (): void => {
    if (!issues) return;
    // Re-harvest before painting: the bar is built before the first fetch
    // lands, and a facet menu that offers nothing is worse than no facet.
    facets.sync(issues);
    const q = S.query.toLowerCase();
    // GitHub's answer wins when we have one for THIS query: it saw every issue
    // in the repository, and the local filter only ever saw the loaded page.
    const source = q && S.serverHits ? S.serverHits : issues;
    const items = source.filter((it) => passesFacets(it) && (q && !S.serverHits ? matches(it, q) : true));
    header.setCount?.(items.length, S.serverHits && q ? undefined : issues.length);
    // The tab learns its count the moment the list lands, not on the next visit.
    if (S.issueState !== "all") {
      seg.setLabel(
        S.issueState,
        S.issueState === "open"
          ? l10n.t("Open ({0})", issues.length)
          : l10n.t("Closed ({0})", issues.length),
      );
    } else {
      // All carries both counts — label both tabs so neither grows on the next click.
      seg.setLabel("open", l10n.t("Open ({0})", issues.filter((i) => i.state === "open").length));
      seg.setLabel("closed", l10n.t("Closed ({0})", issues.filter((i) => i.state === "closed").length));
    }
    setSearchNote(S.serverNote);
    listEl.replaceChildren();
    if (issues.length === 0) {
      const emptyCopy: Record<typeof S.issueState, { title: string; desc: string; icon: string }> = {
        open: {
          title: l10n.t("No open issues"),
          desc: l10n.t("You're all caught up — there's nothing open to triage right now."),
          icon: "issue-opened",
        },
        closed: {
          title: l10n.t("No closed issues"),
          desc: l10n.t("Closed issues will show here once you close some."),
          icon: "issue-closed",
        },
        all: {
          title: l10n.t("No issues yet"),
          desc: l10n.t("This repo has no issues. Open the first one to start tracking work."),
          icon: "issue-opened",
        },
      };
      const c = emptyCopy[S.issueState];
      listEl.appendChild(
        emptyState(
          c.title,
          c.desc,
          S.issueState === "closed"
            ? { icon: c.icon }
            : {
                icon: c.icon,
                action: { label: l10n.t("New issue"), icon: "add", onClick: () => nav("issuenew") },
              },
        ),
      );
      return;
    }
    if (items.length === 0) {
      const desc = S.query
        ? l10n.t("Nothing matches “{0}”.", S.query)
        : l10n.t("No issues match the active filters.");
      listEl.appendChild(
        emptyState(l10n.t("No matching issues"), desc, {
          icon: "search",
          anchor: "inline",
          secondary:
            facets.activeCount() > 0
              ? { label: l10n.t("Clear filters"), icon: "clear-all", onClick: () => facets.clear() }
              : undefined,
        }),
      );
      return;
    }
    for (const it of sortIssues(items, S.issueSort)) listEl.appendChild(buildRow(it));
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
    label: l10n.t("Closed as"),
    icon: "circle-slash",
    anyLabel: l10n.t("Any reason"),
    options: [
      { value: "completed", label: l10n.t("Completed"), icon: "issue-closed" },
      { value: "not_planned", label: l10n.t("Not planned"), icon: "circle-slash" },
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
        label: l10n.t("Label"),
        icon: "tag",
        anyLabel: l10n.t("All labels"),
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
        label: l10n.t("Assignee"),
        icon: "person",
        anyLabel: l10n.t("Anyone"),
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
        label: l10n.t("Milestone"),
        icon: "milestone",
        anyLabel: l10n.t("Any milestone"),
        harvest: harvestValues<IssueInfo>((it) => it.milestone?.title),
        predicate: (it, v) => it.milestone?.title === v,
      },
      {
        key: "author",
        label: l10n.t("Author"),
        icon: "account",
        anyLabel: l10n.t("Anyone"),
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
      ...(S.issueState === "open" ? [] : [closedReasonSpec]),
    ],
    state: S.issueFacets,
    items: issues ?? [],
    onChange: () => renderList(),
  });
  facetSlot.replaceChildren(facets.el);

  header.querySelector(".gh-head-titlewrap")?.appendChild(
    searchField({
      placeholder: l10n.t("Search issues…"),
      initial: S.query,
      onInput: (q) => {
        S.query = q;
        // The old answer is not about the new query. Dropping it here is what
        // stops a stale "12 matching issues on GitHub" sitting above results
        // for something else entirely.
        S.serverHits = null;
        S.serverNote = q.trim() ? l10n.t("Searching GitHub…") : "";
        renderList();
        searcher.queue(q);
      },
    }),
  );

  if (issues) renderList(); // instant paint from cache

  try {
    const fresh = await gget("issue:list", { state: S.issueState }, 15000);
    if (!view.isConnected) return;
    issues = fresh;
    renderList();
  } catch (e) {
    if (!view.isConnected) return;
    if (!issues) {
      listEl.replaceChildren(
        errorState(l10n.t("Couldn't load issues"), cleanErr(e) || l10n.t("GitHub request failed."), refresh),
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
    backLabel: from?.label ?? l10n.t("Issues"),
    crumb: `#${n}`,
    pageLabel: l10n.t("Issue #{0}", n),
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
        errorState(l10n.t("Couldn't load issue"), cleanErr(e) || l10n.t("GitHub request failed."), reload),
      );
      return;
    }
    if (!view.isConnected) return;
    if (!d) {
      main.replaceChildren(
        emptyState(l10n.t("Issue unavailable"), l10n.t("This issue couldn't be loaded.")),
      );
      return;
    }
    const viewer = await gget("github:status", undefined, 30_000)
      .then((st) => st.login)
      .catch(() => undefined);
    buildDetail({ main, rail, topActions, d, nav, reload, viewer });
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
  // Who is reading, so a comment's menu can offer only what this account may
  // actually do. Cached and cheap; undefined when signed out, which correctly
  // makes every comment somebody else's.
  const viewer = await gget("github:status", undefined, 30_000)
    .then((st) => st.login)
    .catch(() => undefined);
  let d: IssueDetail | undefined;
  try {
    d = await gget("issue:detail", number, 8000);
  } catch (e) {
    container.replaceChildren(
      errorState(l10n.t("Couldn't load issue"), cleanErr(e) || l10n.t("GitHub request failed."), reload),
    );
    return;
  }
  if (!container.isConnected) return;
  if (!d) {
    container.replaceChildren(
      emptyState(l10n.t("Issue unavailable"), l10n.t("This issue couldn't be loaded.")),
    );
    return;
  }
  const main = el("div", "det-main det-main-drawer");
  container.replaceChildren(main);
  buildDetail({ main, rail: null, topActions: null, d, nav, reload, viewer });
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
  /** The signed-in login, so a comment offers only what this account may do.
   *  Undefined when signed out, which correctly makes every comment
   *  somebody else's. */
  viewer?: string;
}

function buildDetail(ctx: DetailCtx): void {
  const { main, rail, d, nav, reload } = ctx;
  // The reply box below — where THIS page's Quote reply lands.
  const reply: { box?: ReplyBox } = {};
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
  analyzeBtn.append(glyph("sparkle"), span(l10n.t("Analyze")));
  analyzeBtn.addEventListener("click", () =>
    openAssistantTab({
      title: l10n.t("Analyze #{0}", it.number),
      // Sent to the AI model, not rendered in the UI — not translated.
      goal: `Analyze this GitHub issue. Summarize the problem, the likely root cause, and a concrete suggested approach. Be concise and use Markdown.\n\n${aiCtx()}`,
      nav,
    }),
  );
  void aiEnabled().then((ok) => (analyzeBtn.hidden = !ok));
  actions.push(analyzeBtn);

  const editBtn = el("button", "mini-btn");
  editBtn.append(glyph("edit"), span(l10n.t("Edit")));
  editBtn.addEventListener("click", () => nav("issuenew", { number: it.number }));
  actions.push(editBtn);

  const closing = it.state === "open";
  const stateBtn = el("button", closing ? "btn btn-primary" : "mini-btn");
  stateBtn.append(
    glyph(closing ? "issue-closed" : "issue-opened"),
    span(closing ? l10n.t("Close issue") : l10n.t("Reopen")),
  );
  // Close opens a chooser (completed / not planned) — say so, like Merge and Review do.
  if (closing) stateBtn.appendChild(glyph("chevron-down"));
  if (closing) {
    // WHY it is being closed, not just that it is.
    //
    // The app has always drawn and filtered the difference — the pill reads
    // "Closed as not planned", and the list carries a whole "Closed as" facet —
    // while the only control it had was a yes/no confirmation that always sent
    // `completed`. So triage (won't fix, invalid, out of scope) had to happen on
    // github.com and this app could only report the result afterwards.
    //
    // A menu of two verbs rather than a confirm dialog: "are you sure" is a
    // worse question than "which of these did you mean", and the answer to the
    // second is also the confirmation.
    stateBtn.setAttribute("aria-haspopup", "menu");
    stateBtn.addEventListener("click", () => {
      openMenu(stateBtn, [
        {
          label: l10n.t("Close as completed"),
          icon: "pass-filled",
          onClick: () => void changeState(it.number, "closed", stateBtn, reload, "completed"),
        },
        {
          label: l10n.t("Close as not planned"),
          icon: "circle-slash",
          onClick: () => void changeState(it.number, "closed", stateBtn, reload, "not_planned"),
        },
      ]);
    });
  } else {
    stateBtn.addEventListener("click", () => void changeState(it.number, "open", stateBtn, reload));
  }
  actions.push(stateBtn);

  // The ⋯ menu — the actions an issue HAS that do not deserve a button each.
  // The issue page had no overflow at all while the PR page did, so half of
  // GitHub's issue actions had nowhere to live: you could not copy a link,
  // could not lock a heated thread, could not spin a follow-up out of an old
  // discussion without leaving the app.
  const moreBtn = el("button", "mini-btn gh-icon-btn");
  moreBtn.append(glyph("ellipsis"));
  moreBtn.title = l10n.t("More actions");
  moreBtn.setAttribute("aria-label", l10n.t("More actions"));
  moreBtn.setAttribute("aria-haspopup", "menu");
  moreBtn.addEventListener("click", () => {
    const items: MenuItem[] = [
      {
        label: l10n.t("Copy link"),
        icon: "copy",
        onClick: () => void copyText(it.htmlUrl, l10n.t("Copied issue link.")),
      },
      {
        label: l10n.t("Reference in new issue"),
        sub: l10n.t("Starts one that links #{0}", it.number),
        icon: "issue-draft",
        onClick: () => nav("issuenew", { seedBody: `${l10n.t("Ref #{0} — {1}", it.number, it.title)}\n\n` }),
      },
      { separator: true },
    ];
    if (it.locked) {
      items.push({
        label: l10n.t("Unlock conversation"),
        sub: l10n.t("Everyone can comment again"),
        icon: "unlock",
        onClick: () => void setLocked(it.number, false, undefined, reload),
      });
    } else {
      // The reason is part of the act, so it is asked in the same menu rather
      // than behind a second hop — GitHub's own vocabulary, plus "no reason",
      // because a lock does not owe anyone an explanation.
      for (const [reason, label] of [
        [undefined, l10n.t("Lock conversation")],
        ["off-topic", l10n.t("Lock as off-topic")],
        ["too heated", l10n.t("Lock as too heated")],
        ["resolved", l10n.t("Lock as resolved")],
        ["spam", l10n.t("Lock as spam")],
      ] as const) {
        items.push({
          label,
          icon: "lock",
          onClick: () => void setLocked(it.number, true, reason, reload),
        });
      }
    }
    openMenu(moreBtn, items);
  });
  actions.push(moreBtn);

  // The de-emphasized escape hatch: everything above is doable in-app.
  const openBtn = el("button", "mini-btn gh-icon-btn");
  openBtn.append(glyph("link-external"));
  openBtn.title = l10n.t("Open this issue on GitHub");
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
      stKind === "open"
        ? l10n.t("Open")
        : stKind === "not-planned"
          ? l10n.t("Closed as not planned")
          : l10n.t("Closed"),
      stKind,
    ),
  );
  const h = el("h1", "det-title");
  h.append(span(it.title), span(`  #${it.number}`, "det-title-num"));
  titleRow.appendChild(h);
  // The same pencil beside the title the PR page has — one edit affordance,
  // in one place, on both detail pages.
  const editTitleBtn = el("button", "mini-btn gh-icon-btn det-title-edit");
  editTitleBtn.append(glyph("pencil"));
  editTitleBtn.title = l10n.t("Edit title & description");
  editTitleBtn.setAttribute("aria-label", l10n.t("Edit issue title and description"));
  editTitleBtn.addEventListener("click", () => nav("issuenew", { number: it.number }));
  titleRow.appendChild(editTitleBtn);
  main.appendChild(titleRow);

  const sub = el("div", "det-sub");
  const author = it.user?.login;
  if (author) {
    const chip = el("button", "gh-meta-author");
    chip.append(avatar(author, it.user?.avatarUrl ?? null, 18), span(author));
    chip.title = l10n.t("View @{0}'s profile", author);
    chip.addEventListener("click", () =>
      openPeek(memberCard({ login: author, avatarUrl: it.user?.avatarUrl ?? null, htmlUrl: `https://github.com/${author}` })),
    );
    sub.appendChild(chip);
  }
  const subText = el("span");
  subText.textContent =
    it.comments === 1
      ? l10n.t("opened {0} · 1 comment", relTimeISO(it.createdAt))
      : l10n.t("opened {0} · {1} comments", relTimeISO(it.createdAt), it.comments);
  subText.title = absTimeISO(it.createdAt);
  sub.appendChild(subText);
  main.appendChild(sub);

  // ── properties (rail on the page; inline strip in the drawer) ──
  const labelsEdit = (anchor: HTMLElement): void => void labelsMenu(anchor, it, reload);
  const assigneesEdit = (): void => void editAssignees(it, d.assignees, reload);
  const milestoneEdit = (anchor: HTMLElement): void => void milestoneMenu(anchor, it, reload);

  if (rail) {
    const assignProp = propSection(l10n.t("Assignees"), {
      onEdit: assigneesEdit,
      editTitle: l10n.t("Edit assignees"),
    });
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
      assignProp.body.appendChild(propAddBtn(l10n.t("Assign"), assigneesEdit));
    }

    const labelProp = propSection(l10n.t("Labels"), {
      onEdit: labelsEdit,
      editTitle: l10n.t("Edit labels"),
    });
    if (it.labels.length) {
      for (const l of it.labels) labelProp.body.appendChild(labelChip(l.name, l.color));
    } else {
      labelProp.body.appendChild(propAddBtn(l10n.t("Add labels"), () => labelsEdit(labelProp.root)));
    }

    // Who closed it, when, and WHY — the three questions a closed issue raises
    // and the app used to answer with silence.
    if (it.state === "closed" && (it.closedBy || it.closedAt)) {
      const closedProp = propSection(
        it.stateReason === "not_planned" ? l10n.t("Closed as not planned") : l10n.t("Closed"),
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

    const msProp = propSection(l10n.t("Milestone"), {
      onEdit: milestoneEdit,
      editTitle: l10n.t("Set milestone"),
    });
    if (it.milestone) {
      const m = el("span", "det-milestone");
      m.append(glyph("milestone"), span(it.milestone.title));
      msProp.body.appendChild(m);
    } else {
      msProp.body.appendChild(propAddBtn(l10n.t("Set milestone"), () => milestoneEdit(msProp.root)));
    }

    const about = propSection(l10n.t("About"));
    const fact = (k: string, iso: string): HTMLElement => {
      const row = el("div", "det-fact");
      const v = el("span", "det-fact-v");
      v.textContent = relTimeISO(iso);
      v.title = absTimeISO(iso);
      row.append(span(k, "det-fact-k"), v);
      return row;
    };
    about.body.classList.add("det-prop-facts");
    about.body.append(fact(l10n.t("Created"), it.createdAt), fact(l10n.t("Updated"), it.updatedAt));

    // GitHub's rail order, which readers already know: the things you can
    // EDIT first (assignees, labels, milestone), then the things the issue
    // has ACCUMULATED (development, participants, lock), then the dates.
    rail.append(assignProp.root, labelProp.root, msProp.root);

    // ── Development — the pull requests this issue is entangled with ──
    //
    // GitHub's rail answers "is anyone fixing this" with a Development section;
    // ours answered with nothing, and the only trace was a cross-reference
    // event buried mid-timeline. The events already carry everything needed —
    // this is a read of data the page had and did not show.
    //
    // Keyed by REPOSITORY and number, not by number: `#12` from two different
    // projects is two different pull requests, and one key meant the second
    // silently replaced the first — the rail showed one row where two pieces
    // of work were open.
    const here = cachePeek("github:status", undefined)?.repo;
    const mine = here ? `${here.owner}/${here.repo}` : undefined;
    const linkedPrs = new Map<string, NonNullable<TimelineEvent["source"]>>();
    for (const ev of d.events ?? []) {
      if (ev.kind === "cross-referenced" && ev.source?.kind === "pr") {
        linkedPrs.set(`${ev.source.repo ?? ""}${ev.source.ref}`, ev.source);
      }
    }
    if (linkedPrs.size) {
      const dev = propSection(l10n.t("Development"));
      for (const src of linkedPrs.values()) {
        const foreign = !!src.repo && !!mine && src.repo !== mine;
        const ref = foreign ? `${src.repo}${src.ref}` : src.ref;
        const row = el("button", "det-dev-pr");
        const state = src.merged ? "merged" : src.state === "closed" ? "closed" : "open";
        const ic = glyph(
          state === "merged" ? "git-merge" : state === "closed" ? "git-pull-request-closed" : "git-pull-request",
        );
        ic.classList.add(`is-${state}`);
        const t = span(src.title ? `${ref} ${src.title}` : ref, "det-dev-title");
        t.title = src.title ? `${src.title} — ${ref}` : ref;
        row.append(ic, t);
        const stateWord =
          state === "merged" ? l10n.t("merged") : state === "closed" ? l10n.t("closed") : l10n.t("open");
        row.setAttribute(
          "aria-label",
          src.title
            ? l10n.t("Pull request {0}: {1} ({2})", ref, src.title, stateWord)
            : l10n.t("Pull request {0} ({1})", ref, stateWord),
        );
        const num = Number(src.ref.replace("#", ""));
        row.addEventListener("click", () => {
          // A pull request in another project has no page in this app, and
          // routing by its number alone opened THIS repository's pull request
          // with the same number. The Inbox's reader can show it in place.
          if (foreign && src.repo) {
            const [owner, repo] = src.repo.split("/");
            void openExternalItem({
              owner,
              repo,
              number: num,
              kind: "pull",
              htmlUrl: src.url ?? `https://github.com/${src.repo}/pull/${num}`,
            });
            return;
          }
          nav("prs", { number: num });
        });
        dev.body.appendChild(row);
      }
      rail.appendChild(dev.root);
    }

    // ── Participants — who has been in this conversation ──
    //
    // Author, everyone who commented, whoever closed it. Computed from data on
    // the page, so the count and the faces can never disagree with the thread
    // below them.
    const people = new Map<string, string | null | undefined>();
    if (it.user) people.set(it.user.login, it.user.avatarUrl);
    for (const cm of d.comments) if (cm.author) people.set(cm.author.login, cm.author.avatarUrl);
    if (it.closedBy) people.set(it.closedBy.login, it.closedBy.avatarUrl);
    const parts = propSection(
      people.size === 1 ? l10n.t("1 participant") : l10n.t("{0} participants", people.size),
    );
    parts.body.appendChild(
      avatarStack([...people].map(([login, avatarUrl]) => ({ login, avatarUrl })), 8, 22),
    );
    rail.appendChild(parts.root);

    // A locked thread says so where the properties live, not only in a
    // timeline event that may be forty comments up.
    if (it.locked) {
      const lock = propSection(l10n.t("Conversation locked"));
      const line = el("div", "det-lock-line");
      line.append(
        glyph("lock"),
        span(
          it.activeLockReason
            ? l10n.t("as {0}", it.activeLockReason)
            : l10n.t("by a collaborator"),
          "det-lock-why",
        ),
      );
      lock.body.appendChild(line);
      rail.appendChild(lock.root);
    }

    rail.appendChild(about.root);
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
    // No `comment` here: the issue BODY is edited through the composer page,
    // which is a different endpoint and a different screen. Quoting it is
    // still the same gesture, so that stays.
    commentCard(it.user?.login ?? "author", l10n.t("opened this issue"), it.body ?? "", it.createdAt, {
      association: it.authorAssociation,
      reactions: it.reactions,
      onQuote: (text) => quoteInto(reply.box, text, it.user?.login),
      onIssueReact: (content, on) => toggleReaction("issue", it.number, content, on),
    }),
  );
  // Comments and events, in the order they happened.
  //
  // Merged by timestamp rather than appended in two blocks: a thread where
  // every label and close is bunched at the end is not a record of anything.
  // Comments win a tie — an event fired by posting a comment (closing with a
  // comment, say) reads as the comment first and then what it did.
  type Entry = { at: string; comment?: IssueComment; event?: TimelineEvent };
  const merged: Entry[] = [
    ...d.comments.map((c): Entry => ({ at: c.createdAt, comment: c })),
    ...(d.events ?? []).map((e): Entry => ({ at: e.createdAt, event: e })),
  ].sort((a, b) => (a.at === b.at ? (a.comment ? -1 : 1) : a.at < b.at ? -1 : 1));

  for (const entry of merged) {
    if (entry.event) {
      timeline.appendChild(timelineEvent(entry.event, nav));
      continue;
    }
    const c = entry.comment!;
    timeline.appendChild(
      commentCard(c.author?.login ?? "unknown", l10n.t("commented"), c.body, c.createdAt, {
        updatedAt: c.updatedAt,
        association: c.authorAssociation,
        reactions: c.reactions,
        comment: { id: c.id, htmlUrl: c.htmlUrl, mine: c.author?.login === ctx.viewer, reload },
        onQuote: (text) => quoteInto(reply.box, text, c.author?.login),
      }),
    );
  }
  main.appendChild(timeline);

  // ── composer ──
  const composer = el("div", "gh-composer");
  // The SAME editor the New Issue form uses.
  //
  // Writing an issue got Write/Preview and a formatting toolbar; replying to
  // one — the far more frequent act — got a four-row box with none of it, in
  // the same renderer, a few hundred lines apart. Markdown you cannot preview
  // is markdown you find out about after you post it.
  const ed = mdEditor({
    value: commentDrafts.get(draftKey(it.number)) ?? "",
    placeholder: l10n.t("Leave a comment…"),
    rows: 4,
    label: l10n.t("Comment on issue #{0}", it.number),
    onInput: (v) => {
      if (v.trim()) commentDrafts.set(draftKey(it.number), v);
      else commentDrafts.delete(draftKey(it.number));
      syncSend();
    },
    onSubmit: () => {
      if (!send.disabled) send.click();
    },
  });
  const ta = ed.textarea;
  // Quote reply writes here. Cleared by the next detail render, which replaces
  // this composer with its own.
  reply.box = ed;
  const crow = el("div", "gh-composer-actions");
  const send = el("button", "btn btn-primary") as HTMLButtonElement;
  send.append(glyph("comment"), span(l10n.t("Comment")));
  const syncSend = (): void => {
    const ready = ed.get().trim().length > 0;
    send.disabled = !ready;
    send.title = ready ? l10n.t("Post this comment") : l10n.t("Write something first");
  };
  syncSend();
  send.addEventListener("click", () => void postComment(it.number, ta, send, reload));
  const draftChip = aiChip(l10n.t("Draft a reply"), () =>
    void streamInto(
      "assist",
      // Sent to the AI model, not rendered in the UI — not translated.
      { description: `Draft a concise, helpful reply comment for this GitHub issue. Output only the comment text.\n\n${aiCtx()}` },
      ta,
      draftChip as HTMLButtonElement,
    ),
  );
  draftChip.hidden = true;
  void aiEnabled().then((ok) => (draftChip.hidden = !ok));
  crow.append(draftChip, send);
  composer.append(ed.root, crow);
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
    toast(l10n.t("Write a comment first."), "info");
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  ta.disabled = true;
  try {
    const r = await host.invoke("issue:comment", { number: n, body });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't post the comment."), "error");
      return;
    }
    toast(l10n.t("Comment posted."), "success");
    commentDrafts.delete(draftKey(n));
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't post the comment."), "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
    ta.disabled = false;
  }
}

/** Lock or unlock the conversation, and say what happened. */
/** Re-order the loaded page. A copy — the cache's array is shared. */
function sortIssues(items: IssueInfo[], issueSort: IssueSort): IssueInfo[] {
  const out = [...items];
  const reactions = (it: IssueInfo): number => it.reactions?.total ?? 0;
  switch (issueSort) {
    case "updated":
      return out; // the API's own order — do not re-sort what is already right
    case "newest":
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    case "oldest":
      return out.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    case "commented":
      return out.sort((a, b) => b.comments - a.comments);
    case "reactions":
      return out.sort((a, b) => reactions(b) - reactions(a));
  }
}

/** The release an issue is aimed at, worn beside its labels. */
function milestoneChip(title: string): HTMLElement {
  const m = span("", "sec-milestone");
  m.append(glyph("milestone"), span(title));
  m.title = l10n.t("Milestone: {0}", title);
  return m;
}

async function setLocked(
  number: number,
  locked: boolean,
  reason: string | undefined,
  reload: () => void,
): Promise<void> {
  const r = await host.invoke("issue:setLocked", { number, locked, reason });
  if (!r.ok) {
    toast(
      r.message ??
        (locked
          ? l10n.t("Couldn't lock the conversation.")
          : l10n.t("Couldn't unlock the conversation.")),
      "error",
    );
    return;
  }
  toast(locked ? l10n.t("Conversation locked.") : l10n.t("Conversation unlocked."), "success");
  bust("issue");
  reload();
}

async function changeState(
  n: number,
  state: "open" | "closed",
  btn: HTMLElement,
  reload: () => void,
  reason?: "completed" | "not_planned",
): Promise<void> {
  (btn as HTMLButtonElement).disabled = true;
  try {
    const r = await host.invoke("issue:setState", { number: n, state, reason });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't update the issue."), "error");
      return;
    }
    toast(
      state === "closed"
        ? reason === "not_planned"
          ? l10n.t("Closed #{0} as not planned.", n)
          : l10n.t("Closed issue #{0}.", n)
        : l10n.t("Reopened issue #{0}.", n),
      "success",
    );
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't update the issue."), "error");
  } finally {
    (btn as HTMLButtonElement).disabled = false;
  }
}

async function labelsMenu(anchor: HTMLElement, it: IssueInfo, reload: () => void): Promise<void> {
  let repoLabels: RepoLabel[] = [];
  try {
    repoLabels = await gget("issue:labels", undefined, 60000);
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't load labels."), "error");
    return;
  }
  if (repoLabels.length === 0) {
    toast(l10n.t("This repo has no labels defined."), "info");
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
      toast(r.message ?? l10n.t("Couldn't update labels."), "error");
      return;
    }
    toast(l10n.t("Labels updated."), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't update labels."), "error");
  }
}

/** A picker of the repo's milestones (open first, progress as the sub line)
 *  plus a "No milestone" choice to clear. */
async function milestoneMenu(anchor: HTMLElement, it: IssueInfo, reload: () => void): Promise<void> {
  let ms: MilestoneInfo[] = [];
  try {
    ms = await gget("issue:milestones", undefined, 60000);
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't load milestones."), "error");
    return;
  }
  if (ms.length === 0) {
    toast(l10n.t("This repo has no milestones defined."), "info");
    return;
  }
  const ordered = [...ms].sort((a, b) => (a.state === b.state ? 0 : a.state === "open" ? -1 : 1));
  openMenu(
    anchor,
    [
      {
        label: l10n.t("No milestone"),
        icon: "circle-slash",
        current: !it.milestone,
        onClick: () => void applyMilestone(it.number, null, reload),
      },
      { separator: true },
      ...ordered.map((m) => {
        const total = m.openIssues + m.closedIssues;
        const progress = total > 0 ? l10n.t("{0}/{1} closed", m.closedIssues, total) : l10n.t("no issues");
        return {
          label: m.title,
          icon: "milestone",
          current: it.milestone?.number === m.number,
          sub: m.state === "closed" ? l10n.t("closed · {0}", progress) : progress,
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
      toast(r.message ?? l10n.t("Couldn't update the milestone."), "error");
      return;
    }
    toast(milestone == null ? l10n.t("Milestone cleared.") : l10n.t("Milestone updated."), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't update the milestone."), "error");
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
    assignees = await peoplePickerModal({
      title: l10n.t("Assignees"),
      okLabel: l10n.t("Save"),
      people,
      selected: current,
    });
  } else {
    const csv = await promptInline(
      l10n.t("Assignees"),
      l10n.t("comma-separated logins, e.g. octocat, hubot"),
      current.join(", "),
      l10n.t("Save"),
    );
    assignees = csv === null ? null : csv.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  }
  if (assignees === null) return;
  try {
    const r = await host.invoke("issue:setAssignees", { number: it.number, assignees });
    if (!r.ok) {
      toast(r.message ?? l10n.t("Couldn't update assignees."), "error");
      return;
    }
    toast(l10n.t("Assignees updated."), "success");
    reload();
  } catch (e) {
    toast(cleanErr(e) || l10n.t("Couldn't update assignees."), "error");
  }
}
