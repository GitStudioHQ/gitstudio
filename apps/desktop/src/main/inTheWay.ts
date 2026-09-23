// The desktop's one door for a command that applies commits — a revert, a
// cherry-pick, a checkout, a merge, a rebase, a stash apply or pop, a branch
// created and switched to from elsewhere, a pull request checked out, a pull.
//
// Crash report #18 (from the extension, and the desktop had the same shape):
// git refused a revert over the user's uncommitted edit — "Your local changes
// to the following files would be overwritten by merge … fatal: revert
// failed" — and that went out as a red error and a crash report. It is the
// user's state: nothing ran, and their work is safe.
//
// So every one of those bridge methods runs its git command through
// `applyForDoor` (the pull through `pullForDoor`). A refusal over uncommitted
// work (recognised by the engine from git's state — see git-service
// changesInTheWay.ts) answers `expected`, in the engine's words, with
// `inTheWay` naming the files and the repository. The renderer asks Stash &
// Retry or Cancel (bridge.ts), and a Stash & Retry sends the SAME request
// again with `stashFirst` set to that repository's root — never an argv: the
// bridge rebuilds the command from its own validated request, and refuses the
// retry in any other repository.
//
// A failure that is NOT the user's work in the way — a missing ref, a stop on
// conflicts, git failing — comes back as git's run, and the door handles it
// exactly as it did before: reported when it is a genuine failure.

import type { GitContext } from "@gitstudio/git-service/index";
import type { GitRunResult } from "@gitstudio/git-service/GitProcess";
import type { PullMode, PullResult } from "@gitstudio/git-service/SyncOps";
import {
  changesInTheWayMessage,
  operationInTheWayMessage,
  pullInTheWayMessage,
  runApplying,
  stashAndRetry,
  stashAndRetryPull,
  stashRetryNote,
  type ApplyOp,
  type ChangesInTheWay,
  type OperationInTheWay,
  type StashRetryOutcome,
} from "@gitstudio/git-service/changesInTheWay";
import type { CommitActionResult } from "../shared/ipc";

/** What a door gets back: a final answer, or git's run to handle as it always has. */
export type DoorApplied =
  /** Said here — changes in the way, a stash that failed, another repository. */
  | { answer: CommitActionResult }
  /** git ran (again, after a stash, when `stashFirst` was set): the door
   *  handles the result as before and passes `stashNote` on. */
  | { result: GitRunResult; stashNote?: string };

export async function applyForDoor(
  ctx: GitContext,
  op: ApplyOp,
  stashFirst: unknown,
): Promise<DoorApplied> {
  if (stashFirst !== undefined) {
    const refused = retryRefused(ctx, stashFirst);
    if (refused) return { answer: refused };
    const out = await stashAndRetry(ctx.process, op);
    if (out.blocked) {
      return { answer: blockedAnswer(out.blocked) };
    }
    if (out.stashFailed) {
      return { answer: stashFailedAnswer(out) };
    }
    if (out.inTheWay) {
      return { answer: inTheWayAnswer(ctx, out.inTheWay) };
    }
    const note = stashRetryNote(out);
    return note ? { result: out.result, stashNote: note } : { result: out.result };
  }
  const { result, inTheWay, blocked } = await runApplying(ctx.process, op);
  if (blocked) return { answer: blockedAnswer(blocked) };
  return inTheWay ? { answer: inTheWayAnswer(ctx, inTheWay) } : { result };
}

/**
 * Refused because git is already stopped — a merge, a rebase, a cherry-pick,
 * a revert or a `git am` waiting, or files left unmerged. The user's state:
 * said in the engine's words (what is stopped, what is left, finish or abort
 * it first), `expected`, and never offered to Stash & Retry — the stop's
 * files are its own. It used to be git's text ("Merging is not possible
 * because you have unmerged files", "You have not concluded your merge", "It
 * seems that there is already a rebase-merge directory"), and filed.
 */
function blockedAnswer(b: OperationInTheWay): CommitActionResult {
  return { ok: false, changed: false, expected: true, message: operationInTheWayMessage(b) };
}

/** What the pull's door gets back: a final answer, or the pull's own result. */
export type PullDoorApplied =
  | { answer: CommitActionResult }
  | { pulled: PullResult; stashNote?: string };

/**
 * The pull, through the same door: a pull refused over the user's work
 * answers `inTheWay` (with the sentence naming the files), and sent again with
 * `stashFirst` it stashes just those, pulls again and puts them back. Every
 * other outcome — pulled, stopped, blocked, diverged, detached, failed — is
 * the pull's own result, for syncPull to say as it always has.
 */
export async function pullForDoor(
  ctx: GitContext,
  mode: PullMode | undefined,
  stashFirst: unknown,
): Promise<PullDoorApplied> {
  // pull-stop-reviewed: a forwarder. What it pulls goes back to syncPull, which
  // reads `.stopped` and `.blocked` — only the refusal over the user's work is
  // settled here.
  const pull = (): Promise<PullResult> => ctx.sync.pull({ mode });
  let pulled: PullResult;
  let stashNote: string | undefined;
  if (stashFirst !== undefined) {
    const refused = retryRefused(ctx, stashFirst);
    if (refused) return { answer: refused };
    const out = await stashAndRetryPull(ctx.process, pull);
    if (out.stashFailed) return { answer: stashFailedAnswer(out) };
    pulled = out.pulled;
    stashNote = stashRetryNote(out);
  } else {
    pulled = await pull();
  }
  if (pulled.dirty) {
    return {
      answer: {
        ok: false,
        changed: false,
        expected: true,
        message: pullInTheWayMessage(pulled.dirty),
        inTheWay: { kind: "pull", files: pulled.dirty.paths, root: ctx.root },
      },
    };
  }
  return stashNote ? { pulled, stashNote } : { pulled };
}

/**
 * A Stash & Retry is answered only in the repository the refusal came from:
 * it stashes and runs in whichever repository is open, and a question left
 * open across a switch is not an answer about the new one. A `stashFirst`
 * that is not a path at all is a malformed request — our defect — and is
 * left reportable.
 */
function retryRefused(ctx: GitContext, stashFirst: unknown): CommitActionResult | undefined {
  if (typeof stashFirst !== "string") {
    return { ok: false, changed: false, message: "That isn't a repository to stash and retry in." };
  }
  if (stashFirst !== ctx.root) {
    return {
      ok: false,
      changed: false,
      expected: true,
      message: "Another repository is open now, so nothing was stashed or run.",
    };
  }
  return undefined;
}

/**
 * The stash a Stash & Retry needed could not be made (or, for a stash applied
 * over changes, the stash it named is gone). Nothing was run. A stash that is
 * gone is the user's state; git failing to stash is a genuine failure, and
 * stays reportable.
 */
function stashFailedAnswer(out: StashRetryOutcome): CommitActionResult {
  return {
    ok: false,
    changed: false,
    ...(out.stashGone ? { expected: true } : {}),
    message: `Couldn't stash your changes, so nothing ran — ${out.stashFailed}`,
  };
}

/** The refusal, as the renderer needs it: said, not filed, and answerable. */
function inTheWayAnswer(ctx: GitContext, v: ChangesInTheWay): CommitActionResult {
  return {
    ok: false,
    changed: false,
    expected: true,
    message: changesInTheWayMessage(v),
    inTheWay: { kind: v.kind, files: v.paths, root: ctx.root },
  };
}

/** A checkout op for the argv a door already runs — one definition, in
 *  git-service, shared with the other host's doors and the AI tools. */
export { checkoutOp } from "@gitstudio/git-service/changesInTheWay";
