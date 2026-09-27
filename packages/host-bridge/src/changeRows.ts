// The rows every "what is about to leave / what is here" list is made of —
// the push review's commits and files, a worktree's uncommitted files and its
// commits not pushed. One shape, so one renderer (webview-ui's changeRows)
// draws them all and they read the same everywhere.

/** One changed file. */
export interface ChangeFile {
  /** Repo-relative path — today's name. */
  path: string;
  /** Where a rename came from. */
  oldPath?: string;
  /** A M D R C T as git names them; "U" untracked; "!" conflicted. */
  status: string;
  /** Lines added and deleted, when known; -1 for a binary file. */
  additions?: number;
  deletions?: number;
  /** An uncommitted change: which side it is on. */
  area?: "staged" | "unstaged" | "untracked" | "conflicted";
}

/** One commit. */
export interface ChangeCommit {
  sha: string;
  /** Its parents (the first is what its files are diffed against). */
  parents?: string[];
  subject: string;
  author: string;
  /** Author date, seconds since the epoch. */
  date: number;
  /**
   * Its age as the host says every commit's ("3h", "2d": the extension's
   * relativeTime) — shown in place of the page's own reading of `date`.
   */
  rel?: string;
}

/** A status letter, in words — for a tooltip or a screen reader. */
export function statusWords(status: string, area?: ChangeFile["area"]): string {
  const base: Record<string, string> = {
    A: "Added",
    M: "Modified",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
    U: "Untracked",
    "!": "Conflicted",
  };
  const word = base[status] ?? "Changed";
  return area === "staged" ? `${word}, staged` : word;
}
