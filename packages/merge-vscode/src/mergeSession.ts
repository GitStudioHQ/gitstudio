// One open merge editor's conversation with git (PLAN §3.7 W14, the S0
// message sequencing). The custom-editor provider owns the VS Code pieces —
// the webview, the TextDocument, tabs — and hands every git-facing message to
// this vscode-free session, so the sequencing is unit-tested:
//
//   ready                 → init
//   apply{text}           → save, `git add` (EXIT CODE checked), noteChoice
//                           "merged", then applied{staged, message?} and
//                           opChanged{op, remainingConflicts}
//   takeRole{role}        → ConflictOps.takeRole, then applied and opChanged
//   deleteFile            → ConflictOps.deleteFile, then applied and opChanged
//   continueOperation     → OperationProvider.continue, then outcome and
//                           opChanged; when git stops on the next commit and
//                           THIS file conflicts again, a fresh init follows
//   cancel{mode:"abort"}  → OperationProvider.abort, then outcome and opChanged
//                           (older pages; the shell's bottom bar no longer
//                           ends the operation — its Close only closes, and
//                           the conflicts dashboard holds Abort)
//
// Whoever posts an abort has asked its own confirm first; nothing here asks
// again.

import type { ConflictOpResult } from "@gitstudio/git-service/ConflictOps";
import type {
  OperationContinueOptions,
  OperationControlOptions,
  OperationDetection,
  OperationReadOptions,
} from "@gitstudio/git-service/OperationProvider";
import type {
  OperationOutcome,
  OperationView,
  SideRole,
} from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage, MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import { outcomeLine, type OperationVerb } from "./outcome";
import { markersOnlyPayload, readMergePayload, type SidesReader } from "./payload";
import { stageResolvedPath, type GitRunner } from "./stageResolved";

/** The git surface one session needs — a GitContext satisfies it. */
export interface SessionGit {
  operation: {
    view(opts?: OperationReadOptions): Promise<OperationView>;
    detect(opts?: OperationReadOptions): Promise<OperationDetection>;
    continue(opts?: OperationContinueOptions): Promise<OperationOutcome>;
    abort(opts?: OperationControlOptions): Promise<OperationOutcome>;
  };
  conflictOps: SidesReader & {
    takeRole(path: string, role: SideRole): Promise<ConflictOpResult>;
    deleteFile(path: string): Promise<ConflictOpResult>;
    noteChoice(path: string, choice: SideRole | "merged"): void;
    /** Hold-to-undo's `checkout -m`: re-create the conflict of a resolved path. */
    restore(path: string): Promise<ConflictOpResult>;
  };
  conflict: { isConflicted(path: string): Promise<boolean> };
  process: GitRunner;
}

export interface MergeSessionDeps {
  /** The repository, when the file is inside one. */
  git?: SessionGit;
  /** Repo-relative, forward-slashed path. Required with `git`. */
  rel?: string;
  /** Absolute path (language detection, titles). */
  fileName: string;
  /** The live document text. */
  workingText(): string;
  /**
   * The file's text as git left it on disk. After a Continue stops on the next
   * commit, git has rewritten the file and the editor may not have reloaded it
   * yet, so a re-init must not trust the document.
   */
  diskText?(): Promise<string>;
  /** Write `text` into the document and save it. Throws when it cannot. */
  save(text: string): Promise<void>;
  post(msg: HostMessage): void;
  settings(): { autoApplyNonConflicting: boolean };
  jetbrainsName(): string | undefined;
  /** The one-time tip for this stop (POLISH A5.9), if the product has one to show. */
  tip?(op: OperationView | undefined): MergeInitPayload["tip"];
  /**
   * The product's undo envelope (GitStudio's UndoLedger), for an Apply on a
   * file with no conflict. It cannot snapshot an unmerged index, so an Apply
   * that resolves a conflict is undone through `offerUndo` instead.
   */
  withUndo?<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * The one-step undo of an Apply that resolved a conflict, in every product:
   * show `text` with an Undo action that runs `undo` (PLAN matrix row 22 — the
   * Undo re-creates the conflict, `git checkout -m`, and refuses once git has
   * moved on or the file has changed since).
   */
  offerUndo?(text: string, undo: () => Promise<void>): void;
  notify(kind: "info" | "warn" | "error", text: string): void;
  /** Repository state changed (refresh views, poke the git provider). */
  changed?(): void;
  /** Before an Abort: save the conflicted documents so no dirty buffer fights git. */
  beforeAbort?(): Promise<void>;
  /** After a successful Abort: close the merge editors whose conflicts are gone. */
  afterAbort?(): Promise<void>;
}

export class MergeSession {
  constructor(private readonly deps: MergeSessionDeps) {}

