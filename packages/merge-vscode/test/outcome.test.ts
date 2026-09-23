import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationOutcome } from "@gitstudio/host-bridge/conflictsProtocol";
import { continueRefusal, outcomeLine, verbConfirm } from "../src/outcome";
import { view } from "./fixtures";

const o = (x: Partial<OperationOutcome>): OperationOutcome => ({
  ok: false,
  view: view("none"),
  remainingConflicts: 0,
  ...x,
});

test("ok → done, in the operation's own words (named from BEFORE the verb)", () => {
  assert.deepEqual(outcomeLine(o({ ok: true }), "continue", view("rebase")), { kind: "done", text: "Rebase complete." });
  assert.deepEqual(outcomeLine(o({ ok: true }), "continue", view("merge")), { kind: "done", text: "Merge complete." });
  assert.equal(outcomeLine(o({ ok: true }), "abort", view("cherry-pick")).text, "Cherry-pick cancelled — the repository is back where it was before.");
  assert.equal(outcomeLine(o({ ok: true, message: "Rebase complete — 3 commits." }), "continue", view("rebase")).text, "Rebase complete — 3 commits.");
});

test("stopped → stopped, naming the step git stopped at", () => {
  const next = view("rebase", { step: { n: 2, m: 3, unit: "commit" } });
  assert.deepEqual(outcomeLine(o({ stopped: true, view: next }), "continue", view("rebase")), {
    kind: "stopped",
    text: "Stopped at commit 2 of 3 — it has conflicts to resolve.",
  });
  const paused = view("rebase", { pause: { reason: "edit", detail: "Paused to edit 1a2b3c4 fix" } });
  assert.equal(outcomeLine(o({ stopped: true, view: paused }), "continue", view("rebase")).text, "Paused: Paused to edit 1a2b3c4 fix");
});

test("anything else → failed, with git's reason, or the refusal in plain words", () => {
  assert.deepEqual(outcomeLine(o({ message: "could not apply 1a2b3c4" }), "continue", view("rebase")), {
    kind: "failed",
    text: "could not apply 1a2b3c4",
  });
  const blocked = view("rebase", { continueBlocked: "a.txt still has conflict markers staged" });
  assert.equal(outcomeLine(o({ refused: "blocked", view: blocked }), "continue", view("rebase")).text, "a.txt still has conflict markers staged");
  const drop = view("rebase", { willDrop: { sha: "1a2b3c4d5e", subject: "T3", branch: "test" } });
  assert.match(outcomeLine(o({ refused: "confirm-drop", view: drop }), "continue", view("rebase")).text, /drops 1a2b3c4 T3/);
  assert.equal(outcomeLine(o({ refused: "not-allowed" }), "skip", view("merge")).text, "There is nothing git can skip here.");
});

// ── Per-operation words (P4 review) ─────────────────────────────────────────
//
// The sentences were built from one noun per operation, and for `git am` and
// a stash apply the noun is a gerund: "before the applying the stash started",
// "git can't continue the applying patches yet", "Applying the stash
// cancelled — …". Every sentence is now written per operation.

test("every operation's outcome reads as a sentence", () => {
  assert.equal(outcomeLine(o({ ok: true }), "continue", view("am")).text, "All patches applied.");
  assert.equal(outcomeLine(o({ ok: true }), "skip", view("am")).text, "Last patch skipped — the series is finished, without it.");
  assert.equal(
    outcomeLine(o({ ok: true }), "abort", view("am")).text,
    "Patch series abandoned — the branch is back where it was before it started.",
  );
  assert.equal(
    outcomeLine(o({ ok: true }), "abort", view("stash")).text,
    "Stash apply cancelled — the files are back as they were, and the stash is still in your list.",
  );
  assert.equal(
    outcomeLine(o({ ok: true }), "abort", view("none")).text,
    "The conflicted files are back to their last committed versions.",
  );
  assert.equal(outcomeLine(o({ ok: true }), "skip", view("rebase")).text, "Last commit skipped — the rebase is complete, without it.");
  for (const kind of ["merge", "rebase", "rebase-merge-step", "cherry-pick", "revert", "am", "stash", "none"] as const) {
    for (const verb of ["continue", "skip", "abort"] as const) {
      const text = outcomeLine(o({ ok: true }), verb, view(kind)).text;
      assert.doesNotMatch(text, /the applying|Applying \w+ (complete|cancelled|skipped)|: skipped/i, `${kind} ${verb}: ${text}`);
    }
  }
});

test("the confirms say what each verb costs, per operation — the dashboard's own words", () => {
  const am = verbConfirm(view("am"), "abort");
  assert.equal(am.title, "Abandon this patch series?");
  assert.doesNotMatch(am.message, /the applying/i);
  const stash = verbConfirm(view("stash"), "abort");
  assert.match(stash.message, /stash itself stays in your stash list/);
  assert.doesNotMatch(stash.message, /the applying/i);
  const none = verbConfirm(view("none"), "abort");
  assert.match(none.message, /staged/i, "reset --merge also discards what was staged — the confirm says so");
  const rebase = verbConfirm(view("rebase"), "abort");
  assert.equal(rebase.title, "Abort the rebase?");
  const skip = verbConfirm(view("am", { verbs: { abort: "Abort (git am)", skip: "Skip patch" } }), "skip");
  assert.equal(skip.title, "Skip patch?");
  assert.match(skip.message, /patch git is stuck on/);
});

test("why Continue is not offered, per operation (never 'the applying patches')", () => {
  assert.equal(continueRefusal(view("am", { verbs: { abort: "Abort (git am)" } })), "There is nothing to continue in the patch series.");
  assert.equal(continueRefusal(view("none")), "Nothing is in progress.");
  assert.equal(
    continueRefusal(view("am", { verbs: { abort: "x", continue: "Continue (git am)" }, canContinue: false })),
    "git can't continue the patch series yet.",
  );
  assert.equal(
    continueRefusal(
      view("rebase", { verbs: { abort: "x", continue: "Continue Rebase" }, canContinue: false, continueBlocked: "Resolve a.txt first." }),
    ),
    "Resolve a.txt first.",
  );
});
