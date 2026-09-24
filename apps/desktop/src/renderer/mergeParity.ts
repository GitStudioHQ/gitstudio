// The desktop's half of the shared merge experience: how the merge shell and
// the conflicts dashboard (packages/webview-ui) talk to the main process.
//
// Both components speak a host-agnostic vocabulary — WebviewMessage for the
// shell, ConflictsAction for the dashboard. The extension answers them over
// postMessage; here each one is mapped onto the IPC channels P2 implements
// (conflict:*, op:*, jetbrains:*, merge:settings), and the answers are turned
// back into the HostMessages / ConflictsState the components expect.
//
// Deliberately free of DOM and of `window.gitstudio`: every effect is an
// injected dependency, so the whole mapping is unit-tested in node
// (test/mergeShellMount.test.ts) against a fake `invoke`.

import type { HostMessage, MergeInitPayload, WebviewMessage } from "@gitstudio/host-bridge/protocol";
import {
  DEFAULT_MERGE_SETTINGS,
  HOLD_TO_UNDO_MS,
  type ConflictShape,
  type ConflictsAction,
  type ConflictsSnapshot,
  type ConflictsState,
  type JetBrainsIdeInfo,
  type MergeSettings,
  type OperationOutcome,
  type OperationView,
  type SideRole,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { roleOfStage, skipEndedText } from "@gitstudio/engine/conflict/sides";
import { resolvedOutsideMerge } from "@gitstudio/engine/conflict/documentText";
import { StashEndTracker, type StashEnd } from "@gitstudio/engine/conflict/stashEnd";
import { conflictTypeFor } from "@gitstudio/engine/conflict/conflictType";
import {
  continueBlockedText,
  opChipLabel,
  opNoun,
  stepText,
  willDropText,
} from "@gitstudio/webview-ui/conflicts/opText";
import type { ConflictModel, GitOpState, GitStudioBridge } from "../shared/ipc";

export type Invoke = GitStudioBridge["invoke"];
export type Notify = (
  message: string,
  kind: "info" | "success" | "error",
  action?: { label: string; onClick: () => void },
) => void;
export type Undoable = (
  message: string,
  action: {
    label: string;
    undo: () => Promise<string | { info: string } | void>;
    after?: () => void | Promise<void>;
  },
) => void;

/**
 * What an undo of a resolution reports. conflict:restore refuses as EXPECTED
 * once the operation the file was resolved in has finished (git keeps the
 * resolve-undo record past the commit, and `checkout -m` would put markers
 * back into finished work) — that is news for the user, not an error.
 */
function restoreResult(
  r: { ok: boolean; message?: string; expected?: boolean },
  path: string,
): string | { info: string } | void {
  if (r.ok) return undefined;
  const message = r.message || `Couldn't bring the conflict in ${path} back.`;
  return r.expected ? { info: message } : message;
}

// ── the model → payload mapping ──────────────────────────────────────────────

/**
 * What kind of conflict this is. The main process says so (`shape`) once P2's
 * ConflictOps lands; until then, and for any older answer, it is read off the
 * legacy flags the desktop has always sent.
 */
export function conflictShape(model: ConflictModel): ConflictShape {
  if (model.shape) return model.shape;
  if (model.binary) return "binary";
  if (model.truncated) return "too-large";
  if (model.bothDeleted) return "both-deleted";
  if (model.missingSide) return model.hasBase ? "modify-delete" : "added-one-side";
  return model.hasBase ? "text" : "added-both";
}

/**
 * Which conflict this is, leaving out the file's own text: the file, the stop
 * it belongs to, and the three sides git holds for it (and their titles). A
 * Continue that stopped on the next commit is a different stop, and the merge
 * editor is rebuilt for it; a write to the file from outside (another editor,
 * a formatter, a terminal) is the SAME stop, and the editor — with the work
 * in it — stays (DiffPanel.showConflict).
 */
export function conflictStop(m: ConflictModel): string {
  return JSON.stringify([
    m.path,
    m.op?.episode ?? "",
    m.shape ?? "",
    m.missingRole ?? "",
    m.oursLabel,
    m.theirsLabel,
    m.base,
    m.ours,
    m.theirs,
  ]);
}

/**
 * Exactly "the same conflict": its stop and the file's text. The same
 * signature again is a repaint with nothing new in it; the same stop with
 * other text is the file changed on disk.
 */
export function conflictSignature(m: ConflictModel): string {
  return JSON.stringify([conflictStop(m), m.result]);
}

/**
 * The ROLE with no version of the file. `missingSide` is in STAGE terms
 * ("ours" = stage 2), and which role stage 2 is depends on the operation —
 * during a rebase it is Theirs. Mapped through the one stage→role helper.
 */
export function missingRoleOf(model: ConflictModel): SideRole | undefined {
  if (model.missingRole) return model.missingRole;
  if (!model.missingSide) return undefined;
  const stage: 2 | 3 = model.missingSide === "ours" ? 2 : 3;
  if (model.op) return roleOfStage(model.op, stage);
  return stage === 2 ? "yours" : "theirs";
}

/**
 * The shell's init payload for a conflicted file. The texts arrive already
 * mapped (op.yours on the left). `commits`: a submodule's two commits, from
 * the conflicts snapshot (the model does not carry them) — the panel names
 * them.
 */
export function mergePayload(
  model: ConflictModel,
  settings: MergeSettings,
  ide?: JetBrainsIdeInfo,
  commits?: { yours?: string; theirs?: string },
): MergeInitPayload {
  const shape = conflictShape(model);
  const missingRole = missingRoleOf(model);
  return {
    fileName: model.path,
    // The extensions' own mapping (engine conflictTypeFor): a modify/delete,
    // a one-sided add and a double delete were all "content" here.
    conflictType: conflictTypeFor({ shape, missingRole, hasBase: model.hasBase, source: "git-stages" }),
    source: "git-stages",
    hasBase: model.hasBase,
    oursLabel: model.oursLabel,
    theirsLabel: model.theirsLabel,
    base: model.base,
    ours: model.ours,
    theirs: model.theirs,
    result: model.result,
    jetbrainsName: ide?.name,
    op: model.op,
    // D3 as overridden: the desktop used to auto-apply unconditionally; it is
    // now the Settings ▸ Merge setting, OFF unless turned on.
    autoApplyNonConflicting: settings.autoApplyNonConflicting,
    shape,
    missingRole,
    ...(shape === "submodule" && commits ? { commits } : {}),
  };
}

/**
 * A submodule's two commits, read from the conflicts snapshot (its row
 * carries them); undefined for every other shape, or when it cannot be read.
 */
export async function submoduleCommits(
  invoke: Invoke,
  model: ConflictModel,
): Promise<{ yours?: string; theirs?: string } | undefined> {
  if (conflictShape(model) !== "submodule") return undefined;
  try {
    const s = await invoke("conflict:state", undefined);
    return s?.files.find((f) => f.path === model.path)?.commits;
  } catch {
    return undefined;
  }
}

// ── settings & IDE, cached for the session ───────────────────────────────────

let settingsCache: Promise<MergeSettings> | undefined;
let ideCache: Promise<JetBrainsIdeInfo | undefined> | undefined;

/** The merge settings. A main process that cannot answer yet means the defaults. */
export function loadMergeSettings(invoke: Invoke): Promise<MergeSettings> {
  settingsCache ??= invoke("merge:settings", undefined)
    .then((s) => ({ ...DEFAULT_MERGE_SETTINGS, ...(s ?? {}) }))
    .catch(() => ({ ...DEFAULT_MERGE_SETTINGS }));
  return settingsCache;
}

/** The JetBrains IDE the settings resolve to, or undefined when none is installed. */
export function detectJetBrains(invoke: Invoke): Promise<JetBrainsIdeInfo | undefined> {
  ideCache ??= invoke("jetbrains:detect", undefined)
    .then((i) => i ?? undefined)
    .catch(() => undefined);
  return ideCache;
}

/** Save settings; the answer is what the main process actually stored. */
export async function saveMergeSettings(invoke: Invoke, patch: Partial<MergeSettings>): Promise<MergeSettings> {
  const next = await invoke("merge:setSettings", patch);
  const merged = { ...DEFAULT_MERGE_SETTINGS, ...(next ?? {}) };
  settingsCache = Promise.resolve(merged);
  // Which IDE is used can change with the preferred IDE or the path.
  if ("preferredIde" in patch || "jetbrainsPath" in patch) ideCache = undefined;
  return merged;
}

/** Forget the cached settings and IDE (a repository switch, a Look again). */
export function forgetMergeSettings(): void {
  settingsCache = undefined;
  ideCache = undefined;
}

// ── outcomes ─────────────────────────────────────────────────────────────────

/**
 * One line for what a Continue / Skip / Abort did: ok → done, stopped → stopped
 * (not a failure — git moved on and needs you again), anything else → failed
 * with the reason. `before` is the operation as it was when the verb was
 * pressed; the view after a finished operation is "none" and names nothing.
 */
export function outcomeLine(
  o: OperationOutcome,
  before: OperationView,
  verb: "continue" | "skip" | "abort",
): { kind: "done" | "stopped" | "failed"; text: string } {
  const noun = opNoun(before.kind);
  const cap = noun.charAt(0).toUpperCase() + noun.slice(1);
  if (o.ok) {
    return {
      kind: "done",
      text:
        o.message ||
        (verb === "abort"
          ? `${cap} ended. The repository is back where it was before it started.`
          : verb === "skip"
            ? // Which one it left out, and whether git applied the rest after it.
              `${skipEndedText(before)}.`
            : `${cap} complete.`),
    };
  }
  if (o.stopped) {
    const step = stepText(o.view);
    return {
      kind: "stopped",
      text:
        o.message ||
        (o.view.pause
          ? o.view.pause.detail
          : step
            ? `Stopped at ${step}: there is more to resolve.`
            : "Stopped again: there is more to resolve."),
    };
  }
  if (o.refused === "blocked") {
    return { kind: "failed", text: continueBlockedText(o.view, o.remainingConflicts) || o.message || "Not yet." };
  }
  if (o.refused === "confirm-drop") {
    return { kind: "failed", text: willDropText(o.view) || o.message || "Confirm dropping the empty commit first." };
  }
  return { kind: "failed", text: o.message || `The ${noun} did not ${verb}.` };
}

/** Unmerged paths in a snapshot (rows not yet resolved). */
export function pendingOf(s: ConflictsSnapshot): number {
  return s.files.filter((f) => f.status !== "resolved").length;
}

// ── one verb at a time ───────────────────────────────────────────────────────

/**
 * Continue / Skip / Abort and every whole-file resolution go through here. The
 * main process `serialize()`s its queue, so a second press does not fail — it
 * RUNS, after the first: two Continues could walk past the next conflicting
 * commit, two Skips drop two commits. One lock for the whole renderer, shared by
 * the dashboard and the merge editor, because both offer the same verbs.
 */
let verbInFlight = false;
export async function exclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (verbInFlight) return undefined;
  verbInFlight = true;
  try {
    return await fn();
  } finally {
    verbInFlight = false;
  }
}
/** For the harness and tests: is a verb running right now? */
export function verbRunning(): boolean {
  return verbInFlight;
}

