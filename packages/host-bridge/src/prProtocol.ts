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

// ── The pull request's page ──────────────────────────────────────────────────
//
// THE PAGE CONTRACT (packages/webview-ui/src/pr/page-main.ts): the same as the
// list's — `ready` from the page once it listens, then a full
// `{ type: "state", state }` from the host after every change; the page keeps
// no GitHub state of its own, only what is on screen (which tab, what is
// typed, which commit is open). A state older than the one on screen (`seq`)
// is ignored.

/** A review's verdict, as GitHub records it. */
export type PrReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

/** GitHub's `mergeStateStatus`: whether, and why not, it can be merged now. */
export type PrMergeState = "CLEAN" | "UNSTABLE" | "HAS_HOOKS" | "BEHIND" | "BLOCKED" | "DIRTY" | "DRAFT" | "UNKNOWN";

export type PrMergeMethod = "merge" | "squash" | "rebase";

/** The viewer's role in the repository (GraphQL's viewerPermission). */
export type PrPermission = "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ";

/** Someone the pull request asks, or asked, to review it. */
export interface PrReviewer {
  login?: string;
  team?: string;
  avatarUrl?: string | null;
  /** Their latest verdict, when they gave one. */
  verdict?: PrReviewState;
  /** Asked, and not answered since. */
  requested: boolean;
}

/** One comment in a review thread (or a pending one of yours). */
export interface PrThreadComment {
  id: string;
  author: PrPerson | null;
  body: string;
  createdAt: string;
  url: string;
  /** Sent, and GitHub hasn't answered yet. */
  sending?: boolean;
}

/** A review thread: comments on one place in one file. */
export interface PrThread {
  id: string;
  path: string;
  /** Where it sits in the diff as it is now; null when the code moved on (outdated). */
  line: number | null;
  startLine: number | null;
  /** Where it sat when it was written. */
  originalLine: number | null;
  side: "LEFT" | "RIGHT";
  resolved: boolean;
  outdated: boolean;
  resolvedBy?: string;
  canResolve: boolean;
  canUnresolve: boolean;
  canReply: boolean;
  /** The review it was written in (a timeline review's id). */
  reviewId?: string;
  comments: PrThreadComment[];
  /** How many comments it has on GitHub (more than `comments` when cut short). */
  totalComments: number;
}

export type PrTimelineEvent = "merged" | "closed" | "reopened" | "ready" | "draft" | "forcePushed" | "reviewRequested" | "reviewDismissed";

/** One thing that happened on the pull request, oldest first. */
export type PrTimelineItem =
  | { kind: "comment"; id: string; author: PrPerson | null; body: string; createdAt: string; url: string; sending?: boolean }
  | {
      kind: "review";
      id: string;
      author: PrPerson | null;
      state: PrReviewState;
      body: string;
      createdAt: string;
      url: string;
      sending?: boolean;
    }
  | { kind: "event"; id: string; event: PrTimelineEvent; actor: PrPerson | null; createdAt: string; detail?: string };

/** One commit of the pull request. */
export interface PrCommit {
  sha: string;
  shortSha: string;
  headline: string;
  body: string;
  /** The GitHub account, when the commit's email belongs to one. */
  author: PrPerson | null;
  authorName: string;
  committedAt: string;
  ci: CiState;
}

/** A check run's (or a commit status's) result, in the page's terms. */
export type PrCheckState = "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled";

/** One check on the pull request's head: a check run, or a legacy commit status. */
export interface PrCheck {
  name: string;
  /** "Code OSS" — the workflow a run belongs to. */
  workflow?: string;
  /** "GitHub Actions" — the app that ran it. */
  app?: string;
  state: PrCheckState;
  /** GitHub's own word: its conclusion or status ("TIMED_OUT", "QUEUED"). */
  raw: string;
  startedAt?: string;
  completedAt?: string;
  /** Where its log or details are. */
  url?: string;
  required: boolean;
  /** A status's description. */
  description?: string;
}

/** Everything the page draws of a pull request, as GitHub answers one question for it. */
export interface PrDetail {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  kind: PrKind;
  draft: boolean;
  state: "open" | "closed";
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: PrPerson | null;
  mergedBy: PrPerson | null;
  headRef: string;
  headSha: string;
  headOwner: string | null;
  headRepo: string | null;
  baseRef: string;
  baseSha: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  mergeState: PrMergeState;
  reviewDecision?: ReviewDecision;
  labels: { name: string; color: string }[];
  assignees: PrPerson[];
  reviewers: PrReviewer[];
  ci: CiRollup;
  /** Oldest first — the latest `timelineTotal` at most GitHub was asked for. */
  timeline: PrTimelineItem[];
  timelineTotal: number;
  threads: PrThread[];
  threadsTotal: number;
  commits: PrCommit[];
  checks: PrCheck[];
  checksTotal: number;
  viewer: {
    login?: string;
    avatarUrl?: string | null;
    permission: PrPermission;
    /** The viewer opened it (GitHub takes no approval from its author). */
    isAuthor: boolean;
    /** May close, reopen, mark ready. */
    canUpdate: boolean;
    canUpdateBranch: boolean;
    canDeleteBranch: boolean;
  };
  repo: {
    /** "owner/repo". */
    id: string;
    mergeMethods: PrMergeMethod[];
    /** The method GitHub offers this viewer first. */
    defaultMethod?: PrMergeMethod;
    /** GitHub deletes the head branch itself after a merge. */
    deleteBranchOnMerge: boolean;
  };
}

