// Side mapping and labels (PLAN §3.1, W2): the ONE place that knows which git
// stage is "Yours". Pure — no vscode / node / monaco import.
//
// Decision D1: during a rebase "Yours" is YOUR commit being replayed — git's
// stage 3 — and it is drawn on the LEFT, as JetBrains does
// (GitMergeUtil.java: `CURRENT = isReversed ? theirsContent : yoursContent`).
// A stash re-apply is reversed the same way: stage 3 holds the changes you
// stashed. Merge, cherry-pick, revert, am and a `--rebase-merges` merge step are
// NOT reversed: stage 2 is the branch you are standing on.
//
// Why the contents swap and not only the titles: git's stage 2 during a rebase
// is the branch you are rebasing ONTO. "Accept Yours" that took stage 2 (git
// checkout --ours) followed by Continue silently removed the reporter's only
// commit from their branch (issue #12, scratchpad git-semantics/products.out).
// A label-only fix leaves "left = mine" false in exactly the case that loses
// work.
//
// Every host maps contents, missing sides, badges and the JetBrains LOCAL /
// REMOTE files through `byRole` / `stageOf` / `roleOfStage` below and never
// re-derives the swap (memory: fix-both-siblings). Flipping D1 is one column:
// `YOURS_STAGE`.

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
  /** HEAD's branch (`symbolic-ref -q HEAD`, refs/heads/ stripped), else the short sha. */
  current: string;
  /** rebase / rebase-merge-step: the branch being rebased (head-name, refs/heads/ stripped; short orig-head when detached). */
  branch?: string;
  /** rebase: onto's display name; undefined when nothing names it ("Already rebased commits"). */
  onto?: string;
  /** rebase: the onto commit itself, for the "{sha7} ({subject})" fallback when nothing names it. */
  ontoCommit?: { sha: string; subject: string };
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
  /** How many paths are unmerged (kind "none": decides whether there is a title at all). */
  unmerged?: number;
  /** A deliberate stop with nothing to resolve (rebase merge backend only). */
  pause?: { reason: "edit" | "break" | "exec-failed"; command?: string };
}

/** The wording half of an OperationView — everything `describeSides` decides. */
export interface SideDescription {
  title: string;
  direction?: OperationView["direction"];
  yours: SideView;
  theirs: SideView;
  verbs: OperationView["verbs"];
  /** Present when `facts.pause` is: the pause card's text. */
  pause?: OperationView["pause"];
}

/**
 * Which git stage holds YOUR side, per operation — the single swap column
 * (decision D1). 3 = reversed (your commit / your stash is git's "theirs").
 */
export const YOURS_STAGE: Readonly<Record<OperationKind, 2 | 3>> = {
  merge: 2,
  rebase: 3,
  "rebase-merge-step": 2,
  "cherry-pick": 2,
  revert: 2,
  am: 2,
  stash: 3,
  none: 2,
};

/**
 * Names both sides of the stopped operation and decides which stage is Yours
 * (PLAN §3.1 table). Pure: every string comes from `facts`.
 */
export function describeSides(facts: OperationFacts): SideDescription {
  const yoursStage = YOURS_STAGE[facts.kind];
  const theirsStage: 2 | 3 = yoursStage === 2 ? 3 : 2;
  const words = WORDING[facts.kind](facts);
  const side = (role: SideRole, stage: 2 | 3, w: SideWords): SideView => ({
    role,
    stage,
    name: w.name,
    paneTitle: w.paneTitle,
    description: w.description,
  });
  const out: SideDescription = {
    title: words.title,
    yours: side("yours", yoursStage, words.yours),
    theirs: side("theirs", theirsStage, words.theirs),
    verbs: words.verbs,
  };
  if (words.direction) out.direction = words.direction;
  if (facts.pause) out.pause = { reason: facts.pause.reason, detail: pauseDetail(facts) };
  return out;
}