// ── the merge shell's adapter ────────────────────────────────────────────────

export interface MergeAdapterDeps {
  invoke: Invoke;
  /** Hand a host message to the shell. */
  deliver(message: HostMessage): void;
  /** This file was resolved (or brought back): repaint Changes, back to the dashboard. */
  onResolved(): void;
  /** Exit viewer: leave the conflict in the file and show the dashboard. */
  onExit(): void;
  /** The operation moved (Continue / Abort): refresh refs, the branch, everything. */
  onOperationChanged(outcome: { kind: "done" | "stopped" | "failed"; text: string }): void;
  /**
   * The file went to the IDE (Open in <IDE>): the host puts the editor away
   * and shows the hand-off — "Resolving in <IDE>", with Mark resolved — the
   * way the Settings route does. False when it has nowhere to, and the
   * adapter says it in a toast instead.
   */
  onHandedToIde?(): boolean;
  undoable: Undoable;
  notify: Notify;
  /**
   * Ask before an Apply writes over something the merge editor did not make
   * (a resolution already in the file, an edit made since it opened). A host
   * without one writes, as before.
   */
  confirm?(spec: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
}

/** The file name as a sentence names it. */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Maps the shell's WebviewMessages onto IPC for one conflicted file.
 *
 * - apply → conflict:resolve, then `applied` (staged only when git said so),
 *   an undo that brings the conflict back (conflict:restore), and `opChanged`;
 * - takeRole → conflict:takeRole (conflict:takeSide for a model with no op,
 *   where no role mapping is known and stage 2 is "yours"); deleteFile →
 *   conflict:delete;
 * - continueOperation → op:continue; cancel{abort} (older pages) → op:abort —
 *   each an `outcome` then `opChanged`; cancel{exit} (Close) and
 *   showConflicts → back to the dashboard, writing nothing;
 * - openInJetBrains → jetbrains:merge, with "Mark resolved" on the notice.
 */
export class DesktopMergeAdapter {
  constructor(
    private readonly model: ConflictModel,
    private readonly deps: MergeAdapterDeps,
  ) {}

