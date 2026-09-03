// The desktop IPC contract: the typed request/response shapes that flow over
// Electron's `ipcMain.handle` / `ipcRenderer.invoke` bridge. This module is
// shared by the main process (which implements the handlers), the preload
// (which forwards them across the contextBridge), and the renderer (which calls
// them through `window.gitstudio`). It is TYPE-ONLY and imports nothing
// host-specific, so the renderer (browser) and main (Node) bundles both carry it.

import type { WireRow, RowStat } from "@gitstudio/host-bridge/graphProtocol";
import type { CommitDetailsPayload } from "@gitstudio/host-bridge/commitDetailsProtocol";

export type { RowStat, CommitDetailsPayload };

/** A repo the user has opened, surfaced in the "recent" list + sidebar header. */
export interface RepoInfo {
  /** Absolute repo root (the `rev-parse --show-toplevel`). */
  root: string;
  /** Last path segment of the root — the display name. */
  name: string;
}

/** A ref decoration listed in the sidebar (branch / remote / tag). */
export interface RefInfo {
  type: "head" | "remote" | "tag" | "stash";
  name: string;
  fullName: string;
  sha: string;
  isCurrent: boolean;
  upstream?: string;
  /** The tracked upstream no longer exists (git's `[gone]`). */
  gone?: boolean;
  /** Tip commit date, epoch seconds. */
  date?: number;
  /** Tip commit subject — what this ref actually points at. */
  subject?: string;
  /** "tag" for an ANNOTATED tag, "commit" otherwise. */
  objectType?: string;
  /** For a remote's own HEAD ref, the DEFAULT branch it points at. (Written
   *  without the literal path, because the star-slash in it closes a comment.) */
  symref?: string;
}

/** The current HEAD, for the sidebar's "on branch …" affordance. */
export interface HeadInfo {
  detached: boolean;
  branch?: string;
  sha: string;
}

/** A page of graph rows plus the paging cursor the renderer feeds back. */
export interface GraphPage {
  rows: WireRow[];
  head: string;
  totalColumns: number;
  hasMore: boolean;
  /** Skip cursor for the next page request. */
  nextSkip: number;
}

/** One changed file in a commit or in the working tree. */
export interface ChangedFile {
  path: string;
  /** Single-letter git status: A(dded) M(odified) D(eleted) R(enamed) … */
  status: string;
  /**
   * The path on the BASE side, when this is a rename or a copy.
   *
   * The base does not have the file under its new name, so a diff asked for
   * `path` on both sides comes back empty on the left and renders a rename as
   * a brand-new file. Callers pass this as `compare:fileDiff`'s `leftPath`.
   */
  oldPath?: string;
  /** Present for working-tree changes: is the change staged (in the index)? */
  staged?: boolean;
  /**
   * An UNMERGED path — a merge conflict, not an edit.
   *
   * Porcelain v1's two status columns normally mean index-half and
   * worktree-half, which is what the parser assumed. For an unmerged path they
   * mean something else entirely: the two SIDES of the merge. Reading `UD` as
   * "staged U, unstaged D" produced two rows for one file, one of them claiming
   * a deletion of a file sitting on disk, and the phantom "staged" copy carried
   * an Unstage button that destroys the merge stages.
   *
   * Nothing downstream could tell a conflict from an edit because nothing said
   * so. This is that flag.
   */
  conflicted?: boolean;
  /** For an unmerged path, the raw two-letter code (UU, AA, DU, UD, …). */
  conflictKind?: string;
}

/** One entry in a HEAD directory listing, for the GitHub-style Code browser. */
export interface TreeEntry {
  /** Last path segment — the display name. */
  name: string;
  /** Repo-root-relative path (POSIX separators), e.g. "src/main/main.ts". */
  path: string;
  /** "tree" = folder, "blob" = file. */
  type: "tree" | "blob";
  /** Blob size in bytes (from `ls-tree --long`); omitted for trees. */
  size?: number;
}

/** A blob's text content at HEAD, for the read-only file viewer. */
export interface RepoFile {
  path: string;
  /** Decoded text. Empty string when binary or over the cap. */
  text: string;
  /** True when the file exceeded the size cap and was not read. */
  truncated?: boolean;
  /** True when a NUL byte was detected — not rendered as text. */
  binary?: boolean;
}

/** The tip commit of HEAD, for the Code browser's "latest commit" bar. */
export interface HeadCommit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /** Authored timestamp, epoch seconds. */
  date: number;
  subject: string;
  /**
   * The complete message — subject, blank line, body, trailers. Amend prefills
   * from THIS, never from `subject`: committing back a subject-only message
   * deletes the body and every trailer (Co-Authored-By, Signed-off-by) with no
   * warning, because that is exactly what the user appears to have typed.
   */
  message: string;
  /** Total commits reachable from HEAD. */
  total: number;
}

/** A commit's full details for the right-hand details panel. */
export interface CommitDetails {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Epoch SECONDS — what git's `%at` gives, and what `relTime`/`absTime` in
   *  the renderer take. Passing milliseconds reads as "just now" forever,
   *  because the negative delta is clamped to zero. */
  authorDate: number;
  committer: string;
  committerEmail: string;
  /** Epoch seconds — see `authorDate`. */
  committerDate: number;
  subject: string;
  body: string;
  files: ChangedFile[];
}

/** The two sides of a file diff, ready to drop into the shared DiffView. */
export interface FileDiff {
  path: string;
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  /** True when the file is conflicted — the renderer opens the 3-pane merge. */
  conflicted: boolean;
  /**
   * The INDEX version, sent only for working-tree diffs.
   *
   * The diff itself is HEAD vs the working tree; the index is the third text the
   * staging ticks need to say whether each change is already staged. It rides
   * along on this response rather than a second round trip so the ticks can
   * never describe a different revision than the panes they sit between.
   * Undefined for a commit diff, which has nothing to stage.
   */
  indexText?: string;
  /**
   * This file is BINARY, so there is no text diff to show.
   *
   * `git show` on a PNG or a font decodes to a wall of U+FFFD (or, with a NUL
   * byte in it, to nothing). Handing that to a diff editor produced two empty
   * panes and no explanation — "the diff doesn't show". The renderer says so
   * instead of mounting an editor over nothing.
   */
  binary?: boolean;
  /** One side was longer than the read cap and is shown only in part. */
  truncated?: boolean;
  /**
   * The file is not on disk.
   *
   * Two empty sides are not always an empty file: a path added to the index and
   * then deleted from the working tree (git's `AD`) reads as empty on both
   * sides of a HEAD-vs-working diff, and calling that "an empty file" is a
   * different claim from "you deleted it". The producer knows which; the panel
   * cannot tell from the text.
   */
  deleted?: boolean;
  /**
   * The file exists on ONE side only.
   *
   * For a text file the two panes show this plainly. For a BINARY one both
   * texts are empty by construction — the producer refuses to decode it — so
   * nothing downstream could tell an added image from a deleted one from an
   * edited one, and all three were described as "its contents changed".
   */
  onlySide?: "added" | "deleted";
}

/** One change since HEAD, and how much of it the index already holds. */
export interface ChangeBlockWire {
  head: { start: number; end: number };
  working: { start: number; end: number };
  state: "staged" | "unstaged" | "partial";
}

/** The three sides of a conflicted file, for the shared MergeView. */
export interface ConflictModel {
  path: string;
  hasBase: boolean;
  base: string;
  ours: string;
  theirs: string;
  result: string;
  oursLabel: string;
  theirsLabel: string;
  /** No text to merge — the file is binary on at least one side. */
  binary?: boolean;
  /** The working copy was read only in part, so `result` is not the file and
   *  writing it back would truncate it. No text merge is possible. */
  truncated?: boolean;
  /** A MODIFY/DELETE conflict: this side has no version of the file at all
   *  (the index holds no stage for it). Not the same as a side that emptied
   *  it, which is what an empty string alone looks like. */
  missingSide?: "ours" | "theirs";
  /**
   * NEITHER side has this file — git's `DD`.
   *
   * Distinct from a modify/delete: the index lists the path with stage 1 and
   * neither 2 nor 3. Folded into `missingSide` it was drawn as "changed on one
   * side, deleted on the other" and offered a "Take <side>" button for a side
   * that has nothing to take, which `conflictTakeSide` then refuses.
   */
  bothDeleted?: boolean;
}

/** A git action requested from the graph context menu. */
export interface CommitActionRequest {
  action:
    /** Detaching checkout of the commit itself. */
    | "checkout"
    /**
     * Check out a REF that sits on this commit — the branch, not the commit
     * (issues #12/#19). `name` carries the ref and `refKind` how to treat it: a
     * local branch attaches by name, a remote one creates a local tracking
     * branch, a tag detaches (which is the only case where detaching is right).
     */
    | "checkout-ref"
    | "branch"
    | "tag"
    | "cherry-pick"
    | "revert"
    | "reset-soft"
    | "reset-mixed"
    | "reset-hard"
    | "copy-sha";
  sha: string;
  /** Free-text argument (a new branch/tag name, or the ref for checkout-ref). */
  name?: string;
  /** For checkout-ref: what kind of ref `name` is. */
  refKind?: "head" | "remote" | "tag";
}

export interface CommitActionResult {
  ok: boolean;
  /** True when the repo state changed and the graph should refresh. */
  changed: boolean;
  message?: string;
  /**
   * This failure is a condition the user can be in, not a defect — so it must
   * not be crash-reported. The renderer shows `message` exactly as before; only
   * the reporter treats it differently. Mirrors ExpectedError for the throwing
   * paths (see main/expectedError.ts).
   */
  expected?: boolean;
}

