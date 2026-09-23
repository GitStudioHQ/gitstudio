import type { GitRef } from "@gitstudio/git-service/index";
import { resolveListedRef, type RefCheckoutContext } from "./refCheckout";

// Pure ref-name helpers for the worktree-create flow. Kept DOM- and vscode-free
// so they're unit-testable, like the parser in git-service.

/**
 * The bare name of a branch a start point's upstream would be set from. For a
 * remote-tracking ref `refs/remotes/origin/feature` this is "feature" (NOT
 * "origin/feature"): git's `branch.autoSetupMerge=simple` compares the new
 * branch's name to the remote branch's short name, so `-b feature … origin/feature`
 * tracks while `-b my-experiment … origin/feature` must not.
 */
export function shortNameOf(startPoint: string): string | undefined {
  if (startPoint.startsWith("refs/heads/")) {
    return startPoint.slice("refs/heads/".length);
  }
  if (startPoint.startsWith("refs/remotes/")) {
    return startPoint.slice("refs/remotes/".length).split("/").slice(1).join("/");
  }
  if (startPoint.startsWith("refs/tags/")) {
    return startPoint.slice("refs/tags/".length);
  }
  return undefined;
}

/**
 * The ref the worktree flow works from: the one git LISTS for `ref` — its own
 * GitRef when it carries a full name, else the listed ref of the same name AND
 * type (the branch menu's webview sends name + type only). Undefined when the
 * list has no such ref or cannot be read, and the flow then STOPS.
 *
 * It used to fall back to the webview's short name and guess: strip a "heads/"
 * and rebuild refs/heads/<rest>. But git's collision-disambiguated "heads/v1.2"
 * and a branch genuinely named "heads/v1.2" are the same string, so the guess
 * is wrong for one of them — and a guessed full name is the bug every checkout
 * door has stopped committing (issue #30's follow-up).
 */
export async function worktreeRefFor(
  ctx: Pick<RefCheckoutContext, "refs">,
  ref: GitRef,
): Promise<(GitRef & { fullName: string }) | undefined> {
  const hit = await resolveListedRef(ctx, ref);
  return hit ? { ...ref, ...hit, fullName: hit.fullName } : undefined;
}

/**
 * The bare name for `ref`, from its FULL name: "refs/heads/v1.2" → "v1.2",
 * "refs/remotes/origin/x" → "origin/x". When a local branch and a tag share a
 * short name, `%(refname:short)` returns "heads/v1.2" / "tags/v1.2"; the full
 * name is authoritative and never false-strips a branch really called
 * "heads/x". A ref with no full name has no bare name: "" (resolve it with
 * worktreeRefFor first — nothing is guessed from the short one).
 */
export function bareName(ref: GitRef): string {
  if (!ref.fullName) {
    return "";
  }
  switch (ref.type) {
    case "head":
      return ref.fullName.startsWith("refs/heads/") ? ref.fullName.slice("refs/heads/".length) : "";
    case "remote":
      return ref.fullName.startsWith("refs/remotes/") ? ref.fullName.slice("refs/remotes/".length) : "";
    case "tag":
      return ref.fullName.startsWith("refs/tags/") ? ref.fullName.slice("refs/tags/".length) : "";
    default:
      return ref.fullName;
  }
}

/**
 * The fully-qualified ref to start a new branch from: the ref's own full name,
 * or undefined when it has none — never one rebuilt from the short name.
 */
export function startPointOf(ref: GitRef): string | undefined {
  if (!ref.fullName || ref.type === "stash") {
    return undefined;
  }
  return ref.fullName;
}
