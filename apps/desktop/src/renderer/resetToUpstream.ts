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

/** The menu item — the same words the VS Code extension uses for it. */
export function resetItemLabel(upstream: string): string {
  return `Reset to '${upstream}'…`;
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
  const branch = p.branch ?? "this branch";
  const up = p.upstream ?? "its upstream";
  const lost = p.lost ?? 0;
  const gained = p.gained ?? 0;
  const dirty = p.current ? (p.dirty ?? 0) : 0;
  if (!lost && !gained && !dirty) return undefined;

  const title = `Reset ${branch} to '${up}'?`;
  const lines: string[] = [];
  if (p.fetchError) {
    lines.push(`Couldn't fetch from ${p.remote ?? "the remote"} (${p.fetchError}), so this uses ${up} as it was last fetched.`, "");
  }

  if (!lost && !dirty) {
    lines.push(
      `Nothing will be lost: ${branch} has no commits that aren't on ${up}` +
        (p.current ? ", and no uncommitted changes" : "") +
        `. It will move forward ${plural(gained, "commit")} to match.`,
    );
    return { title, message: lines.join("\n"), confirmLabel: "Reset", danger: false };
  }

  if (lost) {
    lines.push(`${branch} will lose ${lost === 1 ? "1 commit that isn't" : `${plural(lost, "commit")} that aren't`} on ${up}:`);
    const named = p.lostSubjects ?? [];
    for (const s of named) lines.push(`  • ${s}`);
    if (lost > named.length) lines.push(`  …and ${lost - named.length} more`);
  }
  if (dirty) {
    lines.push(`Uncommitted changes to ${plural(dirty, "file")} will be discarded. Untracked files are kept.`);
  }
  lines.push("");
  lines.push(
    p.current
      ? `${branch} will then match ${up} exactly.`
      : `${branch} will then match ${up} exactly. You're not on ${branch}, so nothing in your working tree changes.`,
  );
  lines.push("You can undo this straight afterwards.");
  return { title, message: lines.join("\n"), confirmLabel: "Reset", danger: true };
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
    return { kind: "refused", message: e instanceof Error ? e.message : "Couldn't read the branch.", tone: "error" };
  }
  if (!p?.ok || !p.from || !p.to) {
    return {
      kind: "refused",
      message: p?.message || "Couldn't tell what resetting would do — refresh and try again.",
      tone: p?.expected ? "info" : "error",
    };
  }
  if (!deps.stillHere()) return { kind: "cancelled" };
  const q = resetQuestion(p);
  if (!q) {
    return { kind: "nothing", message: `${p.branch} already matches ${p.upstream} — there is nothing to reset.` };
  }
  if (!(await deps.ask(q))) return { kind: "cancelled" };
  if (!deps.stillHere()) return { kind: "cancelled" };
  let r: BranchResetResult;
  try {
    r = await deps.reset(p);
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : `Couldn't reset ${p.branch}.`, tone: "error" };
  }
  if (!r?.ok) {
    return { kind: "failed", message: r?.message || `Couldn't reset ${p.branch}.`, tone: r?.expected ? "info" : "error" };
  }
  return { kind: "reset", plan: p, result: r, message: `Reset ${p.branch} to ${p.upstream}.` };
}
