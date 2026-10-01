import type { GitRef } from "@gitstudio/git-service/index";
import { resettableBranches } from "@gitstudio/git-service/branchReset";
import * as l10n from "@vscode/l10n";

// What the Changes view's branch menu is sent: its rows, built from one
// for-each-ref listing. No `vscode` here, so a test can feed it what real git
// lists.

/** A local branch row for the branch menu (folds in the old Branches view). */
export interface BranchRefPayload {
  name: string;
  current: boolean;
  upstream?: string;
  favorite: boolean;
  /** Commits ahead/behind the upstream — drives the menu's ↑/↓ badges. */
  ahead?: number;
  behind?: number;
  /**
   * The upstream is a remote-tracking branch this repository has — what
   * "Reset to '<upstream>'…" resets to. False for no upstream, one that is a
   * local branch, and one gone from the remote.
   */
  upstreamOnRemote?: boolean;
  /**
   * The upstream no longer exists on its remote (git's "[gone]": deleted, as
   * a merged pull request leaves it). Without this the row would name it as
   * if it were live.
   */
  gone?: boolean;
}

/** Everything the branch menu needs: local branches (with favorites), remotes, recents, tags. */
export interface BranchesPayload {
  local: BranchRefPayload[];
  /** Remote branches, short names ("origin/feature"). */
  remote: string[];
  recent: string[];
  /** Tag names, newest-looking first (numeric-desc sort). */
  tags: string[];
  /**
   * The repository's remotes by name. The menu groups remote branches by
   * remote, and a remote's name may itself hold a slash ("team/eu"), so it
   * cannot be read off "team/eu/feature" by splitting at the first one.
   */
  remoteNames?: string[];
}

/** Local branches (with favorites), remotes, recents, and tags for the branch menu. */
export function branchesPayload(
  refs: readonly GitRef[],
  favorites: readonly string[],
  recent: string[],
  remoteNames: readonly string[] = [],
): BranchesPayload {
  const favs = new Set(favorites);
  // Where the submenu offers "Reset to '<upstream>'…" (#32).
  const resettable = resettableBranches(refs);
  const local: BranchRefPayload[] = refs
    .filter((r) => r.type === "head")
    .map((r) => ({
      name: r.name,
      current: r.isCurrent,
      upstream: r.upstream,
      favorite: favs.has(r.name),
      ahead: r.ahead,
      behind: r.behind,
      upstreamOnRemote: resettable.has(r.name),
      ...(r.gone ? { gone: true } : {}),
    }));
  // Not a remote's HEAD pointer. git shortens refs/remotes/origin/HEAD to
  // the bare remote name ("origin"), so the "/HEAD" test never matched it:
  // the menu listed a remote branch called "origin" whose checkout could
  // only fail. `symref` is what marks it (the Branches tree's twin).
  const remote = refs
    .filter((r) => r.type === "remote" && !r.symref && !r.name.endsWith("/HEAD"))
    .map((r) => r.name);
  // Tags sorted so "newest" (highest version) floats up — a numeric-aware
  // descending compare puts v1.10 above v1.9 and v2 above v1.
  const tags = refs
    .filter((r) => r.type === "tag")
    .map((r) => r.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return { local, remote, recent, tags, remoteNames: [...remoteNames] };
}

/**
 * `payload` with each local branch's star as `favorites` has it now — the same
 * object when nothing differs. The host's instant first post re-sends the list
 * it last built, and a star set since would otherwise go out unset: the menu
 * moved the row at once, and that post moved it back.
 */
export function withFavorites(payload: BranchesPayload, favorites: readonly string[]): BranchesPayload {
  const favs = new Set(favorites);
  if (payload.local.every((b) => b.favorite === favs.has(b.name))) return payload;
  return { ...payload, local: payload.local.map((b) => ({ ...b, favorite: favs.has(b.name) })) };
}

/**
 * The full name of a ref picked from a list by its short name and its kind,
 * as git lists it now — undefined when there is none any more. A short name
 * names one ref only while no other shares it: a tag made since the list was
 * drawn with the name of the branch that was picked, and `git checkout
 * --detach v1` lands on the branch (git prefers it), whichever was picked.
 * git's own short name for a ref that shares one ("heads/v1") is found too.
 */
export function pickedRefName(
  refs: readonly GitRef[],
  name: string,
  refType: "head" | "remote" | "tag",
): string | undefined {
  const prefix = refType === "head" ? "refs/heads/" : refType === "remote" ? "refs/remotes/" : "refs/tags/";
  const same = refs.filter((r) => r.type === refType);
  return (same.find((r) => r.name === name) ?? same.find((r) => r.fullName === prefix + name))?.fullName;
}

/**
 * A branch-menu action as the person chose it, for a message about it:
 * "Pull into 'feature'", not the message's action id ("pullFf").
 */
export function branchActionWords(action: string | undefined, ref?: string): string {
  switch (action) {
    case "fetch":
      return l10n.t("Fetch");
    case "pull":
      return l10n.t("Pull");
    case "pullMerge":
      return l10n.t("Pull using Merge");
    case "pullRebase":
      return l10n.t("Pull using Rebase");
    case "push":
      return l10n.t("Push");
    case "pullFf":
      return ref ? l10n.t("Pull into '{0}'", ref) : l10n.t("Pull");
    case "new":
      return ref ? l10n.t("New Branch '{0}'", ref.trim()) : l10n.t("New Branch");
    case "checkoutRef":
      return ref ? l10n.t("Checkout '{0}'", ref.trim()) : l10n.t("Checkout");
    default:
      return action ?? l10n.t("The branch action");
  }
}
