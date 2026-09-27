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

import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { sameFolder } from "@gitstudio/git-service/folderPath";
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
import { STASH_GONE_MESSAGE } from "@gitstudio/git-service/StashProvider";
import type { CommitActionResult } from "../shared/ipc";

/** What a door gets back: a final answer, or git's run to handle as it always has. */
export type DoorApplied =
  /** Said here — changes in the way, a stash that failed, another repository. */
  | { answer: CommitActionResult }
  /** git ran (again, after a stash, when `stashFirst` was set): the door
   *  handles the result as before and passes `stashNote` on — and
   *  `stashKept`: a Pop that applied its stash and kept it (applyForDoor). */
  | { result: GitRunResult; stashNote?: string; stashKept?: true };

/** A stash applied without its staging, because git could not stage it again. */
export const STASH_UNSTAGED_NOTE =
  "The stash's staged changes came back unstaged — git couldn't stage them again here. " +
  "It stays in the list, still holding them as they were staged.";
/** …and a Pop that therefore kept its stash. */
export const STASH_KEPT_NOTE =
  "The stash's staged changes came back unstaged — git couldn't stage them again here — so it was " +
  "applied, not popped: it stays in the list, still holding them as they were staged.";

export async function applyForDoor(
  ctx: GitContext,
  op: ApplyOp,
  stashFirst: unknown,
): Promise<DoorApplied> {
  const applied = await applyOnce(ctx, op, stashFirst);
  if (!("staging" in applied)) return applied;
  // A stash applied with its staging (`index`) where git could not stage it
  // again — the user's own staged changes in the way, or its staged half no
  // longer applying at HEAD. Nothing of it ran, so it runs as it always did,
  // everything unstaged — but APPLIED, even for a Pop: popping drops the
  // stash, and with it the only copy of a staged version that differed from
  // its file (issue #4's loss). So it stays in the list, and the note says
  // why. (The extension asks first; the desktop has no question for this yet.)
  const plain: ApplyOp = op.kind === "stash" ? { kind: "stash", stash: op.stash } : op;
  const again = await applyOnce(ctx, plain, stashFirst);
  if ("staging" in again) return { result: again.result };
  if (!("result" in again)) return again;
  const ran = op.kind === "stash" && again.result.code === 0;
  const kept = ran && op.pop === true;
  const notes = [applied.stashNote, again.stashNote, ran ? (kept ? STASH_KEPT_NOTE : STASH_UNSTAGED_NOTE) : undefined];
  const said = notes.filter(Boolean).join(" ");
  return { ...again, ...(said ? { stashNote: said } : {}), ...(kept ? { stashKept: true as const } : {}) };
}

/** One run through the door; `staging` when a stash's `index` was refused. */
async function applyOnce(
  ctx: GitContext,
  op: ApplyOp,
  stashFirst: unknown,
): Promise<DoorApplied | { staging: true; result: GitRunResult; stashNote?: string }> {
  if (stashFirst !== undefined) {
    const refused = await retryRefused(ctx, stashFirst);
    if (refused) return { answer: refused };
    const out = await stashAndRetry(ctx.process, op);
    if (out.blocked) {
      return { answer: blockedAnswer(out.blocked) };
    }
    if (out.indexBusy) {
      return { staging: true, result: out.result };
    }
    if (out.stashFailed) {
      return { answer: stashFailedAnswer(out) };
    }
    if (out.inTheWay) {
      return { answer: inTheWayAnswer(ctx, out.inTheWay) };
    }
    const note = stashRetryNote(out);
    if (out.indexRefused) {
      return note ? { staging: true, result: out.result, stashNote: note } : { staging: true, result: out.result };
    }
    return note ? { result: out.result, stashNote: note } : { result: out.result };
  }
  const { result, inTheWay, blocked, indexBusy, indexRefused, stashGone } = await runApplying(ctx.process, op);
  if (blocked) return { answer: blockedAnswer(blocked) };
  // Named by sha, and gone from the list between the page's check and git
  // running: nothing ran. It answered git's empty "not run" before, which
  // read as "The operation failed." and was filed.
  if (stashGone) return { answer: stashGoneAnswer() };
  if (indexBusy || indexRefused) return { staging: true, result };
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
    const refused = await retryRefused(ctx, stashFirst);
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
 *
 * "The repository" is a folder, not a string: see {@link sameRepository}.
 */
async function retryRefused(ctx: GitContext, stashFirst: unknown): Promise<CommitActionResult | undefined> {
  if (typeof stashFirst !== "string") {
    return { ok: false, changed: false, message: "That isn't a repository to stash and retry in." };
  }
  if (!(await sameRepository(stashFirst, ctx.root))) {
    return {
      ok: false,
      changed: false,
      expected: true,
      message: "Another repository is open now, so nothing was stashed or run.",
    };
  }
  return undefined;
}

const pathsOn = (platform: string) => (platform === "win32" ? win32 : posix);

/**
 * Whether two paths spell the same folder, by their text alone — git-service's
 * one rule for that (folderPath's sameFolder, without the disk): `/` against
 * `\`, a trailing separator and a `..` fall away; and on Windows regardless
 * of case, which its file system ignores. A relative path names no folder
 * here (resolving it would ask this process's working directory, which is
 * nobody's answer). Pure, so the Windows rules are tested on any machine with
 * `platform: "win32"`.
 */
export function sameFolderSpelling(a: string, b: string, platform: string = process.platform): boolean {
  const paths = pathsOn(platform);
  if (!paths.isAbsolute(a) || !paths.isAbsolute(b)) return false;
  return sameFolder(a, b, { platform, realpath: null });
}

/**
 * Whether `a` and `b` are one repository's folder.
 *
 * The renderer sends a refusal's own `root` back unchanged (renderer/
 * bridge.ts), so the text agrees and the disk is never asked. When it does
 * not, the file system settles it: the native realpath sees through a symlink
 * (/var is /private/var on macOS) and through a Windows 8.3 short name to the
 * long one — os.tmpdir() on a CI runner is C:\Users\RUNNER~1\…, and git names
 * the same folder C:/Users/runneradmin/…. No text rule can expand RUNNER~1.
 * A folder that is not there is not the open repository.
 */
export async function sameRepository(
  a: string,
  b: string,
  platform: string = process.platform,
  real: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (sameFolderSpelling(a, b, platform)) return true;
  const paths = pathsOn(platform);
  if (!paths.isAbsolute(a) || !paths.isAbsolute(b)) return false;
  const onDisk = async (p: string): Promise<string | undefined> => {
    try {
      return await real(p);
    } catch {
      return undefined;
    }
  };
  const [x, y] = await Promise.all([onDisk(a), onDisk(b)]);
  return x !== undefined && y !== undefined && sameFolderSpelling(x, y, platform);
}

/**
 * The stash a Stash & Retry needed could not be made (or, for a stash applied
 * over changes, the stash it named is gone). Nothing was run. A stash that is
 * gone is the user's state, said as the extension says it; git failing to
 * stash is a genuine failure, and stays reportable.
 */
function stashFailedAnswer(out: StashRetryOutcome): CommitActionResult {
  if (out.stashGone) return stashGoneAnswer();
  return {
    ok: false,
    changed: false,
    message: `Couldn't stash your changes, so nothing ran — ${out.stashFailed}`,
  };
}

/** The stash the request named has left the list (popped or dropped since
 *  the page drew it): nothing ran. The user's state. */
export function stashGoneAnswer(): CommitActionResult {
  return { ok: false, changed: false, expected: true, message: STASH_GONE_MESSAGE };
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
