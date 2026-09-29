import { refShortName } from "./checkoutRef";
import type { GitProcess, GitRunOptions, GitRunResult } from "./GitProcess";
import { rebaseInProgress } from "./rebaseInProgress";
import { isStashSha, literalPathspec as literally, StashProvider, stashBranchNameRefusal } from "./StashProvider";
import { parseV2 } from "./StatusProvider";
import { pick, sameStop, stoppedIn, type OperationInTheWay, type StoppedHere } from "./stoppedOperation";
import type { PullDirty, PullResult } from "./SyncOps";

export {
  operationInTheWayMessage,
  type OperationInTheWay,
  type StoppedOperation,
} from "./stoppedOperation";

// A command that applies commits to the working tree — revert, cherry-pick,
// merge, rebase, a branch checkout, a stash apply or pop — REFUSES when the
// user's uncommitted work is in its way, and changes nothing. That is the
// commonest failure any of them has, and it is a state, not a defect: crash
// report #18 was a revert refused over "Your local changes to the following
// files would be overwritten by merge", filed as a crash with git's text.
//
// Recognised here the way the pull's `dirty` is (SyncOps.inTheWay): from the
// exit code and git's own state afterwards — HEAD where it was, nothing
// paused, nothing unmerged — and the user's uncommitted paths set against the
// paths the command would write. Never from git's English, which is
// localised: a Russian refusal reads nothing like the one above.
//
// What each command refuses over, verified against git 2.49
// (test/changesInTheWay.test.ts pins every row):
//
//   cherry-pick, revert   any STAGED change (the index must match HEAD), and an
//                         unstaged or untracked file the commit touches — 128
//   merge                 a staged change (a true merge; a fast-forward carries
//                         unrelated ones), and an unstaged or untracked file the
//                         incoming side touches — 2, or 1 for a fast-forward
//   rebase                ANY change to a tracked file, and an untracked file
//                         the new base has — 1
//   checkout              a change to a file that differs between HEAD and the
//                         target, or an untracked file the target has — 1
//   stash apply / pop     a change to a file the stash touches, or an untracked
//                         file the stash would restore — 1
//
// With `merge.autoStash` / `rebase.autoStash` git stashes by itself, so a
// refusal there is some other refusal and is never claimed.
//
// A PULL is the same refusal, recognised where the pull is run
// (SyncOps.pull's `dirty`), and gets the same answer here: its sentence
// (pullInTheWayMessage) and its Stash & Retry (stashAndRetryPull).

/** A command that applies commits to the working tree, and how to run it. */
export type ApplyOp =
  | {
      kind: "cherry-pick" | "revert";
      /** The commit being picked or reverted (the first, of several). */
      commit: string;
      /**
       * Several commits in one command (issue #32), in the order `args` runs
       * them — `commit` among them. git refuses such a run commit by commit,
       * so an edit in the way of the THIRD is refused after two were applied,
       * with the sequencer left open: this op is asked about before git starts
       * (aheadOfMany), never after.
       */
      commits?: readonly string[];
      /** `-m`: the parent a merge commit is taken against. */
      mainline?: number;
      args: string[];
    }
  | {
      kind: "merge";
      /** What is merged in. */
      target: string;
      /** `--no-ff`: a true merge even where a fast-forward would do. */
      noFf?: boolean;
      args: string[];
    }
  | { kind: "rebase"; onto: string; args: string[] }
  | {
      kind: "checkout";
      /** What HEAD will be at afterwards — a branch, a tag, a commit. */
      target: string;
      args: string[];
    }
  | {
      kind: "stash";
      /**
       * The stash to apply: its full sha, or `stash@{1}`. By sha it is found
       * in the list immediately before git runs (a pop needs the selector),
       * so a list renumbered meanwhile cannot make it pop another stash — and
       * a stash that has left the list is not run at all (`stashGone`).
       */
      stash: string;
      /** `pop` rather than `apply`. */
      pop?: boolean;
      /**
       * `--index`: stage again what was staged when the stash was made
       * (StashProvider.holdsStaged). Never run over an index with staged
       * changes of the user's — git resets the index before it merges, then
       * refuses, and those changes come out unstaged — so that answers
       * `indexBusy` without running; and when git refuses the staged half
       * itself ("conflicts in index"), having changed nothing, the answer is
       * `indexRefused`. Either way the caller may run it again without.
       */
      index?: boolean;
      /**
       * `git stash branch <branch>` instead of an apply: a new branch at the
       * stash's base, switched to, the stash applied there with its staging,
       * and dropped once it applies. It switches before it applies, so a
       * refusal of the apply would leave the switch done: what is in its way
       * is asked BEFORE git runs (stashBranchAhead), never read from the
       * failure. A name git cannot use is refused before anything else.
       */
      branch?: string;
      /**
       * `stash` is not a stash of the list but a stash-shaped commit cut from
       * this one, the listed stash's full sha (StashProvider.subset: some of
       * its files). It is applied by its own sha and never popped; the stash
       * it was cut from must still be in the list when git runs — a stash
       * that has left it runs nothing (`stashGone`), as for any stash op.
       */
      cutFrom?: string;
    };

/** What the user's uncommitted work was in the way of: a command that applies
 *  commits, or a pull. */
export type InTheWayKind = ApplyOp["kind"] | "pull";

/** The user's uncommitted work a command refused over. */
export interface ChangesInTheWay {
  kind: InTheWayKind;
  /** Repo-relative, sorted, never empty. */
  paths: string[];
  /** Those of them git does not track yet — a stash must include untracked files. */
  untracked: string[];
  /** A pull that rebases: it needs the whole working tree clean, not only
   *  the files it brings changes to. */
  rebase?: true;
  /** A stash op's `branch`: they are in the way of creating that branch from
   *  the stash — which switches to where the stash was made first — and not
   *  necessarily of the stash itself (a file it never touches can be). */
  branch?: string;
}

/**
 * Create a branch at HEAD and switch to it (`git checkout -b <name>`), as a
 * door op. Its target is HEAD itself: the working tree does not change, so
 * nothing of the user's is ever in its way — but it is a switch, and over a
 * stopped merge, cherry-pick or revert `git checkout -b` ENDS the operation
 * (`git switch -c` refuses), so the door refuses it there.
 */
export function newBranchAtHead(name: string): ApplyOp {
  return { kind: "checkout", target: "HEAD", args: ["checkout", "-b", name] };
}

/** A checkout op for the argv a door already runs: its target is its last word.
 *  (The desktop's and the extension's doors, and the AI tools, share it.) */
export function checkoutOp(args: string[]): ApplyOp {
  return { kind: "checkout", target: args[args.length - 1] ?? "HEAD", args };
}

/** The argv an op runs. */
export function applyArgs(op: ApplyOp): string[] {
  return op.kind === "stash" ? stashArgs(op, op.stash) : op.args;
}

