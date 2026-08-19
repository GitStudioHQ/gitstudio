import type { GitRef } from "@gitstudio/host-bridge/git";

/** One row of the branch switcher. */
export interface BranchChoice {
  id: string;
  label: string;
  icon: string;
  description?: string;
}

/**
 * "origin/main" -> "main". Only used to decide whether a remote branch would
 * duplicate a local one that already exists.
 */
export function shortenRemote(name: string): string {
  const cut = name.indexOf("/");
  return cut === -1 ? name : name.slice(cut + 1);
}

/**
 * What the status bar's branch switcher offers.
 *
 * Locals first, then remote branches that have no local counterpart yet —
 * listing `origin/main` beside `main` would offer the same destination twice,
 * and picking the remote one would be the worse of the two.
 *
 * Separate from syncStatus.ts, which imports `vscode`, so this can be tested.
 */
export function branchChoices(refs: readonly GitRef[]): BranchChoice[] {
  const locals = refs.filter((r) => r.type === "head");
  const remotes = refs.filter((r) => r.type === "remote");
  const localNames = new Set(locals.map((r) => r.name));

  return [
    ...locals.map((r) => ({
      id: r.name,
      label: r.name,
      icon: r.isCurrent ? "check" : "git-branch",
      description: r.isCurrent
        ? "current branch"
        : r.upstream
          ? `tracking ${r.upstream}`
          : undefined,
    })),
    ...remotes
      .filter((r) => !localNames.has(shortenRemote(r.name)))
      .map((r) => ({
        id: r.name,
        label: r.name,
        icon: "cloud",
        description: "remote branch",
      })),
  ];
}