/** One tickable change within a file (see hunks:list). */
export interface FileHunkWire {
  index: number;
  /** 0-based line range in the working-tree file. */
  start: number;
  end: number;
  preview: string;
  lineCount: number;
}

/** A stash entry for the Stashes view. */
export interface StashInfo {
  sha: string;
  /** The selector git uses, e.g. "stash@{0}". */
  ref: string;
  message: string;
  /** Commit time, epoch seconds. */
  time: number;
}

/** A linked worktree for the Worktrees view. */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
  /** True when this worktree is the one the app currently has open. */
  current?: boolean;
}

/** One commit in a Compare result. */
export interface CompareCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** The rest of the message. `git log` already parses it; this used to drop
   *  it, so a commit list had no way to show a commit's reasoning. */
  body?: string;
  author: string;
  /** Author date, epoch seconds. */
  date: number;
  /** More than one parent — reads completely differently in a list. */
  isMerge?: boolean;
}

/** The result of comparing two refs (base…head). */
export interface CompareResult {
  /** Commits in `head` that are not in `base` (i.e. base..head), newest first. */
  commits: CompareCommit[];
  /** Files changed between base and head. */
  files: ChangedFile[];
  /** The REAL count of commits in base..head — not the length of `commits`,
   *  which is capped. See `commitsTruncated`. */
  ahead: number;
  behind: number;
  /** True when `commits` holds only the first N of `ahead`. The list has to be
   *  able to say so; a count that is silently a cap is worse than no count. */
  commitsTruncated?: boolean;
}

/** Diff range mode for Compare: ".." (direct) or "..." (since merge-base). */
export type CompareMode = "two-dot" | "three-dot";

/** Current-branch sync state for the top-bar sync widget. */
export interface SyncStatus {
  branch?: string;
  upstream?: string;
  /** Commits the local branch is ahead of its upstream. */
  ahead: number;
  /** Commits the local branch is behind its upstream. */
  behind: number;
  /** True when there's no upstream yet (branch not published). */
  noUpstream: boolean;
}

/** A branch with remote-tracking context, for the Branches manager. */
export interface BranchInfo {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /**
   * The upstream this branch tracks NO LONGER EXISTS (git's `[gone]`).
   *
   * The most common state in this app's own workflow — GitHub deletes the head
   * branch when a pull request merges — and it used to be thrown away in
   * `parseTrack`, so the branch read as `0 ahead, 0 behind`: perfectly in sync
   * with a remote that is not there. It is also the clearest signal that a
   * branch is finished and safe to delete.
   */
  gone?: boolean;
  /**
   * Divergence from the repository's DEFAULT branch, not from the upstream.
   *
   * A different and more useful question than ahead/behind-upstream: "how far
   * is this from main". `aheadDefault === 0` means every commit here is
   * already reachable from the default branch — which is what MERGED means,
   * and therefore what "safe to delete" means.
   *
   * Absent on git < 2.41, which does not have `%(ahead-behind:)`. Absent is
   * not zero: the UI must render nothing rather than a bar of zero.
   */
  aheadDefault?: number;
  behindDefault?: number;
  /** Every commit on this branch is reachable from the default branch. */
  merged?: boolean;
  /** Subject of the branch tip commit. */
  subject: string;
  /** Tip commit author date, epoch seconds. */
  date: number;
}

// ── GitHub (PRs / Issues / Projects) ──────────────────────────────────────────

export interface GitHubUser {
  login: string;
  avatarUrl: string | null;
}
export interface PrLabel {
  name: string;
  color: string;
}
export interface PrRef {
  ref: string;
  sha: string;
}
/** The emoji reaction tallies GitHub keeps on issues, PRs, and comments.
 *  Only non-zero buckets are rendered, so a quiet item shows nothing. */
export interface ReactionSummary {
  total: number;
  plusOne: number;
  minusOne: number;
  laugh: number;
  hooray: number;
  confused: number;
  heart: number;
  rocket: number;
  eyes: number;
}

/** How the author relates to the repo (OWNER / MEMBER / CONTRIBUTOR / …) —
 *  GitHub badges this next to a name and it's real signal about who's talking. */
export type AuthorAssociation = string;

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  htmlUrl: string;
  user: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
  head: PrRef;
  base: PrRef;
  labels: PrLabel[];
  comments?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Assigned users, so the detail rail can SHOW them (not just set them). */
  assignees?: GitHubUser[];
  /** Set when the PR was merged — "closed" and "merged" are different states. */
  mergedAt?: string | null;
  /** When it closed (merged or not). */
  closedAt?: string | null;
  /** Who actually pressed merge — often NOT the author. */
  mergedBy?: GitHubUser | null;
  /** Review-thread comment count (distinct from `comments`, the conversation). */
  reviewComments?: number;
  /** Commits in the PR. */
  commits?: number;
  /** Reviewers who were asked but haven't reviewed yet. */
  requestedReviewers?: GitHubUser[];
  milestone?: { number: number; title: string } | null;
  authorAssociation?: AuthorAssociation;
  /** "owner/repo" of the HEAD branch's repo — set when the PR comes from a
   *  fork, which changes how much you trust its CI. */
  headRepoFullName?: string | null;
  reactions?: ReactionSummary;
}
export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /**
   * Where a renamed or copied file came FROM.
   *
   * GitHub sends it and the mapper dropped it, so an `R` row could say a file
   * was renamed and never say from what — which is the only fact that makes a
   * rename readable. Costs nothing: it is in the response already.
   */
  previousFilename?: string;
}
/** A PR detail bundle for the PR detail panel. */
export interface PrDetail {
  pr: PullRequest;
  files: PrFile[];
  /** Combined CI state: "success" | "failure" | "pending" | "error" | "". */
  checks: string;
}
export interface IssueInfo {
  number: number;
  title: string;
  body: string | null;
  state: string;
  htmlUrl: string;
  user: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: PrLabel[];
  assignees: GitHubUser[];
  /** The issue's milestone, so the detail rail can SHOW it (not just set it). */
  milestone?: { number: number; title: string } | null;
  closedAt?: string | null;
  closedBy?: GitHubUser | null;
  /** "completed" | "not_planned" | "reopened" — GitHub renders a closed issue
   *  differently depending on WHY, and so must we (purple vs gray). */
  stateReason?: string | null;
  authorAssociation?: AuthorAssociation;
  reactions?: ReactionSummary;
}
export interface ProjectInfo {
  /** GraphQL node id (ProjectV2) — the handle for item queries + mutations. */
  id: string;
  number: number;
  title: string;
  shortDescription: string;
  url: string;
  itemCount: number;
  closed: boolean;
  updatedAt: string;
}

// ── Issues (CRUD) ──
export interface RepoLabel {
  name: string;
  color: string;
  description: string | null;
}
export interface IssueComment {
  id: number;
  author: GitHubUser | null;
  body: string;
  createdAt: string;
  /** Later than createdAt ⇒ the comment was edited after posting. */
  updatedAt?: string;
  authorAssociation?: AuthorAssociation;
  reactions?: ReactionSummary;
  /** Permalink to this comment on github.com — what "Copy link" copies. */
  htmlUrl?: string;
}
export interface IssueDetail {
  issue: IssueInfo;
  comments: IssueComment[];
  assignees: string[];
}
/** One entry on the My Work page: something in this repo that involves YOU —
 *  a review you were asked for, an item assigned to you, a PR you authored, or
 *  a mention. The workday-first surface (docs/desktop-redesign.md). */
export interface MyWorkItem {
  kind: "review-requested" | "assigned" | "my-prs" | "mentions";
  type: "issue" | "pr";
  number: number;
  title: string;
  state: string;
  draft: boolean;
  updatedAt: string;
  comments: number;
  author: string | null;
}

/** A unified, read-only issue/PR snapshot from ANY repo — for viewing a
 *  cross-repo notification subject in-app rather than opening github.com. */
export interface ExternalItemDetail {
  kind: "issue" | "pull";
  number: number;
  repo: string;
  title: string;
  state: string;
  body: string | null;
  htmlUrl: string;
  author: string | null;
  createdAt: string;
  comments: { author: string | null; body: string; createdAt: string }[];
}

// ── Pull Requests (CRUD) ──
export interface RepoCollaborator {
  login: string;
  avatarUrl: string | null;
}
export interface BranchRef {
  name: string;
  isDefault: boolean;
}
export interface CreatePrRequest {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}
export type PrReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export interface PrReviewRequest {
  number: number;
  event: PrReviewEvent;
  body?: string;
}

// ── Actions (control) ──
export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string;
  number: number;
  /** Step timing — the raw material for the per-step duration timeline. */
  startedAt: string;
  completedAt: string;
}
export interface WorkflowJob {
  id: number;
  /** The run this job belongs to (deep-link key). */
  runId: number;
  runAttempt: number;
  name: string;
  status: string;
  conclusion: string;
  htmlUrl: string;
  /** Queued time — `startedAt − createdAt` is the queue latency. */
  createdAt: string;
  startedAt: string;
  completedAt: string;
  steps: WorkflowStep[];
  /** WHERE it ran: the runner's name ("GitHub Actions 12") + group. */
  runnerName: string;
  runnerGroupName: string;
  /** The requested runner labels ("ubuntu-latest", "self-hosted"…). */
  labels: string[];
  workflowName: string;
  headBranch: string;
}
/** One increment of a job's log for the live-tail pipeline (see
 *  main/github/logTail.ts for the append/reset/truncate semantics). */
