// The pull requests surfaces' wire: what a PR row IS, and what the Pull
// Requests list says to its host and hears back. Shared by the VS Code
// extension (a sidebar webview view) and — when it adopts the same list — the
// desktop app, so neither can drift from the other's idea of a row.
//
// The rules that fill these shapes (the queries, the mapping, the vocabulary)
// live in @gitstudio/engine/forge/prList and forge/pullRequests; this module
// is only the shapes, so the webview bundle and the host agree on them
// without either importing the other.
//
// THE LIST PAGE CONTRACT (packages/webview-ui/src/pr/list-main.ts):
// - the page posts `{ type: "ready" }` once it listens; the host answers with a
//   full `{ type: "state", state }` and sends a full state after every change;
// - every user action is a PrListMessage; the page keeps no GitHub state of
//   its own, only what is on screen (its menus, the search box's words);
// - a state older than the one on screen (`seq`) is ignored.

// ── A pull request, as a row ─────────────────────────────────────────────────

/** A PR's display state: merged beats closed beats draft beats open. */
export type PrKind = "open" | "draft" | "merged" | "closed";

export type CiState = "success" | "failure" | "pending" | "none";

/** A commit's checks: the state, and how many of them say what. */
export interface CiRollup {
  state: CiState;
  total: number;
  failed: number;
  pending: number;
}

/** What a PR's reviews add up to, as GitHub decides it. */
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface PrPerson {
  login: string;
  avatarUrl: string | null;
}

/** Someone asked to review: a person, or a team (its slug). */
export interface PrReviewRequest {
  login?: string;
  team?: string;
  avatarUrl?: string | null;
}

/** One row of the list: everything it shows, and what its actions need. */
export interface PrListItem {
  number: number;
  title: string;
  url: string;
  kind: PrKind;
  draft: boolean;
  /** GitHub's REST state: `closed` for merged too. */
  state: "open" | "closed";
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: PrPerson | null;
  headRef: string;
  headSha: string;
  /** Who owns the head branch's repository (a fork's owner). */
  headOwner: string | null;
  /** "owner/repo" of the head branch — null when that fork was deleted. */
  headRepo: string | null;
  headUrl: string | null;
  baseRef: string;
  baseSha: string;
  /** The head lives in another repository: a fork. */
  isFork: boolean;
  maintainerCanModify: boolean;
  labels: { name: string; color: string }[];
  assignees: PrPerson[];
  reviewRequests: PrReviewRequest[];
  reviewDecision?: ReviewDecision;
  ci: CiRollup;
  comments: number;
  /** "owner/repo" the pull request belongs to. */
  repository: string;
}

// ── The list's question ──────────────────────────────────────────────────────

/** The list's segments. GitHub has no "merged" state; this list does. */
export type PrListState = "open" | "merged" | "closed" | "all";

/**
 * What narrows the list. A person is a login, or `@me` (whoever is signed
 * in); an assignee may also be `@none` — no one. (`none` alone is a login a
 * GitHub account can have.)
 */
export interface PrListFilters {
  /** Words GitHub looks for in titles and descriptions. */
  text?: string;
  author?: string;
  /** Asked to review — `@me` includes the teams you are in. */
  reviewRequested?: string;
  assignee?: string;
  /** A label's name. */
  label?: string;
}

export type PrFacet = Exclude<keyof PrListFilters, "text">;

export interface PrListCounts {
  open: number;
  merged: number;
  closed: number;
}

// ── The list view: host → page ───────────────────────────────────────────────

/** A repository the list can show: the one origin was forked from, or a remote's. */
export interface PrListTarget {
  /** "owner/repo". */
  id: string;
  owner: string;
  repo: string;
  /** Why it is offered, in words: "origin was forked from it", "remote origin — your fork". */
  detail: string;
}

/** Something a message's button does. */
export type PrListAction =
  | { kind: "signIn"; again?: boolean }
  | { kind: "retry" }
  /** Ask again for the next page (one that failed to come). */
  | { kind: "loadMore" }
  | { kind: "openUrl"; url: string }
  | { kind: "createPr" }
  | { kind: "clearFilters" }
  | { kind: "switchRepository" };

export interface PrListButton {
  label: string;
  /** A codicon name. */
  icon?: string;
  primary?: boolean;
  /** What it does, in words, when the label alone doesn't say it all. */
  title?: string;
  action: PrListAction;
}

/** A whole-view message (no repository, not on GitHub, signed out, a failed first load) or a notice above the rows. */
export interface PrListMessage {
  /** A codicon name. */
  icon: string;
  tone: "info" | "warning" | "error";
  title: string;
  detail?: string;
  buttons: PrListButton[];
}

/** A row, as the list draws it. */
export interface PrRowView extends PrListItem {
  /** Its branch is the one checked out here. */
  checkedOut: boolean;
}

export interface PrListViewState {
  /** Increases with every state the host sends; the page ignores anything older. */
  seq: number;
  /**
   * `loading`: the first page is on its way (skeleton rows). `list`: rows
   * (or none, said per segment). `message`: the view has nothing to list —
   * `message` says why and what to do.
   */
  status: "loading" | "list" | "message";
  message?: PrListMessage;
  /** Said above the rows: a refresh that failed, a list GitHub cut short. */
  notice?: PrListMessage;
  /** Every repository the list can show; a switcher when there is more than one. */
  targets: PrListTarget[];
  /** The one shown (a target's id). */
  target?: string;
  /** Who is signed in. */
  viewer?: PrPerson;
  segment: PrListState;
  filters: PrListFilters;
  /** The segments' counts with the filters applied, once known. */
  counts?: PrListCounts;
  rows: PrRowView[];
  /** How many match — the rows are the first `rows.length` of them. */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** A load or refresh is on its way while the rows on screen stay. */
  refreshing: boolean;
  /** What the filter menus offer, once asked for. */
  facetOptions?: {
    labels: { name: string; color: string }[];
    people: PrPerson[];
    truncated: boolean;
  };
  /** The facet options are being read. */
  facetOptionsLoading?: boolean;
  /** The host's clock (epoch ms), so ages read the same in a test as on screen. */
  now: number;
}

export type PrListHostMessage = { type: "state"; state: PrListViewState };

// ── The list view: page → host ───────────────────────────────────────────────

export type PrListMessageToHost =
  | { type: "ready" }
  | { type: "segment"; segment: PrListState }
  /** The whole filter set: the search box's words and every facet. */
  | { type: "filters"; filters: PrListFilters }
  | { type: "loadMore" }
  | { type: "refresh" }
  /** Open the pull request's page. */
  | { type: "open"; number: number }
  | { type: "checkout"; number: number }
  | { type: "startReview"; number: number }
  | { type: "merge"; number: number }
  | { type: "openOnGitHub"; number: number }
  | { type: "copyLink"; number: number }
  /** Show another repository's pull requests (a target's id). */
  | { type: "target"; id: string }
  /** The filter menus want their labels and people. */
  | { type: "facetOptions" }
  | { type: "action"; action: PrListAction };
