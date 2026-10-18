import * as vscode from "vscode";
import type { CommitRecord, GitRef } from "@gitstudio/host-bridge/git";
import { mergeCommitFiles } from "@gitstudio/git-service/CommitDetailsProvider";
import type { RepoEntry } from "../git/repoManager";
import { toRevisionUri } from "../history/revisionContentProvider";
import { promptInput, promptPick, type DialogChoice } from "../ui/dialogs";
import * as l10n from "@vscode/l10n";
import { openDiff } from "../merge/diffPlaces";
import { refLabel } from "@gitstudio/host-bridge/graphRefFilter";

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
  /** What `base` and `head` name, as git resolves them — for each pill's icon. */
  baseKind: RefKind;
  headKind: RefKind;
}

/** What a ref names: a local branch, a remote branch, a tag, or a commit. */
export type RefKind = "branch" | "remote" | "tag" | "commit";

/**
 * What `ref` names, resolved the way git resolves it for the comparison
 * (`rev-parse --symbolic-full-name`). A sha, `HEAD~2` or anything else that
 * is not a ref is a commit. An option-like name never reaches git.
 */
export async function refKind(repo: RepoEntry, ref: string): Promise<RefKind> {
  if (!ref || ref.startsWith("-")) {
    return "commit";
  }
  const r = await repo.ctx.process.run(["rev-parse", "--symbolic-full-name", ref]);
  const full = r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "") : "";
  if (full.startsWith("refs/heads/")) return "branch";
  if (full.startsWith("refs/remotes/")) return "remote";
  if (full.startsWith("refs/tags/")) return "tag";
  return "commit";
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

/** Files changed between two refs, with per-file line counts. `threeDot` uses
 *  `A...B` (what B introduced, GitHub-style); otherwise the direct `A B` diff.
 *
 *  NUL-separated (`-z`), through the parser the commit details use: without
 *  it git quotes an "unusual" path ("\303\251t\303\251.txt", quotes and all)
 *  and a tab or newline in a name splits the line — the push review listed
 *  names no file has, without their counts, and their diffs opened nothing. */
export async function collectCompareFiles(
  repo: RepoEntry,
  refA: string,
  refB: string,
  threeDot = true,
): Promise<CompareFile[]> {
  const range = threeDot ? [`${refA}...${refB}`] : [refA, refB];
  const [nameStatus, numstat] = await Promise.all([
    repo.ctx.process.run(["diff", "--name-status", "-z", "-M", ...range]),
    repo.ctx.process.run(["diff", "--numstat", "-z", "-M", ...range]),
  ]);
  if (nameStatus.code !== 0) {
    return [];
  }
  return mergeCommitFiles(numstat.code === 0 ? numstat.stdout : "", nameStatus.stdout);
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
    throw new Error(l10n.t("Unknown ref: {0}", ref));
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
  const [commits, files, ahead, behind, mb, baseKind, headKind] = await Promise.all([
    collectCommits(repo, [`${base}..${head}`], []),
    collectCompareFiles(repo, base, head, threeDot),
    countRange(repo, base, head), // ahead: commits head has, base lacks
    countRange(repo, head, base), // behind: commits base has, head lacks
    threeDot ? mergeBase(repo, base, head) : Promise.resolve(undefined),
    refKind(repo, base),
    refKind(repo, head),
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
    baseKind,
    headKind,
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
  await openDiff(
    left,
    right,
    `${name} (${compareRefLabel(arg.refA)} ↔ ${compareRefLabel(arg.refB)})`,
    undefined,
    "compare",
  );
}

/**
 * A compared side as the panel names it: a commit by its short sha, a ref by
 * its name with the namespace shorn ("refs/tags/v1" reads "v1", as the graph's
 * chips say it). The panel compares by full names and full shas, so neither a
 * tag and a branch of one name nor two abbreviations can be mistaken for each
 * other; only what is SHOWN is short. Each pill's icon still says which kind.
 */
export function compareRefLabel(ref: string): string {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref) ? ref.slice(0, 7) : refLabel(ref);
}

/** The id of the "Enter a commit SHA…" row. Never a ref's: those start "refs/". */
export const ENTER_COMMIT = "enter-commit";

/**
 * What a commit can be compared with (issue #123): every local branch, then
 * every remote branch (a remote's HEAD pointer left out — it is a copy of the
 * default branch beside it), then every tag. Each is picked by its FULL name:
 * `%(refname:short)` is "heads/release" beside a tag "release", and a short
 * name handed on to git means whichever of the two git prefers.
 */
export function compareTargetChoices(refs: readonly GitRef[]): DialogChoice[] {
  const of = (type: GitRef["type"], icon: string): DialogChoice[] =>
    refs
      .filter((r) => r.type === type && !(type === "remote" && r.symref))
      .map((r) => ({
        id: r.fullName,
        label: refLabel(r.fullName),
        icon,
        detail: r.sha.slice(0, 7),
      }));
  return [
    { id: ENTER_COMMIT, label: l10n.t("Enter a commit SHA…"), icon: "git-commit" },
    ...of("head", "git-branch"),
    ...of("remote", "cloud"),
    ...of("tag", "tag"),
  ];
}

/** `rev` as a full commit sha, or undefined when it names no commit here. An
 *  option-like text never reaches git. */
export async function resolveCommit(repo: RepoEntry, rev: string): Promise<string | undefined> {
  const text = rev.trim();
  if (!text || text.startsWith("-")) {
    return undefined;
  }
  try {
    const r = await repo.ctx.process.run(["rev-parse", "--verify", "--quiet", `${text}^{commit}`]);
    const sha = r.code === 0 ? r.stdout.trim() : "";
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask what to compare a commit with: a branch, a remote branch, a tag, or a
 * commit typed by its SHA. Answers a ref's full name or a commit's full sha;
 * undefined when the question was dismissed. A SHA that names no commit asks
 * again, with what was typed still in the field and the reason under the title.
 */
export async function pickCompareTarget(repo: RepoEntry, title: string): Promise<string | undefined> {
  let refs: GitRef[] = [];
  try {
    refs = await repo.ctx.refs.listRefs();
  } catch {
    // No refs to list still leaves the SHA row.
  }
  const picked = await promptPick({ title, choices: compareTargetChoices(refs) });
  if (picked !== ENTER_COMMIT) {
    return picked;
  }
  let value = "";
  let hint: string | undefined;
  for (;;) {
    const typed = (
      await promptInput({
        title,
        placeholder: l10n.t("Commit SHA"),
        value,
        hint,
        confirmLabel: l10n.t("Compare"),
        validate: "nonEmpty",
      })
    )?.trim();
    if (!typed) {
      return undefined;
    }
    const sha = await resolveCommit(repo, typed);
    if (sha) {
      return sha;
    }
    value = typed;
    hint = l10n.t("{0} is not a commit in this repository.", typed);
  }
}