export interface LogDelta {
  text: string;
  totalLength: number;
  reset: boolean;
  truncated: boolean;
}
/** Server-side filters for the runs list — GitHub filters these at the API. */
export interface ActionsRunsFilter {
  workflowId?: number;
  branch?: string;
  actor?: string;
  /** Status OR conclusion (GitHub treats the param as either). */
  status?: string;
  event?: string;
}
export interface WorkflowRunDetail {
  run: WorkflowRun;
  jobs: WorkflowJob[];
}
export interface WorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
  htmlUrl: string;
}
export interface WorkflowDispatchInput {
  name: string;
  description: string;
  required: boolean;
  default: string;
  options?: string[];
  type: string;
}

// ── Releases ──
export interface ReleaseAsset {
  id: number;
  name: string;
  label: string | null;
  contentType: string;
  size: number;
  downloadCount: number;
  downloadUrl: string;
  createdAt: string;
  updatedAt: string;
}
export interface ReleaseInfo {
  id: number;
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  htmlUrl: string;
  author: GitHubUser | null;
  createdAt: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
}
export interface TagInfo {
  name: string;
  sha: string;
}
export interface ReleaseInput {
  id?: number;
  tagName: string;
  targetCommitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  /**
   * Whether this release becomes the repository's "Latest" one.
   *
   * GitHub's own composer asks; ours could not, so publishing an old
   * back-ported tag silently moved the Latest badge onto it. Undefined leaves
   * GitHub's default (it picks by date), which is what a caller that never
   * asked the question should get.
   */
  makeLatest?: boolean;
}

/** What GitHub's generate-notes endpoint answers with. */
export interface GeneratedNotes {
  name: string;
  body: string;
}

// ── Notifications ──
export interface NotificationThread {
  id: string;
  title: string;
  type: string;
  reason: string;
  repo: string;
  repoAvatarUrl: string | null;
  updatedAt: string;
  unread: boolean;
  htmlUrl: string;
  /** When you last read this thread (null = never). */
  lastReadAt?: string | null;
  /** The subject, parsed from subject.url — the key to deep-linking IN-APP
   *  instead of bouncing to github.com. See `subjectRef()` in github/maps.ts. */
  subjectKind?: "issue" | "pull" | "release" | "commit" | "discussion" | "other";
  /** Issue/PR/release number, when the subject has one. */
  subjectNumber?: number;
  /** Commit sha, for Commit subjects. */
  subjectSha?: string;
}
export interface NotificationActionResult {
  ok: boolean;
  message?: string;
  /** See CommitActionResult.expected — a condition, not a defect to report. */
  expected?: boolean;
}

// ── Organizations ──
export interface OrgInfo {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  description: string | null;
  htmlUrl: string;
}
export interface OrgRepo {
  name: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stargazersCount: number;
  pushedAt: string;
}
export interface OrgTeam {
  name: string;
  slug: string;
  description: string | null;
  privacy: string;
  htmlUrl: string;
}
export interface OrgMember {
  login: string;
  avatarUrl: string | null;
  htmlUrl: string;
}
/** The full repo record behind an org-repo peek (GET /repos/{owner}/{repo}). */
export interface OrgRepoDetail {
  fullName: string;
  description: string | null;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  openIssuesCount: number;
  forksCount: number;
  stargazersCount: number;
  topics: string[];
  license: string | null;
  language: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  pushedAt: string;
  createdAt: string;
  homepage: string | null;
}
/** One entry when browsing a REMOTE repo in-app (no clone needed). */
export interface GhRepoEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
}
/** A remote repo file's text (or why it can't be shown inline). */
export interface GhRepoFile {
  path: string;
  text: string;
  /** Too large for an inline look (the contents API caps at 1MB anyway). */
  truncated: boolean;
  binary: boolean;
  size: number;
}
/** A user profile for the member peek (GET /users/{login}). */
export interface GhUserInfo {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  htmlUrl: string;
  followers: number;
  following: number;
  publicRepos: number;
  createdAt: string;
  /** "User" or "Organization" — an account page renders differently for each. */
  type: string;
  twitter: string | null;
  email: string | null;
}

// ── Projects v2 (board) ──
export interface ProjectStatusOption {
  id: string;
  name: string;
  color: string;
}
export interface ProjectStatusField {
  id: string;
  name: string;
  options: ProjectStatusOption[];
}
export interface ProjectItem {
  id: string;
  type: string;
  title: string;
  number: number | null;
  state: string;
  url: string | null;
  author: string;
  statusOptionId: string | null;
  statusName: string;
  updatedAt: string;
}
export interface ProjectBoard {
  field: ProjectStatusField | null;
  items: ProjectItem[];
}

