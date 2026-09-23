// "Checkout main" / "Checkout origin/main" for the refs sitting on a commit row
// (issues #12 / #19).
//
// Pure and DOM-free so the decisions below can be tested directly — they are the
// parts that are easy to get subtly wrong, and they mirror the extension's
// equivalent (apps/extension/src/graph/commitActions.ts refMenuItems) so the same
// right-click means the same thing in both products.

import type { CommitActionRequest } from "../shared/ipc";

/** A ref decoration on a commit row, as the renderer knows it. */
export interface RowRef {
  name: string;
  kind: "head" | "remote" | "tag";
  /** True for the branch HEAD currently points at. */
  current?: boolean;
  /** The full name ("refs/heads/main") — what the checkout is planned from,
   *  because `name` is git's short form and "heads/release" names a revision,
   *  not a branch, once a tag shares the name. */
  fullName?: string;
}

export interface RefMenuItem {
  label: string;
  ref: { name: string; kind: RowRef["kind"]; fullName?: string };
  /** Present when the action asks something first (and so the label ends "…"). */
  confirm?: string;
}

/**
 * Build the checkout items for a row's refs.
 *
 * Three decisions worth stating:
 *
 *   · the branch you are ALREADY on is skipped — offering to switch to where you
 *     are is noise, and it is the most common row to right-click.
 *   · `origin/HEAD` is dropped. It is a symbolic pointer at the remote's default
 *     branch, so checking it out lands on a detached HEAD at whatever it points
 *     to. Never what anyone means, and it appears on a very common row.
 *   · a tag detaches, because a tag is a fixed point and there is no branch to
 *     attach to. That is the one case where detaching is right, so it is allowed
 *     — but it asks first, and the label says so with an ellipsis.
 */
export function refMenuItems(refs: readonly RowRef[]): RefMenuItem[] {
  const items: RefMenuItem[] = [];
  for (const ref of refs) {
    if (ref.kind === "head" && ref.current) {
      continue;
    }
    if (ref.name.endsWith("/HEAD")) {
      continue;
    }
    const full = ref.fullName ? { fullName: ref.fullName } : {};
    // Named by the full name shorn — "release", never git's "heads/release"
    // beside a tag of that name (the chips say "release" too).
    const said = ref.fullName ? refDisplay(ref.fullName) : ref.name;
    if (ref.kind === "tag") {
      items.push({
        label: `Checkout ${said}…`,
        ref: { name: ref.name, kind: "tag", ...full },
        confirm: `Check out tag ${said}? You'll be on a detached HEAD, not on a branch.`,
      });
    } else {
      items.push({
        label: `Checkout ${said}`,
        ref: { name: ref.name, kind: ref.kind, ...full },
      });
    }
  }
  return items;
}

/**
 * The request every "check out this ref" door sends — the Branches list's
 * row button and menu, the branch switcher, the ref page — built from the
 * ref's FULL name and nothing else.
 *
 * Those doors used to send `%(refname:short)` alone, and with a branch and a
 * tag both called "release" the branch's short name is "heads/release":
 * `git checkout heads/release` resolves it as a REVISION and detaches HEAD at
 * the branch tip, while reporting success. The main process plans the
 * checkout from `fullName` (git-service's planRefCheckout) and refuses a
 * request without one, so a door cannot quietly fall back to the short name.
 * `name` and `refKind` are derived from it, for the words only.
 */
export function refCheckoutRequest(fullName: string): CommitActionRequest {
  const refKind: RowRef["kind"] = fullName.startsWith("refs/remotes/")
    ? "remote"
    : fullName.startsWith("refs/tags/")
      ? "tag"
      : "head";
  return {
    action: "checkout-ref",
    // Required by the request shape, unused on this path: the ref travels
    // in fullName.
    sha: fullName,
    name: refDisplay(fullName),
    refKind,
    fullName,
  };
}

/** A full name shorn of its namespace, for a toast: never fed back to git. */
export function refDisplay(fullName: string): string {
  return fullName.replace(/^refs\/(heads|remotes|tags)\//, "");
}
