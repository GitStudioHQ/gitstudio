// Where the Commit Graph's branch filter (issue #30) is remembered: one
// selection per REPOSITORY, shared by every graph surface in every window (the
// bottom panel, the Commits sidebar view and the editor tab all host the same
// graph and all read the same selection).
//
// Per repository, not per workspace. The selection lived in workspaceState,
// keyed by the repo root — and workspaceState is a different store for every
// workspace, so the same repository opened as a folder and inside a
// .code-workspace remembered two selections, and a root reached through a
// symlink (/tmp vs /private/tmp on macOS) was a third. It lives in globalState
// now, keyed by the root's REAL path, which is what the desktop app does too:
// its filters are app-wide settings keyed by the root its repo manager hands
// out, and those are realpath'd (repoStore.ts). One repository, one selection,
// in both products.
//
// A selection remembered the old way is carried over once (see migrate()).
//
// Free of `vscode` on purpose, so it unit-tests under plain tsx: the mementos
// are injected (globalState / workspaceState in production, Maps in tests),
// and change notification is a plain listener set rather than a
// vscode.EventEmitter.

import { realpathSync } from "node:fs";
import type { GraphRefFilter } from "@gitstudio/host-bridge/graphProtocol";

/** Memento key → `Record<canonical repo root, string[] | null>`: a list is a
 *  selection, null is All CHOSEN, and no entry is All never chosen since the
 *  upgrade (which a migration may fill). The same key in globalState and,
 *  before, workspaceState. */
const STATE_KEY = "gitstudio.graph.refFilter";

/** The slice of `vscode.Memento` the store uses. */
export interface RefFilterMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface RefFilterStoreOptions {
  /**
   * A root → the key it is remembered under. Production passes realpathRoot,
   * so the same repository reached two ways is one key; tests pass a fake.
   */
  canonical?: (root: string) => string;
  /**
   * The workspace's own memento — where selections were remembered before.
   * Whatever it holds is carried into the global store once, then removed.
   */
  legacy?: RefFilterMemento;
}

/** A root's real path — symlinks resolved — or the root itself when it cannot
 *  be resolved (gone, unreadable): a key that is merely un-canonical beats a
 *  store that throws. */
export function realpathRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

export class RefFilterStore {
  private readonly listeners = new Set<(root: string) => void>();
  private readonly canonical: (root: string) => string;
  /** Resolves when the one-time carry-over from `legacy` has been written. */
  readonly migrated: Promise<void>;

  constructor(
    /** globalState in production. */
    private readonly memento: RefFilterMemento,
    opts: RefFilterStoreOptions = {},
  ) {
    this.canonical = opts.canonical ?? ((r) => r);
    this.migrated = opts.legacy ? this.migrate(opts.legacy) : Promise.resolve();
  }

  /** The key a root is remembered under. */
  private key(root: string): string {
    return this.canonical(root);
  }

  /** Whether two roots are the same repository to this store — what a graph
   *  host asks of a change event before reloading. */
  sameRepo(a: string | undefined, b: string | undefined): boolean {
    return !!a && !!b && this.key(a) === this.key(b);
  }

  /**
   * The stored selection for a repository, as stored. It may name refs that
   * no longer exist — the host prunes it against the live ref list, because
   * only the host has that list.
   */
  get(root: string): GraphRefFilter {
    const all = this.memento.get<Record<string, unknown>>(STATE_KEY);
    const refs = all && typeof all === "object" ? all[this.key(root)] : undefined;
    return clean(refs);
  }

  /**
   * Remember `refs` for a repository (null, or an empty list, is All) and tell every graph
   * showing that repository — the surface that made the change included, so
   * a change has exactly one path to a reload rather than a direct one plus
   * an echo. `silent` skips the telling: a host pruning refs that no longer
   * exist is already mid-reload, and the pruned list walks the same history.
   */
  async set(root: string, refs: GraphRefFilter, opts?: { silent?: boolean }): Promise<void> {
    const all = { ...(this.memento.get<Record<string, unknown>>(STATE_KEY) ?? {}) };
    const key = this.key(root);
    // All is remembered as a CHOICE (null), not as a missing entry: a missing
    // entry is what a repository nobody has touched since the upgrade looks
    // like, and migrate() carries an old workspace's selection into exactly
    // those — so All chosen here was rolled back by the next old workspace to
    // open. A null entry reads as All (clean) and says "decided".
    all[key] = refs && refs.length > 0 ? refs : null;
    await this.memento.update(STATE_KEY, all);
    if (opts?.silent) return;
    for (const fn of [...this.listeners]) fn(root);
  }

  /** Subscribe to changes; returns the unsubscribe. `root` is the repo whose
   *  selection moved (compare with sameRepo), so a host for another repo can
   *  ignore it. */
  onDidChange(fn: (root: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /**
   * Carry this workspace's old selections into the global store, once.
   *
   * Each is re-keyed by its canonical root. A repository the global store
   * already has a selection for keeps THAT one — it is the newer word, set
   * from some other workspace (or migrated from one first) — so opening an
   * old workspace never rolls another window's choice back. The old record
   * is removed afterwards, which is what makes this happen once per
   * workspace. The memento applies an update in memory at once, so a get()
   * made before the returned promise settles already sees the result.
   */
  private async migrate(legacy: RefFilterMemento): Promise<void> {
    const old = legacy.get<Record<string, unknown>>(STATE_KEY);
    if (old === undefined) return;
    if (old && typeof old === "object" && !Array.isArray(old)) {
      const all = { ...(this.memento.get<Record<string, unknown>>(STATE_KEY) ?? {}) };
      let changed = false;
      for (const [root, refs] of Object.entries(old)) {
        const kept = clean(refs);
        const key = this.key(root);
        if (!kept || key in all) continue;
        all[key] = kept;
        changed = true;
      }
      if (changed) await this.memento.update(STATE_KEY, all);
    }
    await legacy.update(STATE_KEY, undefined);
  }
}

/** A stored value as a selection: the strings in it, or null (All). */
function clean(refs: unknown): GraphRefFilter {
  if (!Array.isArray(refs)) return null;
  const out = refs.filter((r): r is string => typeof r === "string");
  return out.length > 0 ? out : null;
}

let current: RefFilterStore | undefined;

/** Installed once at activation (see extension.ts); graph hosts read it. */
export function setRefFilterStore(store: RefFilterStore | undefined): void {
  current = store;
}
export function getRefFilterStore(): RefFilterStore | undefined {
  return current;
}