// ── Gists ──
export interface GistFile {
  filename: string;
  language: string;
  type: string;
  size: number;
  rawUrl: string;
  content: string;
  truncated: boolean;
}
export interface GistInfo {
  id: string;
  description: string;
  public: boolean;
  htmlUrl: string;
  owner: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  files: GistFile[];
  comments: number;
}
export interface GistCreate {
  description: string;
  filename: string;
  content: string;
  public: boolean;
}
export interface GistUpdate {
  id: string;
  description: string;
  filename: string;
  content: string;
  newFilename?: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** One branch of a remote repo (the Explore ref switcher). */
export interface GhRepoBranch {
  name: string;
  sha: string;
  protected: boolean;
}

/** Every blob path in a remote repo — the go-to-file index. */
export interface GhRepoPaths {
  paths: string[];
  /** GitHub truncated the tree, or we capped it. Say so; never pretend. */
  truncated: boolean;
  /** How many blobs the tree actually had (before our cap). */
  total: number;
}

// ── Global GitHub search (Explore) ──

/** One repository in a search result. */
export interface SearchRepoItem {
  id: number;
  fullName: string;
  owner: string;
  ownerAvatarUrl: string | null;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  updatedAt: string;
  pushedAt: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  topics: string[];
  license: string | null;
  htmlUrl: string;
  defaultBranch: string;
}

/** One person or organization in a search result. */
export interface SearchUserItem {
  login: string;
  avatarUrl: string | null;
  htmlUrl: string;
  /** "User" or "Organization". */
  type: string;
}

/** One code hit. GitHub's code search returns the FILE, plus optional
 *  text-match fragments when the text-match media type is requested. */
/**
 * One matching fragment of a code-search hit, plus WHERE in it the query
 * matched.
 *
 * The offsets were being thrown away, so a code search — whose whole job is
 * "find me this string" — rendered three lines of code with nothing marking
 * the string. GitHub sends them; we simply did not carry them.
 */
export interface SearchCodeFragment {
  text: string;
  /** [start, end) character offsets into `text`, from GitHub's text_matches. */
  ranges: Array<[number, number]>;
}

export interface SearchCodeItem {
  name: string;
  path: string;
  repoFullName: string;
  htmlUrl: string;
  /** Matching line fragments, when GitHub returned them. */
  fragments: SearchCodeFragment[];
}

/** One page of results, plus the honesty the UI needs to render it. */
export interface SearchPage<T> {
  items: T[];
  /** What GitHub says matched — can exceed what's reachable (1000 cap). */
  totalCount: number;
  /** GitHub gave up early and the results are partial. */
  incomplete: boolean;
  /** True when another page exists AND is within the 1000-result ceiling. */
  hasMore: boolean;
  /** Set instead of items when the local rate budget is spent. */
  limited?: { retryInMs: number };
}

export type SearchSort = "best" | "stars" | "updated";

/** One repository copy on this machine (Settings → Repositories manager). */
export interface LocalCopy {
  /** Absolute repo root. */
  root: string;
  /** Folder name — the display label. */
  name: string;
  /** "owner/repo" from the origin remote, when it's a GitHub remote. */
  origin?: string;
  /** Sits inside the configured clone folder (so GitStudio may delete it). */
  managed: boolean;
  /** Present in the recent-repositories list. */
  recent: boolean;
  /** The repo currently open in the app. */
  current: boolean;
  /** The folder is gone (a recent someone deleted outside GitStudio). */
  missing: boolean;
}

/** A folder GitStudio scans for repositories. */
export interface RepoFolder {
  /** Absolute path. */
  path: string;
  /** "~/…"-style rendering for UI copy. */
  display: string;
  /** The configured clone folder: always scanned, cannot be removed. */
  isCloneDir: boolean;
  /** How many repositories were found in it. */
  repoCount: number;
  /** The folder is gone or unreadable. */
  missing: boolean;
}

/** The app-wide preferences (Settings → Repositories card). */
export interface AppSettingsView {
  /** Effective absolute default clone parent. */
  cloneDir: string;
  /** "~/GitStudio"-style rendering for UI copy. */
  cloneDirDisplay: string;
  cloneDirIsDefault: boolean;
  /** Extra folders GitStudio scans for repositories. */
  repoFolders: string[];
  askWhereEveryTime: boolean;
}

/** Connection state for the GitHub-backed views. */
export interface GitHubStatus {
  connected: boolean;
  login?: string;
  /** The resolved owner/repo from the active repo's origin remote, if GitHub. */
  repo?: { owner: string; repo: string };
}

/** The device-flow code the user enters at github.com/login/device. */
export interface DeviceCodeInfo {
  ok: boolean;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  deviceCode?: string;
  /** Seconds between polls. */
  interval?: number;
  /** Seconds until the code expires. */
  expiresIn?: number;
  message?: string;
  /**
   * `ok:false` because of a condition rather than a defect — offline, or
   * github.com refusing to issue a code. Keeps the IPC wrapper's ok:false
   * branch from filing a crash report. See main/expectedError.ts.
   */
  expected?: boolean;
}

/** One poll of the device-flow token endpoint. */
export interface DevicePollResult {
  state: "pending" | "slow_down" | "authorized" | "denied" | "expired" | "error";
  login?: string;
  message?: string;
}

/** The global git author identity (user.name / user.email). */
export interface GitIdentity {
  name: string;
  email: string;
}

/** A local SSH public key found under ~/.ssh. */
export interface SshKey {
  /** The .pub filename, e.g. "id_ed25519.pub". */
  file: string;
  /** Key type, e.g. "ssh-ed25519" / "ssh-rsa". */
  type: string;
  /** The trailing comment (often an email/host). */
  comment: string;
}

// ── Integrated terminal ──────────────────────────────────────────────────────

/** A spawned PTY session handle. */
export interface TerminalSession {
  id: string;
  /** The shell that was launched (e.g. /bin/zsh, powershell.exe). */
  shell: string;
}

/** A chunk of PTY output streamed to the renderer. */
export interface TerminalData {
  id: string;
  data: string;
}

/** A PTY session ended. */
export interface TerminalExit {
  id: string;
  exitCode: number;
}

/**
 * One completed git invocation the app ran, streamed to the renderer's "Output"
 * tab so the user can see every git command GitStudio executes on their behalf.
 */
export interface GitLogEntry {
  /** Monotonic id (per app session). */
  id: number;
  /** The meaningful git arguments, e.g. ["status", "--porcelain"]. */
  args: string[];
  /** The full command line for display, e.g. "git status --porcelain". */
  command: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Process exit code, or null when it failed to spawn / was killed. */
  exitCode: number | null;
  /** True when the process exited non-zero or failed to run. */
  failed: boolean;
  /** On failure: the (truncated) stderr explaining why. */
  stderr?: string;
  /** The user action this command ran under (Output-tab group title). */
  action?: string;
  /** Groups commands of ONE action invocation (same id = same group). */
  actionId?: number;
  /** Epoch milliseconds when the command finished. */
  at: number;
}

// ── Clone / browse GitHub repos ──────────────────────────────────────────────

/** A repository the signed-in user can clone (from GET /user/repos etc.). */
export interface GhRepoBrief {
  /** "owner/name". */
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  stars: number;
  language: string | null;
  /** ISO timestamp of last push, for sorting/recency. */
  updatedAt: string;
}

/** A clone request: a git URL + the parent directory to clone into. */
export interface CloneRequest {
  url: string;
  /** Absolute parent directory; the repo lands in `parent/<name>`. */
  parentDir: string;
  /** Optional override for the target folder name. */
  name?: string;
}

/** Progress emitted during a clone (parsed from `git clone --progress`). */
export interface CloneProgress {
  /** e.g. "Receiving objects", "Resolving deltas". */
  phase: string;
  /** 0..100 when git reports a percentage. */
  percent?: number;
  /** The raw progress line, for a verbose log. */
  raw: string;
}

/** The terminal outcome of a clone. */
export interface CloneResult {
  ok: boolean;
  /** Absolute path of the cloned repo on success. */
  root?: string;
  message?: string;
  /** Machine-readable failure mode (the dialog focuses the right field). */
  code?: "dest-exists" | "bad-name";
}

/** A commit in a PR's Commits tab. */
export interface PrCommitInfo {
  sha: string;
  shortSha: string;
  /** The subject — the message's first line. */
  message: string;
  /** The rest of the message, "" when there is none. */
  body?: string;
  /** The author's display name as git recorded it. */
  author: string;
  /** The GitHub account, when the commit matched one — for the avatar. */
  login?: string;
  avatarUrl?: string;
  /** ISO-8601. */
  date: string;
  /** GitHub verified the signature. */
  verified?: boolean;
  /** More than one parent. */
  isMerge?: boolean;
}

/** A timeline entry in a PR's Conversation tab (a comment or a review). */
export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  /** "comment" = plain issue comment; "review" carries a state. */
  kind: "comment" | "review";
  /** For reviews: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state?: string;
}

/** A CI check run for a PR's Pipelines tab. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string;
  detailsUrl?: string;
}

/** A GitHub Actions workflow run for the Actions tab. */
export interface WorkflowRun {
  id: number;
  /** The user-facing "#42" (NOT the internal id). */
  runNumber: number;
  runAttempt: number;
  /** The workflow's name ("Desktop CI"). */
  name: string;
  /** The run's own title (commit subject / PR title). */
  displayTitle: string;
  status: string;
  conclusion: string;
  branch: string;
  headSha: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  /** When execution actually began (createdAt→this = queue time). */
  runStartedAt: string;
  htmlUrl: string;
  /** WHO: the run's actor, and the re-runner when different. */
  actor: GitHubUser | null;
  triggeringActor: GitHubUser | null;
  workflowId: number;
  workflowPath: string;
  headCommitMessage: string;
  headCommitAuthor: string;
  pullRequests: { number: number }[];
}

// ── Interactive rebase (the Rebase view) ────────────────────────────────────

/** One commit in the rebase plan, oldest first (git's todo order). */
export interface RebaseCommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  subject: string;
  /** Humanized author time, e.g. "3h ago". */
  rel: string;
  /**
   * The commit's FULL message — subject, blank line, body, trailers.
   *
   * A reword seeded its textarea from the subject alone, so choosing Reword and
   * changing nothing still committed the subject and deleted the explanation,
   * the `Fixes #N`, the `Signed-off-by` and every `Co-Authored-By` under it —
   * reporting "Rebase complete."
   */
  body?: string;
  /**
   * Local branches whose tip IS this commit (excluding the one being rebased).
   *
   * A rewrite gives every commit a new sha, so a branch left pointing at an old
   * one is not "untouched" — it is stranded on a parallel line nothing
   * references any more. The plan builder can carry them along with
   * `update-ref`; it needs to be told which branches those are.
   */
  branches?: string[];
}

/** Everything the Rebase view needs to render a plan. */
export interface RebasePlanState {
  ok: boolean;
  /** The repo's own `rebase.updateRefs`, so the "carry other branches" toggle
   *  starts where the user's git already stands rather than at our guess. */
  updateRefs?: boolean;
  /** Why the plan couldn't be loaded (ok === false). */
  message?: string;
  /** The base the rebase runs onto, exclusive (or "--root"). */
  base: string;
  branch: string;
  commits: RebaseCommitInfo[];
  /** The commit being rebased ONTO — the dimmed anchor row. */
  baseCommit?: { shortSha: string; subject: string };
  /** True when a rebase is already mid-flight (conflict or `edit` stop). */
  inProgress: boolean;
  /**
   * HEAD's sha when this plan was built, echoed back on apply.
   *
   * A plan is a promise about a specific branch tip. Commit from a terminal
   * while the workspace is open and the rows no longer describe the range:
   * `apply` re-walks it, finds the new commit missing from the rows, treats it
   * as one of the below-the-cap tail and appends it — and appending is
   * newest-last, so the reversal into git's todo made the commit you just wrote
   * the FIRST pick, moving it to the bottom of the branch's history. Reported
   * as success, with nothing on screen ever mentioning it.
   */
  headSha?: string;
  /**
   * How many commits `apply()` will replay — the whole selection, not the page
   * shown. Above the display cap the two differ, and both the cap banner and
   * the confirm dialog quoted the page: "Showing the newest 200 … the older
   * ones are kept as-is" and "This rewrites 200 commits" on a range of 260, all
   * 260 of which are replayed and get new IDs the moment the base has moved.
   */
  replayCount?: number;
}

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface RebaseApplyRow {
  action: RebaseAction;
  sha: string;
  subject: string;
  /** New message for a `reword` row. */
  message?: string;
  /** Branches tipped at this commit — see RebaseCommitInfo.branches. */
  branches?: string[];
}

export interface RebaseApplyRequest {
  base: string;
  rows: RebaseApplyRow[];
  /** The `headSha` the plan was built against. When it no longer matches, the
   *  rows describe a range that has moved and applying them rewrites history
   *  the user never saw. Omitted only by callers that built the rows this tick. */
  headSha?: string;
  /** Carry other local branches through the rewrite. Omitted = follow the
   *  repo's own `rebase.updateRefs`, so GitStudio does what the user's git
   *  would do rather than silently doing something else. */
  updateRefs?: boolean;
}

/** Wire form of the runner's RebaseOutcome. */
export interface RebaseOutcomeWire {
  status: "done" | "stopped" | "failed";
  reason?: "conflict" | "edit" | "unknown";
  message?: string;
}

/**
 * The full channel map: channel name -> [request, response]. Used to make the
 * preload's `invoke` and the main handlers strongly typed end to end.
 */