  post(message: WebviewMessage): void {
    void this.handle(message);
  }

  async handle(message: WebviewMessage): Promise<void> {
    const { invoke, deliver } = this.deps;
    const path = this.model.path;
    try {
      switch (message.type) {
        case "apply": {
          const refusal = await this.overwriteRefusal(message.text);
          if (refusal) {
            deliver({ type: "outcome", kind: "failed", text: refusal });
            return;
          }
          const r = await exclusive(() => invoke("conflict:resolve", { path, content: message.text }));
          if (!r) return;
          if (!r.ok) {
            // `applied` means the result was WRITTEN (protocol.ts). A refusal
            // (expected: no longer conflicted, not UTF-8 text, deleted on both
            // sides) writes nothing — say it failed, and leave Apply live.
            if (r.expected) {
              deliver({ type: "outcome", kind: "failed", text: r.message || `Nothing was written to ${path}.` });
              return;
            }
            deliver({ type: "applied", staged: false, message: r.message || `Couldn't save the merge of ${path}.` });
            return;
          }
          deliver({ type: "applied", staged: true });
          this.offerUndo(`Resolved ${path}.`);
          await this.refreshOp();
          this.deps.onResolved();
          return;
        }
        case "takeRole":
        case "deleteFile": {
          // By ROLE when the operation is known. A model with no operation has
          // no role mapping, and stage 2 is the side drawn on the left — the
          // legacy stage-based channel says exactly that.
          const r = await exclusive(() =>
            message.type === "deleteFile"
              ? invoke("conflict:delete", { path })
              : this.model.op
                ? invoke("conflict:takeRole", { path, role: message.role })
                : invoke("conflict:takeSide", { path, side: message.role === "yours" ? "ours" : "theirs" }),
          );
          if (!r) return;
          if (!r.ok) {
            deliver({ type: "applied", staged: false, message: r.message || `Couldn't resolve ${path}.` });
            return;
          }
          deliver({ type: "applied", staged: true });
          this.offerUndo(message.type === "deleteFile" ? `Deleted ${path}.` : `Resolved ${path}.`);
          await this.refreshOp();
          this.deps.onResolved();
          return;
        }
        case "showConflicts":
          // The conflicts list is what the desktop shows once the editor
          // steps aside: leave the file as it is, and show it.
          this.deps.onExit();
          return;
        case "continueOperation":
        case "cancel": {
          // Close: ONLY leave the merge view. Nothing is written (the desktop
          // writes on Apply alone), the operation stays paused and the file
          // keeps its markers.
          if (message.type === "cancel" && message.mode !== "abort") {
            this.deps.onExit();
            return;
          }
          const before = this.model.op;
          if (!before) {
            // No operation known: there is nothing to continue or abort.
            if (message.type === "cancel") this.deps.onExit();
            return;
          }
          const verb = message.type === "cancel" ? "abort" : "continue";
          const o = await exclusive(() =>
            message.type === "cancel"
              ? invoke("op:abort", undefined)
              : invoke("op:continue", message.confirmDrop ? { confirmDrop: true } : {}),
          );
          if (!o) return;
          const line = outcomeLine(o, before, verb);
          deliver({ type: "outcome", kind: line.kind, text: line.text });
          deliver({ type: "opChanged", op: o.view, remainingConflicts: o.remainingConflicts });
          this.deps.onOperationChanged(line);
          return;
        }
        case "openInJetBrains": {
          const r = await invoke("jetbrains:merge", { path });
          if (!r.ok) {
            this.deps.notify(r.message || "Couldn't open the IDE.", "error");
            return;
          }
          // The button says it closes this editor: the host shows the hand-off
          // in its place. A toast is only for a host with nowhere to put it —
          // it goes in seconds, and "Mark resolved" with it.
          if (this.deps.onHandedToIde?.()) return;
          this.deps.notify(`Resolve ${path} in the IDE's merge window, then mark it resolved here.`, "info", {
            label: "Mark resolved",
            onClick: () => void this.markResolvedInIde(),
          });
          return;
        }
        default:
          // ready / resultChanged / diff messages: nothing to do on the desktop,
          // which writes the result only on Apply.
          return;
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (message.type === "apply" || message.type === "takeRole" || message.type === "deleteFile") {
        deliver({ type: "applied", staged: false, message: text });
      } else if (message.type === "continueOperation" || message.type === "cancel") {
        deliver({ type: "outcome", kind: "failed", text });
      } else {
        this.deps.notify(text, "error");
      }
    }
  }

  /**
   * Apply writes the Result over the file. Two things there are not the
   * merge editor's to throw away without asking (POLISH A1.2, A1.3):
   *
   * - a resolution the file already had when the editor opened — no markers
   *   left, by hand or by git rerere — which the Result, starting over from
   *   the conflict, does not show;
   * - an edit made to the file since it opened (another editor, a checkout in
   *   a terminal): the watcher's refresh usually reloads the editor first,
   *   but an Apply inside that window wrote the stale Result over it.
   *
   * The Result starts FROM a resolution already in the file (the view seeds
   * it), so an Apply that writes it back unchanged replaces nothing and asks
   * nothing.
   *
   * The reason nothing was written, or undefined to go ahead.
   */
  private async overwriteRefusal(text: string): Promise<string | undefined> {
    const ask = this.deps.confirm;
    if (!ask) return undefined;
    const model = this.model;
    const name = fileName(model.path);
    const same = (a: string, b: string): boolean => a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
    if (resolvedOutsideMerge(model.result, model.base) && !same(text, model.result)) {
      const go = await ask({
        title: `Replace the resolution already in ${name}?`,
        message:
          `${name} had no conflict markers left when the merge editor opened: it was already resolved, by hand or ` +
          `by git rerere. Apply replaces that with the Result shown here, and stages it.`,
        confirmLabel: "Replace and stage",
        danger: true,
      });
      if (!go) return `Nothing was written. ${name} keeps the resolution it had.`;
    }
    const now = await this.deps.invoke("conflict:model", model.path).catch(() => undefined);
    if (now && now.result !== model.result) {
      const go = await ask({
        title: `${name} changed outside the merge editor`,
        message:
          `It was edited in another editor or on disk since the merge editor opened it. Apply replaces that edit ` +
          `with the Result shown here, and stages it.`,
        confirmLabel: "Replace and stage",
        danger: true,
      });
      if (!go) return `Nothing was written. ${name} keeps the edit made outside the merge editor.`;
    }
    return undefined;
  }

  private async markResolvedInIde(): Promise<void> {
    const r = await this.deps.invoke("jetbrains:markResolved", { path: this.model.path });
    if (!r.ok) {
      this.deps.notify(r.message || "Couldn't stage the file.", "error");
      return;
    }
    this.deps.notify(`Resolved ${this.model.path}.`, "success");
    this.deps.onResolved();
  }

  /** Every resolution is one ⌘Z away: `checkout -m` brings the conflict back. */
  private offerUndo(message: string): void {
    const path = this.model.path;
    this.deps.undoable(message, {
      label: `Bring back the conflict in ${path}`,
      undo: async () => restoreResult(await this.deps.invoke("conflict:restore", { path }), path),
      after: () => this.deps.onResolved(),
    });
  }

  private async refreshOp(): Promise<void> {
    if (!this.model.op) return;
    try {
      const s = await this.deps.invoke("conflict:state", undefined);
      if (s) this.deps.deliver({ type: "opChanged", op: s.op, remainingConflicts: pendingOf(s) });
    } catch {
      /* the shell keeps what it had */
    }
  }
}

// ── the conflicts dashboard's controller ─────────────────────────────────────

export interface ConflictsControllerDeps {
  invoke: Invoke;
  /** Open a file in the merge editor (select its row in Changes). */
  openMerge(path: string): void;
  /** A file was resolved or restored: repaint the Changes list. */
  onFileChanged(): void;
  /** The operation moved: refresh refs, branch and the list, and say what happened. */
  onOperationChanged(outcome: { kind: "done" | "stopped" | "failed"; text: string }): void;
  notify: Notify;
  undoable: Undoable;
  /**
   * Register an undo (⌘Z, Edit ▸ Undo) WITHOUT a toast. A dashboard row's
   * Accept already says what happened in the row (its pill, Hold to undo); a
   * toast per row stacked "Resolved …  Undo" over the right third of the
   * window — exactly where the next rows' Accept buttons are. Absent: the
   * toast is shown (`undoable`).
   */
  pushUndo?: (action: Parameters<Undoable>[1]) => void;
}

/**
 * Holds the dashboard's host-side state for the app's lifetime and maps its
 * actions onto IPC. The Changes view is rebuilt on every repaint; the
 * controller is not, so the outcome of a Continue, the busy lock and the
 * in-flight verb survive the rebuild. Each rebuild calls `attach` with the new
 * dashboard's render.
 */
export class DesktopConflicts {
  private renderTarget?: (state: ConflictsState) => void;
  private snapshot?: ConflictsSnapshot;
  /** An operation verb (Continue / Skip / Abort) is in flight: the whole dashboard waits. */
  private busy = false;
  /**
   * Rows whose own action is waiting or running. Only these show busy: a
   * press on one row used to lock the whole dashboard (`busy`), and every
   * button on it went locked and back — the owner's "flashes and refreshes
   * all other rows".
   */
  private readonly rowBusy = new Set<string>();
  /** An operation verb is waiting its turn or running: a second one is not run. */
  private verbPending = false;
  /** A row's action holds the shared lock (`exclusive`) right now: that lock is not the page's. */
  private rowRunning = false;
  /** Rows whose press is waiting, running or being read back: a second press on one runs nothing. */
  private readonly rowActive = new Set<string>();
  /** The dashboard's actions, one at a time in the order pressed (a second row's press waits; it is not dropped). */
  private queue: Promise<void> = Promise.resolve();
  /** The highest action seq finished (ConflictsState.done). */
  private done = 0;
  /** `done` as it stood when the snapshot on screen was READ: a read that overlapped an action does not claim it. */
  private snapshotDone = 0;
  /** Reads are numbered; one that comes back after a later one has been shown is stale and dropped. */
  private reads = 0;
  private shownRead = 0;
  private outcome?: ConflictsState["outcome"];
  private outcomeEpisode?: string;
  private notice?: ConflictsState["notice"];
  /**
   * The last state READ failed. Kept apart from `notice` (an action's own
   * error): the next read that works clears this one, and must not wipe the
   * reason a Continue or an Accept just gave.
   */
  private readError?: string;
  private readonly stashEnds = new StashEndTracker();
  private stashEnd?: StashEnd;
  private readonly deps: ConflictsControllerDeps;

