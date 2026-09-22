import { basename } from "node:path";
import type { GitProcess } from "./GitProcess";
import type { ConflictProvider } from "./ConflictProvider";
import type { OperationSource } from "./OperationProvider";
import { byRole } from "@gitstudio/engine/conflict/sides";
import type {
  ConflictShape,
  ConflictsSnapshot,
  OperationView,
  SideRole,
} from "@gitstudio/host-bridge/conflictsProtocol";
import type { VersionsSource } from "@gitstudio/host-bridge/protocol";

/**
 * Whole-file conflict actions and per-file facts, stated in ROLE terms
 * (PLAN §3.4 W4). One instance per repository (GitContext.conflictOps), shared
 * by the desktop main process and the VS Code host package, so the dashboard's
 * rows, badges and resolutions cannot drift between products.
 *
 * S0 contract seed: the shapes and signatures are the contract; the bodies are
 * STUBS that P2 replaces. Stubs report no conflicted files and refuse every
 * write without running git; `readSides` passes today's ConflictProvider read
 * through the stub operation (no swap, shape "text").
 *
 * Rules the real bodies follow: `ls-files -u -z` decides which stages exist
 * (a MISSING side is never inferred from a failed checkout); git moves the
 * bytes (`checkout --ours|--theirs -- p`, never a string round-trip); every
 * write uses `--` and an exact path; the containment and symlink guards of the
 * desktop's conflictTakeSide / conflictResolve apply to both.
 */

export interface ConflictReadOpts {
  signal?: AbortSignal;
  /** The operation, when the caller already has it (saves a re-read). */
  op?: OperationView;
}

/** What git says about one unmerged path. */
export interface ConflictFileFacts {
  /** Repo-root-relative, exactly as `ls-files -z` reports it. */
  path: string;
  /** porcelain v2 XY in STAGE terms (X = stage 2's side, Y = stage 3's): "UU", "DU", "AA", "DD", … */
  xy: string;
  /** Which stages the index holds for the path. */
  stages: ReadonlyArray<1 | 2 | 3>;
  shape: ConflictShape;
  /** modify-delete / added-one-side: the ROLE with no version of the file. */
  missingRole?: SideRole;
  /** The XY badge in ROLE terms ("deleted in theirs (master)"); "" for both-modified. */
  badge: string;
  /** A common ancestor (stage 1) exists. */
  hasBase: boolean;
}

/**
 * The three texts of one conflicted file, ALREADY mapped to roles through
 * `op` — the one read both the desktop's ConflictModel and the extensions'
 * MergeInitPayload are built from.
 */
export interface MergeSides {
  op: OperationView;
  path: string;
  shape: ConflictShape;
  missingRole?: SideRole;
  hasBase: boolean;
  source: VersionsSource;
  /** Stage 1, or "" when there is no base. */
  base: string;
  /** Stage `op.yours.stage` — the LEFT pane. */
  yours: string;
  /** Stage `op.theirs.stage` — the RIGHT pane. */
  theirs: string;
}

export interface ReadSidesOptions extends ConflictReadOpts {
  /** Live working text, for the marker fallback when no stages exist. */
  workingText?: string;
}

/** Structurally a desktop CommitActionResult. */
export interface ConflictOpResult {
  ok: boolean;
  changed: boolean;
  message?: string;
  /** A refusal the user is allowed to hit (not an error report). */
  expected?: boolean;
}

export class ConflictOps {
  constructor(
    private readonly proc: GitProcess,
    /** Absolute repo (worktree) root. */
    private readonly root: string,
    private readonly conflict: ConflictProvider,
    private readonly operation: OperationSource,
  ) {}

  /** Every unmerged path with its facts, in `ls-files -u` order. S0 STUB — P2: none. */
  async conflictFiles(_opts?: ConflictReadOpts): Promise<ConflictFileFacts[]> {
    return [];
  }

  /** One path's facts; undefined when it is not unmerged. S0 STUB — P2: undefined. */
  async fileFacts(_path: string, _opts?: ConflictReadOpts): Promise<ConflictFileFacts | undefined> {
    return undefined;
  }

  /**
   * The role-mapped texts for the merge editor. S0 STUB — P2 adds shape /
   * missingRole / binary detection; the stub maps today's read through the
   * (stub, unswapped) operation and calls every file "text".
   */
  async readSides(path: string, opts?: ReadSidesOptions): Promise<MergeSides> {
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    const v = await this.conflict.getConflictVersions(path, {
      signal: opts?.signal,
      workingText: opts?.workingText,
    });
    const sides = byRole(op, v.ours, v.theirs);
    return {
      op,
      path,
      shape: "text",
      hasBase: v.hasBase,
      source: v.source,
      base: v.base,
      yours: sides.yours,
      theirs: sides.theirs,
    };
  }

  /**
   * The dashboard's git half: the operation, every unmerged row, plus rows
   * resolved during this episode (remembered per `op.episode`, with the
   * `choice` recorded by takeRole / noteChoice). S0 STUB — P2: no rows.
   */
  async snapshot(opts?: ConflictReadOpts): Promise<ConflictsSnapshot> {
    const op = opts?.op ?? (await this.operation.view({ signal: opts?.signal }));
    return { repoName: basename(this.root), op, files: [], total: 0, resolved: 0 };
  }

  /**
   * Resolve the whole file as `role`: its stage exists → checkout that stage +
   * `add`; its stage is ABSENT (known from ls-files -u) → `rm`. A both-deleted
   * path is refused with an explanation (use deleteFile). S0 STUB — P2.
   */
  async takeRole(_path: string, _role: SideRole, _opts?: ConflictReadOpts): Promise<ConflictOpResult> {
    return notYet();
  }

  /** Resolve a both-deleted (DD) path by deleting it (`rm -- p`). S0 STUB — P2. */
  async deleteFile(_path: string, _opts?: ConflictReadOpts): Promise<ConflictOpResult> {
    return notYet();
  }

  /**
   * Hold-to-undo: re-create the conflict of a path resolved during this
   * operation (`checkout -m -- p`; git rewrites the markers as ours/theirs).
   * S0 STUB — P2.
   */
  async restore(_path: string, _opts?: ConflictReadOpts): Promise<ConflictOpResult> {
    return notYet();
  }

  /**
   * Record how a path was resolved outside takeRole (the merge editor's Apply
   * = "merged"), for the snapshot's row pills. S0 STUB — P2.
   */
  noteChoice(_path: string, _choice: SideRole | "merged"): void {}
}

function notYet(): ConflictOpResult {
  return { ok: false, changed: false, expected: true, message: "Not available yet." };
}