/** `git stash apply|pop [--index] <stash>`, or `git stash branch <name>
 *  <stash>` — the one place a stash op's argv is written, so the first run
 *  and Stash & Retry's run cannot differ. */
function stashArgs(op: StashOp, stash: string): string[] {
  if (op.branch !== undefined) return ["stash", "branch", op.branch, stash];
  return ["stash", op.pop ? "pop" : "apply", ...(op.index ? ["--index"] : []), stash];
}

type StashOp = Extract<ApplyOp, { kind: "stash" }>;

/** Is this a `git stash branch`? */
const isStashBranch = (op: ApplyOp): op is StashOp & { branch: string } =>
  op.kind === "stash" && op.branch !== undefined;

/**
 * The argv to run NOW: a stash named by sha is looked up in the list at this
 * moment — a pop or a branch (which drop it) is handed its current
 * `stash@{n}` — or null when it has left the list. Everything else is
 * applyArgs.
 */
async function argsNow(proc: GitProcess, op: ApplyOp, signal?: AbortSignal): Promise<string[] | null> {
  if (op.kind !== "stash" || !isStashSha(op.stash)) return applyArgs(op);
  return stashArgsNow(new StashProvider(proc), op, op.stash, signal);
}

/**
 * A stash op's argv for the stash with sha `target`, where the list holds it
 * NOW — or null when it has left the list. A part cut from a stash
 * (`cutFrom`) is applied by its own sha, while the stash it came from is
 * still listed.
 */
async function stashArgsNow(
  stashes: StashProvider,
  op: StashOp,
  target: string | null,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (op.cutFrom !== undefined) {
    if (op.pop || op.branch !== undefined || !target) return null;
    return (await stashRefOf(stashes, op.cutFrom, signal)) ? stashArgs(op, target) : null;
  }
  const ref = await stashRefOf(stashes, target, signal);
  if (!ref) return null;
  return stashArgs(op, op.pop || op.branch !== undefined ? ref : (target as string));
}

/** A command that was not run. */
const NOT_RUN: GitRunResult = { code: 1, stdout: "", stderr: "" };

/** The operation's name, for a sentence. */
const THE: Record<InTheWayKind, string> = {
  revert: "the revert",
  "cherry-pick": "the cherry-pick",
  merge: "the merge",
  rebase: "the rebase",
  checkout: "switching to it",
  stash: "applying the stash",
  pull: "the pull",
};

/** "a.txt", "a.txt and b.txt", "a.txt, b.txt and 3 other files". */
function nameThe(paths: readonly string[]): string {
  if (paths.length === 1) return paths[0];
  if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
  const rest = paths.length - 2;
  return `${paths[0]}, ${paths[1]} and ${rest} other file${rest === 1 ? "" : "s"}`;
}

/**
 * What to tell the user: which of their changes are in the way, of what. The
 * way on — stash them and retry, or cancel — is the question the caller asks.
 */
export function changesInTheWayMessage(v: ChangesInTheWay): string {
  const them = v.paths.length === 1 ? "it" : "them";
  if (v.kind === "rebase" || (v.kind === "pull" && v.rebase)) {
    return (
      `${v.kind === "pull" ? "Pulling with rebase" : "A rebase"} needs a clean working tree, and your ` +
      `uncommitted changes to ${nameThe(v.paths)} are in the way. Stash ${them} and try again, or commit ${them} first.`
    );
  }
  if (v.kind === "stash" && v.branch !== undefined) {
    // Not "applying the stash": the file in the way may be one the stash never
    // touches, in the way of the switch to where the stash was made.
    return (
      `Your uncommitted changes to ${nameThe(v.paths)} are in the way of creating the branch “${v.branch}” ` +
      `from the stash, which first switches to where the stash was made. ` +
      `Stash ${them} and try again, or commit ${them} first.`
    );
  }
  return (
    `Your uncommitted changes to ${nameThe(v.paths)} are in the way of ${THE[v.kind]} — ` +
    `git won't overwrite them. Stash ${them} and try again, or commit ${them} first.`
  );
}

/**
 * Run `op`, and when it is refused over the user's uncommitted work, say which
 * of it is in the way. `inTheWay` is set only when NOTHING happened — the
 * command is safe to run again once those paths are out of the way.
 *
 * When git is ALREADY stopped — a merge, a rebase, a cherry-pick, a revert or
 * a `git am` waiting for the user, or files left unmerged — the uncommitted
 * files are that operation's (its conflicts, or the resolution staged for its
 * Continue), never the user's work in the way: stashing them would take them
 * out of the operation. A command git refuses there comes back `blocked`
 * instead, naming the operation — and only when nothing happened; a command
 * that stopped on conflicts of its own is git's outcome, as ever.
 *
 * A command that would END the stopped operation, or move HEAD out from under
 * it, is not run over one at all (endsOrMoves): a checkout — `git switch`
 * refuses it there, `git checkout` quietly ends a stopped merge, cherry-pick
 * or revert — a merge, a rebase, and a pick anywhere but a plain rebase stop.
 */
