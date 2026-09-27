import * as vscode from "vscode";
import { failed, NO_REPOSITORY, notifyInfo, notifyWarning } from "../ui/notify";
import { promptConfirm, promptPick, questionsAsked } from "../ui/dialogs";
import type { RestorePlan, Snapshot } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry, UndoOptions } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";
import { pausedForUser } from "../git/pausedForUser";
import { notifyPaused } from "../git/pauseNotice";

// The universal Undo envelope — GitStudio's flagship trust feature.
//
// Every destructive operation is wrapped by runWithUndo(): the repo is
// snapshotted BEFORE the op (git-service's SnapshotProvider: HEAD, every local
// branch, the stash stack, the uncommitted state), the op runs, and `settle`
// keeps exactly what it changed. Only an op that changed something is
// recorded, with a subtle "<label> — done. · [Undo]" toast — or, when git was
// left stopped for the user, "<label> stopped — finish it, or Undo."
//
// `gitstudio.undo` undoes the most recent entry by putting back what THAT op
// changed and nothing else — the plan says so in words first ("Switch back to
// 'main'", "Bring back branch 'feature' at 1a2b3c4"), or says why it can't be
// done safely instead of guessing. It used to hard-reset whatever branch HEAD
// was on now to the commit HEAD had been at: undoing "Checkout feature" moved
// FEATURE onto main's commit, and undoing a pushed checkout committed a revert.
// When the op's result has been pushed SINCE, putting it back would rewrite
// published history, so the undo is a new commit instead (Revert).
//
// Entries persist (minimally) in workspaceState as a per-repo ring buffer, so
// Undo survives a window reload.

const MAX_ENTRIES = 20;
// v2: snapshots carry their scope. v1 entries (HEAD-only snapshots) are not
// read back — undoing one could only guess what it had changed.
const STATE_KEY = "gitstudio.undoLedger.v2";

/** A single undoable operation. `headBefore` is the snapshot's HEAD sha. */
export interface UndoEntry {
  readonly snapshot: Snapshot;
  readonly label: string;
  readonly time: number;
  /** HEAD before the op ran. */
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
   * Capture a pre-op snapshot, run `fn`, then — when the op changed anything —
   * record an undo entry and show the subtle "<label> — done. · [Undo]" toast
   * ("<label> stopped — finish it, or Undo." when git was left stopped for the
   * user; "<label> did not finish." for a result that reports a failure). On
   * failure we STILL record what it changed (so a half-finished op can be
   * undone) and rethrow. `fn`'s return value is passed through untouched.
   */
  async runWithUndo<T>(
    repo: RepoEntry,
    label: string,
    fn: () => Promise<T>,
    opts?: UndoOptions,
  ): Promise<T> {
    let snapshot: Snapshot;
    try {
      snapshot = await repo.ctx.snapshot.capture(label, {
        ...(opts?.branch ? { branch: opts.branch } : {}),
        ...(opts?.deferred ? { deferred: opts.deferred } : {}),
        ...(opts?.refsOnly ? { refsOnly: true } : {}),
      });
    } catch {
      // If we can't even snapshot (an unborn HEAD), run the op unguarded
      // rather than block it. (An index git won't copy — a conflict in
      // progress — is still snapshotted: its branches and stashes can go
      // back, and the tree's plan says it can't.)
      return fn();
    }

    // The op's own questions are DOM, not modal: what the user saves while
    // one is open lands inside the op's window, and can't be told from the
    // op's own changes. The snapshot says so, so an undo that would rewrite
    // the tree says it takes those too.
    const questions = questionsAsked();
    const noteAsked = (): void => {
      if (questionsAsked() !== questions) repo.ctx.snapshot.markAsked(snapshot);
    };
    try {
      const result = await fn();
      noteAsked();
      if (nothingRan(result)) {
        // Cancelled at a question (Stash & Retry's Cancel, a dismissed
        // dialog): nothing ran, so there is nothing to undo — a toast
        // offering Undo for "Revert …" said the opposite.
        return result;
      }
      if (await this.settle(repo, snapshot)) {
        this.offerUndoToast(repo.root, this.record(repo.root, snapshot), outcomeOf(snapshot, result));
      }
      return result;
    } catch (err) {
      // The op threw mid-flight; still record whatever it changed.
      noteAsked();
      if (await this.settle(repo, snapshot)) {
        this.record(repo.root, snapshot);
      }
      throw err;
    }
  }

