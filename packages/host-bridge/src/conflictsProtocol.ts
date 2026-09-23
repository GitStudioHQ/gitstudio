// The merge-parity contract: ONE vocabulary for "which operation is stopped,
// which side is yours, and what can be done next", shared by the GitStudio
// extension, Merge Studio and the desktop app, and by the conflicts dashboard
// every one of them mounts.
//
// IMPORTANT: this module must stay free of any `vscode` / `node` / `monaco`
// import — the webviews (browser context) and the desktop renderer import it,
// and the engine/host-bridge purity guard (scripts/check-engine-purity.sh)
// covers it. Types plus a few frozen data constants only; no logic.
//
// FROZEN after the S0 contract seed (merge-parity/seed). A change goes through
// the orchestrator and is re-broadcast to every package building against it.
//
// Vocabulary (PLAN §3.1, decision D1/D2):
// - "Yours" / "Theirs" are ROLES, never git stages. During a rebase (and a
//   stash re-apply) Yours is git's stage 3 — your commit being replayed — and
//   it is still drawn on the LEFT. Everywhere else Yours is stage 2.
// - The ONLY code that decides which stage a role maps to is `describeSides`
//   (packages/engine/src/conflict/sides.ts). Everything else reads
//   `op.yours.stage` / `op.theirs.stage` and never reinterprets a side.

// ── Operation ────────────────────────────────────────────────────────────────

/**
 * What git is in the middle of. Detected locale-free from the files git
 * writes (MERGE_HEAD, rebase-merge/, rebase-apply/{rebasing,applying},
 * CHERRY_PICK_HEAD, REVERT_HEAD) — never from git's English output.
 *
 * - "rebase-merge-step": `rebase --rebase-merges` stopped while re-creating a
 *   merge (MERGE_HEAD AND rebase-merge/). Ended only by the REBASE verbs.
 * - "stash": unmerged files, no operation file, and the working text carries
 *   git's stash markers (`>>>>>>> Stashed changes`); also an autostash
 *   re-apply. Heuristic — falls back to "none" when the markers are gone.
 * - "none": nothing recognisable is in progress. May still have unmerged
 *   files ("Unmerged files on {current}"); then Cancel runs `reset --merge`.
 */
export type OperationKind =
  | "merge"
  | "rebase"
  | "rebase-merge-step"
  | "cherry-pick"
  | "revert"
  | "am"
  | "stash"
  | "none";

/** A side of a conflict, named from the USER's point of view. */
export type SideRole = "yours" | "theirs";

/**
 * One side of the conflict, fully described. Every string is display text,
 * plain words, sentence case (PLAN §3.1 table).
 */
export interface SideView {
  role: SideRole;
  /** The git index stage holding this side's content. The one swap lives here. */
  stage: 2 | 3;
  /**
   * Short name for pills and the direction bar: a branch ("test", "master"),
   * "stash", "undo of 1a2b3c4", "patch 2/5". Never a full ref (refs/heads/…).
   */
  name: string;
  /**
   * The merge editor's pane header, e.g. "Rebasing 1a2b3c4 from test" or
   * "Already rebased commits and commits from master". Hosts copy this into
   * MergeInitPayload.oursLabel / theirsLabel.
   */
  paneTitle: string;
  /** Tooltip naming the side in full ("Your commit 1a2b3c4 “test change” from test"). */
  description: string;
}

/**
 * Everything a UI needs to show and drive the stopped operation. Produced by
 * git-service `OperationProvider.view()`; consumed unchanged by the merge
 * shell (opChanged / MergeInitPayload.op), the conflicts dashboard, the
 * extension's Changes banner and the desktop (conflict:state, ConflictModel.op).
 */
