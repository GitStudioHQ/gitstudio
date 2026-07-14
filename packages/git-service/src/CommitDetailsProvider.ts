import type { CommitFileChange } from "@gitstudio/host-bridge/git";
import { GitProcess } from "./GitProcess";
import type { GitRunOptions } from "./GitProcess";

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
