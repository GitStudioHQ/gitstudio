// POLISH A5.9 at activation: is this an upgrade from a version that showed a
// rebase's sides the other way round? Each extension calls this ONCE, first
// thing in `activate` — before it writes its own "walkthrough shown" key, which
// is how an install that predates this bookkeeping is told from a fresh one —
// and passes the answer to its MergeProduct as `sidesTip`.
//
// vscode-free (a Memento-shaped store), so it is unit-tested under node.

import { sidesFlipUpgrade, type SidesTipFacts } from "./product";

/** The part of vscode.Memento this reads and writes. */
export interface TipStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface SidesTipSetup {
  /** The version running now (its package.json). */
  version: string;
  /** globalState key recording the version that last ran. */
  lastVersionKey: string;
  /** The last version that showed the sides swapped (Merge Studio 0.3.4, GitStudio 1.13.0). */
  flippedAfter: string;
  /** A key every earlier version wrote (read BEFORE this activation writes it). */
  priorInstall: boolean;
  /** globalState key: the tip was dismissed. */
  dismissedKey: string;
  /** "Why?" — a page that explains it. */
  why?: string;
}

/**
 * The tip's facts for an upgrader, or undefined; the running version is
 * recorded either way. An upgrade is remembered (`<dismissedKey>.pending`)
 * until the tip is dismissed: the first rebase may come weeks after the
 * update, in a later session that no longer looks like an upgrade.
 */
export function setUpSidesTip(store: TipStore, setup: SidesTipSetup): SidesTipFacts | undefined {
  const pendingKey = `${setup.dismissedKey}.pending`;
  const upgrade = sidesFlipUpgrade({
    lastVersion: store.get(setup.lastVersionKey),
    priorInstall: setup.priorInstall,
    flippedAfter: setup.flippedAfter,
  });
  void store.update(setup.lastVersionKey, setup.version);
  if (upgrade) {
    void store.update(pendingKey, true);
  }
  if (!(upgrade || store.get<boolean>(pendingKey)) || store.get<boolean>(setup.dismissedKey)) {
    return undefined;
  }
  const [major, minor] = setup.version.split(/[.-]/);
  return {
    version: `${major ?? "0"}.${minor ?? "0"}`,
    dismissedKey: setup.dismissedKey,
    ...(setup.why ? { why: setup.why } : {}),
  };
}

/** The page both products link as "Why?": the README section on git's swapped words. */
export const SIDES_WHY_URL = "https://github.com/GitStudioHQ/merge-studio#rebases-which-side-is-yours";
