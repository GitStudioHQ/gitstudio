// Several commits' files as one change (#161) — what the "N commits selected"
// summary lists, so a stack can be read the way one commit is.
//
// Two answers, and which one is decided by the commits, never guessed:
//
//   stack   The selection is one unbroken run: each commit is the first
//           parent of the next. Then there IS one change, from the oldest
//           one's parent to the newest, and git diffs it in one go — exact
//           files, renames, line counts, and a file changed and changed back
//           inside the run is not listed. It is what squashing them would
//           make.
//   pieces  Anything else: a gap, or commits from more than one line. There
//           is no single before and after for the whole selection, so each
//           file gets its own: from before the first selected commit that
//           changed it to after the last. That can take in commits between
//           them that are not selected — and when the commits are on more
//           than one line of history (`divergent`), the last one's side does
//           not hold the other line's change at all. The pane says which.
//
// One git process reads every selected commit's parents and changes; a stack
// costs one more for its diff, pieces one more to ask whether every commit is
// an ancestor of the newest. The shas go on stdin, so a long selection is no
// problem for the command line.

import type { CombinedChanges, CombinedFileChange, CommitFileChange } from "@gitstudio/host-bridge/git";
import { attachGitFailure } from "@gitstudio/host-bridge/reportShape";
import type { GitProcess, GitRunOptions, GitRunResult } from "./GitProcess";
import { mergeCommitFiles } from "./CommitDetailsProvider";

/** git's empty tree: the "before" of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The same in a sha-256 repository, where the sha-1 one names nothing. */
export const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/** The empty tree of the repository `sha` is from: its object format is its length. */
export function emptyTreeFor(sha: string): string {
  return sha.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE;
}

/**
 * `-m --first-parent` is the spelling every git understands, but from git
 * 2.31 on `-m` takes the user's `log.diffMerges` (combined, remerge…), which
 * then wins over `--first-parent` and a merge lists no files. Pinned here;
 * an older git ignores a config key it does not know.
 */
export const FIRST_PARENT_DIFFS = ["-c", "log.diffMerges=first-parent"] as const;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A selected commit as `git log` describes it: its parents, and what it changed against the first. */
export interface CommitChanges {
  sha: string;
  parents: string[];
  changes: { status: string; path: string; oldPath?: string }[];
}

/**
 * The files `shas` changed, combined. `shas` are the selection in the
 * graph's order, newest first — a topological order, which `pieces` relies
 * on: of two selected commits where one is the other's ancestor, the
 * ancestor comes later. A sha git cannot find is left out.
 */
export async function combinedChanges(
  proc: GitProcess,
  shas: readonly string[],
  opts?: GitRunOptions,
): Promise<CombinedChanges> {
  const wanted = shas.filter((s) => SHA.test(s));
  if (wanted.length === 0) return { kind: "pieces", files: [] };
  const logArgs = [
    ...FIRST_PARENT_DIFFS,
    "log",
    "--no-walk=unsorted",
    "--ignore-missing",
    "-z",
    "-M",
    "--name-status",
    // A merge is read against its first parent, as its own details are.
    "-m",
    "--first-parent",
    // A root commit lists its files as added (whatever log.showRoot says).
    "--root",
    "--format=%H %P",
    "--stdin",
  ];
  const r = await proc.run(logArgs, { ...opts, input: wanted.join("\n") + "\n" });
  if (r.code !== 0) throw failed(logArgs, r);
  const commits = parseCommitChangesZ(r.stdout);
  const run = stackOf(commits);
  if (run) {
    const diff = (flag: string) => ["diff", "-M", "-z", flag, run.base, run.tip];
    const [numstat, nameStatus] = await Promise.all([
      proc.run(diff("--numstat"), opts),
      proc.run(diff("--name-status"), opts),
    ]);
    if (numstat.code !== 0) throw failed(diff("--numstat"), numstat);
    if (nameStatus.code !== 0) throw failed(diff("--name-status"), nameStatus);
    const files = mergeCommitFiles(numstat.stdout, nameStatus.stdout).map(
      ({ oldPath, ...f }): CombinedFileChange => ({ ...f, ...(oldPath ? { oldPath } : {}), from: run.base, to: run.tip }),
    );
    return { kind: "stack", files };
  }
  const files = combinePieces(commits);
  return (await oneLine(proc, commits, opts)) ? { kind: "pieces", files } : { kind: "pieces", divergent: true, files };
}