  constructor(deps: ConflictsControllerDeps) {
    this.deps = deps;
  }

  /** Point the controller at a (new) dashboard. Returns its action handler. */
  attach(render: (state: ConflictsState) => void): (action: ConflictsAction) => void {
    this.renderTarget = render;
    return (action) => void this.handle(action);
  }

  detach(render: (state: ConflictsState) => void): void {
    if (this.renderTarget === render) this.renderTarget = undefined;
  }

  /** The last state painted (the Changes strip and the rail read it). */
  current(): ConflictsSnapshot | undefined {
    return this.snapshot;
  }

  /** Carry an outcome from elsewhere (the merge editor's Continue) onto the dashboard. */
  setOutcome(outcome: ConflictsState["outcome"]): void {
    this.outcome = outcome;
    this.outcomeEpisode = undefined;
    this.paint();
  }

  /**
   * A stash apply just ended with every conflict resolved: git reports nothing
   * in progress, and the Changes view keeps the dashboard up to say so
   * (engine stashEnd.ts — the extensions' controller folds the same way).
   */
  hasFinished(): boolean {
    return !!this.stashEnd;
  }

  /** A conflicted stash apply was being shown: "nothing in progress" may be its end. */
  watchingStash(): boolean {
    return this.stashEnds.watching;
  }

