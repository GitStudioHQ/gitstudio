import type { GitRef } from "@gitstudio/git-service/index";

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
 * The bare short name for `ref`, with git's disambiguating type prefix removed.
 * When a local branch and a tag share a short name (git warns "refname 'v1.2'
 * is ambiguous"), `%(refname:short)` returns the name with the type prefixed —
 * "heads/v1.2" / "tags/v1.2" — and for remotes it can return "remotes/origin/x".
 * Checking a branch out by name or reconstructing `refs/<type>/<name>` needs the
 * prefix handled: an un-stripped "heads/v1.2" silently detaches, a double
 * prefix ("refs/tags/tags/v1.2") is a fatal.
 *
 * Derived from `fullName` when present (authoritative, never false-strips): a
 * genuine branch named "heads/x" and a collision-prefixed name are string-
 * identical, so name-based stripping alone would corrupt one of them. Only when
 * `fullName` is absent (branch-menu webview, before worktreeFromRef re-resolves
 * it) do we fall back to stripping a single type prefix from the short name.
 */
export function bareName(ref: GitRef): string {
  if (ref.fullName) {
    switch (ref.type) {
      case "head":
        return ref.fullName.slice("refs/heads/".length);
      case "remote":
        return ref.fullName.slice("refs/remotes/".length);
      case "tag":
        return ref.fullName.slice("refs/tags/".length);
      default:
        return ref.fullName;
    }
  }
  switch (ref.type) {
    case "head":
      return ref.name.replace(/^heads\//, "");
    case "remote":
      return ref.name.replace(/^remotes\//, "");
    case "tag":
      return ref.name.replace(/^tags\//, "");
    default:
      return ref.name;
  }
}

/**
 * The fully-qualified ref to start a new branch from. The Worktrees view builds
 * its refs from `listRefs()`, so `fullName` is set; the branch menu's webview
 * only sends `name` + `type` (no `fullName`). Reconstruct the FQN here so both
 * create paths pass an identical start point — otherwise the branch-menu path
 * falls back to "from HEAD", silently skipping the upstream tracking that the
 * Worktrees-view path sets up for a remote start point.
 */
export function startPointOf(ref: GitRef): string | undefined {
  if (ref.fullName) {
    return ref.fullName;
  }
  const name = bareName(ref);
  switch (ref.type) {
    case "head":
      return `refs/heads/${name}`;
    case "remote":
      return `refs/remotes/${name}`;
    case "tag":
      return `refs/tags/${name}`;
    default:
      return undefined;
  }
}
