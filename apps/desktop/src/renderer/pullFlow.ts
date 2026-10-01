// Pull, including the question git asks and used to make the user answer in a
// terminal.
//
// When a branch and its upstream have BOTH moved, git refuses to guess. Left to
// itself it prints advice meant for a shell — "You have divergent branches and
// need to specify how to reconcile them", then three `git config` lines — and
// that wall is what reached a GitStudio user who pressed Pull (report #12).
//
// The bridge turns the refusal into a `diverged` result with nothing changed.
// This module is the other half: ask the choice git is asking for, then pull
// again with it. The chosen mode is passed to git as a flag on that one
// command — the user's `pull.rebase` is NEVER written, because a choice made in
// a dialog is about this pull, not about every pull from now on. ("Remember
// this" would be a setting, and a setting is a thing to ask for.)
//
// The decision lives here, DOM-free and injected, for the reason
// `askForCommitAction` was lifted out of the context menu: the top bar's Pull
// and the Branches list's ↓ pill are two doors onto the same operation, and a
// question that lives inside one of them is a question the other does not ask.

import type { PullActionResult, PullDivergence, PullMode } from "../shared/ipc";
import { promptChoice } from "./dialogs";
import * as l10n from "@vscode/l10n";

/** What `pullWithChoice` needs from the outside world. */
export interface PullFlowDeps {
  /** `host.invoke("sync:pull", …)`. */
  pull: (opts: { mode?: PullMode } | undefined) => Promise<PullActionResult>;
  /** Ask which reconciliation to use; `undefined` means the user backed out. */
  ask: (d: PullDivergence) => Promise<PullMode | undefined>;
}

/** The result, plus whether the user cancelled at the question. */
export interface PullOutcome {
  result: PullActionResult;
  /** True when the divergence question was asked and dismissed. Nothing ran,
   *  nothing failed — so the caller must not toast an error. */
  cancelled: boolean;
  /** The mode the user picked, when they were asked. */
  mode?: PullMode;
}

/**
 * Pull, asking how to reconcile only if git could not decide for itself.
 *
 * ONE retry by construction: the second call carries a mode, and a pull with a
 * mode can never come back `diverged`. A loop here would be a loop the user
 * cannot leave.
 */
export async function pullWithChoice(deps: PullFlowDeps): Promise<PullOutcome> {
  const first = await deps.pull(undefined);
  if (!first.diverged) {
    return { result: first, cancelled: false };
  }
  const mode = await deps.ask(first.diverged);
  if (!mode) {
    return { result: first, cancelled: true };
  }
  return { result: await deps.pull({ mode }), cancelled: false, mode };
}

/**
 * The question itself.
 *
 * Both options are ordinary — neither is `danger` — but they do different
 * things to history, and the sub-lines say which, because that is the whole
 * reason this is a modal and not a menu (a menu row ellipsises its sub-label).
 *
 * `holdWhile` keeps it up through the refresh its own fetch sets off (see
 * promptChoice): the fetch that found the divergence moved the upstream's
 * remote-tracking ref, and the watcher's refresh arrives while the question is
 * on screen. Without it the question was answered "Cancel" before anyone could
 * read it.
 */
export async function askPullMode(
  d: PullDivergence,
  holdWhile?: () => boolean,
): Promise<PullMode | undefined> {
  const mine = d.ahead === 1 ? l10n.t("{0} commit", d.ahead) : l10n.t("{0} commits", d.ahead);
  const theirs = d.behind === 1 ? l10n.t("{0} commit", d.behind) : l10n.t("{0} commits", d.behind);
  const pick = await promptChoice({
    title: l10n.t("'{0}' and {1} have diverged", d.branch, d.upstream),
    hint: l10n.t(
      "You have {0} {1} doesn't, and it has {2} you don't. Git needs to know how to combine them — this choice applies to this pull only.",
      mine,
      d.upstream,
      theirs,
    ),
    choices: [
      {
        id: "merge",
        label: l10n.t("Merge"),
        sub: l10n.t(
          "Bring {0} in and record a merge commit. Your commits keep their shas and their place in history.",
          theirs,
        ),
        icon: "git-merge",
      },
      {
        id: "rebase",
        label: l10n.t("Rebase"),
        sub: l10n.t(
          "Replay your {0} on top of {1}. Linear history, but your commits are rewritten with new shas.",
          mine,
          d.upstream,
        ),
        icon: "git-pull-request",
      },
    ],
    cancelId: "cancel",
    holdWhile,
  });
  return pick === "merge" || pick === "rebase" ? pick : undefined;
}