  /** The user moved on (opened a file): the finished card is not brought back. */
  clearFinished(): void {
    this.stashEnds.clear();
    this.stashEnd = undefined;
  }

  async refresh(): Promise<ConflictsSnapshot | undefined> {
    const read = ++this.reads;
    const doneAtRead = this.done;
    try {
      const s = await this.deps.invoke("conflict:state", undefined);
      if (!s) throw new Error("The conflict state came back empty.");
      if (read < this.shownRead) return this.snapshot; // a later read is already on screen
      this.shownRead = read;
      this.snapshot = s;
      this.snapshotDone = doneAtRead;
      this.stashEnd = this.stashEnds.fold(s);
      this.readError = undefined;
      // An outcome describes the stop it happened at, plus the one it led
      // to. Two stops later it is history.
      if (this.outcome && this.outcomeEpisode && this.outcomeEpisode !== s.op.episode) {
        this.outcome = undefined;
      }
      this.outcomeEpisode ??= s.op.episode;
      this.paint();
      return s;
    } catch (e) {
      this.readError = `Couldn't read the conflicts: ${e instanceof Error ? e.message : String(e)}`;
      this.paint();
      return undefined;
    }
  }

  state(): ConflictsState | undefined {
    const s = this.snapshot;
    if (!s) return undefined;
    const ended = this.stashEnd;
    const files = ended
      ? ended.files
      : s.files.map((f) => (this.rowBusy.has(f.path) ? { ...f, status: "busy" as const } : f));
    return {
      brand: { name: "GitStudio", mark: "gitstudio" },
      repoName: s.repoName,
      op: s.op,
      files,
      total: ended ? ended.files.length : s.total,
      resolved: ended ? ended.files.length : files.filter((f) => f.status === "resolved").length,
      // The page waits for an operation verb — ours, or the merge editor's
      // (one lock for both) — never for one row's action.
      busy: this.busy || (verbInFlight && !this.rowRunning),
      done: this.snapshotDone,
      holdToUndoMs: HOLD_TO_UNDO_MS,
      notice: this.notice ?? (this.readError ? { kind: "error", text: this.readError } : undefined),
      outcome: this.outcome,
      ...(ended ? { finished: ended.finished } : {}),
    };
  }

