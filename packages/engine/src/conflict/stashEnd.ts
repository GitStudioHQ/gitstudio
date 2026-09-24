// The end of a conflicted stash apply, as the conflicts dashboard shows it.
// Pure — no vscode / node / DOM import; both dashboard hosts (the extensions'
// DashboardController and the desktop's DesktopConflicts) fold their git
// snapshots through it, so the two cannot drift (memory: fix-both-siblings).
//
// git keeps NO operation for a stash apply or pop: the stash markers in the
// conflicted files are its only trace (OperationProvider's kind "stash"). The
// moment the last file is resolved, git reports nothing in progress and
// nothing unmerged — and the dashboard, seeing an operation "end elsewhere",
// closed itself (the extensions) or fell back to "Nothing selected" (the
// desktop). Every other operation keeps a card saying it is done. Here the
// card also says the one thing git leaves behind: after a pop that stopped on
// conflicts, the stash entry is still in the stash list.

import type { ConflictFileView, ConflictsSnapshot, ConflictsState } from "@gitstudio/host-bridge/conflictsProtocol";

export const STASH_FINISHED: NonNullable<ConflictsState["finished"]> = {
  title: "Stash applied",
  text:
    "Every conflict is resolved, and your stashed changes are in your files. git keeps the stash entry " +
    "when applying it stops on conflicts, so it is still in your stash list — drop it once you are happy " +
    "with the result.",
};

/** What the dashboard shows instead of an empty "nothing in progress" snapshot. */
export interface StashEnd {
  finished: NonNullable<ConflictsState["finished"]>;
  /** The stash apply's rows, every one resolved. */
  files: ConflictFileView[];
}

/**
 * Folds each snapshot the host reads. While a stash apply is conflicted it
 * remembers the rows; when git then reports nothing in progress and nothing
 * unmerged, `fold` returns the finished state to show, and keeps returning it
 * until something else happens (a new conflict, another operation) or the
 * host calls `clear` (the user closed the page).
 */
export class StashEndTracker {
  private rows: ConflictFileView[] | undefined;
  private ended: StashEnd | undefined;

  fold(s: Pick<ConflictsSnapshot, "op" | "files">): StashEnd | undefined {
    const pending = s.files.some((f) => f.status !== "resolved");
    if (s.op.kind === "stash") {
      this.rows = s.files;
      this.ended = undefined;
      return undefined;
    }
    if (s.op.kind === "none") {
      if (pending) {
        // Still the same stash apply, read without its markers (a file edited
        // clean but not yet staged): keep the rows it had.
        return undefined;
      }
      if (this.ended) return this.ended;
      if (this.rows && s.files.length === 0) {
        this.ended = {
          finished: STASH_FINISHED,
          files: this.rows.map((f) => ({ ...f, status: "resolved" as const })),
        };
        this.rows = undefined;
        return this.ended;
      }
      this.rows = undefined;
      return undefined;
    }
    // Another operation: whatever was remembered belongs to the past.
    this.rows = undefined;
    this.ended = undefined;
    return undefined;
  }

  /** A conflicted stash apply was seen and has not been let go of (its end may be next). */
  get watching(): boolean {
    return !!this.rows || !!this.ended;
  }

  /** The user closed the page (or the host moved on): forget it. */
  clear(): void {
    this.rows = undefined;
    this.ended = undefined;
  }
}
