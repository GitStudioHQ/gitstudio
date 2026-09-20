// Where the Commit Graph's branch filter (issue #30) is remembered: one
// selection per repository, in workspaceState, shared by every graph surface
// in the window (the bottom panel, the Commits sidebar view and the editor
// tab all host the same graph and all read the same selection).
//
// Free of `vscode` on purpose, so it unit-tests under plain tsx: the memento is
// injected (workspaceState in production, a Map in tests), and change
// notification is a plain listener set rather than a vscode.EventEmitter.

import type { GraphRefFilter } from "@gitstudio/host-bridge/graphProtocol";

/** workspaceState key → `Record<repoRoot, string[]>` (a repo with no entry is All). */
const STATE_KEY = "gitstudio.graph.refFilter";

/** The slice of `vscode.Memento` the store uses. */
export interface RefFilterMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class RefFilterStore {
  private readonly listeners = new Set<(root: string) => void>();

  constructor(private readonly memento: RefFilterMemento) {}

  /**
   * The stored selection for a repository, as stored. It may name refs that
   * no longer exist — the host prunes it against the live ref list, because
   * only the host has that list.
   */
  get(root: string): GraphRefFilter {
    const all = this.memento.get<Record<string, unknown>>(STATE_KEY);
    const refs = all && typeof all === "object" ? all[root] : undefined;
    if (!Array.isArray(refs)) return null;
    const out = refs.filter((r): r is string => typeof r === "string");
    return out.length > 0 ? out : null;
  }

  /**
   * Remember `refs` for a repository (null forgets it) and tell every graph
   * showing that repository — the surface that made the change included, so
   * a change has exactly one path to a reload rather than a direct one plus
   * an echo. `silent` skips the telling: a host pruning refs that no longer
   * exist is already mid-reload, and the pruned list walks the same history.
   */
  async set(root: string, refs: GraphRefFilter, opts?: { silent?: boolean }): Promise<void> {
    const all = { ...(this.memento.get<Record<string, unknown>>(STATE_KEY) ?? {}) };
    if (refs && refs.length > 0) all[root] = refs;
    else delete all[root];
    await this.memento.update(STATE_KEY, all);
    if (opts?.silent) return;
    for (const fn of [...this.listeners]) fn(root);
  }

  /** Subscribe to changes; returns the unsubscribe. `root` is the repo whose
   *  selection moved, so a host for another repo can ignore it. */
  onDidChange(fn: (root: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

let current: RefFilterStore | undefined;

/** Installed once at activation (see extension.ts); graph hosts read it. */
export function setRefFilterStore(store: RefFilterStore | undefined): void {
  current = store;
}
export function getRefFilterStore(): RefFilterStore | undefined {
  return current;
}
