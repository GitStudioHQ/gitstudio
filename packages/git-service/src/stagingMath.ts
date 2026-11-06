// Where the staging diffs run.
//
// Block staging diffs whole files: HEAD against the working text, the index
// against it, and again to build the text it writes. Each is the engine's
// line diff (vscode-diff), which on most files is milliseconds — and on a file
// whose every line changed is the diff's full 5-second budget, spent refining
// one file-sized block character by character (#145: a 3,000-line file
// rewritten, staged, then Enter pressed — the window froze for 5 s, then again
// on the next pause in typing, because the editor gutter re-diffs after every
// edit). VS Code runs the same algorithm in a worker for exactly this reason.
//
// So the diffs go through this one seam. In-process by default (the desktop's
// main process, the tests, any host that has not installed anything); the
// extension installs a worker-thread implementation at activation, and then no
// file of any shape can block the extension host while it is diffed.
//
// `key` names what a job is FOR (the gutter passes the document): a newer job
// with the same key makes the older one stale, and `cancel(key)` lets a caller
// that already knows say so before submitting — a stale job is then rejected
// with `Superseded` instead of finishing a diff nobody will paint.

import { computeChangeBlocks, type ChangeBlock } from "@gitstudio/engine/staging/blockStaging";
import {
  applySelectedChanges,
  computeHunks,
  type Hunk,
  type LineRange,
} from "@gitstudio/engine/staging/applyLineChanges";

export interface StagingMath {
  changeBlocks(head: string, index: string, working: string, key?: string): Promise<ChangeBlock[]>;
  hunks(original: string, modified: string): Promise<Hunk[]>;
  apply(original: string, modified: string, selected: LineRange[]): Promise<string>;
  /** Abandon the job running or queued for `key`; it rejects with `Superseded`. */
  cancel?(key: string): void;
}

/** A job given up because a newer one for the same thing replaced it. */
export class Superseded extends Error {
  constructor() {
    super("superseded by a newer job");
    this.name = "Superseded";
  }
}

export const inProcessMath: StagingMath = {
  async changeBlocks(head, index, working) {
    return computeChangeBlocks(head, index, working);
  },
  async hunks(original, modified) {
    return computeHunks(original, modified);
  },
  async apply(original, modified, selected) {
    return applySelectedChanges(original, modified, selected);
  },
};

let current: StagingMath = inProcessMath;

export function stagingMath(): StagingMath {
  return current;
}

/** Install `math` (undefined: back to in-process). Returns the one it replaced. */
export function setStagingMath(math: StagingMath | undefined): StagingMath {
  const previous = current;
  current = math ?? inProcessMath;
  return previous;
}