export async function runApplying(
  proc: GitProcess,
  op: ApplyOp,
  opts?: GitRunOptions,
): Promise<AppliedRun> {
  const signal = opts?.signal;
  // A new branch's name git will not take is refused before git looks at a
  // file — and before anything below could offer to stash the user's work
  // for a command that can never run.
  if (isStashBranch(op)) {
    const refused = await stashBranchNameRefusal(proc, op.branch, signal);
    if (refused) {
      return { result: { code: 1, stdout: "", stderr: refused } };
    }
  }
  const before = await where(proc, signal);
  const stop = await stoppedIn(proc, signal);
  // `git stash branch` switches first: over a stop, a checkout.
  if (stop && endsOrMoves(isStashBranch(op) ? "checkout" : op.kind, stop)) {
    return { result: NOT_RUN, blocked: { kind: op.kind, ...pick(stop) } };
  }
  // `--index` over staged changes of the user's would cost them their staging
  // (see ApplyOp's `index`), so it is not run there at all. Over files left
  // unmerged git refuses every stash before it writes a thing, `--index` or
  // not ("needs merge"): that is the stop's to say, below — not a question
  // about the stash's staging.
  if (op.kind === "stash" && op.index && !(stop && stop.unmerged > 0) && !(await indexMatchesHead(proc, signal))) {
    return { result: NOT_RUN, indexBusy: true };
  }
  if (stop) {
    const blocked: OperationInTheWay = { kind: op.kind, ...pick(stop) };
    // Asked before git runs: whether the stop has anything uncommitted — its
    // conflicts, or the resolution staged for its Continue.
    const busy = stop.unmerged > 0 || (await touchedTree(proc, signal));
    const args = await argsNow(proc, op, signal);
    if (!args) {
      return { result: NOT_RUN, stashGone: true };
    }
    const result = await proc.run(args, { signal });
    if (result.code === 0) {
      return { result };
    }
    // Refused over the stop's own files: HEAD where it was, and the same stop.
    // A rebase paused at an `edit` with a clean tree lets a pick run, so a
    // pick that fails there failed for its own reason, and is reported.
    if (busy && (await where(proc, signal)) === before && sameStop(await stoppedIn(proc, signal), stop)) {
      return { result, blocked };
    }
    return { result };
  }
  // A stash made with -u, and every `git stash branch`, is asked about BEFORE
  // git runs: their refusals are the ones here that are not "nothing
  // happened" (see untrackedStashAhead and stashBranchAhead).
  const ahead =
    op.kind !== "stash"
      ? null
      : isStashBranch(op)
        ? await stashBranchAhead(proc, op, signal)
        : await untrackedStashAhead(proc, op.stash, signal);
  if (ahead?.inTheWay) {
    return { result: NOT_RUN, inTheWay: ahead.inTheWay };
  }
  // So are several commits in one pick or revert (aheadOfMany).
  const many = await aheadOfMany(proc, op, signal);
  if (many) {
    return { result: NOT_RUN, inTheWay: many };
  }
  // The tree as it was, for telling a refused `--index` from a run that did
  // something (a -u stash has already read it).
  const tree = op.kind === "stash" && op.index ? (ahead?.status ?? (await porcelain(proc, signal))) : null;
  const args = await argsNow(proc, op, signal);
  if (!args) {
    return { result: NOT_RUN, stashGone: true };
  }
  const result = await proc.run(args, { signal });
  if (result.code === 0) {
    return { result };
  }
  // …and when it failed anyway, over something the question above could not
  // see, whatever git left half-applied is git's failure, never the user's
  // changes: said as git's, and reported.
  if (ahead && (await porcelain(proc, signal)) !== ahead.status) {
    return { result };
  }
  const inTheWay = await changesInTheWay(proc, op, before, signal);
  if (inTheWay) {
    return { result, inTheWay };
  }
  // Refused with nothing in the way and nothing changed: the staged half no
  // longer applies to the index ("conflicts in index" — HEAD has moved under
  // those files). The stash can still come back, unstaged; the caller asks.
  if (tree !== null && (await nothingHappened(proc, before, tree, signal))) {
    return { result, indexRefused: true };
  }
  return { result };
}

/** What runApplying answers: git's run, and — when it was not simply run —
 *  why. */
export interface AppliedRun {
  result: GitRunResult;
  /** Refused over the user's uncommitted work, having changed nothing. */
  inTheWay?: ChangesInTheWay;
  /** Refused because git is stopped in an operation. */
  blocked?: OperationInTheWay;
  /** A stash op whose stash, named by sha, has left the list: not run. */
  stashGone?: true;
  /** A stash op with `index` over staged changes of the user's: not run. */
  indexBusy?: true;
  /** A stash op with `index` whose staged half git refused: nothing changed. */
  indexRefused?: true;
}

/** Does the index hold nothing staged — the only index `stash apply --index`
 *  leaves alone when it refuses? */
async function indexMatchesHead(proc: GitProcess, signal?: AbortSignal): Promise<boolean> {
  return (await proc.run(["diff", "--cached", "--quiet", "HEAD", "--"], { signal })).code === 0;
}

/** HEAD and its branch where they were, nothing stopped, and the tree exactly
 *  as `tree` read it. */
async function nothingHappened(proc: GitProcess, before: string, tree: string, signal?: AbortSignal): Promise<boolean> {
  if ((await where(proc, signal)) !== before) return false;
  if (await stoppedIn(proc, signal)) return false;
  return (await porcelain(proc, signal)) === tree;
}

/**
 * Would running this command over this stop END the operation, or move HEAD
 * out from under it? Then it is refused before git runs. What git itself does
 * there, pinned against git 2.49 in test/operationInTheWay.test.ts:
 *
 *   checkout     ENDS a stopped merge, cherry-pick or revert (their *_HEAD
 *                removed, the resolution carried to the other branch), and
 *                moves HEAD out from under a rebase or an am. `git switch`
 *                refuses all five, which is the rule taken here.
 *   merge        a fast-forward moves HEAD out from under a stopped rebase;
 *                refused over a stopped revert's staged resolution, git's
 *                failure path removes REVERT_HEAD — the revert ENDED by a
 *                merge that never ran.
 *   rebase       over a clean tree it runs under a stopped cherry-pick (or
 *                merge, or revert) and moves HEAD out from under it.
 *   cherry-pick, a pick over a stopped merge commits UNDER it, and the merge
 *   revert       then records it in its own first parent. At a plain rebase
 *                stop — an `edit`, say — picking a commit in is ordinary git,
 *                and runs (a rebase's merge step is a merge: refused).
 *   stash        applies into the working tree and touches no operation file:
 *                git decides, and a refusal over the stop's files is `blocked`.
 */
function endsOrMoves(kind: ApplyOp["kind"], stop: StoppedHere): boolean {
  if (!stop.operation) return false; // files unmerged, no operation: git refuses these itself
  switch (kind) {
    case "checkout":
    case "merge":
    case "rebase":
      return true;
    case "cherry-pick":
    case "revert":
      return stop.operation !== "rebase" || stop.mergeStep === true;
    case "stash":
      return false;
  }
}

/** Does any tracked file differ from HEAD — in the index or the working tree? */
async function touchedTree(proc: GitProcess, signal?: AbortSignal): Promise<boolean> {
  return (await proc.run(["diff", "--quiet", "HEAD", "--"], { signal })).code !== 0;
}

/** The user's work as `git status` sees it, both halves of a rename by name. */
async function porcelain(proc: GitProcess, signal?: AbortSignal): Promise<string | null> {
  const r = await proc.run(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all", "--no-renames"],
    { signal },
  );
  return r.code === 0 ? r.stdout : null;
}

/**
 * A stash with an untracked half (made with -u) — the one commit-applying
 * command whose refusal CHANGES the working tree. Verified against git 2.49:
 *
 *   · over an edit to a file its tracked half changes, `stash apply` refuses
 *     the merge ("would be overwritten by merge") and then restores its
 *     untracked files anyway;
 *   · over an untracked file of the user's where one of its own goes, it
 *     merges its tracked half first and only then refuses ("already exists,
 *     no checkout — could not restore untracked files").
 *
 * Either way git exits 1 with the stash half-applied, and read afterwards the
 * stash's own files look like the user's changes in its way. So for such a
 * stash the question is asked before it runs: an edit to a file it changes,
 * or an untracked file where it writes or restores one, is in the way, and
 * git is never started. (A STAGED change is not: git merges into the index.)
 *
 * Null for a stash with no untracked half — git refuses that before it writes
 * anything — or when git cannot say; otherwise `status` is the tree as it was
 * asked, for the run to be compared with.
 */
