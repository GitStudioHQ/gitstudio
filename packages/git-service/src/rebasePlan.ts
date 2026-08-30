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
//   · rewords. RebaseRunner looks these up BY SHA when git opens the editor.
//     They used to be a bare list popped once per editor call, which is only
//     correct while nothing interrupts the run — see `rewords` below.
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
  | {
      ok: true;
      todo: string;
      /**
       * Reword messages keyed by the commit they belong to.
       *
       * `rewordMessages` below is the same data as a bare list, and a bare list
       * is only usable by COUNTING editor invocations — which stops being
       * correct the moment a rebase pauses. `git rebase --continue` opens the
       * editor for the commit that stopped, whatever its verb, so a conflicted
       * `pick` consumed the next reword's text and every later message landed
       * one commit early. Keyed by sha there is nothing to count.
       */
      rewords: Array<{ sha: string; message: string }>;
    }
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

  // An update-ref line means "this branch points HERE", so it must travel with
  // its own commit through any reorder — detached from it, the branch lands
  // somewhere arbitrary. (Proved by getting it wrong once: swapping a pick with
  // the update-ref line above it moved a branch onto the commit BEFORE the
  // range began.)
  //
  // "With its commit" is not "on the next line", though. A squash or fixup
  // AMENDS the commit above it, and git records an update-ref the moment it
  // reaches that line — so `pick c2 / update-ref refs/heads/feature / fixup c3`
  // points the branch at c2 and then rewrites c2, leaving the branch on a
  // commit that is no longer in the history. Verified against git 2.49:
  // `merge-base --is-ancestor feature HEAD` fails, which is exactly the
  // orphaning `--update-refs` exists to prevent. git's own `--autosquash`
  // emits `pick c2 / fixup fixup!c2 / update-ref …`, after the fold.
  //
  // So each row's refs are emitted after the LAST row that folds into it.
  // `drop` is transparent when scanning forward — `pick c2 / update-ref /
  // drop c3 / fixup c4` still orphans, because the fixup after the dropped row
  // folds into c2 all the same.
  const FOLDS = new Set(["squash", "fixup"]);
  /** The index of the last row that folds into `i`, or `i` itself. */
  const foldEnd = (i: number): number => {
    let end = i;
    for (let j = i + 1; j < plan.length; j++) {
      if (FOLDS.has(plan[j].action)) end = j;
      else if (plan[j].action === "drop") continue;
      else break;
    }
    return end;
  };

  // Refs to emit after each row, keyed by the row that ends its fold run.
  const refsAfter = new Map<number, string[]>();
  plan.forEach((r, i) => {
    // A DROPPED commit is not in the rewritten history at all, so there is
    // nothing for its branch to point at; git's own --update-refs writes a
    // comment rather than a line, and moving the branch anyway would put it
    // somewhere the user never asked for.
    if (!opts?.updateRefs || r.action === "drop") return;
    const names = (r.branches ?? []).filter(isSafeBranchName);
    if (!names.length) return;
    const at = foldEnd(i);
    refsAfter.set(at, [...(refsAfter.get(at) ?? []), ...names]);
  });

  const lines: string[] = [];
  plan.forEach((r, i) => {
    lines.push(`${r.action} ${r.sha} ${oneLine(r.subject)}`.trimEnd());
    for (const branch of refsAfter.get(i) ?? []) {
      lines.push(`update-ref refs/heads/${branch}`);
    }
  });
  const todo = lines.join("\n") + "\n";
  const rewords = plan
    .filter((r) => r.action === "reword")
    .map((r) => ({ sha: r.sha, message: (r.message ?? "").trim() || r.subject }));

  return { ok: true, todo, rewords };
}