  /** Read the three sides and post `init`. */
  async init(text?: string): Promise<void> {
    const d = this.deps;
    const input = {
      fileName: d.fileName,
      workingText: text ?? d.workingText(),
      jetbrainsName: d.jetbrainsName(),
      autoApplyNonConflicting: d.settings().autoApplyNonConflicting,
    };
    let payload: MergeInitPayload;
    try {
      payload =
        d.git && d.rel !== undefined
          ? await readMergePayload(d.git.conflictOps, d.rel, input)
          : markersOnlyPayload(input);
    } catch (error) {
      d.notify("error", `couldn't read the conflict versions — ${reason(error)}`);
      return;
    }
    const tip = d.tip?.(payload.op);
    if (tip) {
      payload.tip = tip;
    }
    d.post({ type: "init", ...payload });
  }

  /**
   * Apply: save the result, stage it, and say truthfully whether it is staged.
   *
   * When the file was CONFLICTED, the Apply is undone by bringing the conflict
   * back (`checkout -m`), in every product: the product's own envelope
   * (GitStudio's ledger) snapshots with `git stash create`, which git refuses
   * while any path is unmerged ("Cannot save the current index state"), so
   * around a conflict it records nothing and offers nothing. The envelope
   * still wraps an Apply on a file with no conflict ("Reopen With…").
   */
  async apply(text: string): Promise<void> {
    const d = this.deps;
    const resolving =
      d.git && d.rel !== undefined ? await d.git.conflict.isConflicted(d.rel).catch(() => false) : false;
    const run = async (): Promise<void> => {
      try {
        await d.save(text);
      } catch (error) {
        const message = `couldn't save the resolved file — ${reason(error)}`;
        d.notify("error", message);
        d.post({ type: "applied", staged: false, message: capitalise(message) });
        return;
      }
      if (!d.git || d.rel === undefined) {
        d.post({
          type: "applied",
          staged: false,
          message: "Saved. This file is not in a Git repository, so there is nothing to stage.",
        });
        return;
      }
      const staged = await stageResolvedPath(d.git.process, d.rel);
      if (staged.staged) {
        d.git.conflictOps.noteChoice(d.rel, "merged");
      } else if (staged.message) {
        d.notify("warn", staged.message);
      }
      // What an Undo must find unchanged is read BEFORE `applied` goes out,
      // so the page can offer the Undo in place, beside Apply.
      const token =
        staged.staged && resolving && d.offerUndo
          ? await this.undoToken(await d.git.operation.view().catch(() => undefined))
          : undefined;
      d.post({ type: "applied", staged: staged.staged, message: staged.message, ...(token ? { undoable: true } : {}) });
      d.changed?.();
      await this.postOpChanged();
      if (!staged.staged) {
        return;
      }
      if (token && d.offerUndo) {
        d.offerUndo("resolved file saved and staged.", () => this.undoApply(token));
      } else {
        d.notify("info", "resolved file saved and staged.");
      }
    };
    await (d.withUndo && !resolving ? d.withUndo("Apply merge resolution", run) : run());
  }

  /** The no-text panel's Accept Yours / Accept Theirs (or "Delete the file" for the missing role). */
  async takeRole(role: SideRole): Promise<void> {
    await this.resolveWhole(`Accept ${role === "yours" ? "Yours" : "Theirs"}`, (git, rel) =>
      git.conflictOps.takeRole(rel, role),
    );
  }

  /** A both-deleted file's only resolution. */
  async deleteFile(): Promise<void> {
    await this.resolveWhole("Delete the conflicted file", (git, rel) =>
      git.conflictOps.deleteFile(rel),
    );
  }

  /** The shell's "Continue <operation>" after the last file is resolved. */
  async continueOperation(confirmDrop?: boolean): Promise<void> {
    await this.drive("continue", (git) => git.operation.continue({ confirmDrop }));
  }

  /** End the whole operation — posted only after a confirm (older pages; the dashboard has its own route). */
  async abortOperation(): Promise<void> {
    await this.drive("abort", async (git) => {
      await this.deps.beforeAbort?.();
      return git.operation.abort();
    });
  }

  /**
   * The Undo of an Apply that resolved a conflict: put the conflict back
   * (`checkout -m`, which rewrites the markers as ours/theirs) and show the
   * file's sides again.
   *
   * The Undo sits on a toast, and a toast's button still works from the
   * notification centre long after. `checkout -m` answers from git's
   * resolve-undo record, which outlives the commit that concluded the merge,
   * so a late click would put conflict markers back into a finished merge and
   * overwrite anything written to the file since. `token` is what the Apply
   * left behind; the Undo runs only while git is still at that same stop,
   * HEAD has not moved and the file is still exactly what the Apply wrote.
   */
  async undoApply(token?: ApplyUndoToken): Promise<void> {
    const d = this.deps;
    if (!d.git || d.rel === undefined) {
      return;
    }
    if (token) {
      const refusal = await this.undoRefusal(token);
      if (refusal) {
        d.notify("info", refusal);
        // The page's own Undo waits for an answer: say it there too.
        d.post({ type: "outcome", kind: "failed", text: capitalise(refusal) });
        return;
      }
    }
    const result = await d.git.conflictOps.restore(d.rel);
    if (!result.ok) {
      const message = result.message ?? "couldn't restore the conflict.";
      d.notify(result.expected ? "warn" : "error", message);
      d.post({ type: "outcome", kind: "failed", text: capitalise(message) });
      return;
    }
    d.changed?.();
    await this.postOpChanged();
    const text = d.diskText ? await d.diskText().catch(() => undefined) : undefined;
    await this.init(text);
  }

