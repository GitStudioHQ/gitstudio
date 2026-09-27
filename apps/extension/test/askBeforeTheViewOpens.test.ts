// Crash-report fix #18 as the r0923 end-to-end run found it in VS Code: the
// Commit Graph's Revert over an uncommitted edit, with the GitStudio Changes
// view never opened in the window. `<view>.focus` returns before VS Code
// resolves a never-opened view, so the Stash & Retry question found no view,
// counted as Cancel, and nothing ran — then the Undo envelope offered Undo
// for "Revert <sha>", as if something had.
//
// - Arrival: the asker waits for the view to arrive (it used to look once).
// - UndoLedger: a result that says nothing ran records no entry and says
//   nothing.

import Module from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { __said: { kind: string; message: string }[] };
const { Arrival } = require("../src/ui/arrival") as typeof import("../src/ui/arrival");
const { UndoLedger, nothingRan, outcomeOf } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
/* eslint-enable @typescript-eslint/no-require-imports */

test("a view resolved AFTER .focus returned is still the one the dialog is shown in", async () => {
  const arrival = new Arrival<{ id: string }>();
  const view = { id: "changes" };
  // What VS Code does for a never-opened view: focus resolves, the view comes a moment later.
  const focus = async (): Promise<void> => {
    setTimeout(() => arrival.set(view), 40);
  };
  await focus();
  assert.equal(arrival.get(), undefined, "the view is not there when focus returns — the old code gave up here");
  assert.equal(await arrival.wait(2000), view);
  // Already there: at once. Gone (disposed): waits again, and times out to undefined.
  assert.equal(await arrival.wait(0), view);
  arrival.clear(view);
  assert.equal(await arrival.wait(30), undefined);
});

test("nothing ran — a cancel — records no undo entry and offers no Undo; a real run does", async () => {
  const state = new Map<string, unknown>();
  const context = {
    workspaceState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => void state.set(k, v),
    },
  };
  const repos = { getActive: () => undefined };
  const ledger = new UndoLedger(repos as never, context as never);
  const repo = {
    root: "/r",
    // settle + changed: the envelope records only an op that changed something;
    // this one says it did, so what is under test is the cancel alone.
    ctx: {
      snapshot: {
        capture: async (label: string) => ({ label, headSha: "a".repeat(40) }),
        settle: async () => {},
        changed: () => true,
      },
    },
  };
  vscode.__said.length = 0;

  assert.equal(await ledger.runWithUndo(repo as never, "Revert 1a2b3c4", async () => false), false);
  assert.equal(await ledger.runWithUndo(repo as never, "Pop stash@{0}", async () => ({ cancelled: true as const })).then((r) => r.cancelled), true);
  assert.deepEqual(vscode.__said, [], "nothing is offered to undo");
  assert.equal((state.get("gitstudio.undoLedger.v2") as Record<string, unknown[]> | undefined)?.["/r"], undefined);

  // It says what happened — the operation is DONE — not "Undid? Revert …",
  // which read as if it had been undone.
  assert.equal(await ledger.runWithUndo(repo as never, "Revert 1a2b3c4", async () => true), true);
  assert.deepEqual(
    vscode.__said.map((s) => s.message),
    ["Revert 1a2b3c4 — done."],
  );
  // A run that reports a failure still ran something (its snapshot stays
  // reachable), but is not "done".
  vscode.__said.length = 0;
  assert.deepEqual(await ledger.runWithUndo(repo as never, "Pop stash@{0}", async () => ({ ok: false })), { ok: false });
  assert.deepEqual(
    vscode.__said.map((s) => s.message),
    ["Pop stash@{0} did not finish."],
  );

  assert.equal(nothingRan(false), true);
  assert.equal(nothingRan({ cancelled: true }), true);
  assert.equal(nothingRan(true), false);
  assert.equal(nothingRan({ ok: false }), false, "a failure ran something: its snapshot stays reachable");
  assert.equal(nothingRan(undefined), false);
});

test("the toast's word is what the op came to: stopped when settle saw git left waiting, whatever the door answered", () => {
  const snap = (op?: { kind: "cherry-pick" | "rebase" }, deferred?: object) =>
    ({ label: "x", headSha: "a".repeat(40), stashSha: null, ref: null, scope: { settled: { ...(op ? { op } : {}) }, ...(deferred ? { deferred } : {}) } }) as never;
  // The doors that stop answer `true` or a RebaseOutcome — never { ok: false }.
  assert.equal(outcomeOf(snap({ kind: "cherry-pick" }), true), "stopped");
  assert.equal(outcomeOf(snap({ kind: "rebase" }), { status: "stopped", reason: "conflict", message: "" }), "stopped");
  assert.equal(outcomeOf(snap(), { status: "stopped", reason: "conflict", message: "" }), "stopped");
  // An interactive rebase handed to a terminal is MEANT to be under way.
  assert.equal(outcomeOf(snap({ kind: "rebase" }, {}), undefined), "done");
  // Failures, by every shape a door answers with.
  assert.equal(outcomeOf(snap(), { ok: false }), "failed");
  assert.equal(outcomeOf(snap(), { status: "failed", message: "no" }), "failed");
  assert.equal(outcomeOf(snap(), { result: { code: 1, stdout: "", stderr: "CONFLICT" } }), "failed", "a pop that kept its stash");
  // Done.
  assert.equal(outcomeOf(snap(), { result: { code: 0, stdout: "", stderr: "" } }), "done");
  assert.equal(outcomeOf(snap(), { status: "done" }), "done");
  assert.equal(outcomeOf(snap(), true), "done");
  assert.equal(outcomeOf(snap(), undefined), "done");
});