async function untrackedStashAhead(
  proc: GitProcess,
  stash: string,
  signal?: AbortSignal,
): Promise<{ status: string; inTheWay?: ChangesInTheWay } | null> {
  const third = await proc.run(["ls-tree", "-r", "--name-only", "-z", `${stash}^3`, "--"], { signal });
  if (third.code !== 0) return null;
  const status = await porcelain(proc, signal);
  if (status === null) return null;
  const s = parseV2(status);
  // Unmerged: git refuses a stash then, before it writes a thing.
  if (s.merge.length > 0) return { status };
  const own = await proc.run(["diff", "--name-only", "-z", "--no-renames", `${stash}^1`, stash, "--"], { signal });
  if (own.code !== 0) return { status };
  const writes = nameSet(own.stdout);
  const restores = nameSet(third.stdout);
  const untracked = new Set(s.unstaged.filter((f) => f.status === "U").map((f) => f.path));
  const inWay = new Set<string>();
  for (const f of s.unstaged) {
    if (f.status === "U" ? writes.has(f.path) || restores.has(f.path) : writes.has(f.path)) inWay.add(f.path);
  }
  if (inWay.size === 0) return { status };
  const paths = [...inWay].sort();
  return { status, inTheWay: { kind: "stash", paths, untracked: paths.filter((p) => untracked.has(p)) } };
}

/**
 * `git stash branch`, asked before it runs. It switches to the stash's base
 * first and applies the stash there after, so git refusing the apply over the
 * user's work leaves the switch done — HEAD on the new branch, the stash still
 * in the list — and nothing afterwards reads as "nothing happened".
 *
 * So everything of theirs where it will write is in the way, asked up front:
 * a change — staged, unstaged or untracked — to a file that differs between
 * HEAD and the stash's base (the switch), or that the stash changes, stages
 * or restores (the apply; touchedBy).
 *
 * And for a stash that holds STAGED changes, every staged change of theirs,
 * wherever it is. `git stash branch` always applies with `--index`, and that
 * resets the index before it merges and then refuses over any staged change
 * (verified against git 2.49: "Index was not unstashed") — after the switch,
 * the user's staging undone. Only for a stash with nothing staged are staged
 * changes elsewhere carried along, still staged. (Stash & Retry's stash takes
 * everything staged, so its retry runs over a clean index.)
 *
 * Null when git cannot say; otherwise `status` is the tree as it was asked,
 * as for untrackedStashAhead.
 */
async function stashBranchAhead(
  proc: GitProcess,
  op: StashOp & { branch: string },
  signal?: AbortSignal,
): Promise<{ status: string; inTheWay?: ChangesInTheWay } | null> {
  const status = await porcelain(proc, signal);
  if (status === null) return null;
  const s = parseV2(status);
  // Unmerged: git refuses the switch before it writes a thing.
  if (s.merge.length > 0) return { status };
  const touched = await touchedBy(proc, op, signal);
  if (!touched) return { status };
  const anyStaged = s.staged.length > 0 && (await new StashProvider(proc).holdsStaged(op.stash, { signal }));
  const untracked = new Set(s.unstaged.filter((f) => f.status === "U").map((f) => f.path));
  const inWay = new Set([
    ...s.staged.map((f) => f.path).filter((p) => anyStaged || touched.has(p)),
    ...s.unstaged.map((f) => f.path).filter((p) => touched.has(p)),
  ]);
  if (inWay.size === 0) return { status };
  const paths = [...inWay].sort();
  return {
    status,
    inTheWay: { kind: "stash", paths, untracked: paths.filter((p) => untracked.has(p)), branch: op.branch },
  };
}

/**
 * Several commits in one cherry-pick or revert (issue #32) — asked BEFORE git
 * runs. git refuses such a run commit by commit: an edit in the way of the
 * third commit is refused after the first two were applied, git exits 128,
 * and the sequencer is left open with no CHERRY_PICK_HEAD to say so (verified
 * against git 2.49). Nothing afterwards reads as "nothing happened", so the
 * question has to come first: every staged change (the index must match
 * HEAD), and every unstaged or untracked file ANY of the commits touches.
 * Null for a single commit — its refusal is recognised afterwards, as always —
 * and when there is nothing in the way or git cannot say.
 */
async function aheadOfMany(proc: GitProcess, op: ApplyOp, signal?: AbortSignal): Promise<ChangesInTheWay | null> {
  if ((op.kind !== "cherry-pick" && op.kind !== "revert") || (op.commits?.length ?? 0) < 2) return null;
  const status = await porcelain(proc, signal);
  if (status === null) return null;
  const s = parseV2(status);
  // Unmerged: git refuses the whole run before the first commit — a stop.
  if (s.merge.length > 0) return null;
  const staged = new Set(s.staged.map((f) => f.path));
  const unstaged = new Set(s.unstaged.filter((f) => f.status !== "U").map((f) => f.path));
  const untracked = new Set(s.unstaged.filter((f) => f.status === "U").map((f) => f.path));
  if (staged.size + unstaged.size + untracked.size === 0) return null;
  // A commit git cannot find is refused by name before the first is applied
  // ("fatal: bad revision", 128): nothing to stash for.
  if (!(await commitsResolve(proc, op.commits ?? [], signal))) return null;
  const touched = await touchedBy(proc, op, signal);
  const inWay = new Set<string>(staged);
  for (const p of [...unstaged, ...untracked]) if (touched?.has(p)) inWay.add(p);
  if (inWay.size === 0) return null;
  const paths = [...inWay].sort();
  return { kind: op.kind, paths, untracked: paths.filter((p) => untracked.has(p)) };
}

/** HEAD's commit and the branch it is on — what a refusal leaves unchanged. */
async function where(proc: GitProcess, signal?: AbortSignal): Promise<string> {
  const [sha, ref] = await Promise.all([
    proc.run(["rev-parse", "--verify", "--quiet", "HEAD"], { signal }),
    proc.run(["symbolic-ref", "--quiet", "HEAD"], { signal }),
  ]);
  return `${sha.stdout.trim()} ${ref.stdout.trim()}`;
}

/**
 * The user's uncommitted work `op` was refused over, or null. Asked only
 * after it failed; null unless nothing happened and something of theirs lies
 * where the command would write.
 */