/** A changed file, as the Files tab lists it. */
export interface PrPageFile {
  path: string;
  /** A rename's (or copy's) old path. */
  previousPath?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** GitHub sent no diff: a binary file, or one too large to diff. */
  noDiff: boolean;
}

export type PrPageTab = "conversation" | "commits" | "checks" | "files";

/** A queued review comment, as the page lists it. */
export interface PrPendingComment {
  path: string;
  line: number;
  startLine?: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Your review of this pull request, not yet sent. */
export interface PrPendingReview {
  comments: PrPendingComment[];
  /** Started (Start Review), with or without comments yet. */
  started: boolean;
  /** The head the comments were written on. */
  headSha: string;
  /** It isn't the pull request's head any more: the comments are on older code. */
  stale: boolean;
}

/** Something the page is doing for you: what it says while it runs. */
export type PrPageBusy =
  | "merge"
  | "close"
  | "reopen"
  | "ready"
  | "updateBranch"
  | "comment"
  | "review"
  | "checkout"
  | `reply:${string}`
  | `resolve:${string}`;

export interface PrPageViewState {
  seq: number;
  /**
   * `loading`: the first answer is on its way (the page draws what the list
   * already knew, `preview`). `ready`: `pr` is GitHub's. `message`: the page
   * has nothing to show — `message` says why and what to do.
   */
  status: "loading" | "ready" | "message";
  message?: PrListMessage;
  /** Said above the page: a refresh or an action that failed, and what can be done. */
  notice?: PrListMessage;
  /** "owner/repo". */
  repo: string;
  number: number;
  /** The tab the page opens on (the one last shown for this pull request). */
  tab: PrPageTab;
  /** What the list knew, drawn while the page loads. */
  preview?: { title: string; kind: PrKind; author: PrPerson | null; headRef: string; baseRef: string };
  pr?: PrDetail;
  files?: {
    items: PrPageFile[];
    /** GitHub lists at most 3,000; the total is the pull request's own. */
    truncated: boolean;
    error?: string;
  };
  /** A commit's files, once asked for (by sha). */
  commitFiles: Record<string, { status: "loading" | "loaded" | "failed"; files?: PrPageFile[]; error?: string }>;
  review?: PrPendingReview;
  busy: PrPageBusy[];
  refreshing: boolean;
  /** Its head branch is the one checked out here. */
  checkedOut: boolean;
  /** Where the page opens, when the host asks: a tab, and a box to open (`seq` makes each ask new). */
  focus?: { seq: number; tab?: PrPageTab; open?: "merge" | "review" };
  /** Text to put back in a box whose message failed to send (keyed "comment", "review", "reply:<thread id>"). */
  restore?: { seq: number; key: string; body: string };
  /** A box whose message GitHub took: the page empties it (and closes the review box). */
  sent?: { seq: number; key: string };
  /** The host's clock (epoch ms). */
  now: number;
}

export type PrPageHostMessage = { type: "state"; state: PrPageViewState };

export type PrPageMessageToHost =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "tab"; tab: PrPageTab }
  | { type: "checkout" }
  | { type: "openOnGitHub" }
  | { type: "copyLink" }
  /** A link in a body, a check's details, a person. https only; the host checks. */
  | { type: "openUrl"; url: string }
  /** `#12` or `owner/repo#12` in a body: its page if it is a pull request, else GitHub's. */
  | { type: "openRef"; repo?: string; number: number }
  | { type: "merge"; method: PrMergeMethod; title?: string; deleteBranch: boolean }
  | { type: "updateBranch" }
  | { type: "close" }
  | { type: "reopen" }
  | { type: "markReady" }
  | { type: "comment"; body: string }
  | { type: "reply"; threadId: string; body: string }
  | { type: "resolve"; threadId: string; resolved: boolean }
  /** Open a changed file's diff (at a line, for a thread or a pending comment). */
  | { type: "openFile"; path: string; line?: number; side?: "LEFT" | "RIGHT" }
  | { type: "expandCommit"; sha: string }
  | { type: "openCommitFile"; sha: string; path: string }
  | { type: "startReview" }
  | { type: "submitReview"; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string }
  | { type: "discardReview" }
  | { type: "action"; action: PrListAction };

