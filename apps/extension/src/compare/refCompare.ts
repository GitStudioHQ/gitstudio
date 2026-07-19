import * as vscode from "vscode";
import type { CommitRecord, GitRef } from "@gitstudio/host-bridge/git";
import type { RepoEntry } from "../git/repoManager";
import { toRevisionUri } from "../history/revisionContentProvider";

// The ref-comparison engine, lifted out of the retired Search & Compare view so
// the branch-compare panel (and any future consumer) can reuse the same
// battle-tested git plumbing: `git log base..head` for the commits, `git diff
// --name-status -M` (3-dot or 2-dot) for the files, `rev-list --count` for the
// behind count, and native `vscode.diff` over `gitstudio-rev:` URIs per file.

const COMPARE_COMMIT_LIMIT = 400;

/** A file changed between the two compared refs. */
export interface CompareFile {
  path: string;
  /** Single-letter git status (A/M/D/R…). */
  status: string;
  /** Lines added (from `--numstat`); -1 for a binary file. */
  additions: number;
  /** Lines deleted (from `--numstat`); -1 for a binary file. */
  deletions: number;
  /** For a rename (status R), the original path. */
  oldPath?: string;
}

/** The full result of comparing two refs. */
export interface CompareResult {
  /** Commits in `head` that `base` doesn't have (base..head). */
  commits: CommitRecord[];
  files: CompareFile[];
  /** Total lines added across all files (binaries excluded). */
  additions: number;
  /** Total lines deleted across all files (binaries excluded). */
  deletions: number;
  /** `head` is this many commits ahead of `base`. Counted exactly via
   *  `rev-list --count`; the `commits` LIST above is capped for display, but
   *  this number is not, so a >400-commit lead still reports truthfully. */
  ahead: number;
  /** `head` is this many commits behind `base` (commits base has, head lacks). */
  behind: number;
  /**
   * The ref to diff each file FROM. For 3-dot this is the merge-base of the two
   * refs (GitHub's "what head introduced"); for 2-dot it's `base` directly.
   */
  filesLeftRef: string;
}

/** Collect up to `limit` commits from a `git log` invocation. */
export async function collectCommits(
  repo: RepoEntry,
  logArgs: string[],
  paths: string[] = [],
  limit = COMPARE_COMMIT_LIMIT,
): Promise<CommitRecord[]> {
  const FIELD = "\x1f";
  const RECORD = "\x1e";
  const format =
    `--pretty=format:%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at` +
    `${FIELD}%cn${FIELD}%ce${FIELD}%ct${FIELD}%s${FIELD}%b${RECORD}`;
  const args = [
    "log",
    "--date-order",
    format,
    `--max-count=${limit}`,
    ...logArgs,
  ];
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  const result = await repo.ctx.process.run(args);
  if (result.code !== 0) {
    return [];
  }
  const commits: CommitRecord[] = [];
  for (const raw of result.stdout.split(RECORD)) {
    const trimmed = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (trimmed.length === 0) {
      continue;
    }
    const f = trimmed.split(FIELD);
    if (f.length < 10 || f[0] === "") {
      continue;
    }
    commits.push({
      sha: f[0],
      parents: f[1].split(" ").filter((p) => p.length > 0),
      author: f[2],
      authorEmail: f[3],
      authorDate: Number(f[4]),
      committer: f[5],
      committerEmail: f[6],
      committerDate: Number(f[7]),
      subject: f[8],
      body: f[9],
    });
  }
  return commits;
}

/**
 * Reconstruct the new path from a `--numstat` rename token, which git renders
 * as either `old => new` or `pre{old => new}post` (compressed common
 * pre/suffix). Returns the plain path unchanged when there's no rename arrow.
 */
function numstatNewPath(token: string): string {
  const brace = token.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    // `src/{a => b}/f` → `src/b/f`; collapse any doubled slash from an empty side.
    return (brace[1] + brace[3] + brace[4]).replace(/\/\//g, "/");
  }
  const arrow = token.indexOf(" => ");
  return arrow >= 0 ? token.slice(arrow + 4) : token;
}

/** Files changed between two refs, with per-file line counts. `threeDot` uses
 *  `A...B` (what B introduced, GitHub-style); otherwise the direct `A B` diff. */
