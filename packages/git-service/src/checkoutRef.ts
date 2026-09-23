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
 * Why planRefCheckout refuses `fullName`, when the reason is its NAME: the
 * branch a checkout would put on argv starts with "-", so git would read it as
 * an option (see planRefCheckout). Undefined for every other ref — a tag, an
 * ordinary branch, a name outside the namespaces.
 *
 * Refusing is right; refusing in silence, or with "not in this repository any
 * more — refresh and try again", is not: the branch IS there, and refreshing
 * changes nothing. The doors say what is true instead (`message`), and a
 * LOCAL branch can be fixed where it stands — `renameArgs` renames it by its
 * full name, with `--` so the old name is never read as an option either.
 */
export interface OptionLikeRef {
  /** The name git would have been handed: "-f" for refs/heads/-f and for
   *  refs/remotes/origin/-f alike. */
  name: string;
  /** A local branch — the one kind a rename can fix here. A remote-tracking
   *  branch's name belongs to the remote. */
  local: boolean;
  /** What a door says instead of checking out. */
  message: string;
}

export function optionLikeCheckout(fullName: string): OptionLikeRef | undefined {
  const name = refShortName(fullName);
  if (!name || name === fullName || fullName.startsWith("refs/tags/")) return undefined;
  const local = fullName.startsWith("refs/heads/");
  const onArgv = local ? name : localNameFor(name);
  if (!onArgv.startsWith("-")) return undefined;
  const whose = local ? "" : ` (from ${name})`;
  return {
    name: onArgv,
    local,
    message:
      `Git can't safely check out a branch whose name starts with "-": "${onArgv}"${whose} would be read as an option. ` +
      (local ? "Rename it, then check it out." : "Create a branch from it under another name instead."),
  };
}

/**
 * `git branch -m -- <old> <new>` for the local branch `fullName` — the rename
 * a refused option-like branch is offered. By its FULL name: the old name is
 * the one under refs/heads/, never a short form, and `--` ends option parsing
 * so "-f" is a name (git renames it with "renamed a misnamed branch '-f'
 * away"). Undefined for anything that is not a local branch.
 */
export function renameArgs(fullName: string, newName: string): string[] | undefined {
  if (!fullName.startsWith("refs/heads/")) return undefined;
  const old = fullName.slice("refs/heads/".length);
  if (!old || !newName) return undefined;
  return ["branch", "-m", "--", old, newName];
}

/** A name to offer in the rename box: the old one without its leading dashes. */
export function suggestedRename(name: string): string {
  const bare = name.replace(/^-+/, "");
  return bare || "renamed";
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
  // by its full name, which cannot be read as an option.) The doors ask
  // optionLikeCheckout why, and say so.
  if (optionLikeCheckout(fullName)) {
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
    // Tracked by the FULL name: a local branch called "origin/x" makes the
    // short one ambiguous (see planRemoteCheckout's trackRef).
    return { ...(await planRemoteCheckout(proc, name, fullName)), detaches: false };
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
