import type { GitProcess, GitRunOptions } from "./GitProcess";
import * as l10n from "@vscode/l10n";

// Putting a dropped stash back WHERE IT WAS — for both products' Undo.
//
// Dropping a stash only removes its reflog entry: the commit behind it is still
// in the object store, and `git stash store <sha>` makes it a stash again. But
// `store` only ever pushes on TOP of the stack, so an Undo of "Drop stash@{1}"
// used to bring the stash back as stash@{0}, above the one that had been above
// it. Nothing was lost; the list simply no longer said what it said before.
//
// git has no "insert at" either, so this lifts the entries that were above it
// off the stack (each one's sha and message held, and each one only a reflog
// entry — lifting it deletes nothing), stores the dropped one, and stores the
// lifted ones back on top in their order. It does that only while the entries
// above are EXACTLY the ones that were there when it was dropped; if the stack
// has changed since, the stash goes on top instead and the answer says so.
// Any store that fails is reported with the sha that brings it back by hand.

/** One stash entry as the stack lists it: its commit and its reflog message. */
export interface StashSlot {
  sha: string;
  /** The reflog subject (`%gs`) — what `git stash store -m` writes back. */
  message: string;
}

/** Where a stash sat when it was dropped. */
export interface StashPlace {
  /** Its index then: stash@{index}. */
  index: number;
  /** The shas of the entries above it then, newest first (`index` of them). */
  above: string[];
}

export type StashRestoreResult =
  | { ok: true; /** Where it landed. */ index: number; /** It was already on the stack. */ already?: true }
  | { ok: false; expected?: true; message: string };

const SEP = "\x1f";

/** The stash stack, newest first. Empty when there are no stashes (or git can't say). */
export async function stashStack(proc: GitProcess, opts?: GitRunOptions): Promise<StashSlot[]> {
  const r = await proc.run(["stash", "list", `--format=%H${SEP}%gs`], opts);
  if (r.code !== 0) return [];
  const out: StashSlot[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const cut = line.indexOf(SEP);
    const sha = (cut < 0 ? line : line.slice(0, cut)).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) continue;
    out.push({ sha, message: cut < 0 ? "" : line.slice(cut + 1) });
  }
  return out;
}

/** Whether `place` can be honoured on `stack`: the entries above it are the same ones, in order. */
export function placeHolds(stack: readonly StashSlot[], place: StashPlace | undefined): boolean {
  if (!place || place.index <= 0) return false;
  if (place.above.length !== place.index || stack.length < place.index) return false;
  return place.above.every((sha, i) => stack[i]?.sha === sha);
}

async function store(proc: GitProcess, slot: StashSlot, opts?: GitRunOptions): Promise<boolean> {
  const args = ["stash", "store"];
  if (slot.message) args.push("-m", slot.message);
  args.push(slot.sha);
  return (await proc.run(args, opts)).code === 0;
}

/**
 * Put `entry` back on the stash stack — at `place` while that still holds,
 * else on top. A sha that is already a stash is left alone (`already`).
 */
export async function restoreStash(
  proc: GitProcess,
  entry: StashSlot,
  place?: StashPlace,
  opts?: GitRunOptions,
): Promise<StashRestoreResult> {
  if (!/^[0-9a-f]{40,64}$/i.test(entry.sha)) {
    return { ok: false, message: l10n.t("That isn't a stash this app recorded.") };
  }
  // A sha that is not a commit would become a stash ref pointing at nothing.
  const kind = await proc.run(["cat-file", "-t", entry.sha], opts);
  if (kind.code !== 0 || kind.stdout.trim() !== "commit") {
    return { ok: false, expected: true, message: l10n.t("That stash is no longer in the repository.") };
  }
  const stack = await stashStack(proc, opts);
  const at = stack.findIndex((s) => s.sha === entry.sha);
  if (at >= 0) return { ok: true, index: at, already: true };

  const n = placeHolds(stack, place) ? place!.index : 0;
  const lifted = stack.slice(0, n);
  // Lift the entries above its old place: the top one each time.
  for (let i = 0; i < n; i++) {
    const d = await proc.run(["stash", "drop", "-q", "stash@{0}"], opts);
    if (d.code !== 0) {
      // Put back what was lifted so far, newest last, and stop with nothing else changed.
      const back = await restack(proc, lifted.slice(0, i), opts);
      return {
        ok: false,
        message:
          `Couldn't make room for the stash at stash@{${n}} (${d.stderr.trim() || "git stash drop failed"}).` +
          (back ? "" : l10n.t(" Some stashes may need putting back: {0}.", lifted.slice(0, i).map((s) => `git stash store ${s.sha}`).join("; "))),
      };
    }
  }
  const stored = await store(proc, entry, opts);
  const back = await restack(proc, lifted, opts);
  if (!stored) {
    return {
      ok: false,
      message: l10n.t("Couldn't put the stash back. `git stash store {0}` brings it back by hand.", entry.sha),
    };
  }
  if (!back) {
    return {
      ok: false,
      message:
        l10n.t("The stash is back, but the ones that were above it couldn't all be put back on top: ") +
        l10n.t("{0} brings them back.", lifted.map((s) => `git stash store ${s.sha}`).join("; ")),
    };
  }
  return { ok: true, index: n };
}

/** Store `lifted` (newest first) back on top, so the newest ends on top. */
async function restack(proc: GitProcess, lifted: readonly StashSlot[], opts?: GitRunOptions): Promise<boolean> {
  let ok = true;
  for (let i = lifted.length - 1; i >= 0; i--) {
    if (!(await store(proc, lifted[i], opts))) ok = false;
  }
  return ok;
}