// ── A new pull request ───────────────────────────────────────────────────────
//
// THE FORM CONTRACT (packages/webview-ui/src/pr/create-main.ts): the same as
// the page's — `ready` from the form once it listens, then a full
// `{ type: "state", state }` from the host after every change. The form keeps
// what is typed and picked (title, description, draft, reviewers, labels,
// assignees) and takes the host's PROPOSED title and description only while
// the field is untouched: `proposed.key` changes when what they were proposed
// from (head, base, template) does.

/** A commit the pull request will have. */
export interface PrCreateCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** ISO time it was committed. */
  date: string;
}

/** A file the pull request will change, against the merge base. */
export interface PrCreateFile {
  path: string;
  /** A rename's old path. */
  previousPath?: string;
  status: PrPageFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface PrCreateLabel {
  name: string;
  /** Six hex digits, no `#`. */
  color: string;
  description?: string;
}

/** Where the pull request's branch is, or will be, on GitHub. */
export interface PrCreateHead {
  /** The local branch. */
  branch: string;
  /** The remote it is (or will be) pushed to. */
  remote?: string;
  /** The owner of that remote's repository — a fork's owner. */
  owner?: string;
  /** What GitHub is sent as the head: `branch`, or `owner:branch` from a fork. */
  ref: string;
  /**
   * `new`: not on the remote yet. `ahead`: commits to push. `pushed`: up to
   * date there. `diverged`: the remote has commits this branch doesn't.
   * `unknown`: no remote to push it to.
   */
  push: "new" | "ahead" | "pushed" | "diverged" | "unknown";
  ahead: number;
  behind: number;
}

export interface PrCreateViewState {
  seq: number;
  /** `loading`: the first read is on its way. `message`: nothing to create from — why, and what to do. */
  status: "loading" | "ready" | "message";
  message?: PrListMessage;
  /** Said above the form: a read or a create that failed, and what can be done. */
  notice?: PrListMessage;
  /** The repositories it can be opened on; a switcher when there is more than one. */
  targets: PrListTarget[];
  /** The one it opens on ("owner/repo"). */
  target: string;
  viewer?: PrPerson;
  /** The local branches it can be opened from. */
  branches: { name: string; current: boolean }[];
  head?: PrCreateHead;
  /** The clone's GitHub remotes the head can be pushed to: its name, "owner/repo", and "your fork" / "where it opens". */
  pushRemotes?: { name: string; repo: string; detail?: string }[];
  /** The branches it can go into, the default first. */
  bases: { name: string; isDefault: boolean }[];
  base?: string;
  compare: {
    status: "idle" | "loading" | "ready" | "failed";
    /** Newest first; at most the first few hundred. */
    commits: PrCreateCommit[];
    commitsTotal: number;
    files: PrCreateFile[];
    additions: number;
    deletions: number;
    error?: string;
    /** Compared with the base as last fetched: GitHub couldn't be asked for it now. */
    stale?: boolean;
  };
  /** What the form proposes for an untouched title and description. */
  proposed: { key: string; title: string; body: string; bodyFrom: "template" | "commit" | "commits" | "empty" };
  /** The repository's pull request templates. */
  templates: { filename: string }[];
  template?: string;
  /** Who and what can be asked for, once read. */
  options?: { labels: PrCreateLabel[]; people: PrPerson[]; truncated: boolean };
  /** The viewer may set reviewers, labels and assignees on this repository. */
  canSetMetadata: boolean;
  /** Why they can't, in words. */
  metadataNote?: string;
  /** An open pull request this head already has. */
  existing?: { number: number; title: string; url: string; draft: boolean };
  /** Why Create can't run as things are, in words (nothing to compare, head is base, one exists). */
  problem?: string;
  busy?: "create" | "ai";
  /** An AI draft of the description is offered. */
  ai: boolean;
  /** A drafted description, to put in the box (`seq` makes each one new). */
  aiBody?: { seq: number; body: string };
  refreshing: boolean;
  /** The host's clock (epoch ms). */
  now: number;
}

export type PrCreateHostMessage = { type: "state"; state: PrCreateViewState };

export interface PrCreateRequest {
  title: string;
  body: string;
  draft: boolean;
  reviewers: string[];
  assignees: string[];
  labels: string[];
}

export type PrCreateMessageToHost =
  | { type: "ready" }
  | { type: "target"; id: string }
  | { type: "head"; branch: string }
  /** Push the head to another of the clone's GitHub remotes. */
  | { type: "pushRemote"; remote: string }
  | { type: "base"; branch: string }
  /** A template's filename, or null for none. */
  | { type: "template"; filename: string | null }
  /** Open a file's diff, base against head. */
  | { type: "openFile"; path: string }
  | { type: "openExisting" }
  | { type: "aiDraft" }
  | { type: "refresh" }
  | { type: "cancel" }
  | ({ type: "create" } & PrCreateRequest)
  | { type: "action"; action: PrListAction };
