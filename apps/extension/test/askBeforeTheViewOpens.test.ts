// Crash-report fix #18 as the r0923 end-to-end run found it in VS Code: the
// Commit Graph's Revert over an uncommitted edit, with the GitStudio Changes
// view never opened in the window. `<view>.focus` returns before VS Code
// resolves a never-opened view, so the Stash & Retry question found no view,
// counted as Cancel, and nothing ran — then the Undo envelope said "Undid?
// Revert <sha>" with an Undo, as if something had.
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
const { UndoLedger, nothingRan } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
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

test("nothing ran — a cancel — records no undo entry and shows no 'Undid?' toast; a real run does", async () => {
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
    ctx: { snapshot: { capture: async (label: string) => ({ label, headSha: "a".repeat(40) }) } },
  };
  vscode.__said.length = 0;

  assert.equal(await ledger.runWithUndo(repo as never, "Revert 1a2b3c4", async () => false), false);
  assert.equal(await ledger.runWithUndo(repo as never, "Pop stash@{0}", async () => ({ cancelled: true as const })).then((r) => r.cancelled), true);
  assert.deepEqual(vscode.__said.filter((s) => /Undid\?/.test(s.message)), [], "nothing is offered to undo");
  assert.equal((state.get("gitstudio.undoLedger.v1") as Record<string, unknown[]> | undefined)?.["/r"], undefined);

  assert.equal(await ledger.runWithUndo(repo as never, "Revert 1a2b3c4", async () => true), true);
  assert.deepEqual(
    vscode.__said.filter((s) => /Undid\?/.test(s.message)).map((s) => s.message),
    ["Undid? Revert 1a2b3c4"],
  );

  assert.equal(nothingRan(false), true);
  assert.equal(nothingRan({ cancelled: true }), true);
  assert.equal(nothingRan(true), false);
  assert.equal(nothingRan({ ok: false }), false, "a failure ran something: its snapshot stays reachable");
  assert.equal(nothingRan(undefined), false);
});
