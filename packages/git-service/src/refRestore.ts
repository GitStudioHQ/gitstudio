import { nativePath } from "./folderPath";
import type { GitProcess, GitRunOptions } from "./GitProcess";

// Reading and putting back local branches — for both products' Undo.
//
// An Undo puts back the refs an operation moved, and ONLY those: never "reset
// whatever HEAD is on now", which moved a branch the user never touched when
// HEAD had changed branches since (a checkout, a branch made at the new tip).
// Every write here is by FULL name (refs/heads/x) and compare-and-swap against
// where the operation left the ref, so a ref somebody moved since is never
// overwritten, and a name that starts with "-" never reaches git's argv as
// anything but a ref.

/** A local branch an operation moved: where it was, where the op left it (null: absent). */
export interface RefMove {
  /** refs/heads/<name>. */
  ref: string;
  /** Before the op; null when the op created it. */
  before: string | null;
  /** After the op; null when the op deleted it. */
  after: string | null;
}

const SHA = /^[0-9a-f]{40,64}$/i;

/** `refs/heads/x` → `x` (for words; never for argv). */
export function branchShort(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Short sha for words. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A full local-branch name this module will write: refs/heads/<something>. */
export function isBranchRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^refs\/heads\/[^\0\n]+$/.test(ref) && !ref.includes("..");
}

/** A full sha. */
export function isSha(s: unknown): s is string {
  return typeof s === "string" && SHA.test(s);
}

/** Every local branch: full name → sha. */
export async function localBranches(proc: GitProcess, opts?: GitRunOptions): Promise<Record<string, string>> {
  const r = await proc.run(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"], opts);
  const out: Record<string, string> = {};
  if (r.code !== 0) return out;
  for (const line of r.stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at < 0) continue;
    out[line.slice(at + 1)] = line.slice(0, at);
  }
  return out;
}

/** Where each local branch is checked out, by worktree path spelled the
 *  system's way — it is said to a person (branches that aren't, are absent). */
export async function checkedOutAt(proc: GitProcess, opts?: GitRunOptions): Promise<Map<string, string>> {
  const r = await proc.run(["for-each-ref", "--format=%(refname)%00%(worktreepath)", "refs/heads/"], opts);
  const out = new Map<string, string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.split("\n")) {
    const [ref, path] = line.split("\0");
    if (ref && path) out.set(ref, nativePath(path));
  }
  return out;
}

/** HEAD's branch in this worktree by full name, or null when detached. */
export async function headBranch(proc: GitProcess, opts?: GitRunOptions): Promise<string | null> {
  const r = await proc.run(["symbolic-ref", "--quiet", "HEAD"], opts);
  const ref = r.code === 0 ? r.stdout.trim() : "";
  return ref.startsWith("refs/heads/") ? ref : null;
}

/**
 * Why `moves` cannot be put back as things stand — a sentence — or undefined.
 *
 * Each ref must still be where the op left it (a ref already back where it
 * was counts as done, not as moved). A branch checked out in ANOTHER worktree
 * is that worktree's to move. One checked out HERE can only be moved by the
 * caller with `reset --keep` (it moves the files too); `here` says which.
 */
export async function whyRefsNotRestorable(
  proc: GitProcess,
  moves: readonly RefMove[],
  label: string,
  opts?: GitRunOptions & { /** HEAD is about to leave this branch (a switch back). */ leaving?: string | null },
): Promise<string | undefined> {
  const [now, where, head] = await Promise.all([localBranches(proc, opts), checkedOutAt(proc, opts), headBranch(proc, opts)]);
  for (const m of moves) {
    const name = branchShort(m.ref);
    const cur = now[m.ref] ?? null;
    if (cur === m.before) continue; // already back
    if (cur !== m.after) {
      if (m.after === null) {
        return `A branch named '${name}' exists again, so Undo won't bring back the one "${label}" deleted. Nothing was changed.`;
      }
      if (cur === null) {
        return `'${name}' has been deleted since "${label}", so there is nothing to put back.`;
      }
      return `'${name}' has moved since (it is at ${shortSha(cur)} now), and putting it back would throw that away.`;
    }
    const here = head === m.ref && opts?.leaving !== m.ref;
    const elsewhere = head !== m.ref ? where.get(m.ref) : undefined;
    if (elsewhere) {
      return `'${name}' is checked out in another worktree, at ${elsewhere}. Undo it there.`;
    }
    if (here && m.before === null) {
      return `'${name}' is checked out. Switch to another branch, then undo.`;
    }
  }
  return undefined;
}

/**
 * Put one moved ref back — `whyRefsNotRestorable` has said it may be. A ref
 * already back is left alone. Throws with a sentence when git refuses.
 */
export async function putRefBack(
  proc: GitProcess,
  m: RefMove,
  message: string,
  opts?: GitRunOptions & { /** It is HEAD's branch here: move it and its files with `reset --keep`. */ here?: boolean },
): Promise<void> {
  const name = branchShort(m.ref);
  const cur = (await localBranches(proc, opts))[m.ref] ?? null;
  if (cur === m.before) return;
  let args: string[];
  if (m.before === null) {
    // Created by the op: delete it, but only while it is where the op left it.
    args = ["update-ref", "-m", message, "-d", m.ref, m.after ?? ""];
  } else if (m.after === null) {
    // Deleted by the op: bring it back, but only while nothing has that name.
    args = ["update-ref", "-m", message, m.ref, m.before, ""];
  } else if (opts?.here) {
    args = ["reset", "--keep", m.before];
  } else {
    args = ["update-ref", "-m", message, m.ref, m.before, m.after];
  }
  const r = await proc.run(args, opts);
  if (r.code !== 0) {
    const what =
      m.before === null ? `delete '${name}'` : m.after === null ? `bring back '${name}'` : `move '${name}' back to ${shortSha(m.before)}`;
    throw new Error(`Undo couldn't ${what}: ${r.stderr.trim() || "git refused"}`);
  }
}