async function changesInTheWay(
  proc: GitProcess,
  op: ApplyOp,
  before: string,
  signal?: AbortSignal,
): Promise<ChangesInTheWay | null> {
  // Nothing happened: HEAD and its branch where they were, nothing paused —
  // by the operation core's reading, which knows a `git am` too.
  if ((await where(proc, signal)) !== before) return null;
  if (await stoppedIn(proc, signal)) return null;
  // git stashes around these by itself when told to, so a refusal then is
  // some other refusal.
  if (op.kind === "merge" && (await configTrue(proc, "merge.autoStash", signal))) return null;
  if (op.kind === "rebase" && (await configTrue(proc, "rebase.autoStash", signal))) return null;
  // A new branch refused over its NAME was refused before git looked at a file.
  if (op.kind === "checkout" && (await newBranchNameRefused(proc, op.args, signal))) return null;

  // Renames off: a staged rename is in the way under BOTH its names, and a
  // stash of only the new one leaves the old one's deletion staged — the
  // command is refused again, and the stash cannot even be popped back cleanly.
  const status = await porcelain(proc, signal);
  if (status === null) return null;
  const s = parseV2(status);
  if (s.merge.length > 0) return null; // unmerged: a stop, not a refusal
  const staged = new Set(s.staged.map((f) => f.path));
  const unstaged = new Set(s.unstaged.filter((f) => f.status !== "U").map((f) => f.path));
  const untracked = new Set(s.unstaged.filter((f) => f.status === "U").map((f) => f.path));
  if (staged.size + unstaged.size + untracked.size === 0) return null;

  const touched = await touchedBy(proc, op, signal);
  const inWay = new Set<string>();
  const add = (from: Iterable<string>, only?: Set<string> | null): void => {
    for (const p of from) if (!only || only.has(p)) inWay.add(p);
  };
  switch (op.kind) {
    case "cherry-pick":
    case "revert":
      // A commit git cannot find is refused by NAME ("fatal: bad revision")
      // before the index is looked at — the staged changes are not in the way.
      if (!touched && !(await commitsResolve(proc, op.commits ?? [op.commit], signal))) return null;
      // The index must match HEAD before anything is merged — checked before
      // everything else, a merge commit's missing -m included.
      add(staged);
      if (touched) {
        add(unstaged, touched);
        add(untracked, touched);
      }
      break;
    case "merge": {
      if (!touched) return null;
      // A true merge needs the index clean; a fast-forward only refuses what
      // it would overwrite.
      const ff = !op.noFf && (await proc.run(["merge-base", "--is-ancestor", "HEAD", op.target], { signal })).code === 0;
      add(staged, ff ? touched : null);
      add(unstaged, touched);
      add(untracked, touched);
      break;
    }
    case "rebase":
      // Null only when `onto` does not resolve: git refuses the NAME ("fatal:
      // invalid upstream") before it looks at the tree. Every edit was claimed
      // here regardless, and Stash & Retry stashed the user's work for a
      // command that could never run.
      if (!touched) return null;
      add(staged);
      add(unstaged);
      add(untracked, touched);
      break;
    case "checkout":
    case "stash":
      if (!touched) return null;
      add(staged, touched);
      add(unstaged, touched);
      add(untracked, touched);
      break;
  }
  if (inWay.size === 0) return null;
  const paths = [...inWay].sort();
  return {
    kind: op.kind,
    paths,
    untracked: paths.filter((p) => untracked.has(p)),
    ...(isStashBranch(op) ? { branch: op.branch } : {}),
  };
}

/**
 * `checkout -b <name> [<start>]` whose <name> git will not take: a branch of
 * that name exists ("a branch named 'x' already exists"), or it is no branch
 * name at all. git says so before it looks at a file — so the user's edits to
 * the paths a switch to <start> would write are not what refused it, and
 * Stash & Retry would stash them for a command that can never run.
 * (`-B` resets a branch that exists, so it is never refused for that.)
 */
async function newBranchNameRefused(proc: GitProcess, args: readonly string[], signal?: AbortSignal): Promise<boolean> {
  const at = args.indexOf("-b");
  const name = at > 0 && args[0] === "checkout" ? args[at + 1] : undefined;
  if (!name) return false;
  if ((await proc.run(["check-ref-format", "--branch", name], { signal })).code !== 0) return true;
  return (await proc.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { signal })).code === 0;
}

/** Does every one of `commits` name a commit git can find? */
async function commitsResolve(proc: GitProcess, commits: readonly string[], signal?: AbortSignal): Promise<boolean> {
  for (const c of commits) {
    const r = await proc.run(["rev-parse", "--verify", "--quiet", `${c}^{commit}`], { signal });
    if (r.code !== 0) return false;
  }
  return true;
}

/** Is `key` a true boolean in the repository's config? */
async function configTrue(proc: GitProcess, key: string, signal?: AbortSignal): Promise<boolean> {
  const r = await proc.run(["config", "--bool", "--get", key], { signal });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** `-z` name output as a set. */
function nameSet(stdout: string): Set<string> {
  return new Set(stdout.split("\0").filter((p) => p.length > 0));
}

/**
 * Every path `op` would write, or null when that cannot be known (a ref that
 * does not resolve — then the failure was something else). Renames off, so a
 * moved file counts at both of its names.
 */
async function touchedBy(proc: GitProcess, op: ApplyOp, signal?: AbortSignal): Promise<Set<string> | null> {
  const diff = async (from: string, to: string): Promise<Set<string> | null> => {
    const r = await proc.run(["diff", "--name-only", "-z", "--no-renames", from, to, "--"], { signal });
    return r.code === 0 ? nameSet(r.stdout) : null;
  };
  switch (op.kind) {
    case "cherry-pick":
    case "revert": {
      // Several commits: every path any of them writes.
      if ((op.commits?.length ?? 0) > 1) {
        const all = new Set<string>();
        for (const commit of op.commits ?? []) {
          const one = await touchedBy(proc, { ...op, commit, commits: undefined }, signal);
          if (!one) return null;
          for (const p of one) all.add(p);
        }
        return all;
      }
      const parents = await proc.run(["rev-list", "--parents", "-n", "1", op.commit, "--"], { signal });
      if (parents.code !== 0) return null;
      const ps = parents.stdout.trim().split(/\s+/).slice(1);
      if (ps.length === 0) {
        const root = await proc.run(
          ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "-z", "--no-renames", op.commit],
          { signal },
        );
        return root.code === 0 ? nameSet(root.stdout) : null;
      }
      // A merge taken with no -m is refused for that before any file is
      // written, so only its staged changes can have been in the way.
      if (ps.length > 1 && !op.mainline) return null;
      const parent = ps[(op.mainline ?? 1) - 1];
      return parent ? diff(parent, op.commit) : null;
    }
    case "merge": {
      // What the incoming side changed since the two last agreed.
      const base = await proc.run(["merge-base", "HEAD", op.target], { signal });
      return base.code === 0 ? diff(base.stdout.trim(), op.target) : null;
    }
    case "rebase":
      return diff("HEAD", op.onto);
    case "checkout": {
      // `git checkout <name>` looks refs/heads/ up FIRST — a tag of the same
      // name only earns a warning — while a revision like `diff HEAD <name>`
      // resolves the tag. Read the commit the switch will really land on, or
      // the edit in its way is not among the paths and the refusal goes out as
      // git's text. Only for the plain switch: `-b <new> <start>` and
      // `--detach <x>` take a revision, as diff does.
      const plain = op.args.length === 2 && op.args[0] === "checkout" && op.args[1] === op.target;
      if (plain && !op.target.startsWith("refs/")) {
        const branch = `refs/heads/${op.target}`;
        const isBranch = await proc.run(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], { signal });
        if (isBranch.code === 0) return diff("HEAD", branch);
      }
      return diff("HEAD", op.target);
    }
    case "stash": {
      const own = await diff(`${op.stash}^1`, op.stash);
      if (!own) return null;
      // Untracked files a stash made with -u restores, from its third parent.
      const third = await proc.run(["ls-tree", "-r", "--name-only", "-z", `${op.stash}^3`], { signal });
      if (third.code === 0) for (const p of nameSet(third.stdout)) own.add(p);
      if (op.branch !== undefined) {
        // `git stash branch` switches to the stash's base first, and stages
        // the stash's staged half again (its index commit, ^2) — which can
        // name a file its working tree left as the base had it.
        for (const [from, to] of [["HEAD", `${op.stash}^1`], [`${op.stash}^1`, `${op.stash}^2`]]) {
          const more = await diff(from, to);
          if (!more) return null;
          for (const p of more) own.add(p);
        }
      }
      return own;
    }
  }
}