export interface OperationView {
  kind: OperationKind;
  /** Rebase kinds only: "merge" = rebase-merge/, "apply" = rebase-apply/ (+ rebasing). */
  backend?: "merge" | "apply";
  /**
   * One-line header in plain words (§3.1 "Header" column), e.g.
   * "Rebasing test onto master · commit 1 of 1: 1a2b3c4 test change".
   * "" when kind is "none" and nothing is unmerged.
   */
  title: string;
  /**
   * The direction bar: `{from}` → verb → `{to}`, each rendered as
   * "<ROLE PILL> <side.name>". Rebase: yours → onto → theirs
   * ("YOURS test → onto → THEIRS master"). Merge: theirs → into → yours.
   * Absent for "none".
   */
  direction?: { from: SideRole; verb: "into" | "onto" | "on"; to: SideRole };
  /**
   * Progress through a sequence: "commit n of m" (rebase), "patch n of m"
   * (am), "step n of m" (rebase-merge-step). n includes the current one.
   */
  step?: { n: number; m: number; unit: "commit" | "patch" | "step" };
  /** Cherry-pick / revert ranges: how many more are queued after this one ("k more queued"). */
  queued?: number;
  /**
   * The commit (or patch) being replayed / picked / reverted / applied.
   * `sha` is the FULL object name (UIs shorten it to 7); "" for an am patch
   * that records no commit.
   */
  commit?: { sha: string; subject: string; author?: string };
  /** Always drawn on the LEFT. */
  yours: SideView;
  /** Always drawn on the RIGHT. */
  theirs: SideView;
  /**
   * Button labels. `continue` / `skip` are present when the kind HAS that verb
   * at all ("Continue Rebase", "Skip this commit", "Skip patch"); whether it is
   * allowed right now is `canContinue` / `canSkip`. `abort` is always present
   * ("Abort Rebase", "Abort (git am)", "Cancel" for stash / none).
   */
  verbs: { continue?: string; skip?: string; abort: string };
  /** Whether Continue can succeed right now (all gates in PLAN §3.3 passed). */
  canContinue: boolean;
  /** Whether Skip is offered — only where git itself names it as the way out. */
  canSkip: boolean;
  /**
   * Why Continue is disabled, in plain words, naming the file where there is
   * one ("app.ts still has conflict markers staged"). Absent when canContinue.
   */
  continueBlocked?: string;
  /**
   * A merge-backend rebase whose resolution left the commit EMPTY: git will
   * silently drop it on Continue. Continue then needs `confirmDrop: true`.
   */
  willDrop?: { sha: string; subject: string; branch: string };
  /**
   * A deliberate stop with nothing to resolve (edit / break / failed exec).
   * The dashboard shows "Paused to edit {sha7} {subject}" (= `detail`) and
   * offers Continue and Abort only.
   */
  pause?: { reason: "edit" | "break" | "exec-failed"; detail: string };
  /**
   * Opaque identity of the CURRENT stop. It changes whenever git moves to a new
   * commit / patch / step, or a different operation starts (P2 derives it from
   * kind + REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / MERGE_HEAD / am
   * `next`). The dashboard's file list, the "close respected" memory and the
   * resolved-row memory are all keyed by it, so they reset on every rebase
   * step. "none" when nothing is in progress. Never parse it.
   */
  episode: string;
}

/**
 * What a Continue / Skip / Abort did. Returned by git-service
 * OperationProvider.continue/skip/abort and by the desktop's op:* channels.
 */
export interface OperationOutcome {
  /**
   * The verb ran and the step is over: the operation finished (Continue /
   * Abort) or moved on WITHOUT stopping again.
   */
  ok: boolean;
  /**
   * git stopped again — the next commit conflicts, or an edit/break pause.
   * Not a failure: `ok` is false, `expected` is true, and every UI refreshes
   * from `view` (new REBASE_HEAD, new stages, possibly the same path).
   */
  stopped?: boolean;
  /**
   * The provider refused BEFORE running git:
   * - "blocked": `view.continueBlocked` explains why;
   * - "confirm-drop": `view.willDrop` is set and `confirmDrop` was not passed;
   * - "not-allowed": the verb does not apply (Skip where canSkip is false,
   *   anything with nothing in progress).
   */
  refused?: "blocked" | "confirm-drop" | "not-allowed";
  /**
   * Plain words for the outcome line: "Rebase complete", "Stopped at commit 2
   * of 3", or git's own first line of explanation when it failed. Also carries
   * warnings git exits 0 with (`am --abort`'s "Not rewinding to ORIG_HEAD").
   */
  message?: string;
  /**
   * `ok: false` is a state the user is allowed to be in (stopped, refused) —
   * hosts must NOT file it as an error report.
   */
  expected?: boolean;
  /** The operation re-read AFTER the verb. */
  view: OperationView;
  /** Unmerged paths after the verb. */
  remainingConflicts: number;
}

