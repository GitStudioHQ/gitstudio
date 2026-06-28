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
  /** Present for working-tree changes: is the change staged (in the index)? */
  staged?: boolean;
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
  authorDate: number;
  committer: string;
  committerEmail: string;
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
}

/** A git action requested from the graph context menu. */
export interface CommitActionRequest {
  action:
    | "checkout"
    | "branch"
    | "tag"
    | "cherry-pick"
    | "revert"
    | "reset-soft"
    | "reset-mixed"
    | "reset-hard"
    | "copy-sha";
  sha: string;
  /** Free-text argument (a new branch/tag name) where the action needs one. */
  name?: string;
}

export interface CommitActionResult {
  ok: boolean;
  /** True when the repo state changed and the graph should refresh. */
  changed: boolean;
  message?: string;
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
  author: string;
  /** Author date, epoch seconds. */
  date: number;
}

/** The result of comparing two refs (base…head). */
export interface CompareResult {
  /** Commits in `head` that are not in `base` (i.e. base..head), newest first. */
  commits: CompareCommit[];
  /** Files changed between base and head. */
  files: ChangedFile[];
  ahead: number;
  behind: number;
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
}
export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
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
}
export interface IssueDetail {
  issue: IssueInfo;
  comments: IssueComment[];
  assignees: string[];
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
}
export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  htmlUrl: string;
  startedAt: string;
  completedAt: string;
  steps: WorkflowStep[];
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
}
export interface NotificationActionResult {
  ok: boolean;
  message?: string;
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
}

/** A commit in a PR's Commits tab. */
export interface PrCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
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
  name: string;
  status: string;
  conclusion: string;
  branch: string;
  event: string;
  createdAt: string;
  htmlUrl: string;
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
  "head:get": [void, HeadInfo | undefined];
  "status": [void, ChangedFile[]];
  "commit:details": [string, CommitDetailsPayload | undefined];
  "commit:rowStats": [string[], RowStat[]];
  "diff:files": [void, ChangedFile[]];
  "file:diff": [{ path: string; sha?: string }, FileDiff | undefined];
  "conflict:model": [string, ConflictModel | undefined];
  "blame:file": [string, unknown];
  "commit:action": [CommitActionRequest, CommitActionResult];
  // ── Working-tree staging + commit (Changes view) ──
  "stage": [string, CommitActionResult];
  "unstage": [string, CommitActionResult];
  "discard": [string, CommitActionResult];
  "stageAll": [void, CommitActionResult];
  "unstageAll": [void, CommitActionResult];
  "commit": [{ message: string; amend?: boolean }, CommitActionResult];
  // ── Stashes ──
  "stash:list": [void, StashInfo[]];
  "stash:apply": [string, CommitActionResult];
  "stash:pop": [string, CommitActionResult];
  "stash:drop": [string, CommitActionResult];
  "stash:save": [{ message?: string; includeUntracked?: boolean }, CommitActionResult];
  // ── Worktrees ──
  "worktree:list": [void, WorktreeInfo[]];
  "worktree:add": [{ ref: string; newBranch?: boolean }, CommitActionResult];
  "worktree:remove": [{ path: string; force?: boolean }, CommitActionResult];
  "worktree:open": [string, RepoInfo | undefined];
  // ── Sync (control remote changes) ──
  "sync:status": [void, SyncStatus];
  "sync:fetch": [void, CommitActionResult];
  "sync:pull": [void, CommitActionResult];
  "sync:push": [{ setUpstream?: boolean } | void, CommitActionResult];
  // ── Branch management ──
  "branches:list": [void, BranchInfo[]];
  "branch:create": [{ name: string; checkout?: boolean }, CommitActionResult];
  "branch:delete": [{ name: string; force?: boolean }, CommitActionResult];
  // ── Compare (base…head) ──
  "compare:refs": [{ base: string; head: string; mode?: CompareMode }, CompareResult | undefined];
  "compare:fileDiff": [{ base: string; head: string; path: string; mode?: CompareMode }, FileDiff | undefined];
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
  "ssh:keys": [void, SshKey[]];
  "pr:list": [void, PullRequest[]];
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
  "actions:runs": [void, WorkflowRun[]];
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
  "issue:create": [{ title: string; body?: string }, { ok: boolean; number?: number; message?: string }];
  "issue:comment": [{ number: number; body: string }, CommitActionResult];
  "issue:setState": [{ number: number; state: "open" | "closed" }, CommitActionResult];
  "issue:edit": [{ number: number; title?: string; body?: string }, CommitActionResult];
  "issue:labels": [void, RepoLabel[]];
  "issue:setLabels": [{ number: number; labels: string[] }, CommitActionResult];
  "issue:setAssignees": [{ number: number; assignees: string[] }, CommitActionResult];
  // Projects v2.
  "project:list": [void, ProjectInfo[]];
  "project:board": [string, ProjectBoard];
  "project:moveItem": [{ projectId: string; itemId: string; fieldId: string; optionId: string | null }, CommitActionResult];
  "project:addItem": [{ projectId: string; contentId: string }, CommitActionResult];
  // Releases.
  "release:list": [void, ReleaseInfo[]];
  "release:detail": [number, ReleaseInfo | undefined];
  "release:tags": [void, TagInfo[]];
  "release:create": [ReleaseInput, CommitActionResult];
  "release:update": [ReleaseInput, CommitActionResult];
  "release:delete": [number, CommitActionResult];
  // Notifications.
  "notifications:list": [{ all?: boolean; participating?: boolean }, NotificationThread[]];
  "notification:markRead": [{ id: string }, NotificationActionResult];
  "notifications:markAllRead": [void, NotificationActionResult];
  // Organizations.
  "orgs:list": [void, OrgInfo[]];
  "orgs:repos": [string, OrgRepo[]];
  "orgs:teams": [string, OrgTeam[]];
  "orgs:members": [string, OrgMember[]];
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
  "clone:pickDir": [void, string | undefined];
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
}

export type IpcChannel = keyof IpcChannels;
export type IpcRequest<C extends IpcChannel> = IpcChannels[C][0];
export type IpcResponse<C extends IpcChannel> = IpcChannels[C][1];

/** Push events the main process emits to the renderer (host → renderer). */
export interface IpcEvents {
  /** The active repo changed (opened/closed) — the renderer reloads. */
  "repo:changed": RepoInfo | undefined;
  /** A menu item asks the renderer to do something it owns. */
  "menu:command": { command: "openRepo" | "refresh" | "closeRepo" | "toggleTerminal" | "cloneRepo" };
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
  | "branchName";

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

export interface AiSettingsView {
  connections: AiConnectionView[];
  defaultId?: string;
  /** True when at least one connection is usable (gates the ✨ + Assistant). */
  enabled: boolean;
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
  /** Which model tier to use (fast = snappiest). Defaults to "mid". */
  model?: "fast" | "mid" | "deep";
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