/** What became of the changes a stash-and-retry put away. */
export type StashedFate =
  /** Put back where they were. */
  | "restored"
  /** Put back, but they conflict with what the command brought in — the
   *  files are unmerged now, and git kept the stash too. */
  | "conflicted"
  /** The command stopped part-way (conflicts of its own to resolve), so they
   *  wait in the stash until it is finished — as git's own autostash does. */
  | "waiting"
  /** git would not put them back over what the command left in the working
   *  tree (a stash is never merged into uncommitted work); still stashed. */
  | "kept";

export interface StashRetryOutcome {
  /** The command's run after the stash — or its first run, when nothing was stashed. */
  result: GitRunResult;
  /** Set when the stash was made: what for, its message, and what it holds. */
  stashed?: { kind: InTheWayKind; message: string; paths: string[] };
  /** What became of them. Set whenever `stashed` is. */
  fate?: StashedFate;
  /** The stash itself failed, so the command was not run again. */
  stashFailed?: string;
  /** …because the stash a stash op names is gone (dropped or popped since the
   *  question was put) — the user's state, not a failure. */
  stashGone?: true;
  /** Still refused over uncommitted work — the stash did not cover it. */
  inTheWay?: ChangesInTheWay;
  /** Refused because git is stopped in an operation — nothing was stashed. */
  blocked?: OperationInTheWay;
  /** A stash op with `index` over staged changes of the user's (runApplying):
   *  nothing was stashed or run. */
  indexBusy?: true;
  /** A stash op with `index` whose staged half git refused — on the first
   *  run, or on the retry, after which the stashed changes were put back. */
  indexRefused?: true;
}

/** The message a stash-and-retry's stash carries, so it can be found again. */
function stashMessage(op: ApplyOp): string {
  // Named the way the user names it: the doors hand a merge, a rebase and a
  // remote checkout their target by its FULL name (a short one is ambiguous
  // beside a tag), and the stash list read "before merging refs/heads/release".
  const short = (s: string): string => (/^[0-9a-f]{40,64}$/.test(s) ? s.slice(0, 7) : refShortName(s));
  switch (op.kind) {
    case "cherry-pick":
    case "revert":
      return `GitStudio: before ${op.kind} of ${short(op.commit)}`;
    case "merge":
      return `GitStudio: before merging ${short(op.target)}`;
    case "rebase":
      return `GitStudio: before rebasing onto ${short(op.onto)}`;
    case "checkout":
      return `GitStudio: before checking out ${short(op.target)}`;
    case "stash":
      return op.branch !== undefined
        ? "GitStudio: before creating a branch from a stash"
        : "GitStudio: before applying a stash";
  }
}

/**
 * The "Stash & Retry" answer to a refusal: put the changes in the way into a
 * stash of their own, run the command again, and put them back.
 *
 * Only the paths in the way are stashed (untracked ones too, when any are),
 * with whatever else is staged — the rest of the user's work is not the
 * command's business, but staging only survives the way back when nothing
 * else is staged (see stashTheWay). They are put back with their staging
 * where git can (`pop --index`), and without it where it cannot — unless one
 * was staged apart from its file, whose staged version only the stash holds:
 * then they stay in it, "kept" (see popOurs). If the
 * command stops part-way (conflicts to resolve) they are left in the stash,
 * as git's own autostash leaves them, and `fate` says so; if it fails outright
 * they are put straight back, as if nothing had been tried — and when that
 * failure was a refusal over their work all over again, `inTheWay` says so.
 *
 * A stash applied or popped this way is found again by its sha after the new
 * stash has pushed it one place down the list.
 */
export async function stashAndRetry(
  proc: GitProcess,
  op: ApplyOp,
  opts?: GitRunOptions,
): Promise<StashRetryOutcome> {
  const signal = opts?.signal;
  // The stash a stash op names, BY SHA, before anything is pushed on top of it.
  const target = op.kind === "stash" ? await shaOf(proc, op.stash, signal) : null;
  if (op.kind === "stash" && !target) {
    return { result: { code: 1, stdout: "", stderr: "" }, stashFailed: "That stash no longer exists.", stashGone: true };
  }

  // Asked again rather than trusted from the first refusal: the tree may have
  // changed since the question was put — an operation stopped since is said
  // as blocked, and nothing of it is stashed.
  const first = await runApplying(proc, op, opts);
  if (first.blocked) {
    return { result: first.result, blocked: first.blocked };
  }
  if (first.stashGone) {
    return { result: first.result, stashFailed: "That stash no longer exists.", stashGone: true };
  }
  if (first.indexBusy || first.indexRefused) {
    return { result: first.result, ...(first.indexBusy ? { indexBusy: true } : { indexRefused: true }) };
  }
  if (first.result.code === 0 || !first.inTheWay) {
    return { result: first.result };
  }
  const v = first.inTheWay;
  const stashes = new StashProvider(proc);
  const saved = await stashTheWay(proc, stashes, v, stashMessage(op), signal);
  if ("failed" in saved) {
    return { result: first.result, inTheWay: v, stashFailed: saved.failed };
  }
  const { stashed } = saved;

  let args = applyArgs(op);
  if (op.kind === "stash") {
    const now = await stashArgsNow(stashes, op, target, signal);
    if (!now) {
      return {
        result: { code: 1, stdout: "", stderr: "" },
        stashed,
        fate: await putBack(proc, stashes, saved, signal),
        stashFailed: "That stash no longer exists.",
        stashGone: true,
      };
    }
    args = now;
  }
  const at = await where(proc, signal);
  const tree = op.kind === "stash" && op.index ? await porcelain(proc, signal) : null;
  const result = await proc.run(args, { signal });
  if (result.code !== 0 && (await stoppedPartWay(proc, signal))) {
    return { result, stashed, fate: "waiting" };
  }
  // The staged half refused, now that nothing of the user's is in the way —
  // said as that, not as their changes being in the way all over again.
  const indexRefused = result.code !== 0 && tree !== null && (await nothingHappened(proc, at, tree, signal));
  // Done — or failed outright, in which case this puts the tree back as it
  // was before anything was tried.
  const fate = await putBack(proc, stashes, saved, signal);
  if (indexRefused) {
    return { result, stashed, fate, indexRefused: true };
  }
  if (result.code !== 0 && fate === "restored") {
    // Refused AGAIN over the user's work — something the stash did not cover,
    // or changed since. That is still their state, not git failing: said as
    // what is in the way, never as git's text and a crash report.
    const still = await changesInTheWay(proc, op, at, signal);
    if (still) return { result, stashed, fate, inTheWay: still };
  }
  return { result, stashed, fate };
}

