import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { GitProcess, GitRunResult, GitRunWithInputOptions } from "./GitProcess";

/**
 * One repository's index writes, one at a time.
 *
 * Every command that rewrites `.git/index` (add, reset, rm --cached, checkout
 * --, update-index, commit) first creates `.git/index.lock`, and a second one
 * started while the first holds it is refused outright: "Unable to create
 * '.git/index.lock': File exists." The Changes view issues these as separate
 * calls that arrive together (a multi-selection, a few quick clicks on "+"), so
 * on a real repository most of them failed and only some of the files moved.
 *
 * The queue is keyed by the repository's real path, not by object: the
 * extension builds more than one GitContext for a root, and they share the one
 * index. Only the git spawn waits here, never a question to the user, so a
 * caller holding a dialog open cannot stall anybody else's write.
 */
const tails = new Map<string, Promise<unknown>>();

function keyFor(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/** Run `op` after every index write already queued for `root` has finished. */
export function serializeIndexWrite<T>(root: string, op: () => Promise<T>): Promise<T> {
  const key = keyFor(root);
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(op, op);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/**
 * git's refusal when another process holds the index lock. The sentence around
 * it is localised; the lock file's name, which git always prints, is not.
 */
const LOCKED = /index\.lock/;

/**
 * How long a write waits out a lock that ANOTHER process holds — vscode.git's
 * own status refresh, a terminal `git add`. Short: a lock held longer than this
 * is either stale (a crashed git left it) or a long operation the user should
 * hear about, and git's own message says which file to look at.
 */
const LOCK_RETRY_DELAYS_MS = [50, 100, 150, 250, 400];

/**
 * Run one index-writing git command for the repository `proc` serves, queued
 * behind every other index write to it, and retried briefly if another process
 * holds the lock.
 *
 * `retryOnLock: false` is for a command that runs the user's code before it
 * touches the index — `git commit` runs hooks — where running it twice is not
 * the same as running it once.
 */
export function runIndexWrite(
  proc: GitProcess,
  args: string[],
  opts?: GitRunWithInputOptions & { retryOnLock?: boolean },
): Promise<GitRunResult> {
  return serializeIndexWrite(proc.cwd, async () => {
    let r = await proc.run(args, opts);
    if (opts?.retryOnLock === false) return r;
    for (const delay of LOCK_RETRY_DELAYS_MS) {
      if (r.code === 0 || !LOCKED.test(r.stderr) || opts?.signal?.aborted) break;
      await new Promise((done) => setTimeout(done, delay));
      r = await proc.run(args, opts);
    }
    return r;
  });
}
