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