// ── Conflicted files ─────────────────────────────────────────────────────────

/**
 * What kind of conflict a file is, from `ls-files -u` (which stages exist —
 * the only way to tell a MISSING side from an EMPTIED one), `diff --numstat`
 * (binary) and the hosts' read cap (too-large).
 *
 * - "text" / "added-both": a line-by-line merge is possible (added-both has no base).
 * - "binary" / "too-large": take a side only.
 * - "modify-delete": one side edited, the other deleted (`missingRole` = the deleter).
 * - "added-one-side": new on one side, absent on the other, no base (`missingRole` = absent side).
 * - "both-deleted": git's DD; nothing to take — the only resolution is deleting it.
 */
export type ConflictShape =
  | "text"
  | "binary"
  | "too-large"
  | "modify-delete"
  | "both-deleted"
  | "added-one-side"
  | "added-both";

/** One row of the conflicts dashboard. */
export interface ConflictFileView {
  /** Repo-root-relative, forward slashes, exactly as `ls-files -z` reports it. */
  path: string;
  /** "busy" while an action on this row is in flight (the row's buttons are disabled). */
  status: "pending" | "busy" | "resolved";
  /** How a RESOLVED row was resolved in this app during this episode, when known. */
  choice?: SideRole | "merged";
  /**
   * The XY badge stated in ROLE terms ("deleted in theirs (master)", "added in
   * yours (test)"). Absent / "" for the ordinary both-modified case.
   */
  badge?: string;
  shape: ConflictShape;
  /** modify-delete / added-one-side: the role with NO version of the file. */
  missingRole?: SideRole;
}

/**
 * The part of the dashboard state that comes from git (+ the per-episode memory
 * of rows already resolved). The desktop's `conflict:state` channel returns
 * exactly this; hosts add the UI fields to make a ConflictsState.
 */
export type ConflictsSnapshot = Pick<
  ConflictsState,
  "repoName" | "op" | "files" | "total" | "resolved"
>;

/** Everything the conflicts dashboard renders. Host → webview in `{type:"state"}`. */
export interface ConflictsState {
  brand: { name: string; mark: "gitstudio" | "merge-studio" };
  /** Display name of the repository (the root folder's name). */
  repoName: string;
  op: OperationView;
  /**
   * Rows for this EPISODE: every file unmerged now, plus files resolved since
   * the episode began (status "resolved"), in a stable order. Reset when
   * `op.episode` changes.
   */
  files: ConflictFileView[];
  /** files.length. */
  total: number;
  /** Rows with status "resolved". */
  resolved: number;
  /** A host action is in flight; every mutating control is disabled. */
  busy: boolean;
  /** Hold-to-undo duration (HOLD_TO_UNDO_MS). */
  holdToUndoMs: number;
  /** A transient note ("No JetBrains IDE found — using the embedded editor"). */
  notice?: { kind: "info" | "warn" | "error"; text: string };
  /** The last Continue / Skip / Abort result ("Rebase complete", git's reason on failure). */
  outcome?: { kind: "done" | "stopped" | "failed"; text: string };
  /**
   * Brand slot: Merge Studio's "Report a problem" / "Rate" / "Sponsor" links;
   * absent in GitStudio. The FIRST link is the only one shown mid-operation
   * (make it the problem report); the rest appear once the work is done.
   */
  supportLinks?: { label: string; url: string }[];
}

