// The Abort behind GitStudio's rebase doors — the "Abort Rebase" command (and
// the rebase todo editor's Abort, which runs it) and the Interactive Rebase
// panel's Abort. vscode-free, so it is tested against real git.
//
// Both ran `git rebase --abort` unconditionally. `git am` keeps its state in
// the same rebase-apply/ directory a rebase does, so these doors offered Abort
// during a patch series — and git refused it ("It looks like 'git am' is in
// progress. Cannot rebase."), leaving the series stopped. They go through the
// shared operation core now (OperationProvider.abort: `am --abort` for git am,
// `rebase --abort` for a rebase), which the dashboard, the merge editor and
// the desktop's op:abort already use.
//
// Only a rebase-like stop is aborted here: for no operation at all the core's
// abort means `git reset --merge` (the dashboard's "Cancel" over unmerged
// files), which is not what a door named "Abort Rebase" may do; a merge or a
// cherry-pick has its own Abort elsewhere.

import type { OperationKind, OperationOutcome, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";

export interface AbortSource {
  view(): Promise<OperationView>;
  abort(): Promise<OperationOutcome>;
}

export type RebaseAbortResult =
  | { ran: false; kind: OperationKind }
  | { ran: true; kind: OperationKind; outcome: OperationOutcome };

const REBASE_LIKE: ReadonlySet<OperationKind> = new Set(["rebase", "rebase-merge-step", "am"]);

export async function abortRebaseLike(op: AbortSource): Promise<RebaseAbortResult> {
  const view = await op.view();
  if (!REBASE_LIKE.has(view.kind)) return { ran: false, kind: view.kind };
  return { ran: true, kind: view.kind, outcome: await op.abort() };
}

/** What the doors say when there is nothing of theirs to abort. */
export function nothingToAbortText(kind: OperationKind): string {
  return kind === "none" || kind === "stash"
    ? "No rebase in progress."
    : `No rebase in progress — a ${kind} is. Abort it from the Conflicts dashboard.`;
}
