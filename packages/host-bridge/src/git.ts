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

/**
 * One file of several commits' combined change (#161): the file before the
 * first of them that changed it (`from`, read under `oldPath` when it had
 * another name there) and after the last (`to`). Each is a full commit sha,
 * or git's empty tree when the commit before it all is a root.
 */
export interface CombinedFileChange extends CommitFileChange {
  from: string;
  to: string;
}

/**
 * The files several selected commits changed, as one change (#161).
 *
 * `stack`: the commits are one unbroken run, each the first parent of the
 * next, so this is the run's single change from the oldest one's parent to
 * the newest: what squashing them would make. Line counts are git's.
 *
 * `pieces`: any other selection (a gap, or commits from more than one line).
 * Each file runs from before the first selected commit that changed it to
 * after the last, so its diff can include commits in between that are not
 * selected, and its line counts are not known (both 0).
 */
export interface CombinedChanges {
  kind: "stack" | "pieces";
  /**
   * `pieces` only: the commits are not one line of history (each an ancestor
   * of the next), so a file's diff can also leave out a selected change made
   * on another line — its last commit's side never had it.
   */
  divergent?: true;
  files: CombinedFileChange[];
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
  /** The person behind the ref: the tagger for an annotated tag (they cut
   *  it), otherwise the tip commit's author. */
  who?: { name: string; email: string; tagger?: boolean };
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
  /** When the tip was made, epoch seconds — the commit's date, or an annotated tag's own. */
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
  /** git's `symbolic-ref --short`: shortest UNAMBIGUOUS, so "heads/release"
   *  beside a tag "release" — a revision git resolves, not a name to show or
   *  to build a refspec from. For those, see `fullName` (and git-service's
   *  headBranchName). */
  branch?: string;
  /** The branch's full name, "refs/heads/release", when HEAD is on one. */
  fullName?: string;
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
