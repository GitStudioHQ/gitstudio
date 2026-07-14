import * as vscode from "vscode";
import type { GitContext, Snapshot } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";

// The universal Undo envelope — GitStudio's flagship trust feature.
//
// Every destructive operation is wrapped by runWithUndo(): we snapshot the
// repo (HEAD + any dirty work) BEFORE the op, run it, then push a ledger entry
// and surface a subtle "Undid? <label> · [Undo]" toast. `gitstudio.undo` pops
// the most recent entry; if the resulting commit was never pushed we offer a
// hard reset back to the snapshot, but if it's already published we offer a
// Revert instead so we never rewrite shared history.
//
// Entries persist (minimally) in workspaceState as a per-repo ring buffer, so
// Undo survives a window reload.

const MAX_ENTRIES = 20;
const STATE_KEY = "gitstudio.undoLedger.v1";

/** A single undoable operation. `headBefore` is the snapshot's HEAD sha. */
export interface UndoEntry {
  readonly snapshot: Snapshot;
  readonly label: string;
  readonly time: number;
  /** HEAD before the op ran — the commit we'd reset back to. */
  readonly headBefore: string;
}

/** The minimal shape persisted in workspaceState (Snapshot is plain JSON). */
interface PersistedEntry {
  snapshot: Snapshot;
  label: string;
  time: number;
  headBefore: string;
}

type PersistedLedger = Record<string, PersistedEntry[]>;

/**
 * Owns the per-repo undo ring buffers, the runWithUndo wrapper destructive ops
 * route through, and the undo / history commands.
 */
export class UndoLedger {
  /** repoRoot -> ring buffer (newest last). */
  private readonly ledgers = new Map<string, UndoEntry[]>();

  constructor(
    private readonly repos: RepoManager,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.load();
  }

  // ── Wrapping operations ──────────────────────────────────────────────────

  /**
   * Capture a pre-op snapshot, run `fn`, then record an undo entry and show the
   * subtle "Undid? <label> · [Undo]" toast. On failure we STILL record the
   * entry (so the user can undo a half-finished op back to the snapshot) and
   * rethrow. `fn`'s return value is passed through untouched.
   */
  async runWithUndo<T>(
    repo: RepoEntry,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let snapshot: Snapshot;
    try {
      snapshot = await repo.ctx.snapshot.capture(label);
    } catch {
      // If we can't even snapshot (e.g. unborn HEAD), run the op unguarded
      // rather than block it.
      return fn();
    }

    try {
      const result = await fn();
      this.record(repo.root, snapshot);
      this.offerUndoToast(label);
      return result;
    } catch (err) {
      // The op threw mid-flight; still record so the snapshot is reachable.
      this.record(repo.root, snapshot);
      throw err;
    }
  }

  private record(root: string, snapshot: Snapshot): void {
    const entry: UndoEntry = {
      snapshot,
      label: snapshot.label,
      time: Date.now(),
      headBefore: snapshot.headSha,
    };
    const buffer = this.ledgers.get(root) ?? [];
    buffer.push(entry);
    while (buffer.length > MAX_ENTRIES) {
      buffer.shift();
    }
    this.ledgers.set(root, buffer);
    void this.save();
  }

  private offerUndoToast(label: string): void {
    void vscode.window
      .showInformationMessage(`Undid? ${label}`, "Undo")
      .then((choice) => {
        if (choice === "Undo") {
          void this.undoLast();
        }
      });
  }

  // ── Undo commands ────────────────────────────────────────────────────────

