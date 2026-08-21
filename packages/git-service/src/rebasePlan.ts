// Turning the rebase planner's on-screen list into git's todo script.
//
// This is the one place display order becomes git order, and it is shared by the
// extension's rebase workspace and the desktop's Rebase view because getting it
// wrong is silent: the rebase reports success and the history is wrong.
//
// The list is NEWEST FIRST on screen, matching the Commits list (issue #18).
// git's todo file is the opposite — oldest first, replayed top to bottom — so the
// rows are reversed exactly once, here, and everything downstream works on the
// reversed plan.
//
// Two things depend on that and fail quietly if they are left reading the display
// order instead:
//
//   · rewordMessages. RebaseRunner queues these and pops one each time git opens
//     the editor, which happens once per `reword` IN TODO ORDER. Built from the
//     display array they would land on the wrong commits, with no error.
//   · squash/fixup meld into the entry BEFORE them in the file. After the flip
//     that is the row BELOW on screen, which is why the "first commit can't be a
//     squash" guard has to run against the reversed plan, not the visible top row.

/** One row of the plan, in the order the user sees it (newest first). */
export interface RebasePlanRow {
  sha: string;
  action: string;
  subject: string;
  /** The edited message for a `reword` row. */
  message?: string;
  /**
   * Local branches whose tip IS this commit. Only used when the caller opts
   * into carrying them along — see `updateRefs` in BuildOptions.
   */
  branches?: readonly string[];
}

export interface BuildOptions {
  /**
   * Carry other local branches along with the rewrite.
   *
   * Reordering commits gives them new shas. A branch pointing at one of the old
   * ones is NOT left untouched by that — it is left pointing at a commit that
   * is no longer in this branch's history, on a parallel line that nothing
   * references. Emitting `update-ref` moves it onto the rewritten commit
   * instead. Verified against git 2.49: the todo command works in a script we
   * compose ourselves, with no `--update-refs` flag on the command line.
   *
   * It only covers branches that POINT AT a rewritten commit. A branch with its
   * own commits on top has diverged and needs a `rebase --onto` of its own —
   * confirmed empirically, and out of scope here.
   *
   * Off by default: rewriting refs the user did not name should be something
   * they asked for.
   */
  updateRefs?: boolean;
}

export type RebasePlanResult =
  | { ok: true; todo: string; rewordMessages: string[] }
  | { ok: false; message: string };

/** Actions we will write into a todo file. Anything else is a caller bug. */
const TODO_ACTIONS = new Set(["pick", "reword", "edit", "squash", "fixup", "drop"]);

/**
 * A branch name safe to write into a todo script.
 *
 * Same reasoning as the action/sha validation below: this string becomes a
 * script git RUNS. A name carrying a newline would inject a second command, and
 * git's own ref rules already forbid every character rejected here.
 */
function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length < 256 &&
    !/[\s~^:?*[\\]/.test(name) &&
    !name.includes("..") &&
    !name.startsWith("-")
  );
}

/** Collapse a subject to one line — a newline would become a new todo command. */
function oneLine(subject: string): string {
  return subject.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build the todo script from DISPLAY-order rows (newest first).
 *
 * Returns the reasons a plan is refused rather than throwing, so both hosts can
 * show them the same way.
 */
export function buildRebasePlan(
  displayRows: readonly RebasePlanRow[],
  opts?: BuildOptions,
): RebasePlanResult {
  if (displayRows.length === 0) {
    return { ok: false, message: "Nothing to rebase." };
  }

  // The reversal. Everything below reads `plan`, never the display order.
  const plan = displayRows.slice().reverse();

  const firstKept = plan.find((r) => r.action !== "drop");
  if (firstKept && (firstKept.action === "squash" || firstKept.action === "fixup")) {
    return {
      ok: false,
      message: `The oldest commit can't be "${firstKept.action}" — there's nothing older for it to fold into.`,
    };
  }
  if (!plan.some((r) => r.action !== "drop")) {
    return { ok: false, message: "Dropping every commit would erase the whole range." };
  }

  // This string becomes a script git RUNS. TypeScript's union is erased at
  // runtime, so an unexpected action or a sha-shaped impostor is validated here
  // rather than trusted — an "exec" smuggled through would be executed.
  const bad = plan.find(
    (r) => !TODO_ACTIONS.has(r.action) || !/^[0-9a-fA-F]{4,40}$/.test(r.sha),
  );
  if (bad) {
    return {
      ok: false,
      message: `Refusing to rebase: unrecognised plan entry ${JSON.stringify(bad.action)}.`,
    };
  }

  // An update-ref line means "this branch points HERE", so it must sit
  // immediately after its own pick and travel with it through any reorder.
  // Detached from its commit the branch lands somewhere arbitrary — proved by
  // getting this wrong once: swapping a pick with the update-ref line above it
  // moved a branch onto the commit BEFORE the range began.
  const lines: string[] = [];
  for (const r of plan) {
    lines.push(`${r.action} ${r.sha} ${oneLine(r.subject)}`.trimEnd());
    if (!opts?.updateRefs || r.action === "drop") {
      continue;
    }
    for (const branch of r.branches ?? []) {
      if (isSafeBranchName(branch)) {
        lines.push(`update-ref refs/heads/${branch}`);
      }
    }
  }
  const todo = lines.join("\n") + "\n";
  const rewordMessages = plan
    .filter((r) => r.action === "reword")
    .map((r) => (r.message ?? "").trim() || r.subject);

  return { ok: true, todo, rewordMessages };
}