  private paint(): void {
    const st = this.state();
    if (st) this.renderTarget?.(st);
  }

  async handle(action: ConflictsAction): Promise<void> {
    const { invoke } = this.deps;
    switch (action.type) {
      case "ready":
        await this.refresh();
        return;
      case "merge":
        this.deps.openMerge(action.path);
        return;
      case "accept":
      case "restore":
      case "delete":
        await this.fileVerb(action);
        return;
      case "continue":
      case "skip":
      case "abort": {
        if (this.verbPending) {
          // A second verb while one waits or runs was pressed on what the page
          // showed before the first: two Continues walk past the stop. It runs
          // nothing; the page still hears, in turn, that it is over.
          await this.inTurn(async () => this.dropped(action.seq));
          return;
        }
        // The page waits from the press (a verb can queue behind a row's action).
        this.verbPending = true;
        this.busy = true;
        this.paint();
        // After any row action pressed before it (the queue), never beside it.
        await this.inTurn(async () => {
          try {
            await this.runVerb(action);
          } finally {
            this.verbPending = false;
            this.busy = false;
            this.paint();
          }
        });
        return;
      }
      default:
        // close / openExternal: the desktop hosts the dashboard in place and
        // offers no support links.
        return;
    }
  }

  /** Continue / Skip / Abort, in its turn: run it, read what it did, say so. */
  private async runVerb(action: Extract<ConflictsAction, { type: "continue" | "skip" | "abort" }>): Promise<void> {
    const { invoke } = this.deps;
    const before = this.snapshot?.op;
    let line: { kind: "done" | "stopped" | "failed"; text: string } | undefined;
    const o = before
      ? await this.run(
          () =>
            action.type === "continue"
              ? invoke("op:continue", action.confirmDrop ? { confirmDrop: true } : {})
              : action.type === "skip"
                ? invoke("op:skip", undefined)
                : invoke("op:abort", undefined),
          async (result) => {
            line = outcomeLine(result, before, action.type);
            this.outcome = line;
            this.outcomeEpisode = result.view.episode;
            this.finish(action.seq);
            await this.refresh();
          },
          true,
        )
      : undefined;
    if (!o || !line) {
      // Nothing ran (no state yet, or another verb held the lock): the page
      // still hears that this press is over.
      this.finish(action.seq);
      await this.refresh();
      return;
    }
    this.deps.onOperationChanged(line);
  }

