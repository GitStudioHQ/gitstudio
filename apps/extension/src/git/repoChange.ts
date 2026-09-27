// What moved in a repository, as RepoManager's change event says it.
//
// One event used to mean "something, somewhere": vscode.git fires its state
// event on every `git status` it runs — a save, a window focus — and every
// subscriber reloaded everything on it. The commit graph re-read its log,
// refs and layout (three surfaces, ~90 KB each), blame dropped every cached
// file and the Timeline emptied, while only the working tree had moved.
//
// The event now carries the kinds of change behind it, from where it came:
//   · workingTree — vscode.git's state event with HEAD, its upstream and the
//     ahead/behind counts as they were (files edited, staged, discarded);
//   · refs        — a ref moved: the refs/ watcher, HEAD's file, or vscode.git
//     reporting a different HEAD, upstream or count;
//   · operation   — git's operation-state files (MERGE_HEAD, rebase-merge/…);
//   · repos       — a repository opened or closed, or the active one changed.
// A subscriber that cares about only some of them asks touches(). An event
// with no kinds (an older caller's fire()) touches everything.
//
// vscode-free, so the classification is unit-tested.

export type RepoChangeKind = "workingTree" | "refs" | "operation" | "repos";

export const ALL_REPO_CHANGES: readonly RepoChangeKind[] = ["workingTree", "refs", "operation", "repos"];

export interface RepoChangeEvent {
  readonly kinds: ReadonlySet<RepoChangeKind>;
}

export function repoChange(kinds: Iterable<RepoChangeKind>): RepoChangeEvent {
  return { kinds: new Set(kinds) };
}

/** Whether the change could have moved any of `kinds` — true when it does not say. */
export function touches(e: RepoChangeEvent | undefined | void, ...kinds: RepoChangeKind[]): boolean {
  if (!e || !e.kinds || e.kinds.size === 0) return true;
  return kinds.some((k) => e.kinds.has(k));
}

/** The part of vscode.git's repository state a ref move changes. */
export interface HeadStateLike {
  HEAD?: {
    name?: string;
    commit?: string;
    upstream?: { remote: string; name: string };
    ahead?: number;
    behind?: number;
  };
  rebaseCommit?: { hash?: string };
}

/**
 * A signature of the ref-ish part of a vscode.git state: two states with the
 * same signature differ only in their files.
 */
export function headSignature(state: HeadStateLike | undefined): string {
  const h = state?.HEAD;
  return JSON.stringify([
    h?.name ?? null,
    h?.commit ?? null,
    h?.upstream ? `${h.upstream.remote}/${h.upstream.name}` : null,
    h?.ahead ?? null,
    h?.behind ?? null,
    state?.rebaseCommit?.hash ?? null,
  ]);
}

/**
 * What a vscode.git state event moved, given the signature last seen for
 * that repository (undefined: none yet — then it is everything that repo
 * shows, a ref included).
 */
export function classifyStateEvent(previous: string | undefined, next: string): RepoChangeKind[] {
  if (previous === undefined || previous !== next) return ["refs", "workingTree"];
  return ["workingTree"];
}
