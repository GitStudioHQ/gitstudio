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
// Every host maps contents, missing sides and badges through `byRole` /
// `stageOf` / `roleOfStage` below and never re-derives the swap (memory: fix-both-siblings). Flipping D1 is one column:
// `YOURS_STAGE`.

import type {
  OperationKind,
  OperationView,
  SideRole,
  SideView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import * as l10n from "@vscode/l10n";

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
      ? l10n.t("Paused to edit {0} {1}", sha7(facts.commit.sha), facts.commit.subject).trimEnd()
      : l10n.t("Paused to edit a commit");
  }
  if (p.reason === "break") return l10n.t("Paused at a break in the rebase plan");
  return p.command ? l10n.t("Paused because the command “{0}” failed", p.command) : l10n.t("Paused because a command in the rebase plan failed");
}

/**
 * What a Skip that ENDED the operation did, said from the operation as it was
 * when Skip was pressed. Skipping the last commit or patch finishes without
 * it; skipping one with more after it — commit 2 of 3, a pick with more
 * queued — means git went on and applied the rest, and "Last commit skipped"
 * said the opposite. No closing period: each host punctuates its own line.
 *
 *   Commit 2 of 3 skipped; the rest applied — rebase complete
 *   Last patch skipped. The series is finished, without it
 */
export function skipEndedText(before: Pick<OperationView, "kind" | "step" | "queued" | "commit" | "range">): string {
  const am = before.kind === "am";
  const noun = SKIP_NOUN[before.kind];
  // What came AFTER the skipped one: the rest of the sequence (rebase, am),
  // or the picks still queued behind it (a cherry-pick or revert range).
  const rest = before.step ? before.step.m - before.step.n : (before.queued ?? 0);
  if (rest > 0) {
    const unit = before.step?.unit ?? "commit";
    const which = before.step
      ? l10n.t("{0} {1} of {2}", cap(STEP_UNIT[unit]), before.step.n, before.step.m)
      : before.commit?.sha
        ? l10n.t("Commit {0}", sha7(before.commit.sha))
        : l10n.t("The current commit");
    return am
      ? l10n.t("{0} skipped; the rest applied — the series is finished", which)
      : l10n.t("{0} skipped; the rest applied — {1} complete", which, noun);
  }
  if (am) {
    return l10n.t("Last patch skipped. The series is finished, without it");
  }
  if ((before.kind === "cherry-pick" || before.kind === "revert") && !before.step && !before.range) {
    // A single pick or revert: skipping it ENDED the operation with nothing
    // applied. "Revert complete, without it" read as if something had been
    // reverted, after skipping the only revert there was. The last of a
    // RANGE is different — the ones before it are in — and keeps "Last
    // commit skipped. … complete, without it".
    const which = before.commit?.sha ? l10n.t("Commit {0}", sha7(before.commit.sha)) : l10n.t("The current commit");
    return l10n.t("{0} skipped. The {1} is over", which, noun);
  }
  return l10n.t("Last commit skipped. {0} complete, without it", cap(noun));
}

/** The operation as the end of a sentence names it ("… — rebase complete"). */
/** Uppercase the first character. English only — Chinese passes straight through. */
const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Display word for the `unit` the facts carry ("commit" | "patch" | "step"). */
const STEP_UNIT: Readonly<Record<string, string>> = {
  commit: l10n.t("commit"),
  patch: l10n.t("patch"),
  step: l10n.t("step"),
};

const SKIP_NOUN: Readonly<Record<OperationKind, string>> = {
  merge: l10n.t("merge"),
  rebase: l10n.t("rebase"),
  "rebase-merge-step": l10n.t("rebase"),
  "cherry-pick": l10n.t("cherry-pick"),
  revert: l10n.t("revert"),
  am: l10n.t("patch series"),
  stash: l10n.t("stash"),
  none: l10n.t("operation"),
};

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
  return step ? l10n.t(" · {0} {1} of {2}", STEP_UNIT[step.unit], step.n, step.m) : "";
}

function queuedText(queued: number | undefined): string {
  return queued && queued > 0 ? l10n.t(" · {0} more queued", queued) : "";
}

