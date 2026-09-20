import type { CommitFileChange } from "@gitstudio/host-bridge/git";
import { GitProcess } from "./GitProcess";
import type { GitRunOptions } from "./GitProcess";

/** A commit's change summary — one row of the graph's CHANGES column. */
export interface CommitStat {
  sha: string;
  /** Files touched: a rename counts once, a binary file counts. */
  files: number;
  /** Line totals across text files; a binary file adds nothing here. */
  additions: number;
  deletions: number;
}

/**
 * Reads the per-file change set for a single commit — the data behind a
 * GitLens/GitKraken "commit details" panel. A commit is diffed against its
 * first parent (so merges show their first-parent delta, matching how every
 * graph client presents them); a root commit is diffed against the empty tree.
 *
 * Status comes from `--name-status` (authoritative, with rename old/new paths);
 * line counts come from `--numstat`. Both use `-z` so paths with spaces,
 * quotes, or renames parse unambiguously. The two are merged by new path.
 */
export class CommitDetailsProvider {
  constructor(private readonly process: GitProcess) {}

  /**
   * Files changed by `sha`. Pass `firstParent` (the commit's first parent sha)
   * to diff against it; omit/empty for a root commit (diff vs the empty tree).
   */
  async getCommitFiles(
    sha: string,
    firstParent?: string,
    opts?: GitRunOptions,
  ): Promise<CommitFileChange[]> {
    const base = firstParent
      ? (flag: string) => ["diff", "-M", "-z", flag, firstParent, sha]
      : (flag: string) => ["show", "-M", "-z", "--format=", flag, sha];

    const [numstat, namestatus] = await Promise.all([
      this.process.run(base("--numstat"), opts),
      this.process.run(base("--name-status"), opts),
    ]);
    return mergeCommitFiles(numstat.stdout, namestatus.stdout);
  }

  /**
   * Change summaries for MANY commits in ONE git process.
   *
   * The graph's CHANGES column asks for every row in view at once — sixty and
   * more on a tall window — and answering that through `getCommitFiles` cost
   * two spawns per row, three when the caller first streamed `log -1` just to
   * learn the first parent. One `log --no-walk` over the whole list yields the
   * same numbers: a commit is diffed against its first parent (`-m
   * --first-parent`, the spelling every git understands, old and new — so a
   * merge shows exactly what `getCommitFiles(sha, parents[0])` shows), a root
   * commit against the empty tree (`--root`, so a user's `log.showRoot=false`
   * cannot blank it), renames detected as `-M` detects them. The shas travel
   * on stdin, so no window is too tall for the argv limit.
   *
   * One unknown object fails the whole batch — git says so and exits — and
   * that is thrown like any other failed read, for the caller to retry or not.
   */
  async getCommitStats(shas: string[], opts?: GitRunOptions): Promise<CommitStat[]> {
    if (shas.length === 0) {
      return [];
    }
    const r = await this.process.run(
      [
        "log",
        "--no-walk=unsorted",
        "-z",
        "-M",
        "--numstat",
        "-m",
        "--first-parent",
        "--root",
        "--format=%H",
        "--stdin",
      ],
      { ...opts, input: shas.join("\n") + "\n" },
    );
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || `git log --numstat exited ${r.code}`);
    }
    return parseCommitStatsZ(r.stdout);
  }
}

/**
 * Parse `git log --no-walk -z --numstat --format=%H` into one summary per
 * commit. With `-z` every field is NUL-terminated: a commit is its sha, then —
 * only when it changed something — a `\n` and its numstat entries, each
 * `<adds>\t<dels>\t<path>`; a rename carries an empty path and the old and new
 * paths follow as two fields of their own. A commit that changed nothing (an
 * empty commit, an `ours` merge) is its sha alone, straight into the next one.
 */
export function parseCommitStatsZ(stdout: string): CommitStat[] {
  const out: CommitStat[] = [];
  let cur: CommitStat | undefined;
  const tokens = stdout.split("\0");
  let i = 0;
  while (i < tokens.length) {
    // The `\n` between a commit's header and its diff rides on the first
    // entry's field. A rename's old/new paths are consumed positionally below,
    // so this strip can never touch a path.
    const tok = tokens[i].startsWith("\n") ? tokens[i].slice(1) : tokens[i];
    i += 1;
    if (tok === "") {
      continue;
    }
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tok)) {
      cur = { sha: tok, files: 0, additions: 0, deletions: 0 };
      out.push(cur);
      continue;
    }
    const parts = tok.split("\t");
    if (!cur || parts.length < 3) {
      continue;
    }
    if (parts.slice(2).join("\t") === "") {
      i += 2; // a rename: the old and new path fields follow
    }
    cur.files += 1;
    // A binary file reports `-` for both counts: a file, not any lines.
    const adds = Number(parts[0]);
    const dels = Number(parts[1]);
    if (adds > 0) cur.additions += adds;
    if (dels > 0) cur.deletions += dels;
  }
  return out;
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  path: string;
  oldPath?: string;
}

/** Parse `git diff --numstat -z` output into per-new-path line counts. */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
  const tokens = stdout.split("\0");
  const out: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head === "" || head === undefined) {
      i += 1;
      continue;
    }
    // head = "<adds>\t<dels>\t<pathOrEmpty>"
    const parts = head.split("\t");
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const additions = parts[0] === "-" ? -1 : Number(parts[0]) || 0;
    const deletions = parts[1] === "-" ? -1 : Number(parts[1]) || 0;
    const inlinePath = parts.slice(2).join("\t");
    if (inlinePath === "") {
      // Rename/copy: the next two NUL fields are old then new path.
      const oldPath = tokens[i + 1] ?? "";
      const path = tokens[i + 2] ?? "";
      out.push({ additions, deletions, path, oldPath });
      i += 3;
    } else {
      out.push({ additions, deletions, path: inlinePath });
      i += 1;
    }
  }
  return out;
}

interface NameStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
}

/** Parse `git diff --name-status -z` output into status + paths per file. */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split("\0");
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i];
    if (raw === "" || raw === undefined) {
      i += 1;
      continue;
    }
    const status = raw[0]; // R100 -> R, C75 -> C, otherwise A/M/D/T/U…
    if (status === "R" || status === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const path = tokens[i + 2] ?? "";
      out.push({ status, path, oldPath });
      i += 3;
    } else {
      const path = tokens[i + 1] ?? "";
      out.push({ status, path });
      i += 2;
    }
  }
  return out;
}

/**
 * Merge numstat counts into the authoritative name-status entries (keyed by new
 * path), preserving the name-status order. Files with no numstat line (e.g.
 * pure renames with no content change) default to 0/0.
 */
export function mergeCommitFiles(
  numstatStdout: string,
  nameStatusStdout: string,
): CommitFileChange[] {
  const counts = new Map<string, NumstatEntry>();
  for (const n of parseNumstatZ(numstatStdout)) {
    counts.set(n.path, n);
  }
  const out: CommitFileChange[] = [];
  for (const entry of parseNameStatusZ(nameStatusStdout)) {
    const c = counts.get(entry.path);
    out.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: c ? c.additions : 0,
      deletions: c ? c.deletions : 0,
    });
  }
  return out;
}
