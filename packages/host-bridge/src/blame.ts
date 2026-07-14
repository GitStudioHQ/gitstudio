// Host-agnostic blame types, shared by the engine parser
// (@gitstudio/engine/blame/parse), the data layer (@gitstudio/git-service's
// BlameProvider), and the host shells. Like ./git, this module is type-only —
// no `node`/`vscode` imports — so it imports cleanly from any context and keeps
// the engine/host-bridge purity guard passing.

/** A commit referenced by a blame result. Times are epoch seconds. */
export interface BlameCommit {
  sha: string;
  author: string;
  authorMail: string;
  authorTime: number;
  authorTz: string;
  committer: string;
  committerMail: string;
  committerTime: number;
  summary: string;
  /** Where this content lived before the blamed commit, when known. */
  previous?: { sha: string; filename: string };
  /** True for a boundary commit (the history limit / first commit). */
  isBoundary: boolean;
}

/** One source line's attribution. `finalLine` is 1-based. */
export interface BlameLine {
  /** 1-based line number in the blamed (final) file. */
  finalLine: number;
  /** 1-based line number in the commit that introduced it. */
  origLine: number;
  sha: string;
}

/** A parsed blame: commits keyed by sha + one entry per source line. */
export interface BlameResult {
  commits: Map<string, BlameCommit>;
  /** Sorted ascending by `finalLine`, exactly one entry per source line. */
  lines: BlameLine[];
}

/** The "Not Committed Yet" sentinel git uses for uncommitted (dirty) lines. */
export const UNCOMMITTED_SHA = "0000000000000000000000000000000000000000";