/** How much history `oneLine` walks before it gives up and says no. */
export const LINE_WALK_CAP = 20_000;

/**
 * Whether the commits (newest first) are one line of history: each an
 * ancestor of the one listed before it. Only then does a file's last
 * selected change sit on top of its first, so its diff holds every selected
 * change to it. One walk from the newest down to the oldest one's parents
 * answers it; a walk longer than LINE_WALK_CAP says no, which only costs the
 * pane a more careful note.
 */
async function oneLine(proc: GitProcess, commits: readonly CommitChanges[], opts?: GitRunOptions): Promise<boolean> {
  if (commits.length < 2) return true;
  const tip = commits[0].sha;
  const floor = commits[commits.length - 1].parents.map((p) => `^${p}`);
  const args = ["rev-list", "--parents", `--max-count=${LINE_WALK_CAP}`, "--stdin"];
  const r = await proc.run(args, { ...opts, input: [tip, ...floor].join("\n") + "\n" });
  if (r.code !== 0) throw failed(args, r);
  const lines = r.stdout.split("\n").filter(Boolean);
  if (lines.length >= LINE_WALK_CAP) return false;
  const parents = new Map<string, string[]>();
  for (const line of lines) {
    const [sha, ...ps] = line.split(" ");
    parents.set(sha, ps);
  }
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const p of parents.get(at) ?? []) stack.push(p);
    }
    return false;
  };
  for (let i = 0; i + 1 < commits.length; i++) {
    if (!reaches(commits[i].sha, commits[i + 1].sha)) return false;
  }
  return true;
}

/** A git failure, with the facts a crash report is built from (reportShape.ts). */
function failed(args: string[], r: GitRunResult): Error {
  const stderr = r.stderr.trim();
  return attachGitFailure(
    new Error(`git ${args[0]} exited with code ${r.code}` + (stderr ? `: ${stderr}` : "")),
    { args: [...args], exitCode: r.code, stderr },
  );
}

/**
 * Parse `git log --no-walk -z --name-status --format="%H %P"`: per commit a
 * header — its sha and parents, NUL-terminated — then, when it changed
 * anything, a `\n` and its entries, each a status field and one path field
 * (two for a rename or copy: old, then new). The paths are consumed by
 * position, so a path that looks like a status letter or a sha stays a path.
 */
export function parseCommitChangesZ(stdout: string): CommitChanges[] {
  const out: CommitChanges[] = [];
  const tokens = stdout.split("\0");
  let cur: CommitChanges | undefined;
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i];
    i += 1;
    const tok = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (tok === "") continue;
    const head = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)((?: [0-9a-f]{40}(?:[0-9a-f]{24})?)*) ?$/.exec(tok);
    if (head) {
      cur = { sha: head[1], parents: head[2].split(" ").filter(Boolean), changes: [] };
      out.push(cur);
      continue;
    }
    if (!cur || !/^[A-Z]\d*$/.test(tok)) continue;
    const status = tok[0];
    if (status === "R" || status === "C") {
      const oldPath = tokens[i] ?? "";
      const path = tokens[i + 1] ?? "";
      i += 2;
      // A copy leaves its source where it was: the new path is an addition.
      cur.changes.push(status === "R" ? { status, path, oldPath } : { status: "A", path });
    } else {
      cur.changes.push({ status, path: tokens[i] ?? "" });
      i += 1;
    }
  }
  return out;
}

/**
 * The run the commits make, when they make one: a tip, and each commit's
 * first parent the next one down, until every one is used. `base` is the
 * oldest one's first parent — the empty tree for a root commit.
 */