  /**
   * One ROW's action: that row is busy while it waits its turn and runs, and
   * nothing else on the dashboard changes — the page is not locked, the
   * notice above the list stays where it is (taking it away would move every
   * row). The row's result reaches the page with the read after it, which
   * says the press is `done`.
   */
  private async fileVerb(
    action: Extract<ConflictsAction, { type: "accept" | "restore" | "delete" }>,
  ): Promise<void> {
    const path = action.path;
    if (this.rowActive.has(path)) {
      // That row is already at work (or its result is being read back): a
      // second press on it was made on what it showed before — Accept Theirs
      // on a file Accept Yours is resolving. It runs nothing; the page still
      // hears, in turn, that it is over.
      await this.inTurn(async () => this.dropped(action.seq));
      return;
    }
    this.rowActive.add(path);
    this.rowBusy.add(path);
    this.paint();
    await this.inTurn(async () => {
      this.rowRunning = true;
      try {
        await this.runFileVerb(action);
      } finally {
        this.rowRunning = false;
        this.rowActive.delete(path);
      }
    });
  }

  private async runFileVerb(action: Extract<ConflictsAction, { type: "accept" | "restore" | "delete" }>): Promise<void> {
    const { invoke } = this.deps;
    const path = action.path;
    {
      let r: Awaited<ReturnType<typeof invoke<"conflict:takeRole">>> | undefined;
      try {
        r = await this.run(
          () =>
            action.type === "accept"
              ? invoke("conflict:takeRole", { path, role: action.role })
              : action.type === "delete"
                ? invoke("conflict:delete", { path })
                : invoke("conflict:restore", { path }),
          async (res) => {
            if (!res.ok) {
              this.notice = { kind: "error", text: res.message || `Couldn't change ${path}.` };
            } else if (action.type !== "restore") {
              const undo = {
                label: `Bring back the conflict in ${path}`,
                undo: async () => restoreResult(await invoke("conflict:restore", { path }), path),
                after: () => {
                  void this.refresh();
                  this.deps.onFileChanged();
                },
              };
              if (this.deps.pushUndo) this.deps.pushUndo(undo);
              else this.deps.undoable(action.type === "delete" ? `Deleted ${path}.` : `Resolved ${path}.`, undo);
            }
            this.rowBusy.delete(path);
            this.finish(action.seq);
            await this.refresh();
          },
          false,
        );
      } finally {
        if (this.rowBusy.delete(path) || !r) {
          // Nothing ran (another verb held the lock) or it threw: the row
          // still hears that its press is over.
          this.finish(action.seq);
          await this.refresh();
        }
      }
      if (r) this.deps.onFileChanged();
    }
  }