/** The message for a pull that succeeded, naming what it actually did. */
export function pulledMessage(mode: PullMode | undefined): string {
  if (mode === "merge") return l10n.t("Pulled and merged.");
  if (mode === "rebase") return l10n.t("Pulled and rebased your commits on top.");
  return l10n.t("Pulled successfully.");
}

/**
 * What a door does with a pull's outcome — decided once, here, for both doors
 * (the top bar's Pull and the Branches list's ↓ pill), so neither can grow a
 * case the other lacks.
 */
export type PullVerdict =
  /**
   * Asked, and dismissed. Nothing was merged — but the first, mode-less pull
   * already FETCHED, so the remote-tracking ref has moved and every ahead /
   * behind count on screen is stale. The door refreshes them, exactly as a
   * Fetch would; toasting would read as an error the user caused.
   */
  | { kind: "cancelled" }
  /**
   * The merge or rebase stopped on conflicts. Not a failure — the pull did
   * what was asked up to the point where a person has to choose. Said plainly,
   * with the count, in a neutral tone, and then the door takes the user to
   * Changes, where the conflicts dashboard and the merge editor live.
   */
  | { kind: "stopped"; message: string }
  /**
   * Nothing ran: a merge or rebase is still paused — usually the one a stop
   * above left, since the branch is still ahead and behind and Pull is still on
   * offer. Settled like a stop (neutral, then Changes), because Changes is where
   * that operation is finished or aborted. A pull the user's uncommitted work
   * was in the way of lands here too: Changes is where it is committed or
   * stashed.
   */
  | { kind: "blocked"; message: string }
  | { kind: "failed"; message: string; tone: "info" | "error" }
  | { kind: "pulled"; message: string };

export function pullVerdict(out: PullOutcome, fallback: string): PullVerdict {
  // Cancelled at either question: how to reconcile a divergence, or — the
  // user's uncommitted work in the pull's way — Stash & Retry or Cancel
  // (bridge.ts answers that one for every door, as `cancelled`). Either way the
  // first pull already fetched, so the door refreshes the counts.
  if (out.cancelled || out.result.cancelled) return { kind: "cancelled" };
  const r = out.result;
  if (r.stopped) {
    const n = r.stopped.conflicts;
    return {
      kind: "stopped",
      message:
        r.message ||
        (n === 1
          ? l10n.t("The pull stopped on conflicts in 1 file. Resolve them in Changes.")
          : l10n.t("The pull stopped on conflicts in {0} files. Resolve them in Changes.", n)),
    };
  }
  if (r.blocked) {
    return {
      kind: "blocked",
      message:
        r.message ||
        l10n.t("An operation is still in progress. Finish or abort it in Changes before pulling again."),
    };
  }
  // The user's uncommitted work was in the way. Nothing ran — settled like a
  // block, because Changes is where that work is committed or stashed.
  if (r.dirty) {
    return {
      kind: "blocked",
      message:
        r.message ||
        l10n.t("Your uncommitted changes are in the way. Commit or stash them in Changes, then pull again."),
    };
  }
  if (!r.ok) {
    return { kind: "failed", message: r.message || fallback, tone: r.expected ? "info" : "error" };
  }
  return { kind: "pulled", message: pulledMessage(out.mode) };
}
