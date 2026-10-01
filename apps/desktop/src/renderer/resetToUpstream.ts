// "Reset to 'origin/feature'…" — the branch menu's way to make a messy local
// branch 1:1 with its upstream (#32). The main process does the git
// (main/branchReset.ts); this is the part a person reads: the menu item's
// words, the confirm's words, and the order of the three calls.
//
// DOM-free and injected, like pullFlow.ts, so every state the confirm can be
// asked in is testable without a browser — test/resetToUpstream.test.ts walks
// the table: ahead, behind, diverged, equal; checked out or not; dirty or
// clean; a fetch that failed.
//
// The words follow two rules. Say what is LOST, concretely — how many local
// commits, which ones by subject, how many files of uncommitted changes — so
// the confirm is a fact to check rather than a warning to click through. And
// when nothing is lost, say THAT, plainly, with no red button: a branch that
// is only behind its upstream is a fast-forward wearing a scary verb.

import type { BranchResetPlan, BranchResetResult } from "../shared/ipc";
import { plural } from "./textFit";
import * as l10n from "@vscode/l10n";

/** The menu item — the same words the VS Code extension uses for it. */
export function resetItemLabel(upstream: string): string {
  return l10n.t("Reset to '{0}'…", upstream);
}

/** What the confirm shows. */
export interface ResetQuestion {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

/**
 * The confirm for a plan — or undefined when resetting would change nothing
 * (equal, and nothing uncommitted), which is said as a toast instead of asked.
 */
export function resetQuestion(p: BranchResetPlan): ResetQuestion | undefined {
  // Quoted the way the menu item and the extension's question quote them.
  const branch = p.branch ? `'${p.branch}'` : l10n.t("this branch");
  const up = p.upstream ? `'${p.upstream}'` : l10n.t("its upstream");
  const lost = p.lost ?? 0;
  const gained = p.gained ?? 0;
  const dirty = p.current ? (p.dirty ?? 0) : 0;
  if (!lost && !gained && !dirty) return undefined;

  const title = l10n.t("Reset {0} to {1}?", branch, up);
  const lines: string[] = [];
  if (p.fetchError) {
    lines.push(
      l10n.t(
        "Couldn't fetch from {0} ({1}), so this uses {2} as it was last fetched.",
        p.remote ?? l10n.t("the remote"),
        p.fetchError,
        up,
      ),
      "",
    );
  }

  if (!lost && !dirty) {
    lines.push(
      p.current
        ? l10n.t(
            "Nothing will be lost: {0} has no commits that aren't on {1}, and no uncommitted changes. It will move forward {2} to match.",
            branch,
            up,
            plural(gained, "commit"),
          )
        : l10n.t(
            "Nothing will be lost: {0} has no commits that aren't on {1}. It will move forward {2} to match.",
            branch,
            up,
            plural(gained, "commit"),
          ),
    );
    return { title, message: lines.join("\n"), confirmLabel: l10n.t("Reset"), danger: false };
  }

  if (lost) {
    lines.push(
      lost === 1
        ? l10n.t("{0} will lose 1 commit that isn't on {1}:", branch, up)
        : l10n.t("{0} will lose {1} that aren't on {2}:", branch, plural(lost, "commit"), up),
    );
    const named = p.lostSubjects ?? [];
    for (const s of named) lines.push(`  • ${s}`);
    if (lost > named.length) lines.push(l10n.t("  …and {0} more", lost - named.length));
  }
  if (dirty) {
    lines.push(
      l10n.t("Uncommitted changes to {0} will be discarded. Untracked files are kept.", plural(dirty, "file")),
    );
  }
  lines.push("");
  lines.push(
    p.current
      ? l10n.t("{0} will then match {1} exactly.", branch, up)
      : l10n.t(
          "{0} will then match {1} exactly. You're not on {0}, so nothing in your working tree changes.",
          branch,
          up,
        ),
  );
  lines.push(l10n.t("You can undo this straight afterwards."));
  return { title, message: lines.join("\n"), confirmLabel: l10n.t("Reset"), danger: true };
}

/** What a reset came to — the door turns each into one toast. */
export type ResetOutcome =
  /** The plan refused (no upstream, another worktree, an operation, a file
   *  in the way) or could not be read. Nothing ran. */
  | { kind: "refused"; message: string; tone: "info" | "error" }
  /** Already 1:1: nothing to ask, nothing to do. */
  | { kind: "nothing"; message: string }
  /** Asked, and answered Cancel — or the repository changed under the
   *  question. Nothing ran, nothing to say. */
  | { kind: "cancelled" }
  | { kind: "failed"; message: string; tone: "info" | "error" }
  | { kind: "reset"; plan: BranchResetPlan; result: BranchResetResult; message: string };

export interface ResetFlowDeps {
  /** `branch:resetPlan` — fetches, then describes. */
  plan: () => Promise<BranchResetPlan>;
  /** The confirm. */
  ask: (q: ResetQuestion) => Promise<boolean>;
  /** `branch:resetToUpstream` with the plan's tips. */
  reset: (p: BranchResetPlan) => Promise<BranchResetResult>;
  /** Is the repository the plan was read in still the open one? */
  stillHere: () => boolean;
}

/** Plan, ask, reset — in that order, each step only if the last allows it. */
export async function resetToUpstream(deps: ResetFlowDeps): Promise<ResetOutcome> {
  let p: BranchResetPlan;
  try {
    p = await deps.plan();
  } catch (e) {
    return { kind: "refused", message: e instanceof Error ? e.message : l10n.t("Couldn't read the branch."), tone: "error" };
  }
  if (!p?.ok || !p.from || !p.to) {
    return {
      kind: "refused",
      message: p?.message || l10n.t("Couldn't tell what resetting would do — refresh and try again."),
      tone: p?.expected ? "info" : "error",
    };
  }
  if (!deps.stillHere()) return { kind: "cancelled" };
  const q = resetQuestion(p);
  if (!q) {
    return {
      kind: "nothing",
      message: l10n.t("'{0}' already matches '{1}' — there is nothing to reset.", String(p.branch), String(p.upstream)),
    };
  }
  if (!(await deps.ask(q))) return { kind: "cancelled" };
  if (!deps.stillHere()) return { kind: "cancelled" };
  let r: BranchResetResult;
  try {
    r = await deps.reset(p);
  } catch (e) {
    return {
      kind: "failed",
      message: e instanceof Error ? e.message : l10n.t("Couldn't reset {0}.", String(p.branch)),
      tone: "error",
    };
  }
  if (!r?.ok) {
    return {
      kind: "failed",
      message: r?.message || l10n.t("Couldn't reset {0}.", String(p.branch)),
      tone: r?.expected ? "info" : "error",
    };
  }
  return { kind: "reset", plan: p, result: r, message: l10n.t("Reset '{0}' to '{1}'.", String(p.branch), String(p.upstream)) };
}