  /** `gitstudio.undo` — undo the most recent entry of the active repo. */
  async undoLast(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage("No active repository.");
      return;
    }
    const buffer = this.ledgers.get(active.root);
    const entry = buffer?.[buffer.length - 1];
    if (!entry) {
      void vscode.window.showInformationMessage("Nothing to undo.");
      return;
    }
    await this.undoEntry(active, entry, /* discardNewer */ 0);
  }

  /** `gitstudio.showUndoHistory` — pick from recent entries and restore one. */
  async showHistory(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage("No active repository.");
      return;
    }
    const buffer = this.ledgers.get(active.root) ?? [];
    if (buffer.length === 0) {
      void vscode.window.showInformationMessage("No undo history yet.");
      return;
    }

    // Newest first. Track how many newer entries each choice would discard.
    const items = buffer
      .map((entry, index) => ({
        label: `$(history) ${entry.label}`,
        description: relativeTime(entry.time / 1000),
        detail: `HEAD was ${short(entry.headBefore)}`,
        entry,
        discardNewer: buffer.length - 1 - index,
      }))
      .reverse();

    const picked = await vscode.window.showQuickPick(items, {
      title: "Undo History",
      placeHolder: "Restore the repository to a point before this operation",
    });
    if (!picked) {
      return;
    }
    await this.undoEntry(active, picked.entry, picked.discardNewer);
  }

  /**
   * Undo a specific entry. If the entry's resulting state is on local-only
   * history we offer a hard reset back to the snapshot; if `headBefore` is
   * already pushed we instead steer the user to Revert so published history is
   * never rewritten.
   */
  private async undoEntry(
    active: RepoEntry,
    entry: UndoEntry,
    discardNewer: number,
  ): Promise<void> {
    const currentHead = await this.currentHead(active.ctx);
    // The op's *result* is whatever HEAD is now (if the op moved HEAD). If that
    // commit is published, undoing by reset would rewrite shared history.
    const movedHead = currentHead !== null && currentHead !== entry.headBefore;
    const resultPushed =
      movedHead && currentHead
        ? await active.ctx.snapshot.isPushed(currentHead)
        : false;

    if (resultPushed) {
      await this.offerRevertInstead(active, entry, currentHead!);
      return;
    }

    const extra =
      discardNewer > 0
        ? ` This will also discard ${discardNewer} newer ` +
          `operation${discardNewer === 1 ? "" : "s"}.`
        : "";
    const dirtyNote = entry.snapshot.stashSha
      ? " Your uncommitted changes from that point will be restored."
      : "";
    const ok = await confirm(
      `Undo "${entry.label}"? The repository will be reset to ${short(
        entry.headBefore,
      )}.${extra}${dirtyNote}`,
      "Undo",
    );
    if (!ok) {
      return;
    }

    try {
      await active.ctx.snapshot.restore(entry.snapshot);
      flash(`Undid ${entry.label}`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof Error ? err.message : `Undo failed: ${String(err)}`,
      );
      return;
    }

    // Drop this entry and everything newer than it from the ledger.
    this.truncateFrom(active.root, entry);
    await this.save();
  }

  /**
   * The pushed-history safeguard: rather than reset published commits, run the
   * existing revert action on the commit(s) the op introduced.
   */
  private async offerRevertInstead(
    active: RepoEntry,
    entry: UndoEntry,
    currentHead: string,
  ): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `"${entry.label}" has already been pushed. Rewriting published history ` +
        `is unsafe, so GitStudio will Revert the change instead (a new commit ` +
        `that undoes it).`,
      { modal: true },
      "Revert",
    );
    if (choice !== "Revert") {
      return;
    }
    // Revert every commit from headBefore..currentHead (the op may have added
    // more than one). --no-edit keeps it one keystroke.
    const result = await active.ctx.process.run([
      "revert",
      "--no-edit",
      `${entry.headBefore}..${currentHead}`,
    ]);
    if (result.code === 0) {
      flash(`Reverted ${entry.label}`);
      // The op is now logically undone; drop its entry.
      this.truncateFrom(active.root, entry);
      await this.save();
      return;
    }
    const stderr = result.stderr.trim();
    if (/conflict/i.test(stderr)) {
      void vscode.window.showWarningMessage(
        `Revert of "${entry.label}" hit conflicts. Resolve them, then ` +
          `continue or abort the revert.`,
      );
    } else {
      void vscode.window.showErrorMessage(
        stderr ? `Revert failed: ${stderr}` : "Revert failed",
      );
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load(): void {
    const stored = this.context.workspaceState.get<PersistedLedger>(STATE_KEY);
    if (!stored) {
      return;
    }
    for (const [root, entries] of Object.entries(stored)) {
      this.ledgers.set(
        root,
        entries.map((e) => ({
          snapshot: e.snapshot,
          label: e.label,
          time: e.time,
          headBefore: e.headBefore,
        })),
      );
    }
  }

  private async save(): Promise<void> {
    const out: PersistedLedger = {};
    for (const [root, entries] of this.ledgers) {
      out[root] = entries.map((e) => ({
        snapshot: e.snapshot,
        label: e.label,
        time: e.time,
        headBefore: e.headBefore,
      }));
    }
    await this.context.workspaceState.update(STATE_KEY, out);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private truncateFrom(root: string, entry: UndoEntry): void {
    const buffer = this.ledgers.get(root);
    if (!buffer) {
      return;
    }
    const index = buffer.indexOf(entry);
    if (index >= 0) {
      buffer.splice(index); // drop this and all newer entries
    }
  }

  private async currentHead(ctx: GitContext): Promise<string | null> {
    const result = await ctx.process.run(["rev-parse", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : null;
  }
}

// ── Local UI helpers (mirror commitActions.ts) ───────────────────────────────

async function confirm(message: string, action: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return choice === action;
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(discard) ${message}`, 2500);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
