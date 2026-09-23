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
import { roleOfStage } from "@gitstudio/engine/conflict/sides";
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
  action: { label: string; undo: () => Promise<string | void>; after?: () => void | Promise<void> },
) => void;

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

/** The shell's init payload for a conflicted file. The texts arrive already mapped (op.yours on the left). */
export function mergePayload(
  model: ConflictModel,
  settings: MergeSettings,
  ide?: JetBrainsIdeInfo,
): MergeInitPayload {
  const shape = conflictShape(model);
  return {
    fileName: model.path,
    conflictType: shape === "added-both" ? "add-add" : "content",
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
    missingRole: missingRoleOf(model),
  };
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
            ? `Skipped. The ${noun} carried on.`
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
  undoable: Undoable;
  notify: Notify;
}

/**
 * Maps the shell's WebviewMessages onto IPC for one conflicted file.
 *
 * - apply → conflict:resolve, then `applied` (staged only when git said so),
 *   an undo that brings the conflict back (conflict:restore), and `opChanged`;
 * - takeRole → conflict:takeRole (conflict:takeSide for a model with no op,
 *   where no role mapping is known and stage 2 is "yours"); deleteFile →
 *   conflict:delete;
 * - continueOperation → op:continue; cancel{abort} → op:abort — each an
 *   `outcome` then `opChanged`; cancel{exit} → back to the dashboard;
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
          const r = await exclusive(() => invoke("conflict:resolve", { path, content: message.text }));
          if (!r) return;
          if (!r.ok) {
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
        case "continueOperation":
        case "cancel": {
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
      undo: async () => {
        const r = await this.deps.invoke("conflict:restore", { path });
        return r.ok ? undefined : r.message || `Couldn't bring the conflict in ${path} back.`;
      },
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
  private busy = false;
  private outcome?: ConflictsState["outcome"];
  private outcomeEpisode?: string;
  private notice?: ConflictsState["notice"];
  /**
   * The last state READ failed. Kept apart from `notice` (an action's own
   * error): the next read that works clears this one, and must not wipe the
   * reason a Continue or an Accept just gave.
   */
  private readError?: string;
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

  async refresh(): Promise<ConflictsSnapshot | undefined> {
    try {
      const s = await this.deps.invoke("conflict:state", undefined);
      if (!s) throw new Error("The conflict state came back empty.");
      this.snapshot = s;
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
    return {
      brand: { name: "GitStudio", mark: "gitstudio" },
      repoName: s.repoName,
      op: s.op,
      files: s.files,
      total: s.total,
      resolved: s.resolved,
      busy: this.busy || verbInFlight,
      holdToUndoMs: HOLD_TO_UNDO_MS,
      notice: this.notice ?? (this.readError ? { kind: "error", text: this.readError } : undefined),
      outcome: this.outcome,
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
        const before = this.snapshot?.op;
        if (!before) return;
        this.notice = undefined;
        const o = await this.run(() =>
          action.type === "continue"
            ? invoke("op:continue", action.confirmDrop ? { confirmDrop: true } : {})
            : action.type === "skip"
              ? invoke("op:skip", undefined)
              : invoke("op:abort", undefined),
        );
        if (!o) return;
        const line = outcomeLine(o, before, action.type);
        this.outcome = line;
        this.outcomeEpisode = o.view.episode;
        await this.refresh();
        this.deps.onOperationChanged(line);
        return;
      }
      default:
        // close / openExternal: the desktop hosts the dashboard in place and
        // offers no support links.
        return;
    }
  }

  private async fileVerb(
    action: Extract<ConflictsAction, { type: "accept" | "restore" | "delete" }>,
  ): Promise<void> {
    const { invoke } = this.deps;
    const path = action.path;
    this.notice = undefined;
    const r = await this.run(() =>
      action.type === "accept"
        ? invoke("conflict:takeRole", { path, role: action.role })
        : action.type === "delete"
          ? invoke("conflict:delete", { path })
          : invoke("conflict:restore", { path }),
    );
    if (!r) return;
    if (!r.ok) {
      this.notice = { kind: "error", text: r.message || `Couldn't change ${path}.` };
    } else if (action.type !== "restore") {
      this.deps.undoable(action.type === "delete" ? `Deleted ${path}.` : `Resolved ${path}.`, {
        label: `Bring back the conflict in ${path}`,
        undo: async () => {
          const u = await invoke("conflict:restore", { path });
          return u.ok ? undefined : u.message || `Couldn't bring the conflict in ${path} back.`;
        },
        after: () => {
          void this.refresh();
          this.deps.onFileChanged();
        },
      });
    }
    await this.refresh();
    this.deps.onFileChanged();
  }

  /** One verb at a time, with the dashboard locked (busy) while it runs. */
  private async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (verbInFlight) return undefined;
    this.busy = true;
    this.paint();
    try {
      return await exclusive(fn);
    } catch (e) {
      this.notice = { kind: "error", text: e instanceof Error ? e.message : String(e) };
      return undefined;
    } finally {
      this.busy = false;
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