export interface IpcChannels {
  "repo:open": [void, RepoInfo | undefined];
  "repo:openPath": [string, RepoInfo | undefined];
  "repo:recent": [void, RepoInfo[]];
  "repo:current": [void, RepoInfo | undefined];
  "repo:close": [void, void];
  "graph:load": [{ skip?: number; maxCount?: number }, GraphPage];
  "refs:list": [void, RefInfo[]];
  /** Branches CONTAINING a commit (reachability), for the details pane's
   *  "in N branches" row. Lazy — it walks history. */
  "refs:contains": [{ sha: string }, { branches: string[]; truncated: boolean }];
  "head:get": [void, HeadInfo | undefined];
  "status": [void, ChangedFile[]];
  "commit:details": [string, CommitDetailsPayload | undefined];
  /**
   * Which local branches contain this commit — "did this come from the branch
   * I am on, or was it merged in from somewhere else".
   *
   * A commit page that shows the change but never says where it lives leaves
   * the reader unable to answer the first question they have about it.
   */
  "commit:branches": [string, CommitBranches];
  "commit:rowStats": [string[], RowStat[]];
  "diff:files": [void, ChangedFile[]];
  "file:diff": [{ path: string; sha?: string }, FileDiff | undefined];
  "conflict:model": [string, ConflictModel | undefined];
  "blame:file": [string, unknown];
  "commit:action": [CommitActionRequest, CommitActionResult];
  // ── Interactive rebase (Rebase view). Continue/abort/skip reuse the existing
  //    mid-operation channels further down — they drive the same git state.
  "rebase:load": [{ base?: string; sha?: string }, RebasePlanState];
  "rebase:apply": [RebaseApplyRequest, RebaseOutcomeWire];
  // ── Working-tree staging + commit (Changes view) ──
  "stage": [string, CommitActionResult];
  "unstage": [string, CommitActionResult];
  "discard": [string, CommitActionResult];
  "stageAll": [void, CommitActionResult];
  "unstageAll": [void, CommitActionResult];
  /** The still-unstaged changes within one file, for per-hunk ticks (#20). */
  "hunks:list": [string, FileHunkWire[]];
  /** Stage one of those changes, leaving the rest of the file unstaged. */
  "hunks:stage": [{ path: string; index: number }, CommitActionResult];
  "commit": [{ message: string; amend?: boolean }, CommitActionResult];
  // ── Stashes ──
  "stash:list": [void, StashInfo[]];
  "stash:apply": [string, CommitActionResult];
  "stash:pop": [string, CommitActionResult];
  "stash:drop": [string, CommitActionResult];
  /**
   * Stash the whole tree, a selection of paths, or just the index.
   *
   * `paths` and `stagedOnly` are mutually exclusive — git silently mangles the
   * combination (see StashProvider.save), so the git-service layer refuses it.
   */
  "stash:save": [
    {
      message?: string;
      includeUntracked?: boolean;
      paths?: string[];
      stagedOnly?: boolean;
    },
    CommitActionResult,
  ];
  // ── Worktrees ──
  "worktree:list": [void, WorktreeInfo[]];
  "worktree:add": [{ ref: string; newBranch?: boolean }, CommitActionResult];
  "worktree:remove": [{ path: string; force?: boolean }, CommitActionResult];
  "worktree:open": [string, RepoInfo | undefined];
  // ── Sync (control remote changes) ──
  "sync:status": [void, SyncStatus];
  "sync:fetch": [{ prune?: boolean } | void, CommitActionResult];
  "sync:pull": [void, CommitActionResult];
  "sync:push": [{ setUpstream?: boolean; force?: boolean } | void, CommitActionResult];
  /** Push (or publish) ONE named branch, not just the checked-out one. */
  "branch:push": [{ name: string }, CommitActionResult];
  // ── Branch management ──
  "branches:list": [void, BranchInfo[]];
  /** Recent commits reachable from ONE ref (branch / remote / tag / stash sha) —
   *  feeds the peek cards so any ref is browsable without loading the graph. */
  "ref:log": [{ ref: string; maxCount?: number }, CompareCommit[]];
  "branch:create": [{ name: string; checkout?: boolean }, CommitActionResult];
  "branch:delete": [{ name: string; force?: boolean }, CommitActionResult];
  /** Fast-forward a local branch straight from its upstream WITHOUT checking
   *  it out (`git fetch <remote> <remoteBranch>:<localBranch>`). */
  "branch:pullFf": [{ name: string }, CommitActionResult];
  // ── Compare (base…head) ──
  "compare:refs": [{ base: string; head: string; mode?: CompareMode }, CompareResult | undefined];
  /**
   * One file's two sides between two revisions.
   *
   * `leftPath` exists for RENAMES: the file did not exist under `path` on the
   * base side, so asking for it there returns nothing and a 12-line edit
   * rendered as a brand-new file with its entire history thrown away. Callers
   * that know the old name send it.
   */
  "compare:fileDiff": [
    { base: string; head: string; path: string; leftPath?: string; mode?: CompareMode },
    FileDiff | undefined,
  ];
  // ── Code browser (GitHub-style file tree at HEAD) ──
  "repo:tree": [{ path: string }, TreeEntry[]];
  "repo:file": [{ path: string }, RepoFile | undefined];
  "repo:headCommit": [void, HeadCommit | undefined];
  // ── GitHub (PRs / Issues / Projects) ──
  "github:status": [void, GitHubStatus];
  "github:connect": [string, { ok: boolean; login?: string; message?: string }];
  "github:disconnect": [void, void];
  // OAuth Device Flow (the "Sign in with GitHub" path).
  "github:deviceStart": [void, DeviceCodeInfo];
  "github:devicePoll": [{ deviceCode: string }, DevicePollResult];
  // Settings: git identity + local SSH keys.
  "git:identity": [void, GitIdentity];
  "git:setIdentity": [GitIdentity, CommitActionResult];
  /** Write text to the system clipboard via the MAIN process. The renderer's
   *  navigator.clipboard needs focus + a user gesture; this path never does —
   *  it's the fallback that makes auto-copies (device-flow code) reliable. */
  "clipboard:write": [string, void];
  // ── App settings (Settings → Repositories) ──
  "settings:get": [void, AppSettingsView];
  /** Patch settings; `cloneDir: null` resets to the built-in default. */
  "settings:update": [{ cloneDir?: string | null; askWhereEveryTime?: boolean }, AppSettingsView];
  /** Native picker for the default clone folder; persists on choice. */
  "settings:pickCloneDir": [void, AppSettingsView | undefined];
  // ── Accounts (Explore profile pages) ──
  "users:repos": [string, OrgRepo[]];
  "users:orgs": [string, OrgInfo[]];
  // ── Remote repository browsing (Explore entity pages) ──
  /** Branches of any repo — the Explore ref switcher. */
  "ghrepo:branches": [string, GhRepoBranch[]];
  /** Every blob path at a ref, for go-to-file. */
  "ghrepo:paths": [{ fullName: string; ref?: string }, GhRepoPaths];
  // ── Global GitHub search (Explore) ──
  "search:repos": [{ query: string; sort?: SearchSort; page?: number }, SearchPage<SearchRepoItem>];
  "search:users": [{ query: string; kind: "users" | "orgs"; page?: number }, SearchPage<SearchUserItem>];
  "search:code": [{ query: string; page?: number }, SearchPage<SearchCodeItem>];
  // ── Local repository copies (Settings → Repositories manager) ──
  /** Every clone GitStudio knows about: the clone folder ∪ recents. */
  "repos:local": [void, LocalCopy[]];
  /** Reveal a root in Finder/Explorer. */
  "repos:reveal": [string, boolean];
  /** Forget a root from the recent list (never touches disk). */
  "repos:removeRecent": [string, LocalCopy[]];
  /** Every folder scanned for repositories: the clone folder, then the ones
   *  added by hand or learned from an open or a clone. */
  "repos:folders": [void, RepoFolder[]];
  /** Pick a folder to track (native dialog). Undefined when cancelled. */
  "repos:addFolder": [void, RepoFolder[] | undefined];
  /** Stop tracking a folder. Never touches disk, and refuses the clone
   *  folder — that one is always scanned. */
  "repos:removeFolder": [string, RepoFolder[]];
  /** Move a managed clone to the trash. Refuses anything outside the clone
   *  folder, and the repo that's currently open. */
  "repos:trash": [string, CommitActionResult];
  // ── App info + updates ──
  "app:info": [void, { version: string; platform: string }];
  /** Poll the release feed now (the Settings "Check for updates" button). */
  "update:check": [void, UpdateCheckResult];
  /** Start the user-confirmed download; completion arrives as update:ready. */
  "update:download": [void, { ok: boolean; message?: string }];
  /** Apply a ready update: restart into it, or open the macOS installer. */
  "update:install": [void, { ok: boolean; message?: string }];
  "ssh:keys": [void, SshKey[]];
  /** `state` mirrors GitHub's open|closed|all. Merged PRs come back under
   *  `closed` (they carry `mergedAt`), so the renderer narrows those locally. */
  "pr:list": [{ state?: "open" | "closed" | "all" } | void, PullRequest[]];
  "pr:detail": [number, PrDetail | undefined];
  "pr:checkout": [number, CommitActionResult];
  "pr:merge": [{ number: number; method: MergeMethod }, CommitActionResult];
  "pr:commits": [number, PrCommitInfo[]];
  "pr:conversation": [number, PrComment[]];
  "pr:checks": [number, CheckRun[]];
  "pr:approve": [number, CommitActionResult];
  // PR write actions.
  "pr:create": [CreatePrRequest, CommitActionResult];
  "pr:comment": [{ number: number; body: string }, CommitActionResult];
  "pr:review": [PrReviewRequest, CommitActionResult];
  "pr:setState": [{ number: number; state: "open" | "closed" }, CommitActionResult];
  "pr:requestReviewers": [{ number: number; reviewers: string[] }, CommitActionResult];
  "pr:markReady": [number, CommitActionResult];
  "pr:branches": [void, BranchRef[]];
  "pr:reviewers": [void, RepoCollaborator[]];
  // Actions control.
  "actions:runs": [ActionsRunsFilter | undefined, WorkflowRun[]];
  "actions:runDetail": [number, WorkflowRunDetail | undefined];
  "actions:workflows": [void, WorkflowInfo[]];
  "actions:dispatchInputs": [number, WorkflowDispatchInput[]];
  "actions:rerun": [number, CommitActionResult];
  "actions:rerunFailed": [number, CommitActionResult];
  "actions:cancel": [number, CommitActionResult];
  "actions:dispatch": [{ workflowId: number; ref: string; inputs: Record<string, string> }, CommitActionResult];
  // Issues CRUD.
  "issue:list": [{ state?: "open" | "closed" | "all" }, IssueInfo[]];
  "issue:detail": [number, IssueDetail | undefined];
  "issue:create": [
    { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number },
    { ok: boolean; number?: number; message?: string },
  ];
  "issue:comment": [{ number: number; body: string }, CommitActionResult];
  /** Close or reopen. `reason` is GitHub's `state_reason` and only means
   *  anything when closing — "not planned" is triage, and the app has always
   *  been able to display and filter on it without being able to set it. */
  /**
   * Search this repository's issues through GitHub. The list channel reads the
   * 300 most recently updated; this reaches the rest, and is the only path on
   * which qualifiers (`author:@me`, `no:assignee`, `label:"…"`) mean anything.
   */
  "issue:search": [
    { query: string; state?: "open" | "closed" | "all" },
    { items: IssueInfo[]; totalCount: number; incomplete: boolean },
  ];
  /** Edit a comment's body. The comment id has always been on the wire and
   *  the view threw it away, so none of these were reachable. */
  "issue:editComment": [{ id: number; body: string }, CommitActionResult];
  /** Delete a comment. Irreversible on GitHub's side. */
  "issue:deleteComment": [number, CommitActionResult];
  "issue:setState": [
    { number: number; state: "open" | "closed"; reason?: "completed" | "not_planned" },
    CommitActionResult,
  ];
  "issue:edit": [{ number: number; title?: string; body?: string }, CommitActionResult];
  "issue:labels": [void, RepoLabel[]];
  "issue:setLabels": [{ number: number; labels: string[] }, CommitActionResult];
  "issue:setAssignees": [{ number: number; assignees: string[] }, CommitActionResult];
  /** Everything in the current repo that involves the signed-in user (search
   *  API, @me qualifiers): review requests, assignments, own PRs, mentions. */
  "github:myWork": [void, MyWorkItem[]];
  // Read-only fetch of an issue/PR from ANY repo (used to open notifications for
  // OTHER repositories in-app instead of bouncing to github.com).
  "github:externalItem": [
    { owner: string; repo: string; number: number; kind: "issue" | "pull" },
    ExternalItemDetail | undefined,
  ];
  // Projects v2.
  "project:list": [void, ProjectInfo[]];
  "project:board": [string, ProjectBoard];
  "project:moveItem": [{ projectId: string; itemId: string; fieldId: string; optionId: string | null }, CommitActionResult];
  "project:addItem": [{ projectId: string; contentId: string }, CommitActionResult];
  // Releases.
  "release:list": [void, ReleaseInfo[]];
  "release:detail": [number, ReleaseInfo | undefined];
  "release:tags": [void, TagInfo[]];
  /** `id` is the created release, so the composer can land ON it rather than
   *  on a list where you have to go and find what you just published. */
  "release:create": [ReleaseInput, CommitActionResult & { id?: number }];
  /**
   * GitHub's own release notes, written from the merged pull requests between
   * two tags — the "Generate release notes" button on its composer.
   *
   * Without it the app asks someone to hand-write what GitHub will produce in
   * a second, which is most of why the composer felt like a worse place to
   * write a release than the website.
   */
  "release:generateNotes": [
    { tagName: string; targetCommitish?: string; previousTagName?: string },
    GeneratedNotes,
  ];
  "release:update": [ReleaseInput, CommitActionResult];
  "release:delete": [number, CommitActionResult];
  /** Pick local files (native dialog in MAIN) and upload them as assets. */
  "release:uploadAssets": [{ id: number }, CommitActionResult];
  "release:deleteAsset": [number, CommitActionResult];
  // Notifications.
  "notifications:list": [{ all?: boolean; participating?: boolean }, NotificationThread[]];
  /** Unread count for the top-bar badge. AMBIENT: never unlocks the stored
   *  token, so launching the app cannot trigger a keychain prompt. Returns 0
   *  when the token is still locked. */
  "notifications:unreadCount": [void, number];
  "notification:markRead": [{ id: string }, NotificationActionResult];
  "notifications:markAllRead": [void, NotificationActionResult];
  // Organizations.
  "orgs:list": [void, OrgInfo[]];
  "orgs:repos": [string, OrgRepo[]];
  "orgs:teams": [string, OrgTeam[]];
  "orgs:members": [string, OrgMember[]];
  /** Full record for one repo ("owner/repo") — the org-repo peek's body. */
  "orgs:repoDetail": [string, OrgRepoDetail];
  /** A team's members — the team peek's drill-in list. */
  "orgs:teamMembers": [{ org: string; slug: string }, OrgMember[]];
  /** A user's public profile — the member peek's body. */
  "github:userInfo": [string, GhUserInfo];
  // ── Remote repo browsing (look inside ANY GitHub repo without cloning) ──
  /** `ref` is optional everywhere: omitted means the default branch, which is
   *  what every existing caller already meant. */
  "ghrepo:tree": [{ fullName: string; path: string; ref?: string }, GhRepoEntry[]];
  "ghrepo:file": [{ fullName: string; path: string; ref?: string }, GhRepoFile];
  "ghrepo:readme": [{ fullName: string; ref?: string } | string, { name: string; text: string } | undefined];
  /** Open "owner/repo" as a NORMAL repo: reuse any existing local clone, else
   *  clone into `dest` (or the configured default folder), then open. Success
   *  flips the whole app to that repo via repo:changed. `code` makes failure
   *  modes machine-readable — no more matching on message text. */
  "ghrepo:open": [
    { fullName: string; dest?: string; name?: string },
    {
      ok: boolean;
      root?: string;
      cloned?: boolean;
      message?: string;
      code?: "collision" | "clone-failed" | "open-failed" | "bad-name";
    },
  ];
  // Gists.
  "gist:list": [void, GistInfo[]];
  "gist:detail": [string, GistInfo | undefined];
  "gist:create": [GistCreate, CommitActionResult];
  "gist:update": [GistUpdate, CommitActionResult];
  "gist:delete": [string, CommitActionResult];
  // Integrated terminal (PTY). Output streams back via the terminal:* events.
  "terminal:create": [{ cols: number; rows: number }, TerminalSession | undefined];
  "terminal:write": [{ id: string; data: string }, void];
  "terminal:resize": [{ id: string; cols: number; rows: number }, void];
  "terminal:kill": [{ id: string }, void];
  // Clone / browse repos. Clone progress streams via the clone:progress event.
  "clone:pickDir": [{ defaultPath?: string } | void, string | undefined];
  "clone:start": [CloneRequest, CloneResult];
  "github:repos": [{ search?: string } | void, GhRepoBrief[]];
  // ── AI / Agent / MCP (optional, off until a model connection is configured) ──
  "ai:settings": [void, AiSettingsView];
  "ai:catalog": [void, AiPresetView[]];
  "ai:addConnection": [{ preset: string }, AiSettingsView];
  "ai:updateConnection": [AiConnectionPatch, AiSettingsView];
  "ai:removeConnection": [{ id: string }, AiSettingsView];
  "ai:setDefault": [{ id: string }, AiSettingsView];
  "ai:setKey": [{ id: string; key: string }, AiSettingsView];
  "ai:setAgentConfig": [Partial<AgentConfig>, AiSettingsView];
  /** The models the active (or given) connection's provider offers. */
  "ai:models": [{ connectionId?: string } | void, AiModelOption[]];
  "ai:test": [{ id: string }, AiTestResult];
  // One-shot tasks: the invoke resolves with the final text; deltas stream via ai:delta.
  "ai:task": [{ requestId: string; task: AiTaskName; input: AiTaskInput }, AiDone];
  // Agent: streams ai:agentEvent; resolves on done. Writes round-trip via ai:confirmRequest.
  "ai:agentRun": [AgentRunRequest, AiDone];
  "ai:agentConfirm": [AgentConfirmAnswer, void];
  "ai:cancel": [{ requestId: string }, void];
  // MCP "Agent Access": the bundled server's config + one-click install into a client.
  "ai:mcpInfo": [void, McpInfo];
  "ai:mcpInstall": [McpInstallRequest, { ok: boolean; message: string }];
  // ── Assistant chats (persisted; survive refresh + restart) ──
  "ai:chatList": [void, ChatSummary[]];
  "ai:chatCurrent": [void, ChatView | undefined];
  "ai:chatGet": [{ id: string }, ChatView | undefined];
  // `setCurrent: false` creates a chat WITHOUT making it the repo's current one —
  // used by the footer AI tabs so they don't hijack the full Assistant's session.
  "ai:chatNew": [{ setCurrent?: boolean } | undefined, ChatView | undefined];
  "ai:chatSetCurrent": [{ id: string }, void];
  "ai:chatSend": [ChatSendRequest, AiDone];
  "ai:chatDelete": [{ id: string }, void];
  // ── Conflict resolution write-back (3-pane merge editor) ──
  "conflict:resolve": [{ path: string; content: string }, CommitActionResult];
  "conflict:takeSide": [{ path: string; side: "ours" | "theirs" }, CommitActionResult];
  "conflict:list": [void, string[]];
  // ── Hunk / line staging (working ⇄ index) ──
  "stage:lines": [{ path: string; lines: number[]; reverse?: boolean }, CommitActionResult];
  /**
   * Stage or unstage exactly one change block. The renderer sends the block's
   * content-derived ranges, never its position in a list, so a block that merely
   * shifted still resolves and only one that genuinely vanished is refused.
   */
  "blocks:set": [
    { path: string; block: ChangeBlockWire; staged: boolean },
    CommitActionResult & { indexText?: string },
  ];
  // ── Branch ops (engine-backed: merge / rebase / rename / upstream) ──
  "branch:merge": [{ name: string; noFf?: boolean }, CommitActionResult];
  "branch:rebase": [{ onto: string }, CommitActionResult];
  "branch:rename": [{ from: string; to: string }, CommitActionResult];
  "branch:setUpstream": [{ name: string; upstream: string }, CommitActionResult];
  "branch:deleteRemote": [{ remote: string; name: string }, CommitActionResult];
  // ── In-progress operation state + abort/continue ──
  "git:opState": [void, GitOpState];
  "merge:abort": [void, CommitActionResult];
  "merge:continue": [void, CommitActionResult];
  "rebase:abort": [void, CommitActionResult];
  "rebase:continue": [void, CommitActionResult];
  "rebase:skip": [void, CommitActionResult];
  "cherryPick:abort": [void, CommitActionResult];
  "cherryPick:continue": [void, CommitActionResult];
  "revert:abort": [void, CommitActionResult];
  "revert:continue": [void, CommitActionResult];
  "cherryPick:skip": [void, CommitActionResult];
  "revert:skip": [void, CommitActionResult];
  "am:abort": [void, CommitActionResult];
  "am:skip": [void, CommitActionResult];
  "am:continue": [void, CommitActionResult];
  // ── Tag creation (the Branches view's "Create tag here…") ──
  "tag:create": [{ name: string; ref?: string; message?: string }, CommitActionResult];
  /** `git tag -d` — LOCAL only. A tag already pushed survives on the remote,
   *  and the UI has to say so rather than implying the tag is gone. */
  "tag:delete": [string, CommitActionResult];
  /** Publish ONE tag. Pushing every tag at once is a different, much larger
   *  action and must be asked for on its own. */
  "tag:push": [{ name: string; remote?: string }, CommitActionResult];
  // ── PR review depth: per-file diffs + inline threads + metadata ──
  "pr:fileDiff": [{ number: number; path: string }, FileDiff | undefined];
  "pr:reviewThreads": [number, PrReviewThread[]];
  "pr:addReviewComment": [
    { number: number; path: string; line: number; side?: "LEFT" | "RIGHT"; body: string },
    CommitActionResult,
  ];
  "pr:replyThread": [{ number: number; threadId: string; body: string }, CommitActionResult];
  "pr:resolveThread": [{ threadId: string; resolved: boolean }, CommitActionResult];
  "pr:edit": [{ number: number; title?: string; body?: string }, CommitActionResult];
  "pr:setLabels": [{ number: number; labels: string[] }, CommitActionResult];
  "pr:setAssignees": [{ number: number; assignees: string[] }, CommitActionResult];
  "pr:updateBranch": [number, CommitActionResult];
  "pr:labels": [void, RepoLabel[]];
  "pr:prefill": [void, PrPrefill];
  // ── Issues depth: milestones + repo label CRUD ──
  "issue:milestones": [void, MilestoneInfo[]];
  "issue:setMilestone": [{ number: number; milestone: number | null }, CommitActionResult];
  "labels:list": [void, RepoLabel[]];
  "label:create": [{ name: string; color: string; description?: string }, CommitActionResult];
  "label:update": [
    { name: string; newName?: string; color?: string; description?: string },
    CommitActionResult,
  ];
  "label:delete": [string, CommitActionResult];
  // ── Actions depth: logs + artifacts + secrets/variables ──
  "actions:jobLog": [{ jobId: number }, string];
  /** Incremental tail: refetch + slice from `offset` (see LogDelta). */
  "actions:jobLogChunk": [{ jobId: number; offset: number }, LogDelta];
  /** Save one job's full log to ~/Downloads. */
  "actions:saveLog": [{ jobId: number; name: string }, CommitActionResult];
  "actions:artifacts": [number, ArtifactInfo[]];
  "actions:downloadArtifact": [{ id: number; name: string }, CommitActionResult];
  "actions:secrets": [void, RepoSecretInfo[]];
  "actions:setSecret": [{ name: string; value: string }, CommitActionResult];
  "actions:deleteSecret": [string, CommitActionResult];
  "actions:variables": [void, RepoVariableInfo[]];
  "actions:setVariable": [{ name: string; value: string }, CommitActionResult];
  "actions:deleteVariable": [string, CommitActionResult];
  // ── Appearance ──
  /** Set the macOS dock icon to the light/dark brand mark. Renderer resolves
   *  the effective variant (it alone knows the in-app theme override). */
  "appearance:dockIcon": [{ variant: "dark" | "light" }, void];
}