  /**
   * Note what the op changed. True when there is something to undo: a door
   * whose question was cancelled part-way ("not fully merged — Force Delete?"
   * → Cancel) changed nothing, and must not offer Undo for "Delete branch".
   * An op whose changes can't be read is not recorded — its undo could only
   * guess.
   */
  private async settle(repo: RepoEntry, snapshot: Snapshot): Promise<boolean> {
    try {
      await repo.ctx.snapshot.settle(snapshot);
    } catch {
      return false;
    }
    return repo.ctx.snapshot.changed(snapshot);
  }

  private record(root: string, snapshot: Snapshot): UndoEntry {
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
    return entry;
  }

  /**
   * Say what happened — the operation is done (it read "Undid? <label>", as if
   * it had been undone), it stopped for the user, or it did not finish; either
   * way its Undo undoes THAT entry (and the newer ones first), not whatever is
   * newest by the time it is pressed.
   */
  private offerUndoToast(root: string, entry: UndoEntry, outcome: Outcome): void {
    const text =
      outcome === "stopped"
        ? `${entry.label} stopped — finish it, or Undo.`
        : outcome === "failed"
          ? `${entry.label} did not finish.`
          : `${entry.label} — done.`;
    void notifyInfo(text, "Undo")
      .then((choice) => {
        if (choice === "Undo") {
          void this.undoThrough(root, entry);
        }
      });
  }

  /**
   * The toast's Undo: undo THAT entry. It used to undo whatever was newest,
   * so after another op the "Commit X — done." toast undid the op after X.
   * Newer entries go first, newest first, each asked — as Undo History does:
   * an op's plan is only right in the state the ones after it left.
   */
  private async undoThrough(root: string, entry: UndoEntry): Promise<void> {
    const repo = this.repos.getAll().find((r) => r.root === root);
    const buffer = this.ledgers.get(root) ?? [];
    const index = buffer.indexOf(entry);
    if (!repo || index < 0) {
      void notifyInfo(`"${entry.label}" isn't in the undo history any more`);
      return;
    }
    await this.undoChain(repo, buffer.slice(index).reverse());
  }

  // ── Undo commands ────────────────────────────────────────────────────────

