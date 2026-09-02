// Host-agnostic Git types and interfaces shared by the data layer
// (@gitstudio/git-service) and the host shells (the VS Code extension and the
// desktop app). This module must stay dependency-free — pure types only, no
// `node`/`vscode` imports — so it can be imported from any context (including
// the webview) and so the engine/host-bridge purity guard keeps passing.

/** A single commit, as parsed from `git log`. Dates are epoch seconds. */
export interface CommitRecord {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Authored timestamp, epoch seconds. */
  authorDate: number;
  committer: string;
  committerEmail: string;
  /** Committed timestamp, epoch seconds. */
  committerDate: number;
  subject: string;
  body: string;
}

/**
 * One file changed by a commit (diffed against its first parent, or the empty
 * tree for a root commit). `additions`/`deletions` are -1 for binary files.
 */
export interface CommitFileChange {
  /** Current (new) repo-relative path. */
  path: string;
  /** Previous path, when the change is a rename or copy. */
  oldPath?: string;
  /** Single-letter status: A M D R C T (renames/copies normalized to R/C). */
  status: string;
  /** Lines added, or -1 for a binary file. */
  additions: number;
  /** Lines removed, or -1 for a binary file. */
  deletions: number;
}

export type GitRefType = "head" | "remote" | "tag" | "stash";

export interface GitRef {
  type: GitRefType;
  /** Short name, e.g. "main", "origin/main", "v1.0", "stash@{0}". */
  name: string;
  /** Fully-qualified ref name, e.g. "refs/heads/main". */
  fullName: string;
  sha: string;
  isCurrent: boolean;
  /** Short upstream ref name (e.g. "origin/main"), when set. */
  upstream?: string;
  /** Commits ahead of the upstream (from `%(upstream:track)`), when tracked. */
  ahead?: number;
  /** Commits behind the upstream (from `%(upstream:track)`), when tracked. */
  behind?: number;
  /**
   * The upstream this ref tracked NO LONGER EXISTS (git's `[gone]`).
   *
   * Distinct from untracked: `ahead`/`behind` are both absent in either case,
   * so without this a branch whose remote was deleted is indistinguishable from
   * one in perfect sync.
   */
  gone?: boolean;
  /** Tip commit date, epoch seconds — every kind of ref has one. */
  date?: number;
  /** Tip commit subject. A remote branch or a tag with only a name and a sha
   *  cannot be told apart from its neighbours at a glance. */
  subject?: string;
  /** "tag" for an ANNOTATED tag (it is its own object), "commit" otherwise.
   *  The one fact that distinguishes the two kinds of tag, and nothing has ever
   *  carried it. */
  objectType?: string;
  /** What a symbolic ref points at — `refs/remotes/origin/HEAD` names the
   *  repository's DEFAULT branch, for free, on a read that already runs. */
  symref?: string;
}

export interface RepoHead {
  detached: boolean;
  branch?: string;
  sha: string;
}

/**
 * The few host-git touchpoints the data layer cannot do portably on its own.
 * Injected by the shell so the same data layer powers both front-ends: the
 * desktop app reuses NodeGitAdapter, the VS Code extension provides its own
 * backed by vscode.git's discovered binary path.
 */
export interface HostGitAdapter {
  /** Absolute path to the git binary; defaults to "git". */
  gitPath(): string;
  /** Discover the repo root containing `cwd`, or undefined when not a repo. */
  discoverRepoRoot(cwd: string): Promise<string | undefined>;
}