export type IpcChannel = keyof IpcChannels;
export type IpcRequest<C extends IpcChannel> = IpcChannels[C][0];
export type IpcResponse<C extends IpcChannel> = IpcChannels[C][1];

/** Push events the main process emits to the renderer (host → renderer). */
export interface IpcEvents {
  /** The active repo changed (opened/closed) — the renderer reloads. */
  "repo:changed": RepoInfo | undefined;
  /** The recent-repositories list changed (forgotten or trashed elsewhere in
   *  the app) — the repo switcher and the manager both re-render off this. */
  "repo:recentChanged": RepoInfo[];
  /**
   * Something changed on disk in the open repo — a file edited outside the app,
   * or a git command run in another terminal (issue #17). Already debounced in
   * the main process, so it is safe to act on every one of these.
   *
   * `gitDir` says whether the change was under `.git` (HEAD, the index, refs, an
   * operation marker) rather than only in the working tree. It is the difference
   * between "re-read the file list" and "the whole history may have moved": a
   * save cannot change a commit, so a build churning files must not drag a graph
   * reload behind every burst.
   */
  "repo:filesChanged": { gitDir: boolean };
  /** A message from the main process to show in-app (never a native alert). */
  "app:notice": { kind: "info" | "warn" | "error"; message: string };
  /** A menu item asks the renderer to do something it owns. */
  "menu:command": {
    command:
      | "openRepo"
      | "refresh"
      | "closeRepo"
      | "toggleTerminal"
      | "cloneRepo"
      | "toggleSidebar"
      | "palette";
  };
  /** A chunk of PTY output for a terminal session. */
  "terminal:data": TerminalData;
  /** A PTY session ended. */
  "terminal:exit": TerminalExit;
  /** Progress during an in-flight clone. */
  "clone:progress": CloneProgress;
  /** A git command the app ran — streamed to the terminal dock's Output tab. */
  "git:log": GitLogEntry;
  /** Streamed assistant-text deltas for an in-flight ai:task / ai:agentRun. */
  "ai:delta": AiDelta;
  /** A structured step from a running agent (assistant text, tool call/result). */
  "ai:agentEvent": AgentEventWire;
  /** The agent wants the user to approve a write/destructive action before it runs. */
  "ai:confirmRequest": AgentConfirmRequest;
  /** A newer app version exists — the renderer asks the user before anything
   *  downloads (background polls announce a version at most once per session). */
  "update:available": UpdateAvailable;
  /** Download progress for a user-confirmed update, in whole percent. */
  "update:progress": { percent: number };
  /** The confirmed update is downloaded and ready to apply. */
  "update:ready": UpdateReady;
}