  /** `gitstudio.undo` — undo the most recent entry of the active repo. */
  async undoLast(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage(NO_REPOSITORY);
      return;
    }
    const buffer = this.ledgers.get(active.root);
    const entry = buffer?.[buffer.length - 1];
    if (!entry) {
      void notifyInfo("Nothing to undo");
      return;
    }
    await this.undoOne(active, entry);
  }

  /** `gitstudio.showUndoHistory` — pick an entry; it and every newer one are undone, newest first. */
  async showHistory(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage(NO_REPOSITORY);
      return;
    }
    const buffer = this.ledgers.get(active.root) ?? [];
    if (buffer.length === 0) {
      void notifyInfo("No undo history yet");
      return;
    }

    // Newest first. Track how many newer entries each choice undoes first.
    const items = buffer
      .map((entry, index) => ({
        entry,
        index,
        newer: buffer.length - 1 - index,
      }))
      .reverse();

    const pickedId = await promptPick({
      title: "Undo History",
      hint: "Undo this operation — and, newest first, every one after it.",
      choices: items.map((it) => ({
        id: String(it.index),
        label: it.entry.label,
        icon: "history",
        detail: relativeTime(it.entry.time / 1000),
        description: `HEAD was ${short(it.entry.headBefore)}${
          it.newer > 0 ? ` · undoes ${it.newer} newer operation${it.newer === 1 ? "" : "s"} first` : ""
        }`,
      })),
    });
    if (pickedId === undefined) {
      return;
    }
    const picked = items.find((it) => String(it.index) === pickedId);
    if (!picked) {
      return;
    }
    await this.undoChain(active, buffer.slice(picked.index).reverse());
  }

  /**
   * Undo `chain` in order — newest first, down to the one asked for: each op
   * is put back in the state the ones after it left, which is the only state
   * its plan is right for. Stops at the first that isn't undone — except that
   * a newer entry which CAN'T be undone (a commit made since, say) may be
   * forgotten on the way: otherwise it would stand in front of every older
   * entry for good. The older ones are still each checked on their own
   * terms — every plan puts back only what its op changed, and only while it
   * is where the op left it.
   */
  private async undoChain(active: RepoEntry, chain: readonly UndoEntry[]): Promise<void> {
    const target = chain[chain.length - 1];
    for (let i = 0; i < chain.length; i++) {
      const done = await this.undoOne(
        active,
        chain[i],
        chain.length > 1 ? { step: i + 1, of: chain.length } : undefined,
        chain[i] === target ? undefined : target,
      );
      if (!done) {
        return;
      }
    }
  }

  /**
   * Undo one entry: ask git-service what putting back what it changed means
   * now, say that in words, and do exactly that — or say why it can't be done.
   * True when the entry is done with (undone, forgotten, or nothing was left
   * to undo). `heading`: the older entry a chain is on its way to, when this
   * one is only in front of it.
   */
  private async undoOne(
    active: RepoEntry,
    entry: UndoEntry,
    progress?: { step: number; of: number },
    heading?: UndoEntry,
  ): Promise<boolean> {
    const snap = entry.snapshot;
    let plan: RestorePlan;
    try {
      plan = await active.ctx.snapshot.plan(snap);
    } catch (err) {
      void vscode.window.showErrorMessage(failed("Undo", err instanceof Error ? err.message : String(err)));
      return false;
    }
    switch (plan.kind) {
      case "refuse":
        if (heading) {
          const forget = await promptConfirm({
            title: `Can't undo "${entry.label}"`,
            message:
              `${plan.reason} Take it off the undo history and go on to undo "${heading.label}"? ` +
              "That puts back only what it changed, and only where nothing has moved since.",
            confirmLabel: "Forget It and Continue",
          });
          if (!forget) {
            return false;
          }
          this.remove(active.root, entry);
          await this.save();
          return true;
        }
        // Left alone, a refused entry would stand in front of every older one
        // for good: Undo would only ever say this. Forget It takes it off.
        void notifyWarning(`Can't undo "${entry.label}": ${plan.reason}`, "Forget It").then(async (choice) => {
          if (choice === "Forget It") {
            this.remove(active.root, entry);
            await this.save();
          }
        });
        return false;
      case "nothing":
        void notifyInfo(`Nothing to undo for "${entry.label}" — ${plan.reason}`);
        this.remove(active.root, entry);
        await this.save();
        return true;
      case "revert":
        return this.offerRevertInstead(active, entry, plan, progress);
      case "restore":
        break;
    }

    const ok = await promptConfirm({
      title: `Undo "${entry.label}"?${progress ? ` (${progress.step} of ${progress.of})` : ""}`,
      message: plan.lines.join(" "),
      confirmLabel: "Undo",
      danger: plan.danger,
    });
    if (!ok) {
      return false;
    }
    try {
      // Asked again, not trusted: the repository may have moved while the
      // question was up, and then the answer was to a different question.
      const again = await active.ctx.snapshot.plan(snap);
      if (again.kind !== "restore" || again.lines.join(" ") !== plan.lines.join(" ")) {
        void notifyWarning(
          `The repository changed while you were being asked, so "${entry.label}" wasn't undone. Try Undo again.`,
        );
        return false;
      }
      await active.ctx.snapshot.execute(snap, again.steps);
      flash(`Undid ${entry.label}`);
    } catch (err) {
      void vscode.window.showErrorMessage(failed("Undo", err instanceof Error ? err.message : String(err)));
      return false;
    }
    this.remove(active.root, entry);
    await this.save();
    return true;
  }

  /**
   * The pushed-history safeguard: HEAD's branch was moved by the op and the
   * result has been pushed since, so rather than rewrite published commits
   * the undo is a new commit — a revert of the commits the op added, or, for
   * a rewrite (an amend), one commit putting its files back as they were.
   */
  private async offerRevertInstead(
    active: RepoEntry,
    entry: UndoEntry,
    plan: Extract<RestorePlan, { kind: "revert" }>,
    progress?: { step: number; of: number },
  ): Promise<boolean> {
    const ok = await promptConfirm({
      title: `"${entry.label}" has already been pushed${progress ? ` (${progress.step} of ${progress.of})` : ""}`,
      message:
        plan.mode === "range"
          ? "Rewriting published history would break everyone who has already pulled it. GitStudio will Revert instead — a new commit that undoes the change, leaving the original in place."
          : `Rewriting published history would break everyone who has already pulled it. GitStudio will add a new commit instead that puts the files back as they were before "${entry.label}", leaving the pushed commit in place.`,
      confirmLabel: "Revert",
    });
    if (!ok) {
      return false;
    }
    // Asked again, as a restore is: a commit made while the question was up
    // would otherwise be dropped from the branch by the revert's reset.
    const again = await active.ctx.snapshot.plan(entry.snapshot).catch(() => undefined);
    if (
      again?.kind !== "revert" ||
      again.mode !== plan.mode ||
      again.from !== plan.from ||
      again.to !== plan.to ||
      again.branch !== plan.branch
    ) {
      void notifyWarning(
        `The repository changed while you were being asked, so "${entry.label}" wasn't undone. Try Undo again.`,
      );
      return false;
    }
    const result = await active.ctx.snapshot.revert(entry.snapshot, again);
    if (result.code === 0) {
      flash(`Reverted ${entry.label}`);
      // The op is now logically undone; drop its entry.
      this.remove(active.root, entry);
      await this.save();
      return true;
    }
    const stderr = result.stderr.trim();
    // Ask git whether the revert PAUSED rather than reading its prose — the same
    // locale trap as the graph's cherry-pick/revert: on a translated git the
    // English test misses and a routine "resolve this" reads as a hard failure.
    // Exit 1 + REVERT_HEAD means paused; 128 means git refused outright —
    // the one shared test (git/pausedForUser.ts), not a second copy of it.
    const paused = plan.mode === "range" && (await pausedForUser(active.ctx.process, result.code, "REVERT_HEAD"));
    if (paused) {
      notifyPaused(
        `Revert of "${entry.label}" needs a decision — resolve any conflicts ` +
          `and continue, or abort the revert.`,
      );
    } else if (!stderr) {
      // Non-zero with nothing on stderr means there was nothing left to undo;
      // git explains that on stdout.
      void notifyInfo(`Nothing to revert — "${entry.label}" is already undone.`);
    } else {
      void vscode.window.showErrorMessage(failed("Revert", stderr));
    }
    return false;
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
        entries
          .filter((e) => e?.snapshot?.scope)
          .map((e) => ({
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

  /** Drop one entry. Undo runs newest first, so nothing newer is left behind. */
  private remove(root: string, entry: UndoEntry): void {
    const buffer = this.ledgers.get(root);
    if (!buffer) {
      return;
    }
    const index = buffer.indexOf(entry);
    if (index >= 0) {
      buffer.splice(index, 1);
    }
  }
}

/** What the envelope's toast says an op came to. */
type Outcome = "done" | "stopped" | "failed";

/**
 * Read from what settle saw, not only from the result's shape: the doors that
 * stop for the user answer `true` (a cherry-pick, a revert, several of them)
 * or a RebaseOutcome, and "— done." sat next to their "stopped on a commit
 * that needs you". An op that left git stopped in an operation it started — a
 * conflict, an emptied pick, an `edit` row — stopped. A deferred op (an
 * interactive rebase handed to a terminal) is MEANT to be under way.
 */
export function outcomeOf(snapshot: Snapshot, result: unknown): Outcome {
  const s = snapshot.scope;
  if (s?.settled?.op && !s.deferred) return "stopped";
  if (typeof result === "object" && result !== null && (result as { status?: unknown }).status === "stopped") return "stopped";
  return reportsFailure(result) ? "failed" : "done";
}

/**
 * A result that ran but says it failed: `{ ok: false }` (as GitResult does), a
 * RebaseOutcome that failed, or a door's Applied whose git run exited non-zero
 * (a pop that hit conflicts applies the stash and keeps it).
 */
function reportsFailure(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { ok?: unknown; status?: unknown; result?: unknown };
  if (r.ok === false || r.status === "failed") return true;
  const run = r.result as { code?: unknown } | null | undefined;
  return typeof run === "object" && run !== null && typeof run.code === "number" && run.code !== 0;
}

/**
 * An operation's result that says nothing ran: the commit actions' `false`
 * ("nothing changed" — a cancel), or a door's `{ cancelled: true }`
 * (applyOrAsk's Applied, when the Stash & Retry question was cancelled).
 */
export function nothingRan(result: unknown): boolean {
  if (result === false) return true;
  return typeof result === "object" && result !== null && (result as { cancelled?: unknown }).cancelled === true;
}

// ── Local UI helpers (mirror commitActions.ts) ───────────────────────────────

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(discard) ${message}`, 2500);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