export function stackOf(commits: readonly CommitChanges[]): { tip: string; base: string } | undefined {
  if (commits.length < 2) return undefined;
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  if (bySha.size !== commits.length) return undefined;
  const below = new Set(commits.map((c) => c.parents[0]).filter((p): p is string => !!p && bySha.has(p)));
  const tips = commits.filter((c) => !below.has(c.sha));
  if (tips.length !== 1) return undefined;
  let cur = tips[0];
  for (let n = 1; n < commits.length; n++) {
    const next = bySha.get(cur.parents[0] ?? "");
    if (!next) return undefined;
    cur = next;
  }
  return { tip: tips[0].sha, base: cur.parents[0] ?? emptyTreeFor(cur.sha) };
}

/** One path's history across the selection: before its first selected change, after its last. */
interface Span {
  path: string;
  /** The first selected commit that changed it. */
  first: string;
  from: string;
  existedBefore: boolean;
  to: string;
  existsAfter: boolean;
  /** The span this one's file was renamed into, or from (see combinePieces). */
  next?: Span;
  prev?: Span;
}

/**
 * Each file the commits changed, from before the first of them that changed
 * it to after the last. `commits` newest first, as `combinedChanges` takes
 * them; they are walked oldest first.
 *
 * Every PATH has one span, so no path is listed twice and no change to a path
 * is lost under another file's name. A rename then joins two spans into one
 * row only where it really is one file's story: the old name's last change is
 * that rename, and the new name's first. Otherwise the two names stay apart
 * (a deletion and an addition, or two changes), which is what a diff of the
 * whole range says too — a file renamed onto a name that was deleted earlier
 * in the selection, say, is that name changing.
 */
export function combinePieces(commits: readonly CommitChanges[]): CombinedFileChange[] {
  const spans = new Map<string, Span>();
  const renames: { c: CommitChanges; from: string; to: string }[] = [];
  for (const c of [...commits].reverse()) {
    // What this commit did to each path: there before it, there after it. A
    // path can be one rename's source and another's target (two files that
    // swap names): it was there before and is there after.
    const seen = new Map<string, { before: boolean; after: boolean }>();
    const mark = (path: string, before: boolean, after: boolean): void => {
      const m = seen.get(path);
      seen.set(path, m ? { before: m.before || before, after: m.after || after } : { before, after });
    };
    for (const ch of c.changes) {
      if (ch.status === "R" && ch.oldPath !== undefined) {
        mark(ch.oldPath, true, false);
        mark(ch.path, false, true);
        renames.push({ c, from: ch.oldPath, to: ch.path });
      } else {
        mark(ch.path, ch.status !== "A", ch.status !== "D");
      }
    }
    for (const [path, m] of seen) {
      const span = spans.get(path);
      if (span) {
        span.to = c.sha;
        span.existsAfter = m.after;
      } else {
        spans.set(path, {
          path,
          first: c.sha,
          from: c.parents[0] ?? emptyTreeFor(c.sha),
          existedBefore: m.before,
          to: c.sha,
          existsAfter: m.after,
        });
      }
    }
  }
  // A rename in commit c joins old → new when it is where old's story ends
  // (gone after c, its last change) and new's begins (not there before c,
  // its first change).
  for (const { c, from, to } of renames) {
    const a = spans.get(from);
    const b = spans.get(to);
    if (!a || !b || a.next || b.prev) continue;
    if (a.to !== c.sha || a.existsAfter) continue;
    if (b.first !== c.sha || b.existedBefore) continue;
    a.next = b;
    b.prev = a;
  }
  const out: CombinedFileChange[] = [];
  for (const head of spans.values()) {
    if (head.prev) continue;
    let tail = head;
    while (tail.next) tail = tail.next;
    // Added and deleted again inside the selection: nothing to show.
    if (!head.existedBefore && !tail.existsAfter) continue;
    const file: CommitFileChange = !head.existedBefore
      ? { path: tail.path, status: "A", additions: 0, deletions: 0 }
      : !tail.existsAfter
        ? { path: head.path, status: "D", additions: 0, deletions: 0 }
        : head.path !== tail.path
          ? { path: tail.path, oldPath: head.path, status: "R", additions: 0, deletions: 0 }
          : { path: tail.path, status: "M", additions: 0, deletions: 0 };
    out.push({ ...file, from: head.from, to: tail.to });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
