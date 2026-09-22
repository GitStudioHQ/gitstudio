import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationOutcome } from "@gitstudio/host-bridge/conflictsProtocol";
import { outcomeLine } from "../src/outcome";
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