// ── App updates (poll → confirm → pull → apply) ───────────────────────────────

export interface UpdateAvailable {
  /** The newer version waiting on the release feed. */
  version: string;
  /** The version currently running. */
  current: string;
}
export interface UpdateReady {
  version: string;
  /** How update:install applies it: "restart" relaunches into the new version
   *  (electron-updater); "installer" opens the downloaded macOS DMG. */
  kind: "restart" | "installer";
  /** For "installer": where the download landed (~/Downloads). */
  path?: string;
}
export interface UpdateCheckResult {
  status: "uptodate" | "available" | "downloading" | "ready" | "disabled" | "error";
  /** The version currently running. */
  current: string;
  /** For available/downloading/ready: the newer version in question. */
  version?: string;
  /** For error/disabled: why. */
  message?: string;
}

export type IpcEvent = keyof IpcEvents;

/** The shape exposed on `window.gitstudio` by the preload contextBridge. */
export interface GitStudioBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResponse<C>>;
  on<E extends IpcEvent>(event: E, listener: (data: IpcEvents[E]) => void): () => void;
}

// ── Local-git depth wire types ──────────────────────────────────────────────────

/** Which mid-operation state the repo is in — drives abort/continue banners. */
export interface GitOpState {
  merging: boolean;
  rebasing: boolean;
  cherryPicking: boolean;
  reverting: boolean;
  /**
   * A `git am` is stopped mid-series.
   *
   * It shares `rebase-apply/` with a rebase on the apply backend, so telling
   * the two apart is necessary — but telling them apart is not enough. Reported
   * as a rebase, its banner offered two buttons git refuses; reported as
   * NOTHING, the app showed an ordinary dirty tree with a live Commit button,
   * and committing strands the rest of the series and replaces the patch
   * author with you. An operation the app can see has to be an operation the
   * app names.
   */
  amApplying: boolean;
  /** Number of currently-conflicted paths. */
  conflicts: number;
  /**
   * The stopped operation has nothing left to commit.
   *
   * Cherry-picking or reverting something already on the branch stops with
   * CHERRY_PICK_HEAD set and ZERO unmerged files — and so does a conflict the
   * user resolved by keeping HEAD's side. Both look "resolved" to a conflict
   * count, so the banner said "resolve and continue" over an empty file list
   * and left Continue enabled; git then refused with "The previous cherry-pick
   * is now empty" and the app raised it as an error toast, and a crash report.
   * Skip (or Abort) is the way out, and neither was on screen.
   */
  nothingToCommit: boolean;
  /**
   * ONE name for what is in progress — decided in the main process, not
   * re-derived from the booleans above.
   *
   * The renderer's own precedence put `merging` first, and
   * `rebase --rebase-merges` stopping on a `merge` step leaves MERGE_HEAD *and*
   * `rebase-merge/`: the banner called it a merge, and its Abort ran
   * `git merge --abort`, discarding a hand resolution and leaving the rebase
   * running underneath.
   */
  kind: "merge" | "rebase" | "cherry-pick" | "revert" | "am" | null;
  /** Whether `<kind>:continue` can succeed right now. */
  canContinue: boolean;
  /** Whether `<kind>:skip` is offered — and safe. There is no `merge --skip`,
   *  and `rebase --skip` HARD-RESETS, so it is offered only where git itself
   *  names it as the way out. */
  canSkip: boolean;
}

