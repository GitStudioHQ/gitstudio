import { resolve } from "node:path";
import type { GitProcess } from "./GitProcess";
import type { RebaseRunOptions } from "./RebaseRunner";
import { describeSides } from "@gitstudio/engine/conflict/sides";
import type {
  OperationKind,
  OperationOutcome,
  OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * What git is in the middle of, named and driven (PLAN §3.2 W1 + §3.3 W3).
 *
 * S0 contract seed: the class shape, method signatures and option types are
 * the contract (the desktop main process, the shared VS Code host package and
 * the GitStudio extension build against them). The bodies are STUBS that P2
 * replaces: `detect()` and `view()` report nothing in progress, and the three
 * verbs refuse without running git. `gitPath()` is real — it is the
 * worktree-safe path rule every consumer must share.
 *
 * Rules the real bodies follow (PLAN §3.2–3.3): locale-free detection from the
 * files git writes; every path through `gitPath()`; display names only from
 * `%(refname)` with the prefix stripped (never `name-rev`, never a ref built
 * from a short name); Continue/Skip/Abort re-read the full view afterwards.
 */

export interface OperationReadOptions {
  signal?: AbortSignal;
}

/** The cheap answer: which operation, and how many paths are unmerged. No naming. */
export interface OperationDetection {
  kind: OperationKind;
  /** Rebase kinds: "merge" = rebase-merge/, "apply" = rebase-apply/ (+ rebasing). */
  backend?: "merge" | "apply";
  /** `ls-files -u` distinct paths. */
  unmerged: number;
}

export interface OperationControlOptions {
  signal?: AbortSignal;
  /**
   * How the rebase runner spawns git (git path, the host's Output-tab hook,
   * the installer node binary). Rebase verbs go through RebaseRunner so the
   * reword queue survives; defaults to the options given to the constructor.
   */
  runner?: RebaseRunOptions;
}

export interface OperationContinueOptions extends OperationControlOptions {
  /** The user confirmed `view.willDrop`; without it such a Continue is refused. */
  confirmDrop?: boolean;
}

/** Read side — what hosts and tests fake (a fake returns hand-built OperationViews). */
export interface OperationSource {
  view(opts?: OperationReadOptions): Promise<OperationView>;
}

/** Drive side — Continue / Skip / Abort with the gates of PLAN §3.3. */
export interface OperationControl {
  continue(opts?: OperationContinueOptions): Promise<OperationOutcome>;
  skip(opts?: OperationControlOptions): Promise<OperationOutcome>;
  abort(opts?: OperationControlOptions): Promise<OperationOutcome>;
}

export class OperationProvider implements OperationSource, OperationControl {
  constructor(
    private readonly proc: GitProcess,
    /** Absolute repo (worktree) root — `gitPath` resolves against it. */
    private readonly root: string,
    /** Default rebase-runner options (git path, run hook). */
    private readonly runner: RebaseRunOptions = {},
  ) {}

  /**
   * Which operation is in progress + the unmerged count, locale-free.
   * Cheap enough for status bars and hot paths (no naming, no reflog).
   * S0 STUB — P2: always "nothing in progress".
   */
  async detect(_opts?: OperationReadOptions): Promise<OperationDetection> {
    return { kind: "none", unmerged: 0 };
  }

  /**
   * The full OperationView: names, step, commit, verbs, gates.
   * S0 STUB — P2: always the kind-"none" view.
   */
  async view(_opts?: OperationReadOptions): Promise<OperationView> {
    return noneOperationView("");
  }

  /** S0 STUB — P2: refuses without running git. */
  async continue(_opts?: OperationContinueOptions): Promise<OperationOutcome> {
    return this.notYet();
  }

  /** S0 STUB — P2: refuses without running git. */
  async skip(_opts?: OperationControlOptions): Promise<OperationOutcome> {
    return this.notYet();
  }

  /** S0 STUB — P2: refuses without running git. */
  async abort(_opts?: OperationControlOptions): Promise<OperationOutcome> {
    return this.notYet();
  }

  /**
   * The absolute path of a git-dir entry (`MERGE_HEAD`, `rebase-merge`,
   * `rebase-apply/applying`, `index`, …) for THIS worktree:
   * `git rev-parse --git-path <name>` resolved against the root. resolve(),
   * never join(): inside a linked worktree git answers with an ABSOLUTE path
   * (…/main/.git/worktrees/<wt>/MERGE_HEAD), and a join produces a path that
   * cannot exist — the bug that blinded two operation watchers.
   * Rejects when git cannot answer (not a repository).
   */
  async gitPath(name: string, opts?: OperationReadOptions): Promise<string> {
    const r = await this.proc.run(["rev-parse", "--git-path", name], {
      signal: opts?.signal,
    });
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || `git rev-parse --git-path ${name} failed (${r.code}).`);
    }
    return resolve(this.root, r.stdout.trim());
  }

  private notYet(): OperationOutcome {
    return {
      ok: false,
      refused: "not-allowed",
      expected: true,
      message: "Not available yet.",
      view: noneOperationView(""),
      remainingConflicts: 0,
    };
  }
}

/**
 * The view for "nothing in progress" (and the stub's only answer): kind
 * "none", no verbs but Cancel, nothing allowed. `current` is HEAD's display
 * name when the caller knows it.
 */
export function noneOperationView(current: string): OperationView {
  const sides = describeSides({ kind: "none", current });
  return {
    kind: "none",
    title: sides.title,
    yours: sides.yours,
    theirs: sides.theirs,
    verbs: sides.verbs,
    canContinue: false,
    canSkip: false,
    episode: "none",
  };
}