const WORDING: Record<OperationKind, (f: OperationFacts) => Words> = {
  merge(f) {
    const current = here(f);
    const incoming = f.incoming || l10n.t("the other branch");
    return {
      title: l10n.t("Merging {0} into {1}", incoming, current),
      direction: { from: "theirs", verb: "into", to: "yours" },
      yours: {
        name: current,
        paneTitle: l10n.t("Changes from {0}", current),
        description: l10n.t("Your branch {0}, as it was before the merge", current),
      },
      theirs: {
        name: incoming,
        paneTitle: l10n.t("Changes from {0}", incoming),
        description: l10n.t("What is being merged in: {0}", incoming),
      },
      verbs: { continue: l10n.t("Continue Merge"), abort: l10n.t("Abort Merge") },
    };
  },

  rebase(f) {
    const branch = f.branch || here(f);
    const ontoText =
      f.onto ??
      (f.ontoIsRoot
        ? l10n.t("a new root")
        : f.ontoCommit
          ? `${sha7(f.ontoCommit.sha)} (${f.ontoCommit.subject})`
          : l10n.t("the new base"));
    const ontoName =
      f.onto ?? (f.ontoIsRoot ? l10n.t("new root") : f.ontoCommit ? sha7(f.ontoCommit.sha) : l10n.t("new base"));
    const c = f.commit;
    return {
      title: l10n.t("Rebasing {0} onto {1}{2}{3}", branch, ontoText, stepText(f.step), c ? `: ${commitLine(c)}` : ""),
      // The reporter's "test → onto → master".
      direction: { from: "yours", verb: "onto", to: "theirs" },
      yours: {
        name: branch,
        paneTitle: c ? l10n.t("Rebasing {0} from {1}", sha7(c.sha), branch) : l10n.t("Rebasing {0}", branch),
        description: c
          ? l10n.t("Your commit {0} “{1}” from {2}", sha7(c.sha), c.subject, branch)
          : l10n.t("Your branch {0}", branch),
      },
      theirs: {
        name: ontoName,
        paneTitle: f.onto
          ? l10n.t("Already rebased commits and commits from {0}", f.onto)
          : l10n.t("Already rebased commits"),
        description: l10n.t("{0}, plus the commits of {1} already rebased onto it", ontoText, branch),
      },
      verbs: {
        continue: l10n.t("Continue Rebase"),
        // Only the apply backend ever offers Skip (and only for an emptied
        // patch): on the merge backend `rebase --skip` hard-resets a pause.
        ...(f.backend === "apply" ? { skip: l10n.t("Skip this commit") } : {}),
        abort: l10n.t("Abort Rebase"),
      },
    };
  },

  "rebase-merge-step"(f) {
    const branch = f.branch || here(f);
    const label = f.label || l10n.t("the merged branch");
    return {
      title: l10n.t("Re-creating merge of {0} into {1}{2}", label, branch, stepText(f.step)),
      direction: { from: "theirs", verb: "into", to: "yours" },
      yours: {
        name: branch,
        paneTitle: l10n.t("Changes from {0} (rewritten)", branch),
        description: l10n.t("{0} as the rebase has rewritten it so far", branch),
      },
      theirs: {
        name: label,
        paneTitle: l10n.t("Changes from {0} (rewritten)", label),
        description: l10n.t("{0} as the rebase has rewritten it so far", label),
      },
      // Rebase verbs, never `merge --*`: only the rebase can end this.
      verbs: { continue: l10n.t("Continue Rebase"), abort: l10n.t("Abort Rebase") },
    };
  },

  "cherry-pick"(f) {
    const current = here(f);
    const c = f.commit;
    const what = c ? commitLine(c) : l10n.t("a commit");
    return {
      title: l10n.t("Cherry-picking {0} onto {1}{2}", what, current, queuedText(f.queued)),
      direction: { from: "theirs", verb: "onto", to: "yours" },
      yours: {
        name: current,
        paneTitle: l10n.t("Changes from {0}", current),
        description: l10n.t("Your branch {0}", current),
      },
      theirs: {
        name: c ? sha7(c.sha) : l10n.t("picked commit"),
        paneTitle: l10n.t("Changes from cherry-pick {0}", what),
        description: c
          ? l10n.t("The commit being cherry-picked: {0} “{1}”", sha7(c.sha), c.subject)
          : l10n.t("The commit being cherry-picked"),
      },
      verbs: { continue: l10n.t("Continue Cherry-pick"), skip: l10n.t("Skip this commit"), abort: l10n.t("Abort Cherry-pick") },
    };
  },

  revert(f) {
    const current = here(f);
    const c = f.commit;
    return {
      title: l10n.t("Reverting {0} on {1}{2}", c ? commitLine(c) : l10n.t("a commit"), current, queuedText(f.queued)),
      direction: { from: "theirs", verb: "on", to: "yours" },
      yours: {
        name: current,
        paneTitle: l10n.t("Changes from {0}", current),
        description: l10n.t("Your branch {0}", current),
      },
      theirs: {
        // Never "parent of …", which is how git's own marker reads.
        name: c ? `undo of ${sha7(c.sha)}` : "undo",
        paneTitle: c ? l10n.t("Undo of {0}", commitLine(c)) : l10n.t("Undo of the reverted commit"),
        description: c
          ? l10n.t("The reverse of commit {0} “{1}”", sha7(c.sha), c.subject)
          : l10n.t("The reverse of the commit being reverted"),
      },
      verbs: { continue: l10n.t("Continue Revert"), skip: l10n.t("Skip this commit"), abort: l10n.t("Abort Revert") },
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
        l10n.t("Applying {0}{1}", s ? l10n.t("patch {0} of {1}", s.n, s.m) : l10n.t("a patch"), subject ? `: ${subject}` : "") +
        `${author ? l10n.t(" (by {0})", author) : ""} onto ${current}`,
      direction: { from: "theirs", verb: "onto", to: "yours" },
      yours: {
        name: current,
        paneTitle: l10n.t("Changes from {0}", current),
        description: l10n.t("Your branch {0}", current),
      },
      theirs: {
        name: s ? `patch ${nm}` : "patch",
        paneTitle: `${s ? l10n.t("Patch {0}", nm) : "Patch"}${subject ? `: ${subject}` : ""}`,
        description:
          `${s ? l10n.t("Patch {0} of {1}", s.n, s.m) : l10n.t("The patch being applied")}` +
          `${subject ? `: “${subject}”` : ""}${author ? ` by ${author}` : ""}`,
      },
      verbs: { continue: l10n.t("Continue (git am)"), skip: l10n.t("Skip patch"), abort: l10n.t("Abort (git am)") },
    };
  },

  stash(f) {
    const current = here(f);
    return {
      title: l10n.t("Applying stashed changes on {0}", current),
      direction: { from: "yours", verb: "on", to: "theirs" },
      yours: {
        name: "stash",
        paneTitle: l10n.t("Your stashed changes"),
        description: l10n.t("The changes you stashed, being put back"),
      },
      theirs: {
        name: current,
        paneTitle: l10n.t("Committed on {0}", current),
        description: l10n.t("What is committed on {0} now", current),
      },
      // `git reset --merge`: the stash entry is kept, nothing is lost.
      verbs: { abort: "Cancel" },
    };
  },

  none(f) {
    const current = here(f);
    return {
      title: f.unmerged && f.unmerged > 0 ? l10n.t("Unmerged files on {0}", current) : "",
      yours: {
        name: current,
        paneTitle: l10n.t("Current ({0})", current),
        description: l10n.t("The version on {0}", current),
      },
      theirs: {
        name: "incoming",
        paneTitle: "Incoming",
        description: l10n.t("The other side of the conflict"),
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
 * = byRole(...).theirs (right); also for missing sides and XY badge halves.
 */
export function byRole<T>(op: SideStages, stage2: T, stage3: T): { yours: T; theirs: T } {
  return op.yours.stage === 2
    ? { yours: stage2, theirs: stage3 }
    : { yours: stage3, theirs: stage2 };
}