/** A pull's Stash & Retry: the outcome, and the pull's own answer. */
export interface PullRetryOutcome extends StashRetryOutcome {
  /** What the pull said — the retry's, or the first run's when nothing was
   *  stashed. Its `stopped` / `diverged` / `blocked` are the caller's to say. */
  pulled: PullResult;
}

/**
 * What to tell the user when a pull is refused over their uncommitted work
 * (SyncOps.pull's `dirty`), in the words every other refusal uses — which
 * files, in the way of what — for a caller that offers Stash & Retry.
 * (`pullDirtyMessage` is the sentence for one that does not.)
 */
export function pullInTheWayMessage(d: PullDirty): string {
  return changesInTheWayMessage({
    kind: "pull",
    paths: d.paths,
    untracked: [],
    ...(d.rebase ? { rebase: true as const } : {}),
  });
}

/**
 * Stash & Retry for a pull: `pull` is the pull the user asked for, run as
 * SyncOps.pull runs it, so a stop, a divergence or a block is recognised
 * exactly as it is without the stash.
 *
 * The pull is run again first — the tree may have changed since the question
 * was put — and when it is still refused over the user's work (`dirty`), the
 * paths in the way go into a stash of their own ("GitStudio: before pulling"),
 * the pull runs, and they are put back as stashAndRetry puts them back:
 * restored, conflicted, waiting (the pull stopped on conflicts of its own) or
 * kept.
 */
export async function stashAndRetryPull(
  proc: GitProcess,
  pull: () => Promise<PullResult>,
  opts?: GitRunOptions,
): Promise<PullRetryOutcome> {
  const signal = opts?.signal;
  const first = await pull();
  if (first.ok || !first.dirty) {
    return { result: pullRun(first), pulled: first };
  }
  const v: ChangesInTheWay = {
    kind: "pull",
    paths: [...first.dirty.paths].sort(),
    untracked: await untrackedAmong(proc, first.dirty.paths, signal),
    ...(first.dirty.rebase ? { rebase: true as const } : {}),
  };
  const stashes = new StashProvider(proc);
  const saved = await stashTheWay(proc, stashes, v, "GitStudio: before pulling", signal);
  if ("failed" in saved) {
    return { result: pullRun(first), pulled: first, inTheWay: v, stashFailed: saved.failed };
  }
  const { stashed } = saved;
  const pulled = await pull();
  const result = pullRun(pulled);
  if (!pulled.ok && (await stoppedPartWay(proc, signal))) {
    return { result, pulled, stashed, fate: "waiting" };
  }
  return { result, pulled, stashed, fate: await putBack(proc, stashes, saved, signal) };
}

