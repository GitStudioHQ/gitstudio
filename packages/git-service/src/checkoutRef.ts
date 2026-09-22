/**
 * What "Checkout <ref>" hands git, planned from the ref's FULL name.
 *
 * Both hosts' arms took the name off the chip — `%(refname:short)` — and short
 * is only shortest UNAMBIGUOUS. The moment a tag and a branch share "release",
 * git hands out "heads/release" for the branch, and `git checkout
 * heads/release` is not a branch checkout: nothing under refs/heads/ is called
 * that, so git resolves it as a revision and DETACHES at the branch tip
 * ("Note: switching to 'heads/release'…") under a toast saying "Switched to
 * heads/release". That is the exact outcome a "Checkout <branch>" item exists
 * to prevent, and it took the same door twice: the row's commit menu, and the
 * chip's own menu that reuses its arm.
 *
 * So the arms never see the short name. From the full name:
 *
 *   • a branch checks out by the name under refs/heads/. git looks THAT
 *     namespace up first for a checkout, so a tag of the same name only earns
 *     a warning ("refname 'release' is ambiguous") before "Switched to branch";
 *   • a remote-tracking branch by the name under refs/remotes/ — which is what
 *     planRemoteCheckout takes, and strips the remote from;
 *   • a tag by its full refs/tags/ name. The detach can name any revision, and
 *     a full name is never ambiguous.
 *
 * Lives beside planRemoteCheckout for the same reason it does: the extension's
 * graph menu and the desktop's graph menu must mean the same thing.
 */

import { type GitRunner, localNameFor, planRemoteCheckout } from "./checkoutRemote";

export interface RefCheckoutPlan {
  /** Argv for `ctx.process.run`. */
  args: string[];
  /** Status-bar message on success. */
  success: string;
  /** Label for the Undo envelope. */
  undoLabel: string;
  /** The checkout leaves HEAD detached (a tag), so a host asks first. */
  detaches: boolean;
}

/** `refs/heads/x` → `x`, `refs/remotes/origin/x` → `origin/x`, `refs/tags/v1` → `v1`. */
export function refShortName(fullName: string): string {
  return fullName.replace(/^refs\/(heads|remotes|tags)\//, "");
}

/**
 * The plan for `fullName`, or undefined for a name outside the three
 * namespaces (a stash, HEAD, or a short name that reached here by mistake —
 * refusing it is safer than guessing a namespace for it).
 */
export async function planRefCheckout(
  proc: GitRunner,
  fullName: string,
): Promise<RefCheckoutPlan | undefined> {
  const name = refShortName(fullName);
  if (!name || name === fullName) {
    return undefined;
  }
  // A branch checks out by its SHORT name, bare on argv. Porcelain forbids a
  // branch name that starts with "-", but `git update-ref refs/heads/-f`
  // does not and a fetch can bring one in under refs/remotes/ — and planned
  // bare, "Checkout -f" ran `git checkout -f`, discarding every uncommitted
  // change. Refused, as a name git itself would not create. (A tag detaches
  // by its full name, which cannot be read as an option.)
  const onArgv = fullName.startsWith("refs/remotes/") ? localNameFor(name) : name;
  if (!fullName.startsWith("refs/tags/") && onArgv.startsWith("-")) {
    return undefined;
  }
  if (fullName.startsWith("refs/heads/")) {
    return {
      args: ["checkout", name],
      success: `Switched to ${name}`,
      undoLabel: `Checkout ${name}`,
      detaches: false,
    };
  }
  if (fullName.startsWith("refs/remotes/")) {
    return { ...(await planRemoteCheckout(proc, name)), detaches: false };
  }
  return {
    // The full name, so the detach lands on the tag and never on a branch of
    // the same name.
    args: ["checkout", "--detach", fullName],
    success: `Checked out ${name}`,
    undoLabel: `Checkout ${name}`,
    detaches: true,
  };
}