  /** Run `job` after every action pressed before it. */
  private inTurn(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Press `seq` is finished: every state read from now on says so. */
  private finish(seq: number | undefined): void {
    if (seq !== undefined && seq > this.done) this.done = seq;
  }

  /**
   * A press that runs nothing, in its turn. Nothing changed in git, so the
   * state on screen already shows its (lack of) effect: it is claimed done
   * without a read, and painted.
   */
  private async dropped(seq: number | undefined): Promise<void> {
    this.finish(seq);
    if (this.done > this.snapshotDone) {
      this.snapshotDone = this.done;
      this.paint();
    }
  }

  /**
   * One verb at a time, with the dashboard locked (busy) while it runs AND
   * while the state it led to is read back (`settle`) — for an operation
   * verb (`lockPage`). A row's action holds the same lock against the merge
   * editor, but only its own row shows it.
   *
   * Unlocking when the verb returns is not enough. The verb takes ~10 ms; the
   * read of what it did takes longer — and in between, the dashboard repaints
   * from the state BEFORE the verb with every control live again. The second
   * press of a double-click lands on that stale Continue: at an edit pause it
   * walks past the stop the user asked for, after a finished merge it reports
   * a failure over "Merge complete", and on a row it takes a side of a file
   * that is no longer conflicted. The banner this replaced kept its buttons
   * dead through its repaint for the same reason.
   */
  private async run<T>(
    fn: () => Promise<T>,
    settle: (result: T) => Promise<void>,
    lockPage: boolean,
  ): Promise<T | undefined> {
    if (verbInFlight) return undefined;
    if (lockPage) {
      this.notice = undefined; // a verb makes the last one's notice stale
      this.busy = true;
      this.paint();
    }
    try {
      return await exclusive(async () => {
        const result = await fn();
        await settle(result);
        return result;
      });
    } catch (e) {
      this.notice = { kind: "error", text: e instanceof Error ? e.message : String(e) };
      return undefined;
    } finally {
      if (lockPage) this.busy = false;
      this.paint();
    }
  }
}

// ── the rail badge and the top-bar chip ──────────────────────────────────────

/**
 * What the Changes rail item and the top-bar chip say about a stopped
 * operation, or undefined when nothing is in progress. From GitOpState (the
 * cheap read every refresh already makes) — not the full conflict state.
 */
export function opIndicator(op: GitOpState | undefined): { badge: string; label: string; title: string } | undefined {
  if (!op) return undefined;
  if (!op.kind && op.conflicts === 0) return undefined;
  const verb =
    op.kind === "merge"
      ? "Merging"
      : op.kind === "rebase"
        ? "Rebasing"
        : op.kind === "cherry-pick"
          ? "Cherry-picking"
          : op.kind === "revert"
            ? "Reverting"
            : op.kind === "am"
              ? "Applying patches"
              : "Conflicts";
  if (op.conflicts > 0) {
    const files = `${op.conflicts} conflict${op.conflicts === 1 ? "" : "s"}`;
    return {
      badge: String(op.conflicts),
      label: op.kind ? `${verb} · ${files}` : files,
      title: `${op.kind ? `${verb}: ` : ""}${op.conflicts} file${op.conflicts === 1 ? " has" : "s have"} conflicts — open Changes to resolve`,
    };
  }
  if (op.kind && op.canContinue) {
    return {
      badge: "•",
      label: "Ready to continue",
      title: `${verb}: every conflict is resolved — open Changes to continue`,
    };
  }
  return {
    badge: "•",
    label: `${verb} · paused`,
    title: `${verb} is paused — open Changes to continue or abort`,
  };
}

/** The Changes strip's words for a snapshot (shown while a file hides the dashboard). */
export function stripText(s: ConflictsSnapshot): { chip: string; title: string; pending: number } {
  return { chip: opChipLabel(s.op), title: s.op.title, pending: pendingOf(s) };
}
