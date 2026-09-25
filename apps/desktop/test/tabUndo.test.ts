// Undo, per repository tab (issue #32, row 15 of docs/desktop-repo-tabs.md).
//
// An undo is a promise about ONE repository: "restore the branch I deleted"
// run in another would create a branch nobody asked for. With one repository
// open, a switch simply forgot the stack; with tabs a switch is constant, so
// each tab keeps its own, ⌘Z reads only the one in front, and an entry
// refuses to run anywhere but the tab it was recorded in.
//
// undo.ts reaches dialogs.ts (toasts) and, through it, the bridge — so a
// minimal window/document goes in first.

import { test, before } from "node:test";
import assert from "node:assert/strict";

const toasts: string[] = [];
/** Every element the toasts built, with their click handlers — so a check can
 *  press a toast's Undo the way a person would. */
const created: Array<{ textContent: string; handlers: Record<string, () => void> }> = [];
function fakeEl(): Record<string, unknown> {
  const handlers: Record<string, () => void> = {};
  const node: Record<string, unknown> = {
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    setAttribute() {},
    append(...kids: Array<{ textContent?: string }>) {
      for (const k of kids) if (k && typeof k.textContent === "string" && k.textContent) toasts.push(k.textContent);
    },
    appendChild() {},
    addEventListener(type: string, fn: () => void) {
      handlers[type] = fn;
    },
    remove() {},
    isConnected: true,
    textContent: "",
    handlers,
  };
  created.push(node as unknown as { textContent: string; handlers: Record<string, () => void> });
  return node;
}
const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  gitstudio: { invoke: async () => undefined, on: () => () => {} },
  setTimeout,
  clearTimeout,
  addEventListener() {},
};
g.document = { getElementById: () => null, createElement: fakeEl, body: { appendChild() {}, children: [] } };
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
g.navigator = { userAgent: "node", platform: "MacIntel" };

type Undo = typeof import("../src/renderer/undo");
let u!: Undo;
before(async () => {
  u = (await import("../src/renderer/undo")) as Undo;
});

test("each tab keeps its own undo stack; ⌘Z reads only the tab in front", async () => {
  const ran: string[] = [];
  u.setUndoScope(1);
  u.push({ label: "Restore branch a-topic", undo: () => void ran.push("A") });
  u.setUndoScope(2);
  assert.equal(u.undoDepth(), 0, "tab B has nothing to undo");
  await u.undoLast();
  assert.deepEqual(ran, [], "⌘Z in B never reaches A's entry");
  u.push({ label: "Restore tag b1", undo: () => void ran.push("B") });
  u.setUndoScope(1);
  assert.equal(u.undoDepth(), 1, "A's entry survived the trip to B and back");
  await u.undoLast();
  assert.deepEqual(ran, ["A"]);
  u.setUndoScope(2);
  await u.undoLast();
  assert.deepEqual(ran, ["A", "B"]);
});

test("a toast's Undo pressed after a switch refuses — it belongs to the tab it was offered in", async () => {
  const ran: string[] = [];
  u.setUndoScope(3);
  const before = created.length;
  u.didUndoable("Deleted branch x", { label: "Restore branch x", undo: () => void ran.push("x") });
  const undoButton = created.slice(before).find((n) => n.textContent === "Undo");
  assert.ok(undoButton?.handlers.click, "the toast offers Undo");
  // A switch clears the toasts; this is the rule behind that, for a toast that
  // was somehow still there to press.
  u.setUndoScope(4);
  undoButton!.handlers.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ran, [], "tab 4 cannot run tab 3's undo");
  assert.ok(toasts.some((t) => /belongs to another tab/.test(t)), "and says why, in words");
  u.setUndoScope(3);
  assert.equal(u.undoDepth(), 1, "the entry is still waiting in its own tab");
  await u.undoLast();
  assert.deepEqual(ran, ["x"]);
});

test("a closed tab's entries are gone with it", async () => {
  u.setUndoScope(5);
  u.push({ label: "Restore stash", undo: () => undefined });
  u.dropUndoScope(5);
  u.setUndoScope(5);
  assert.equal(u.undoDepth(), 0);
});
