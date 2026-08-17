/**
 * Checking out a remote branch — "origin/fix/1.0.1-quality" → local
 * "fix/1.0.1-quality" — without asking anything first.
 *
 * Both entry points (the Branches view and the graph's per-ref menu) used to
 * open a text prompt pre-filled with the name they had already worked out, so
 * the answer was almost always "yes, that one". A rename dialog in front of a
 * checkout gets in the way of the common case to serve a rare one that is
 * already served better elsewhere: check out, then rename; or create a branch
 * from the remote under any name you like.
 *
 * The two-step decision below replaces `git checkout <short>` DWIM on purpose.
 * DWIM is convenient but conditional — it is off when `checkout.guess=false`,
 * and it refuses outright when several remotes carry the same branch name,
 * which is exactly when guessing would be wrong anyway. Asking whether the
 * local branch exists costs one `rev-parse` and always lands somewhere
 * predictable.
 */

import type { GitRunner } from "./pausedForUser";

export interface RemoteCheckoutPlan {
  /** The local branch the checkout lands on. */
  local: string;
  /** Argv for `ctx.process.run`. */
  args: string[];
  /** Status-bar message on success. */
  success: string;
  /** Label for the Undo envelope. */
  undoLabel: string;
}

/**
 * `origin/feature` → `feature`. Only the FIRST segment is the remote: a branch
 * may legitimately contain slashes ("release/1.5"), and slicing at the last one
 * would check out "1.5".
 */
export function localNameFor(remoteRef: string): string {
  const slash = remoteRef.indexOf("/");
  return slash > 0 ? remoteRef.slice(slash + 1) : remoteRef;
}

/**
 * What to run for "check out `remoteRef`".
 *
 * Existing local branch → switch to it. That is the right answer even when it
 * tracks something else: the user asked for that branch by name, and silently
 * creating a second one under a mangled name would be worse than landing on the
 * one they already have.
 */
export async function planRemoteCheckout(
  proc: GitRunner,
  remoteRef: string,
): Promise<RemoteCheckoutPlan> {
  const local = localNameFor(remoteRef);
  const existing = await proc.run([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${local}`,
  ]);
  if (existing.code === 0) {
    return {
      local,
      args: ["checkout", local],
      success: `Switched to ${local}`,
      undoLabel: `Checkout ${local}`,
    };
  }
  return {
    local,
    // `--track` is explicit rather than implied, so the new branch gets its
    // upstream even where `branch.autoSetupMerge` has been turned off.
    args: ["checkout", "-b", local, "--track", remoteRef],
    success: `Checked out ${local} (tracking ${remoteRef})`,
    undoLabel: `Checkout ${local}`,
  };
}