/** The pause card's line: "Paused to edit 1a2b3c4 fix the parser". */
export function pauseDetail(facts: Pick<OperationFacts, "pause" | "commit">): string {
  const p = facts.pause;
  if (!p) return "";
  if (p.reason === "edit") {
    return facts.commit
      ? `Paused to edit ${sha7(facts.commit.sha)} ${facts.commit.subject}`.trimEnd()
      : "Paused to edit a commit";
  }
  if (p.reason === "break") return "Paused at a break in the rebase plan";
  return p.command ? `Paused because the command “${p.command}” failed` : "Paused because a command in the rebase plan failed";
}

// ── Wording per operation (PLAN §3.1) ─────────────────────────────────────────

interface SideWords {
  name: string;
  paneTitle: string;
  description: string;
}

interface Words {
  title: string;
  direction?: OperationView["direction"];
  yours: SideWords;
  theirs: SideWords;
  verbs: OperationView["verbs"];
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

/** "1a2b3c4 fix the parser" — or just the sha when there is no subject. */
function commitLine(c: { sha: string; subject: string }): string {
  return `${sha7(c.sha)} ${c.subject}`.trimEnd();
}

/** HEAD's name, never empty (an unborn or unreadable HEAD still reads). */
function here(facts: OperationFacts): string {
  return facts.current || "HEAD";
}

function stepText(step: OperationFacts["step"]): string {
  return step ? ` · ${step.unit} ${step.n} of ${step.m}` : "";
}

function queuedText(queued: number | undefined): string {
  return queued && queued > 0 ? ` · ${queued} more queued` : "";
}

const WORDING: Record<OperationKind, (f: OperationFacts) => Words> = {
  merge(f) {
    const current = here(f);
    const incoming = f.incoming || "the other branch";
    return {
      title: `Merging ${incoming} into ${current}`,
      direction: { from: "theirs", verb: "into", to: "yours" },
      yours: {
        name: current,
        paneTitle: `Changes from ${current}`,
        description: `Your branch ${current}, as it was before the merge`,
      },
      theirs: {
        name: incoming,
        paneTitle: `Changes from ${incoming}`,
        description: `What is being merged in: ${incoming}`,
      },
      verbs: { continue: "Continue Merge", abort: "Abort Merge" },
    };
  },

  rebase(f) {
    const branch = f.branch || here(f);
    const ontoText =
      f.onto ??
      (f.ontoIsRoot
        ? "a new root"
        : f.ontoCommit
          ? `${sha7(f.ontoCommit.sha)} (${f.ontoCommit.subject})`
          : "the new base");
    const ontoName =
      f.onto ?? (f.ontoIsRoot ? "new root" : f.ontoCommit ? sha7(f.ontoCommit.sha) : "new base");
    const c = f.commit;
    return {
      title: `Rebasing ${branch} onto ${ontoText}${stepText(f.step)}${c ? `: ${commitLine(c)}` : ""}`,
      // The reporter's "test → onto → master".
      direction: { from: "yours", verb: "onto", to: "theirs" },
      yours: {
        name: branch,
        paneTitle: c ? `Rebasing ${sha7(c.sha)} from ${branch}` : `Rebasing ${branch}`,
        description: c
          ? `Your commit ${sha7(c.sha)} “${c.subject}” from ${branch}`
          : `Your branch ${branch}`,
      },
      theirs: {
        name: ontoName,
        paneTitle: f.onto
          ? `Already rebased commits and commits from ${f.onto}`
          : "Already rebased commits",
        description: `${ontoText}, plus the commits of ${branch} already rebased onto it`,
      },
      verbs: {
        continue: "Continue Rebase",
        // Only the apply backend ever offers Skip (and only for an emptied
        // patch): on the merge backend `rebase --skip` hard-resets a pause.
        ...(f.backend === "apply" ? { skip: "Skip this commit" } : {}),
        abort: "Abort Rebase",
      },
    };
  },

  "rebase-merge-step"(f) {
    const branch = f.branch || here(f);
    const label = f.label || "the merged branch";
    return {
      title: `Re-creating merge of ${label} into ${branch}${stepText(f.step)}`,
      direction: { from: "theirs", verb: "into", to: "yours" },
      yours: {
        name: branch,
        paneTitle: `Changes from ${branch} (rewritten)`,
        description: `${branch} as the rebase has rewritten it so far`,
      },
      theirs: {
        name: label,
        paneTitle: `Changes from ${label} (rewritten)`,
        description: `${label} as the rebase has rewritten it so far`,
      },
      // Rebase verbs, never `merge --*`: only the rebase can end this.
      verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
    };
  },

  "cherry-pick"(f) {
    const current = here(f);
    const c = f.commit;
    const what = c ? commitLine(c) : "a commit";
    return {
      title: `Cherry-picking ${what} onto ${current}${queuedText(f.queued)}`,
      direction: { from: "theirs", verb: "onto", to: "yours" },
      yours: {
        name: current,
        paneTitle: `Changes from ${current}`,
        description: `Your branch ${current}`,
      },
      theirs: {
        name: c ? sha7(c.sha) : "picked commit",
        paneTitle: `Changes from cherry-pick ${what}`,
        description: c
          ? `The commit being cherry-picked: ${sha7(c.sha)} “${c.subject}”`
          : "The commit being cherry-picked",
      },
      verbs: { continue: "Continue Cherry-pick", skip: "Skip this commit", abort: "Abort Cherry-pick" },
    };
  },

  revert(f) {
    const current = here(f);
    const c = f.commit;
    return {
      title: `Reverting ${c ? commitLine(c) : "a commit"} on ${current}${queuedText(f.queued)}`,
      direction: { from: "theirs", verb: "on", to: "yours" },
      yours: {
        name: current,
        paneTitle: `Changes from ${current}`,
        description: `Your branch ${current}`,
      },
      theirs: {
        // Never "parent of …", which is how git's own marker reads.
        name: c ? `undo of ${sha7(c.sha)}` : "undo",
        paneTitle: c ? `Undo of ${commitLine(c)}` : "Undo of the reverted commit",
        description: c
          ? `The reverse of commit ${sha7(c.sha)} “${c.subject}”`
          : "The reverse of the commit being reverted",
      },
      verbs: { continue: "Continue Revert", skip: "Skip this commit", abort: "Abort Revert" },
    };
  },

  am(f) {
    const current = here(f);
    const s = f.step;
    const subject = f.commit?.subject ?? "";
    const author = f.commit?.author;
    const nm = s ? `${s.n}/${s.m}` : "";
    return {
      title:
        `Applying ${s ? `patch ${s.n} of ${s.m}` : "a patch"}${subject ? `: ${subject}` : ""}` +
        `${author ? ` (by ${author})` : ""} onto ${current}`,
      direction: { from: "theirs", verb: "onto", to: "yours" },
      yours: {
        name: current,
        paneTitle: `Changes from ${current}`,
        description: `Your branch ${current}`,
      },
      theirs: {
        name: s ? `patch ${nm}` : "patch",
        paneTitle: `${s ? `Patch ${nm}` : "Patch"}${subject ? `: ${subject}` : ""}`,
        description:
          `${s ? `Patch ${s.n} of ${s.m}` : "The patch being applied"}` +
          `${subject ? `: “${subject}”` : ""}${author ? ` by ${author}` : ""}`,
      },
      verbs: { continue: "Continue (git am)", skip: "Skip patch", abort: "Abort (git am)" },
    };
  },

  stash(f) {
    const current = here(f);
    return {
      title: `Applying stashed changes on ${current}`,
      direction: { from: "yours", verb: "on", to: "theirs" },
      yours: {
        name: "stash",
        paneTitle: "Your stashed changes",
        description: "The changes you stashed, being put back",
      },
      theirs: {
        name: current,
        paneTitle: `Committed on ${current}`,
        description: `What is committed on ${current} now`,
      },
      // `git reset --merge`: the stash entry is kept, nothing is lost.
      verbs: { abort: "Cancel" },
    };
  },

  none(f) {
    const current = here(f);
    return {
      title: f.unmerged && f.unmerged > 0 ? `Unmerged files on ${current}` : "",
      yours: {
        name: current,
        paneTitle: `Current (${current})`,
        description: `The version on ${current}`,
      },
      theirs: {
        name: "incoming",
        paneTitle: "Incoming",
        description: "The other side of the conflict",
      },
      verbs: { abort: "Cancel" },
    };
  },
};

// ── The one stage ⇄ role mapping ─────────────────────────────────────────────

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
