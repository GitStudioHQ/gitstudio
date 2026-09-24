// The conflicts dashboard's state machine (PLAN §3.7 W14, matrix rows 45–54).
// vscode-free: the panel host (conflictsPanel.ts) feeds it git snapshots and
// user events, and does what it decides.
//
// Rules, each a unit test:
// - EPISODES. Everything is keyed by `op.episode` (kind + REBASE_HEAD /
//   CHERRY_PICK_HEAD / …, derived by git-service): the rows come from
//   `ConflictOps.snapshot()`, which already resets its resolved-row memory per
//   episode, and this controller resets ITS memory — the user's close, the
//   pending count it compares against — on the same key. Merge Studio kept one
//   list for the whole session, so resolved rows from rebase step 1 piled up
//   under step 2 (matrix row 54).
// - CLOSE IS RESPECTED FOR THE EPISODE. Closing the dashboard while conflicts
//   remain keeps it closed until the episode changes (the next rebase step
//   stops) or every conflict is gone. Merge Studio re-opened it on the next
//   git event, so it could not stay closed (row 46). Asking for it (the
//   command, the status item) always shows it.
// - REVEAL ON A PENDING DROP. When a file stops being pending, an open
//   dashboard comes back to the front — JetBrains' flow: finish a file, return
//   to the list.
// - CLOSE WHEN THE OPERATION ENDS ELSEWHERE. Nothing in progress and nothing
//   unmerged, after there were conflicts, and no outcome of ours to show →
//   close. When OUR Continue / Abort ended it, the dashboard stays to show the
//   outcome ("Rebase complete.") until the user closes it.