/** Where a commit sits in the branch graph — see `commit:branches`. */
export interface CommitBranches {
  /** Local branches containing it, HEAD's own first when present. */
  branches: string[];
  /** True when the branch HEAD is on contains it. */
  onCurrent: boolean;
  /** The branch HEAD is on, so the page can phrase it ("also on main"). */
  current?: string;
}

// ── GitHub depth wire types (PR threads, milestones, actions) ───────────────────

/** One inline review comment within a PR thread. */
export interface PrReviewComment {
  id: string;
  author: GitHubUser;
  body: string;
  createdAt: string;
}

/** A PR inline review thread anchored to a file + line. */
export interface PrReviewThread {
  id: string;
  path: string;
  /** Diff line the thread anchors to (right side), if known. */
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: PrReviewComment[];
}

/** Prefill for "Create PR from current branch" off the push/Changes flow. */
export interface PrPrefill {
  /** The pushed branch name to use as head; absent when nothing to PR. */
  headRef?: string;
  /** The repo default branch to use as base. */
  baseRef?: string;
  title?: string;
  body?: string;
  /** Commits the head is ahead of base by. */
  commits?: number;
  /** An already-open PR number for this head, if one exists. */
  existing?: number;
}

/** A GitHub milestone. */
export interface MilestoneInfo {
  number: number;
  title: string;
  state: "open" | "closed";
  dueOn?: string | null;
  openIssues: number;
  closedIssues: number;
}

/** A CI artifact produced by a workflow run. */
export interface ArtifactInfo {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  createdAt: string;
}

/** A repo Actions secret (value never returned — write-only). */
export interface RepoSecretInfo {
  name: string;
  updatedAt: string;
}

/** A repo Actions variable (value is readable). */
export interface RepoVariableInfo {
  name: string;
  value: string;
  updatedAt: string;
}

// ── AI / Agent / MCP wire types ───────────────────────────────────────────────
//
// The renderer never sees API keys: a connection is surfaced as a redacted
// "view" (hasKey/usable booleans only). The main-process AiBridge owns the keys
// (encrypted at rest via Electron safeStorage) and all model traffic.

/** The inline ✨ task a one-shot AI call performs. */
export type AiTaskName =
  | "commitMessage"
  | "explainDiff"
  | "summarizeChanges"
  | "prDescription"
  | "reviewDiff"
  | "explainConflict"
  | "changelog"
  | "branchName"
  | "assist";

/** A configured model connection, redacted for the renderer (no key material). */
export interface AiConnectionView {
  id: string;
  label: string;
  preset: string;
  wire: "anthropic" | "openai-compat" | "cli";
  baseUrl: string;
  models: { fast: string; mid: string; deep: string };
  needsKey: boolean;
  local: boolean;
  /** True when a key is stored for this connection (value never sent). */
  hasKey: boolean;
  /** True when the connection is ready to use (base URL + model + key/local). */
  usable: boolean;
}

/** A catalog entry for the "connect a provider" gallery. */
export interface AiPresetView {
  id: string;
  label: string;
  blurb: string;
  wire: string;
  baseUrl: string;
  needsKey: boolean;
  local: boolean;
  keyUrl?: string;
  icon: string;
  note?: string;
  models: { fast: string; mid: string; deep: string };
}

/** Configurable behavior of the in-app Assistant agent (persisted). */
export interface AgentConfig {
  /** Default model tier the Assistant uses (maps to the connection's models). */
  model: "fast" | "mid" | "deep";
  /** An explicit model id chosen in the Assistant (overrides the tier). */
  modelId?: string;
  /** How much the model should reason before answering. */
  thinking: "off" | "auto" | "extended";
  /** Default repo-access level for new conversations. */
  permission: "read" | "write" | "destructive";
}

/** One model the active connection's provider offers, for the in-app picker. */
export interface AiModelOption {
  /** The model id to send (e.g. "claude-sonnet-4-6", "opus", "gpt-4o"). */
  id: string;
  /** A friendlier display label, if different from the id. */
  label?: string;
}

export interface AiSettingsView {
  connections: AiConnectionView[];
  defaultId?: string;
  /** True when at least one connection is usable (gates the ✨ + Assistant). */
  enabled: boolean;
  /** The Assistant agent's configured defaults. */
  agent: AgentConfig;
}

export interface AiConnectionPatch {
  id: string;
  label?: string;
  baseUrl?: string;
  models?: { fast: string; mid: string; deep: string };
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  /** The model that answered, on success. */
  model?: string;
}

/** The input for a one-shot AI task (only the relevant fields are set per task). */
export interface AiTaskInput {
  diff?: string;
  sha?: string;
  path?: string;
  base?: string;
  /** The right-hand side of a base…head comparison (PR / Compare). Defaults to HEAD. */
  head?: string;
  description?: string;
  commits?: string[];
  conflict?: { path: string; base?: string; ours: string; theirs: string };
  /** Override the connection for this call (else the default/per-task default). */
  connectionId?: string;
}

export interface AiDelta {
  requestId: string;
  delta: string;
}

export interface AiDone {
  requestId: string;
  ok: boolean;
  text?: string;
  message?: string;
}

export interface AgentRunRequest {
  requestId: string;
  goal: string;
  allowWrite: boolean;
  allowDestructive: boolean;
  connectionId?: string;
  /** Which model tier to use (fast = snappiest). Defaults to the agent config. */
  model?: "fast" | "mid" | "deep";
  /** An explicit model id to use (overrides the tier). */
  modelId?: string;
  /** Reasoning depth for this run. Defaults to the agent config. */
  thinking?: "off" | "auto" | "extended";
}

/** A structured step emitted by a running agent, streamed to the Assistant view. */
export interface AgentEventWire {
  requestId: string;
  kind: "assistant" | "tool_call" | "tool_result" | "tool_denied" | "status" | "done" | "error";
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  callId?: string;
}

export interface AgentConfirmRequest {
  requestId: string;
  callId: string;
  tool: string;
  title: string;
  /** A short human summary of exactly what will happen (e.g. the commit message). */
  summary: string;
  mode: "write" | "destructive";
}

export interface AgentConfirmAnswer {
  requestId: string;
  callId: string;
  approved: boolean;
}

export interface McpClientInfo {
  id: string;
  label: string;
  /** True when GitStudio's MCP server is already in this client's config. */
  installed: boolean;
  /** Absolute path of the client's config file (for display). */
  configPath?: string;
}

export interface McpInfo {
  /** Absolute path to the bundled gitstudio-mcp entry. */
  binPath: string;
  /** The command + args to launch it (for a config snippet). */
  command: string;
  args: string[];
  /** A ready-to-paste JSON snippet for a generic MCP client. */
  configSnippet: string;
  clients: McpClientInfo[];
  repoRoot?: string;
  /** Whether the bundled server file exists (built) yet. */
  available: boolean;
}

export interface McpInstallRequest {
  client: string;
  write: boolean;
  destructive: boolean;
}

// ── Assistant chats (persisted sessions) ──────────────────────────────────────

export interface ChatTurnView {
  role: "user" | "assistant";
  text: string;
}
export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
}
export interface ChatView {
  id: string;
  title: string;
  connectionId: string;
  turns: ChatTurnView[];
}
export interface ChatSendRequest {
  chatId: string;
  /** Correlates the streaming ai:delta / ai:agentEvent / ai:confirmRequest events. */
  requestId: string;
  goal: string;
  allowWrite: boolean;
  allowDestructive: boolean;
  modelId?: string;
  thinking?: "off" | "auto" | "extended";
}
