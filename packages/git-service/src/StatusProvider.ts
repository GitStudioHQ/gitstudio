import type { GitProcess, GitRunOptions } from "./GitProcess";

/** One changed file: repo-relative path + a one-letter status matching the
 * codes the extension's `statusLetter` produces (A/M/D/R/U/!/T). */
export interface StatusFile {
  path: string;
  status: string;
}

/** The working-tree status, grouped exactly like vscode.git's repo.state so the
 * Changes view can render it identically WITHOUT waiting for vscode.git. */
export interface RepoStatus {
  /** Current branch name, or undefined when detached. */
  branch?: string;
  /** "remote/branch" upstream, or undefined. */
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  /** Unmerged (conflict) entries — the "merge" group. */
  merge: StatusFile[];
  /** Staged (index) changes. */
  staged: StatusFile[];
  /** Working-tree changes + untracked files. */
  unstaged: StatusFile[];
}

function empty(): RepoStatus {
  return {
    ahead: 0,
    behind: 0,
    detached: false,
    merge: [],
    staged: [],
    unstaged: [],
  };
}

/**
 * Reads the working-tree status directly via `git status`, so the Changes view
 * renders instantly from our own git-service instead of waiting for vscode.git
 * to activate + scan. Used as the eager source; once vscode.git attaches its
 * live `repo.state`, the view switches to that (it stays live on file edits).
 */
export class StatusProvider {
  constructor(private readonly proc: GitProcess) {}

  async read(opts?: GitRunOptions): Promise<RepoStatus> {
    const r = await this.proc.run(
      ["status", "--porcelain=v2", "--branch", "-z"],
      { signal: opts?.signal },
    );
    if (r.code !== 0) {
      return empty();
    }
    return parseV2(r.stdout);
  }
}

// Map a porcelain-v2 index status code to the extension's letter.
function stagedLetter(x: string): string | undefined {
  switch (x) {
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R"; // renamed/copied both surface as "R" (matches statusLetter)
    case "T":
      return "T";
    default:
      return undefined; // "." = unchanged in the index
  }
}

// Map a porcelain-v2 worktree status code to the extension's letter.
function unstagedLetter(y: string): string | undefined {
  switch (y) {
    case "M":
      return "M";
    case "D":
      return "D";
    case "T":
      return "T";
    case "A":
      // Intent-to-add (`git add -N`) surfaces as worktree "A"; vscode.git maps
      // INTENT_TO_ADD → "A" in workingTreeChanges, so match it (else the file
      // is invisible during the eager window then pops in when vscode.git lands).
      return "A";
    default:
      return undefined; // "." = unchanged in the worktree
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. Records are NUL-separated; a
 * `2 …` rename/copy record is followed by an extra NUL field (the original
 * path) which we consume + drop.
 */
export function parseV2(stdout: string): RepoStatus {
  const out = empty();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) {
      continue;
    }
    const kind = rec[0];

    if (kind === "#") {
      // Branch header lines: "# branch.head main", "# branch.upstream o/main",
      // "# branch.ab +2 -1".
      const rest = rec.slice(2);
      if (rest.startsWith("branch.head ")) {
        const name = rest.slice("branch.head ".length);
        if (name === "(detached)") {
          out.detached = true;
        } else {
          out.branch = name;
        }
      } else if (rest.startsWith("branch.upstream ")) {
        out.upstream = rest.slice("branch.upstream ".length);
      } else if (rest.startsWith("branch.ab ")) {
        const m = /\+(\d+)\s+-(\d+)/.exec(rest);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }

    if (kind === "?") {
      out.unstaged.push({ path: rec.slice(2), status: "U" });
      continue;
    }
    if (kind === "!") {
      continue; // ignored — never shown
    }

    if (kind === "u") {
      // Unmerged/conflict: "u <XY> <...8 fields...> <path>". Path is the field
      // AFTER the 10 space-separated tokens; simplest is to take everything
      // after the 10th space.
      const path = afterNTokens(rec, 10);
      if (path) {
        out.merge.push({ path, status: "!" });
      }
      continue;
    }

    if (kind === "1" || kind === "2") {
      // Ordinary ("1 <XY> <6 fields> <path>") or rename/copy
      // ("2 <XY> <7 fields incl Xscore> <path>"). The XY code is token[1].
      const xy = rec.split(" ", 2)[1] ?? "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const path =
        kind === "1" ? afterNTokens(rec, 8) : afterNTokens(rec, 9);
      if (kind === "2") {
        // The original path rides in the next NUL field — drop it.
        i++;
      }
      if (!path) {
        continue;
      }
      const s = stagedLetter(x);
      if (s) {
        out.staged.push({ path, status: s });
      }
      const u = unstagedLetter(y);
      if (u) {
        out.unstaged.push({ path, status: u });
      }
    }
  }
  return out;
}

/** Return everything after the first `n` space-separated tokens of `rec`
 * (the path can itself contain spaces, so we don't split it). */
function afterNTokens(rec: string, n: number): string {
  let idx = 0;
  for (let k = 0; k < n; k++) {
    const sp = rec.indexOf(" ", idx);
    if (sp === -1) {
      return "";
    }
    idx = sp + 1;
  }
  return rec.slice(idx);
}