/** A pull's answer as a run, for what StashRetryOutcome carries. */
function pullRun(p: PullResult): GitRunResult {
  return { code: p.ok ? 0 : 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** Which of `paths` git does not track — a stash of them needs `-u`. */
async function untrackedAmong(proc: GitProcess, paths: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const st = await proc.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { signal });
  if (st.code !== 0) return [];
  const untracked = new Set(
    parseV2(st.stdout)
      .unstaged.filter((f) => f.status === "U")
      .map((f) => f.path),
  );
  return paths.filter((p) => untracked.has(p)).sort();
}

/** The sha `ref` resolves to, or null. */
async function shaOf(proc: GitProcess, ref: string, signal?: AbortSignal): Promise<string | null> {
  const r = await proc.run(["rev-parse", "--verify", "--quiet", ref], { signal });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Where the stash with this sha sits in the list now (`stash@{n}`), or null. */
async function stashRefOf(stashes: StashProvider, sha: string | null, signal?: AbortSignal): Promise<string | null> {
  if (!sha) return null;
  const entry = (await stashes.list({ signal })).find((e) => e.sha === sha);
  return entry?.ref ?? null;
}

/** Our stash, once made: its sha, what it holds, and the deletions it unstaged. */
interface Stashed {
  ours: string | null;
  stashed: NonNullable<StashRetryOutcome["stashed"]>;
  /** Staged deletions put back in the index to be stashable — staged again
   *  once the stash is popped (see stashTheWay). */
  restage: string[];
}

/**
 * Put the changes in the way into a stash of their own.
 *
 * Those paths, and every other STAGED one with them. `git stash pop --index`
 * refuses while anything is staged beside what it restores (verified against
 * git 2.49: "Index was not unstashed"), and the plain pop it falls back to
 * brings a staged edit back unstaged — so a staged edit a checkout, a
 * fast-forward or a pull carried along would cost the edit in the way its
 * staging. Staged changes elsewhere touch nothing the command writes, so they
 * come straight back.
 *
 * A STAGED deletion — the file gone from the index, a staged rename's old
 * name among them — is no path `git stash push` will take: "did not match any
 * file(s) known to git", and nothing is stashed. So those paths are put back
 * in the index first (`reset`; the file stays deleted, as an unstaged
 * deletion), stashed like any other change, and staged again once the stash is
 * popped — the user's index exactly as it was.
 */
async function stashTheWay(
  proc: GitProcess,
  stashes: StashProvider,
  v: ChangesInTheWay,
  message: string,
  signal?: AbortSignal,
): Promise<Stashed | { failed: string }> {
  const index = await stagedChanges(proc, signal);
  const paths = [...new Set([...v.paths, ...index.keys()])].sort();
  const deleted = paths.filter((p) => index.get(p) === "D");
  if (deleted.length > 0) {
    const r = await proc.run(["reset", "-q", "--", ...deleted.map(literally)], { signal });
    if (r.code !== 0) return { failed: r.stderr.trim() || "The staged deletions could not be stashed." };
  }
  const saved = await stashes.save({
    message,
    paths,
    includeUntracked: v.untracked.length > 0,
    signal,
  });
  if (!saved.ok || !saved.created) {
    await restageDeletions(proc, deleted, signal);
    return { failed: saved.stderr.trim() || "Nothing could be stashed." };
  }
  return {
    ours: await shaOf(proc, "refs/stash", signal),
    stashed: { kind: v.kind, message, paths },
    restage: deleted,
  };
}

/** Every staged path, renames as a deletion and an addition, with its letter. */
async function stagedChanges(proc: GitProcess, signal?: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await proc.run(["diff", "--cached", "--name-status", "-z", "--no-renames", "HEAD", "--"], { signal });
  if (r.code !== 0) return out;
  const f = r.stdout.split("\0");
  for (let i = 0; i + 1 < f.length; i += 2) {
    if (f[i] && f[i + 1]) out.set(f[i + 1], f[i][0]);
  }
  return out;
}

/** Stage those deletions again. */
async function restageDeletions(proc: GitProcess, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  if (paths.length === 0) return;
  await proc.run(["rm", "--cached", "-q", "--ignore-unmatch", "--", ...paths.map(literally)], { signal });
}

/** Paused part-way: something unmerged, or an operation waiting. */
async function stoppedPartWay(proc: GitProcess, signal?: AbortSignal): Promise<boolean> {
  const st = await proc.run(["status", "--porcelain=v2", "-z"], { signal });
  if (st.code === 0 && parseV2(st.stdout).merge.length > 0) return true;
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if ((await shaOf(proc, marker, signal)) !== null) return true;
  }
  return rebaseInProgress(proc, signal);
}

/** Pop OUR stash — by its sha, wherever it now sits — staging and all. */
async function putBack(
  proc: GitProcess,
  stashes: StashProvider,
  saved: Stashed,
  signal?: AbortSignal,
): Promise<StashedFate> {
  const fate = await popOurs(proc, stashes, saved.ours, signal);
  // Back where they were: the deletions that were staged are staged again.
  if (fate === "restored") await restageDeletions(proc, saved.restage, signal);
  return fate;
}

/**
 * Pop our stash back, with its staging where git can.
 *
 * `pop --index` of a stash that holds staged changes, run over an index that
 * holds staged changes too — the command's own: a stash's staging just
 * restored, a new branch's — resets the index before it merges and then
 * refuses (verified against git 2.49), and what the command staged is gone.
 * So it runs only over a clean index, or for a stash with nothing staged
 * (git leaves the index alone then).
 *
 * Without `--index` the changes come back unstaged. A pop drops the stash, and
 * with it the only copy of a staged version that differed from its file
 * (`MM`) — so a stash holding one stays in the list ("kept"). What was staged
 * exactly as it was on disk is staged again, where the file still is that.
 */
async function popOurs(
  proc: GitProcess,
  stashes: StashProvider,
  ours: string | null,
  signal?: AbortSignal,
): Promise<StashedFate> {
  const ref = await stashRefOf(stashes, ours, signal);
  if (!ref || !ours) return "kept";
  const staged = await stagedIn(proc, ours, signal);
  if (!staged) return "kept";
  const holds = staged.asOnDisk.length + staged.apart.length > 0;
  if (!holds || (await indexMatchesHead(proc, signal))) {
    const withIndex = await proc.run(["stash", "pop", "--index", ref], { signal });
    if (withIndex.code === 0) return "restored";
    const st = await proc.run(["status", "--porcelain=v2", "-z"], { signal });
    if (st.code === 0 && parseV2(st.stdout).merge.length > 0) return "conflicted";
    // `--index` refuses when the staged half cannot be restored as it was;
    // the changes themselves can still come back, unstaged.
    if ((await stashRefOf(stashes, ours, signal)) !== ref) return "kept";
  }
  if (staged.apart.length > 0) return "kept";
  const plain = await proc.run(["stash", "pop", ref], { signal });
  if (plain.code === 0) {
    await restageAsStashed(proc, ours, staged.asOnDisk, signal);
    return "restored";
  }
  const after = await proc.run(["status", "--porcelain=v2", "-z"], { signal });
  return after.code === 0 && parseV2(after.stdout).merge.length > 0 ? "conflicted" : "kept";
}

/**
 * What a stash had staged: the paths staged exactly as their file was
 * (`asOnDisk`), and those whose file differed from what was staged (`apart`)
 * — a pop without `--index` loses the staged version of those. Null when git
 * cannot say.
 */
async function stagedIn(
  proc: GitProcess,
  stash: string,
  signal?: AbortSignal,
): Promise<{ asOnDisk: string[]; apart: string[] } | null> {
  const names = async (from: string, to: string): Promise<Set<string> | null> => {
    const r = await proc.run(["diff", "--name-only", "-z", "--no-renames", from, to, "--"], { signal });
    return r.code === 0 ? nameSet(r.stdout) : null;
  };
  const staged = await names(`${stash}^1`, `${stash}^2`);
  const onDisk = await names(`${stash}^2`, stash);
  if (!staged || !onDisk) return null;
  const all = [...staged].sort();
  return { asOnDisk: all.filter((p) => !onDisk.has(p)), apart: all.filter((p) => onDisk.has(p)) };
}

/** Stage again those of `paths` whose file is still exactly as the stash
 *  holds it — after a pop that could not restore the stash's staging. */
async function restageAsStashed(
  proc: GitProcess,
  stash: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return;
  const differs = await proc.run(
    ["diff", "--name-only", "-z", "--no-renames", stash, "--", ...paths.map(literally)],
    { signal },
  );
  if (differs.code !== 0) return;
  const changed = nameSet(differs.stdout);
  const same = paths.filter((p) => !changed.has(p));
  if (same.length > 0) await proc.run(["add", "--", ...same.map(literally)], { signal });
}

/**
 * What to add about the stashed changes once a stash-and-retry has run, or
 * undefined when they are simply back where they were (the command's own
 * success says enough).
 */
export function stashRetryNote(out: StashRetryOutcome): string | undefined {
  if (!out.stashed) return undefined;
  const which = nameThe(out.stashed.paths);
  const stash = `"${out.stashed.message}"`;
  switch (out.fate) {
    case "restored":
      return undefined;
    case "conflicted":
      return (
        `Your changes to ${which} were put back, but they conflict with what came in — ` +
        `resolve them in Changes. They are also kept in the stash ${stash}.`
      );
    case "waiting":
      return (
        `Your changes to ${which} are waiting in the stash ${stash} — ` +
        `apply it once ${out.stashed.kind === "stash" || out.stashed.kind === "checkout" || out.stashed.kind === "pull" ? "the conflicts are resolved" : `${THE[out.stashed.kind]} is finished`}.`
      );
    default:
      return (
        `Your changes to ${which} are kept in the stash ${stash} — git won't put them back ` +
        "over the changes that just came in. Apply it when you're ready."
      );
  }
}
