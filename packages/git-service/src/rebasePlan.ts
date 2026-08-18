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
}

export type RebasePlanResult =
  | { ok: true; todo: string; rewordMessages: string[] }
  | { ok: false; message: string };

/** Actions we will write into a todo file. Anything else is a caller bug. */
const TODO_ACTIONS = new Set(["pick", "reword", "edit", "squash", "fixup", "drop"]);

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
export function buildRebasePlan(displayRows: readonly RebasePlanRow[]): RebasePlanResult {
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

  const todo =
    plan.map((r) => `${r.action} ${r.sha} ${oneLine(r.subject)}`.trimEnd()).join("\n") + "\n";
  const rewordMessages = plan
    .filter((r) => r.action === "reword")
    .map((r) => (r.message ?? "").trim() || r.subject);

  return { ok: true, todo, rewordMessages };
}