  /** Re-read the operation and tell the shell how many conflicts remain. The view, when git answered. */
  async postOpChanged(): Promise<OperationView | undefined> {
    const git = this.deps.git;
    if (!git) {
      return undefined;
    }
    try {
      const [op, detected] = await Promise.all([git.operation.view(), git.operation.detect()]);
      this.deps.post({ type: "opChanged", op, remainingConflicts: detected.unmerged });
      return op;
    } catch {
      // The shell keeps its last state; the next change re-reads.
      return undefined;
    }
  }

  /** What an Undo must find unchanged; undefined when it cannot be pinned down (then no Undo is offered). */
  private async undoToken(op: OperationView | undefined): Promise<ApplyUndoToken | undefined> {
    const d = this.deps;
    if (!op || !d.git || !d.diskText) {
      return undefined;
    }
    const [head, text] = await Promise.all([headOf(d.git.process), d.diskText().catch(() => undefined)]);
    return text === undefined ? undefined : { episode: op.episode, head, text };
  }

  /** Why an Undo may no longer run, in plain words; undefined when it may. */
  private async undoRefusal(token: ApplyUndoToken): Promise<string | undefined> {
    const d = this.deps;
    const git = d.git!;
    const [op, head, text] = await Promise.all([
      git.operation.view().catch(() => undefined),
      headOf(git.process),
      d.diskText ? d.diskText().catch(() => undefined) : Promise.resolve(undefined),
    ]);
    if (!op || op.episode !== token.episode || head !== token.head) {
      return "git has moved on since that Apply, so there is no conflict to bring back. Nothing was changed.";
    }
    if (text !== token.text) {
      return `${baseName(d.fileName)} changed after the Apply — undoing it now would throw those edits away. Nothing was changed.`;
    }
    return undefined;
  }

  private async resolveWhole(
    label: string,
    act: (git: SessionGit, rel: string) => Promise<ConflictOpResult>,
  ): Promise<void> {
    const d = this.deps;
    if (!d.git || d.rel === undefined) {
      d.post({
        type: "applied",
        staged: false,
        message: "This file is not in a Git repository, so there is no conflict to resolve.",
      });
      return;
    }
    const git = d.git;
    const rel = d.rel;
    const run = async (): Promise<void> => {
      let result: ConflictOpResult;
      try {
        result = await act(git, rel);
      } catch (error) {
        result = { ok: false, changed: false, message: reason(error) };
      }
      if (!result.ok && !result.expected && result.message) {
        d.notify("error", result.message);
      }
      d.post({ type: "applied", staged: result.ok, message: result.ok ? undefined : result.message });
      d.changed?.();
      await this.postOpChanged();
    };
    await (d.withUndo ? d.withUndo(label, run) : run());
  }

  private async drive(
    verb: OperationVerb,
    act: (git: SessionGit) => Promise<OperationOutcome>,
  ): Promise<void> {
    const d = this.deps;
    const git = d.git;
    if (!git) {
      d.post({ type: "outcome", kind: "failed", text: "This file is not in a Git repository." });
      return;
    }
    let before: OperationView;
    let outcome: OperationOutcome;
    try {
      before = await git.operation.view();
      outcome = await act(git);
    } catch (error) {
      d.post({ type: "outcome", kind: "failed", text: capitalise(reason(error)) });
      return;
    }
    const line = outcomeLine(outcome, verb, before);
    d.post({ type: "outcome", kind: line.kind, text: line.text });
    d.post({ type: "opChanged", op: outcome.view, remainingConflicts: outcome.remainingConflicts });
    d.changed?.();
    if (verb === "abort" && outcome.ok) {
      await d.afterAbort?.();
      return;
    }
    if (verb === "continue" && outcome.stopped && d.rel !== undefined) {
      // The next commit may conflict in this very file: show ITS sides, not the
      // ones the editor opened with.
      let again = false;
      try {
        again = await git.conflict.isConflicted(d.rel);
      } catch {
        again = false;
      }
      if (again) {
        const text = d.diskText ? await d.diskText().catch(() => undefined) : undefined;
        await this.init(text);
      }
    }
  }
}

/** What an Apply's Undo checks before it brings the conflict back. */
export interface ApplyUndoToken {
  /** The operation's stop when the Apply landed (OperationView.episode). */
  episode: string;
  /** HEAD then (undefined on an unborn branch or when git would not say). */
  head: string | undefined;
  /** The file on disk right after the Apply (whatever the save wrote). */
  text: string;
}

async function headOf(proc: GitRunner): Promise<string | undefined> {
  try {
    const r = await proc.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return r.code === 0 ? (r.stdout ?? "").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
