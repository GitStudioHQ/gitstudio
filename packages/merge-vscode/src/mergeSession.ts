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
//
// The shell asks its own inline confirm before posting an abort; nothing here
// asks again.

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
  /** The product's undo envelope (GitStudio's UndoLedger). */
  withUndo?<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * A product WITHOUT an undo envelope (Merge Studio) offers the one-step undo
   * here instead: show `text` with an Undo action that runs `undo` (PLAN
   * matrix row 22 — the Undo is re-creating the conflict, `git checkout -m`).
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
    d.post({ type: "init", ...payload });
  }

  /** Apply: save the result, stage it, and say truthfully whether it is staged. */
  async apply(text: string): Promise<void> {
    const d = this.deps;
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
        if (!d.withUndo && d.offerUndo) {
          d.offerUndo("resolved file saved and staged.", () => this.undoApply());
        } else {
          d.notify("info", "resolved file saved and staged.");
        }
      } else if (staged.message) {
        d.notify("warn", staged.message);
      }
      d.post({ type: "applied", staged: staged.staged, message: staged.message });
      d.changed?.();
      await this.postOpChanged();
    };
    await (d.withUndo ? d.withUndo("Apply merge resolution", run) : run());
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

  /** "Cancel <operation>…" — posted only after the shell's inline confirm. */
  async abortOperation(): Promise<void> {
    await this.drive("abort", async (git) => {
      await this.deps.beforeAbort?.();
      return git.operation.abort();
    });
  }

  /**
   * The Undo of an Apply, for a product with no undo envelope: put the conflict
   * back (`checkout -m`, which rewrites the markers as ours/theirs) and show the
   * file's sides again.
   */
  async undoApply(): Promise<void> {
    const d = this.deps;
    if (!d.git || d.rel === undefined) {
      return;
    }
    const result = await d.git.conflictOps.restore(d.rel);
    if (!result.ok) {
      d.notify(result.expected ? "warn" : "error", result.message ?? "couldn't restore the conflict.");
      return;
    }
    d.changed?.();
    await this.postOpChanged();
    const text = d.diskText ? await d.diskText().catch(() => undefined) : undefined;
    await this.init(text);
  }

  /** Re-read the operation and tell the shell how many conflicts remain. */
  async postOpChanged(): Promise<void> {
    const git = this.deps.git;
    if (!git) {
      return;
    }
    try {
      const [op, detected] = await Promise.all([git.operation.view(), git.operation.detect()]);
      this.deps.post({ type: "opChanged", op, remainingConflicts: detected.unmerged });
    } catch {
      // The shell keeps its last state; the next change re-reads.
    }
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