import type {
  ConflictFileView,
  ConflictsSnapshot,
  ConflictsState,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { HOLD_TO_UNDO_MS } from "@gitstudio/host-bridge/conflictsProtocol";
import { StashEndTracker, type StashEnd } from "@gitstudio/engine/conflict/stashEnd";

export interface DashboardOptions {
  brand: ConflictsState["brand"];
  supportLinks?: ConflictsState["supportLinks"];
  holdToUndoMs?: number;
}

export interface UpdateContext {
  /** The panel exists right now. */
  open: boolean;
  /** Automatic showing is allowed (autoOpen on, not deferring to another product). */
  autoShow: boolean;
}

export interface Decision {
  /** Create / show the panel (automatic; never steals focus from an open one). */
  show: boolean;
  /** Bring the open panel to the front. */
  reveal: boolean;
  /** Dispose the open panel. */
  close: boolean;
  state: ConflictsState;
}

export class DashboardController {
  private snapshot: ConflictsSnapshot | undefined;
  /**
   * The actions the host had finished when `snapshot` was READ (its `done`):
   * a state never claims a press whose result its files may not show yet.
   */
  private snapshotDone: number | undefined;
  /** An operation verb (Continue / Skip / Abort) is in flight: the whole page waits. */
  private busy = false;
  /** Rows whose own action is waiting or running: only these show busy. */
  private readonly busyPaths = new Set<string>();
  private notice: ConflictsState["notice"];
  private outcome: ConflictsState["outcome"];
  private outcomeEpisode: string | undefined;
  /** The episode the user closed the dashboard in (auto-show stays off for it). */
  private closedEpisode: string | undefined;
  private lastEpisode: string | undefined;
  private lastPending: number | undefined;
  private hadConflicts = false;
  private readonly stashEnds = new StashEndTracker();
  /** A stash apply that just ended with every conflict resolved. */
  private stashEnd: StashEnd | undefined;
  private tip: ConflictsState["tip"];

  constructor(private readonly opts: DashboardOptions) {}

  /**
   * Fold in a fresh git snapshot and decide what the panel should do. `done`
   * is the host's count of finished actions as it stood when the read BEGAN
   * (ConflictsState.done): a read that overlapped an action does not claim it.
   */
  update(snapshot: ConflictsSnapshot, ctx: UpdateContext, done?: number): Decision {
    this.snapshotDone = done;
    // A stash apply's end reads as "nothing in progress" (git keeps no
    // operation for it): keep its page, finished, instead of closing.
    this.stashEnd = this.stashEnds.fold(snapshot);
    const episode = snapshot.op.episode;
    if (episode !== this.lastEpisode) {
      // A new stop (the next rebase commit, a new merge): the pending baseline
      // belonged to the old one. (The user's close is compared BY episode
      // below, so it lapses here on its own.)
      this.lastPending = undefined;
      this.lastEpisode = episode;
    }
    if (this.outcome && this.outcomeEpisode !== episode) {
      // An outcome describes the stop it produced ("Stopped at commit 2 of 3"
      // IS the new episode); once git has moved on from that, it is history.
      this.outcome = undefined;
    }
    this.snapshot = snapshot;
    const pending = pendingCount(snapshot.files);
    if (pending > 0) {
      this.hadConflicts = true;
    } else {
      // Nothing left to resolve: a later conflict set is a fresh start even if
      // git gives it the same episode key (kind "none" always reads "none").
      this.closedEpisode = undefined;
    }

    const ended = snapshot.op.kind === "none" && pending === 0;
    const close = ctx.open && ended && this.hadConflicts && !this.outcome && !this.stashEnd;
    const reveal =
      ctx.open && !close && this.lastPending !== undefined && pending < this.lastPending;
    const show =
      !ctx.open && ctx.autoShow && pending > 0 && this.closedEpisode !== episode;
    this.lastPending = pending;
    if (close || ended) {
      this.hadConflicts = pending > 0;
    }
    return { show, reveal, close, state: this.state() };
  }

  /** The user closed the panel: respect it for the rest of this episode. */
  userClosed(): void {
    if (this.snapshot && pendingCount(this.snapshot.files) > 0) {
      this.closedEpisode = this.snapshot.op.episode;
    }
    this.outcome = undefined;
    this.notice = undefined;
    this.lastPending = undefined;
    this.stashEnds.clear();
    this.stashEnd = undefined;
  }

  /** The one-time tip to show (POLISH A5.9), or none. */
  setTip(tip: ConflictsState["tip"]): ConflictsState {
    this.tip = tip;
    return this.state();
  }

  /** The user asked for the dashboard (command, status item): it shows whatever the close said. */
  requested(): void {
    this.closedEpisode = undefined;
  }

  /**
   * An operation verb is in flight: the whole page waits (`busy`). A verb
   * makes the previous outcome and notice stale.
   */
  setBusy(busy: boolean): ConflictsState {
    this.busy = busy;
    if (busy) {
      this.outcome = undefined;
      this.notice = undefined;
    }
    return this.state();
  }

  /**
   * One ROW's action is waiting or running: that row shows busy, and nothing
   * else on the page changes — not `busy`, not the outcome, not a notice
   * (removing a notice above the list would move every row).
   */
  setRowBusy(path: string, busy: boolean): ConflictsState {
    if (busy) this.busyPaths.add(path);
    else this.busyPaths.delete(path);
    return this.state();
  }

  /**
   * What the last Continue / Skip / Abort did. `episode` is the operation's
   * episode AFTER the verb (`OperationOutcome.view.episode`): the outcome stays
   * on screen while git is still at that stop, and clears when it moves on.
   */
  setOutcome(outcome: ConflictsState["outcome"], episode?: string): ConflictsState {
    this.outcome = outcome;
    this.outcomeEpisode = outcome ? (episode ?? this.lastEpisode) : undefined;
    return this.state();
  }

  setNotice(notice: ConflictsState["notice"]): ConflictsState {
    this.notice = notice;
    return this.state();
  }

  hasSnapshot(): boolean {
    return this.snapshot !== undefined;
  }

  /** The full state the dashboard renders. */
  state(): ConflictsState {
    const snap = this.snapshot;
    const ended = this.stashEnd;
    const files: ConflictFileView[] = (ended ? ended.files : (snap?.files ?? [])).map((f) =>
      this.busyPaths.has(f.path) ? { ...f, status: "busy" } : f,
    );
    const state: ConflictsState = {
      brand: this.opts.brand,
      repoName: snap?.repoName ?? "",
      op: snap?.op ?? NO_OP,
      files,
      total: ended ? files.length : (snap?.total ?? files.length),
      // Counted from the rows as sent: a row still at work is not "resolved"
      // in the progress bar before it is on its row.
      resolved: ended ? files.length : files.filter((f) => f.status === "resolved").length,
      busy: this.busy,
      holdToUndoMs: this.opts.holdToUndoMs ?? HOLD_TO_UNDO_MS,
    };
    if (this.snapshotDone !== undefined) {
      state.done = this.snapshotDone;
    }
    if (ended) {
      state.finished = ended.finished;
    }
    if (this.tip) {
      state.tip = this.tip;
    }
    if (this.notice) {
      state.notice = this.notice;
    }
    if (this.outcome) {
      state.outcome = this.outcome;
    }
    if (this.opts.supportLinks && this.opts.supportLinks.length > 0) {
      state.supportLinks = this.opts.supportLinks;
    }
    return state;
  }
}

/** Rows still needing a decision (busy rows count: their action has not landed). */
export function pendingCount(files: readonly ConflictFileView[]): number {
  return files.filter((f) => f.status !== "resolved").length;
}

/** The dashboard's title: "Conflicts (2)" while any remain. */
export function dashboardTitle(state: Pick<ConflictsState, "files">): string {
  const pending = pendingCount(state.files);
  return pending > 0 ? `Conflicts (${pending})` : "Conflicts";
}

const NO_OP: ConflictsState["op"] = {
  kind: "none",
  title: "",
  yours: { role: "yours", stage: 2, name: "", paneTitle: "", description: "" },
  theirs: { role: "theirs", stage: 3, name: "", paneTitle: "", description: "" },
  verbs: { abort: "Cancel" },
  canContinue: false,
  canSkip: false,
  episode: "none",
};
