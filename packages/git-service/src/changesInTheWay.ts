import type { GitProcess, GitRunOptions, GitRunResult } from "./GitProcess";
import { rebaseInProgress } from "./rebaseInProgress";
import { StashProvider } from "./StashProvider";
import { parseV2 } from "./StatusProvider";

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

/** A command that applies commits to the working tree, and how to run it. */
export type ApplyOp =
  | {
      kind: "cherry-pick" | "revert";
      /** The commit being picked or reverted. */
      commit: string;
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
      /** The stash to apply, e.g. `stash@{1}` or its sha. */
      stash: string;
      /** `pop` rather than `apply`. */
      pop?: boolean;
    };

/** The user's uncommitted work a command refused over. */
export interface ChangesInTheWay {
  kind: ApplyOp["kind"];
  /** Repo-relative, sorted, never empty. */
  paths: string[];
  /** Those of them git does not track yet — a stash must include untracked files. */
  untracked: string[];
}

/** The argv an op runs. */
export function applyArgs(op: ApplyOp): string[] {
  return op.kind === "stash" ? ["stash", op.pop ? "pop" : "apply", op.stash] : op.args;
}

/** The operation's name, for a sentence. */
const THE: Record<ApplyOp["kind"], string> = {
  revert: "the revert",
  "cherry-pick": "the cherry-pick",
  merge: "the merge",
  rebase: "the rebase",
  checkout: "switching to it",
  stash: "applying the stash",
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
  if (v.kind === "rebase") {
    return (
      `A rebase needs a clean working tree, and your uncommitted changes to ${nameThe(v.paths)} ` +
      `are in the way. Stash ${them} and try again, or commit ${them} first.`
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
 */
export async function runApplying(
  proc: GitProcess,
  op: ApplyOp,
  opts?: GitRunOptions,
): Promise<{ result: GitRunResult; inTheWay?: ChangesInTheWay }> {
  const before = await where(proc, opts?.signal);
  const result = await proc.run(applyArgs(op), { signal: opts?.signal });
  if (result.code === 0) {
    return { result };
  }
  const inTheWay = await changesInTheWay(proc, op, before, opts?.signal);
  return inTheWay ? { result, inTheWay } : { result };
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
  // Nothing happened: HEAD and its branch where they were, nothing paused.
  if ((await where(proc, signal)) !== before) return null;
  const has = async (ref: string): Promise<boolean> =>
    (await proc.run(["rev-parse", "--verify", "--quiet", ref], { signal })).code === 0;
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (await has(marker)) return null;
  }
  if (await rebaseInProgress(proc, signal)) return null;
  // git stashes around these by itself when told to, so a refusal then is
  // some other refusal.
  if (op.kind === "merge" && (await configTrue(proc, "merge.autoStash", signal))) return null;
  if (op.kind === "rebase" && (await configTrue(proc, "rebase.autoStash", signal))) return null;

  const status = await proc.run(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"],
    { signal },
  );
  if (status.code !== 0) return null;
  const s = parseV2(status.stdout);
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
      add(staged);
      add(unstaged);
      if (touched) add(untracked, touched);
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
  return { kind: op.kind, paths, untracked: paths.filter((p) => untracked.has(p)) };
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
    case "checkout":
      return diff("HEAD", op.target);
    case "stash": {
      const own = await diff(`${op.stash}^1`, op.stash);
      if (!own) return null;
      // Untracked files a stash made with -u restores, from its third parent.
      const third = await proc.run(["ls-tree", "-r", "--name-only", "-z", `${op.stash}^3`], { signal });
      if (third.code === 0) for (const p of nameSet(third.stdout)) own.add(p);
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
  stashed?: { kind: ApplyOp["kind"]; message: string; paths: string[] };
  /** What became of them. Set whenever `stashed` is. */
  fate?: StashedFate;
  /** The stash itself failed, so the command was not run again. */
  stashFailed?: string;
  /** Still refused over uncommitted work — the stash did not cover it. */
  inTheWay?: ChangesInTheWay;
}

/** The message a stash-and-retry's stash carries, so it can be found again. */
function stashMessage(op: ApplyOp): string {
  const short = (s: string): string => (/^[0-9a-f]{40,64}$/.test(s) ? s.slice(0, 7) : s);
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
      return "GitStudio: before applying a stash";
  }
}

/**
 * The "Stash & Retry" answer to a refusal: put the changes in the way into a
 * stash of their own, run the command again, and put them back.
 *
 * Only the paths in the way are stashed (untracked ones too, when any are) —
 * the rest of the user's work is not the command's business. They are put
 * back with their staging where git can (`pop --index`), and without it where
 * it cannot. If the command stops part-way (conflicts to resolve) they are
 * left in the stash, as git's own autostash leaves them, and `fate` says so;
 * if it fails outright they are put straight back, as if nothing had been
 * tried.
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
  const sha = async (ref: string): Promise<string | null> => {
    const r = await proc.run(["rev-parse", "--verify", "--quiet", ref], { signal });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  // The stash a stash op names, BY SHA, before anything is pushed on top of it.
  const target = op.kind === "stash" ? await sha(op.stash) : null;
  if (op.kind === "stash" && !target) {
    return { result: { code: 1, stdout: "", stderr: "" }, stashFailed: "That stash no longer exists." };
  }

  // Asked again rather than trusted from the first refusal: the tree may have
  // changed since the question was put.
  const first = await runApplying(proc, op, opts);
  if (first.result.code === 0 || !first.inTheWay) {
    return { result: first.result };
  }
  const v = first.inTheWay;
  const message = stashMessage(op);
  const stashes = new StashProvider(proc);
  const saved = await stashes.save({
    message,
    paths: v.paths,
    includeUntracked: v.untracked.length > 0,
    signal,
  });
  if (!saved.ok || !saved.created) {
    return {
      result: first.result,
      inTheWay: v,
      stashFailed: saved.stderr.trim() || "Nothing could be stashed.",
    };
  }
  const ours = await sha("refs/stash");
  const stashed = { kind: op.kind, message, paths: v.paths };

  const refOf = async (s: string | null): Promise<string | null> => {
    if (!s) return null;
    const entry = (await stashes.list({ signal })).find((e) => e.sha === s);
    return entry?.ref ?? null;
  };
  let args = applyArgs(op);
  if (op.kind === "stash") {
    const now = await refOf(target);
    if (!now) {
      return { result: { code: 1, stdout: "", stderr: "" }, stashed, fate: await putBack(), stashFailed: "That stash no longer exists." };
    }
    args = ["stash", op.pop ? "pop" : "apply", now];
  }
  const result = await proc.run(args, { signal });
  if (result.code !== 0 && (await stopped())) {
    return { result, stashed, fate: "waiting" };
  }
  // Done — or failed outright, in which case this puts the tree back as it
  // was before anything was tried.
  return { result, stashed, fate: await putBack() };

  /** Paused part-way: something unmerged, or an operation waiting. */
  async function stopped(): Promise<boolean> {
    const st = await proc.run(["status", "--porcelain=v2", "-z"], { signal });
    if (st.code === 0 && parseV2(st.stdout).merge.length > 0) return true;
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if ((await sha(marker)) !== null) return true;
    }
    return rebaseInProgress(proc, signal);
  }

  /** Pop OUR stash — by its sha, wherever it now sits — staging and all. */
  async function putBack(): Promise<StashedFate> {
    const ref = await refOf(ours);
    if (!ref) return "kept";
    const withIndex = await proc.run(["stash", "pop", "--index", ref], { signal });
    if (withIndex.code === 0) return "restored";
    const st = await proc.run(["status", "--porcelain=v2", "-z"], { signal });
    if (st.code === 0 && parseV2(st.stdout).merge.length > 0) return "conflicted";
    // `--index` refuses when the staged half cannot be restored as it was;
    // the changes themselves can still come back, unstaged.
    if ((await refOf(ours)) !== ref) return "kept";
    const plain = await proc.run(["stash", "pop", ref], { signal });
    if (plain.code === 0) return "restored";
    const after = await proc.run(["status", "--porcelain=v2", "-z"], { signal });
    return after.code === 0 && parseV2(after.stdout).merge.length > 0 ? "conflicted" : "kept";
  }
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
        `apply it once ${out.stashed.kind === "stash" || out.stashed.kind === "checkout" ? "the conflicts are resolved" : `${THE[out.stashed.kind]} is finished`}.`
      );
    default:
      return (
        `Your changes to ${which} are kept in the stash ${stash} — git won't put them back ` +
        "over the changes that just came in. Apply it when you're ready."
      );
  }
}
