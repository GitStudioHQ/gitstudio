// Side mapping and labels (PLAN §3.1, W2): the ONE place that knows which git
// stage is "Yours". Pure — no vscode / node / monaco import.
//
// S0 contract seed: `describeSides` is a STUB (today's generic labels, NO swap —
// Yours is always stage 2). P2 replaces its body with the §3.1 table (rebase and
// stash put stage 3 on the left) and may EXTEND `OperationFacts` /
// `SideDescription`; the exported names and the helpers' signatures are the
// contract other packages build against.
//
// The helpers below (`stageOf`, `roleOfStage`, `byRole`) are real: their
// meaning is fixed by `op.yours.stage`, and every host maps contents, missing
// sides and badges through them instead of re-deriving the swap (memory:
// fix-both-siblings — the desktop and both extensions must not each own a copy).

import type {
  OperationKind,
  OperationView,
  SideRole,
  SideView,
} from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * The raw facts W1 derives from git (OperationProvider), before any wording.
 * All names are DISPLAY names (never used to build a ref).
 */
export interface OperationFacts {
  kind: OperationKind;
  /** Rebase kinds: which backend. */
  backend?: "merge" | "apply";
  /** HEAD's branch (`symbolic-ref --short -q HEAD`), else the short sha. */
  current: string;
  /** rebase / rebase-merge-step: the branch being rebased (head-name, refs/heads/ stripped; short orig-head when detached). */
  branch?: string;
  /** rebase: onto's display name; undefined when nothing names it ("Already rebased commits"). */
  onto?: string;
  /** rebase --root: onto is the squash-onto empty commit ("a new root"). */
  ontoIsRoot?: boolean;
  /** merge: what is being merged in ("feature", "feature (from origin)", or "{sha7} {subject}"). */
  incoming?: string;
  /** rebase-merge-step: the merge's label (the branch being re-merged). */
  label?: string;
  /** The commit / patch being replayed, picked, reverted or applied. */
  commit?: { sha: string; subject: string; author?: string };
  step?: { n: number; m: number; unit: "commit" | "patch" | "step" };
  queued?: number;
}

/** The wording half of an OperationView — everything `describeSides` decides. */
export interface SideDescription {
  title: string;
  direction?: OperationView["direction"];
  yours: SideView;
  theirs: SideView;
  verbs: OperationView["verbs"];
}

/**
 * Names both sides of the stopped operation and decides which stage is Yours.
 *
 * S0 STUB — P2 owns the real body. Today's labels (the desktop's per-operation
 * wording), no swap: Yours is stage 2 for every kind, titles are empty and no
 * direction is given.
 */
export function describeSides(facts: OperationFacts): SideDescription {
  const legacy = LEGACY_LABELS[facts.kind];
  return {
    title: "",
    yours: {
      role: "yours",
      stage: 2,
      name: facts.current,
      paneTitle: legacy.ours,
      description: legacy.ours,
    },
    theirs: {
      role: "theirs",
      stage: 3,
      name: "",
      paneTitle: legacy.theirs,
      description: legacy.theirs,
    },
    verbs: {
      abort: facts.kind === "none" || facts.kind === "stash" ? "Cancel" : "Abort",
    },
  };
}

/** The stub's labels: stage 2 / stage 3, exactly as the desktop words them today. */
const LEGACY_LABELS: Record<OperationKind, { ours: string; theirs: string }> = {
  merge: { ours: "Current change (your branch)", theirs: "Incoming change" },
  rebase: { ours: "Upstream (what you're rebasing onto)", theirs: "Your commit (being replayed)" },
  "rebase-merge-step": { ours: "Current change (your branch)", theirs: "Incoming change" },
  "cherry-pick": { ours: "Current change (your branch)", theirs: "Incoming change" },
  revert: { ours: "Current change (your branch)", theirs: "Incoming change" },
  am: { ours: "Your branch", theirs: "The patch being applied" },
  stash: { ours: "Current change (your branch)", theirs: "Incoming change" },
  none: { ours: "Current change (your branch)", theirs: "Incoming change" },
};

/** The two sides of an OperationView — all the helpers below need. */
export type SideStages = Pick<OperationView, "yours" | "theirs">;

/** The git stage that holds `role`'s content. */
export function stageOf(op: SideStages, role: SideRole): 2 | 3 {
  return role === "yours" ? op.yours.stage : op.theirs.stage;
}

/** Which role git's stage 2 or 3 is, for this operation. */
export function roleOfStage(op: SideStages, stage: 2 | 3): SideRole {
  return op.yours.stage === stage ? "yours" : "theirs";
}

/**
 * Re-keys stage-keyed values by role: `byRole(op, stage2Value, stage3Value)`.
 * THE content mapping — payload.ours = byRole(...).yours (left), payload.theirs
 * = byRole(...).theirs (right); also for missing sides, XY badge halves and the
 * JetBrains LOCAL (= yours) / REMOTE (= theirs) files.
 */
export function byRole<T>(op: SideStages, stage2: T, stage3: T): { yours: T; theirs: T } {
  return op.yours.stage === 2
    ? { yours: stage2, theirs: stage3 }
    : { yours: stage3, theirs: stage2 };
}