export async function collectCompareFiles(
  repo: RepoEntry,
  refA: string,
  refB: string,
  threeDot = true,
): Promise<CompareFile[]> {
  const range = threeDot ? [`${refA}...${refB}`] : [refA, refB];
  const [nameStatus, numstat] = await Promise.all([
    repo.ctx.process.run(["diff", "--name-status", "-M", ...range]),
    repo.ctx.process.run(["diff", "--numstat", "-M", ...range]),
  ]);
  if (nameStatus.code !== 0) {
    return [];
  }
  // Per-new-path line counts. `-` means binary (git prints `-\t-\tpath`).
  const counts = new Map<string, { additions: number; deletions: number }>();
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split("\t");
      if (parts.length < 3) {
        continue;
      }
      const add = parts[0] === "-" ? -1 : Number(parts[0]);
      const del = parts[1] === "-" ? -1 : Number(parts[1]);
      counts.set(numstatNewPath(parts.slice(2).join("\t")), {
        additions: Number.isFinite(add) ? add : 0,
        deletions: Number.isFinite(del) ? del : 0,
      });
    }
  }
  const files: CompareFile[] = [];
  for (const line of nameStatus.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    // Renames/copies carry both old (parts[1]) and new (parts[2]) paths.
    const isRename = status === "R" || status === "C";
    const path = isRename ? (parts[2] ?? "") : (parts[1] ?? "");
    if (!path) {
      continue;
    }
    const c = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status,
      additions: c.additions,
      deletions: c.deletions,
      oldPath: isRename ? parts[1] : undefined,
    });
  }
  return files;
}

/** The merge-base of two refs, or undefined if none / on error. */
async function mergeBase(
  repo: RepoEntry,
  a: string,
  b: string,
): Promise<string | undefined> {
  const r = await repo.ctx.process.run(["merge-base", a, b]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : undefined;
}

/** How many commits are in `from..to` (i.e. reachable from `to` but not `from`).
 *  Used for BOTH ahead (base..head) and behind (head..base), uncapped. */
async function countRange(
  repo: RepoEntry,
  from: string,
  to: string,
): Promise<number> {
  const r = await repo.ctx.process.run([
    "rev-list",
    "--count",
    `${from}..${to}`,
  ]);
  if (r.code !== 0) {
    return 0;
  }
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Throw if `ref` does not resolve to a commit, so an invalid/nonexistent ref
 *  surfaces as an error instead of a silent all-empty ("identical") result. */
async function assertRef(repo: RepoEntry, ref: string): Promise<void> {
  const r = await repo.ctx.process.run([
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`Unknown ref: ${ref}`);
  }
}

/** Compare `base` against `head` — commits, files, ahead/behind. */
export async function compareRefsData(
  repo: RepoEntry,
  base: string,
  head: string,
  threeDot: boolean,
): Promise<CompareResult> {
  // Fail loudly on an unknown ref (the panel's catch turns the throw into an
  // error view) instead of silently rendering an all-empty "identical" result.
  await Promise.all([assertRef(repo, base), assertRef(repo, head)]);
  const [commits, files, ahead, behind, mb] = await Promise.all([
    collectCommits(repo, [`${base}..${head}`], []),
    collectCompareFiles(repo, base, head, threeDot),
    countRange(repo, base, head), // ahead: commits head has, base lacks
    countRange(repo, head, base), // behind: commits base has, head lacks
    threeDot ? mergeBase(repo, base, head) : Promise.resolve(undefined),
  ]);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (f.additions > 0) additions += f.additions;
    if (f.deletions > 0) deletions += f.deletions;
  }
  return {
    commits,
    files,
    additions,
    deletions,
    ahead,
    behind,
    filesLeftRef: threeDot ? (mb ?? base) : base,
  };
}

/** The raw unified-diff patch for ONE file between two refs, for inline
 *  rendering in the compare view. `-M` detects renames; a small context. */
export async function fileDiffPatch(
  repo: RepoEntry,
  refA: string,
  refB: string,
  path: string,
  oldPath?: string,
  threeDot = true,
): Promise<string> {
  const range = threeDot ? [`${refA}...${refB}`] : [refA, refB];
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  const r = await repo.ctx.process.run([
    "diff",
    "-M",
    ...range,
    "--",
    ...paths,
  ]);
  return r.code === 0 ? r.stdout : "";
}

/** Open a native side-by-side diff of one file between two refs. For a rename,
 *  the left (base) side reads from `oldPath`. */
export async function openCompareFileDiff(arg: {
  root: string;
  refA: string;
  refB: string;
  path: string;
  oldPath?: string;
}): Promise<void> {
  if (!arg) {
    return;
  }
  const left = toRevisionUri(arg.root, arg.refA, arg.oldPath || arg.path);
  const right = toRevisionUri(arg.root, arg.refB, arg.path);
  const name = arg.path.split("/").pop() ?? arg.path;
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${name} (${arg.refA} ↔ ${arg.refB})`,
  );
}

/** A QuickPick over the repo's branches/tags; returns the chosen ref name. */
export async function pickRef(
  refs: GitRef[],
  title: string,
): Promise<string | undefined> {
  const icon = (r: GitRef) =>
    r.type === "tag"
      ? "$(tag)"
      : r.type === "remote"
        ? "$(cloud)"
        : "$(git-branch)";
  const picked = await vscode.window.showQuickPick(
    refs.map((r) => ({
      label: `${icon(r)} ${r.name}`,
      description: r.sha.slice(0, 7),
      name: r.name,
    })),
    { title, placeHolder: "Pick a branch / tag" },
  );
  return picked?.name;
}