/**
 * Dashboard → host. Destructive actions (`abort`, `skip`, `delete`) are only
 * posted AFTER the dashboard's own inline confirm; hosts must not ask again
 * with a modal (apps/extension/test/noVsCodePrompts.test.ts).
 *
 * - accept: resolve the whole file as that role (`ConflictOps.takeRole`). For a
 *   role with no version of the file this DELETES it — the UI labels that
 *   button "Delete the file".
 * - merge: open the file in the merge editor (or the JetBrains IDE when the
 *   resolver setting says so). Not offered for binary / too-large / DD rows.
 * - restore: hold-to-undo — re-create the conflict (`git checkout -m`).
 * - delete: the one resolution of a both-deleted (DD) row (`ConflictOps.deleteFile`).
 * - continue: `confirmDrop: true` only after the user confirmed `op.willDrop`.
 */
export type ConflictsAction =
  | { type: "ready" }
  | { type: "accept"; path: string; role: SideRole }
  | { type: "merge"; path: string }
  | { type: "restore"; path: string }
  | { type: "delete"; path: string }
  | { type: "continue"; confirmDrop?: boolean }
  | { type: "skip" }
  | { type: "abort" }
  | { type: "close" }
  | { type: "openExternal"; url: string };

/** Host → dashboard. */
export type ConflictsHostMessage = { type: "state"; state: ConflictsState };

/** How long a resolved row's undo must be held (ms). Keyboard hold uses the same. */
export const HOLD_TO_UNDO_MS = 750;

// ── JetBrains hand-off and merge settings (all three products) ───────────────

/** The JetBrains IDEs the locator knows, in its default search order. */
export type JetBrainsIdeId =
  | "webstorm"
  | "pycharm"
  | "intellij"
  | "phpstorm"
  | "goland"
  | "clion"
  | "rider"
  | "rubymine"
  | "datagrip";

/** Display names for settings UIs (the preferred-IDE picker), in search order. */
export const JETBRAINS_IDES: ReadonlyArray<{ id: JetBrainsIdeId; name: string }> = [
  { id: "webstorm", name: "WebStorm" },
  { id: "pycharm", name: "PyCharm" },
  { id: "intellij", name: "IntelliJ IDEA" },
  { id: "phpstorm", name: "PhpStorm" },
  { id: "goland", name: "GoLand" },
  { id: "clion", name: "CLion" },
  { id: "rider", name: "Rider" },
  { id: "rubymine", name: "RubyMine" },
  { id: "datagrip", name: "DataGrip" },
];

/** An installed JetBrains IDE the hosts can hand a merge or diff to. */
export interface JetBrainsIdeInfo {
  /** "custom" when it came from the explicit `jetbrainsPath` setting. */
  id: JetBrainsIdeId | "custom";
  /** Display name for buttons: "Open in WebStorm". */
  name: string;
  /** Absolute launcher / binary path that gets spawned. */
  command: string;
}

/**
 * The merge settings every product exposes (GitStudio: `gitstudio.merge.*`;
 * Merge Studio: `jbMerge.*`; desktop: Settings ▸ Merge via merge:settings).
 * Merge Studio's legacy `jbMerge.conflictResolver: "webview"` value is read as
 * "embedded" by its product adapter.
 */
export interface MergeSettings {
  /**
   * Apply every non-conflicting change as the merge view's starting point when
   * it opens. DEFAULT OFF in all three products (orchestrator override of D3,
   * matching JetBrains' own default).
   */
  autoApplyNonConflicting: boolean;
  /** Who resolves a conflict opened from a list: the embedded editor or the IDE. */
  conflictResolver: "embedded" | "jetbrains";
  /** Who shows a file diff routed through the merge experience. */
  diffTool: "embedded" | "jetbrains";
  /** Which installed IDE to use; "auto" = the first found in JETBRAINS_IDES order. */
  preferredIde: JetBrainsIdeId | "auto";
  /** Explicit launcher path; overrides detection. Restricted in untrusted workspaces. */
  jetbrainsPath: string;
}

export const DEFAULT_MERGE_SETTINGS: Readonly<MergeSettings> = {
  autoApplyNonConflicting: false,
  conflictResolver: "embedded",
  diffTool: "embedded",
  preferredIde: "auto",
  jetbrainsPath: "",
};
