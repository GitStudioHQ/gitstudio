// The tab row's rules (issue #32), cell by cell: stepping, the number keys,
// who is in front after a close (the SAME rule main's RepoStore applies), the
// keyboard table on both platforms, and the change mark's words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { afterClose, changeMark, stepTab, tabAtDigit, tabKeyAction, tabLabel } from "../src/renderer/tabModel";
import { RepoStore } from "../src/main/repoStore";
import type { GitContext } from "@gitstudio/git-service/index";

const ROW = ["/a", "/b", "/c"];

test("Ctrl+Tab steps right and wraps; Ctrl+Shift+Tab steps left and wraps", () => {
  assert.equal(stepTab(ROW, "/a", 1), "/b");
  assert.equal(stepTab(ROW, "/c", 1), "/a", "wraps at the end");
  assert.equal(stepTab(ROW, "/a", -1), "/c", "wraps at the start");
  assert.equal(stepTab(ROW, "/b", -1), "/a");
  assert.equal(stepTab(["/a"], "/a", 1), "/a", "one tab steps to itself");
  assert.equal(stepTab([], undefined, 1), undefined);
  assert.equal(stepTab(ROW, undefined, 1), "/a", "from no tab, the first");
  assert.equal(stepTab(ROW, undefined, -1), "/c", "…or the last");
});

test("the number keys: 1–8 by position, 9 is always the last, past the end is nothing", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `/r${i}`);
  assert.equal(tabAtDigit(ten, 1), "/r0");
  assert.equal(tabAtDigit(ten, 8), "/r7");
  assert.equal(tabAtDigit(ten, 9), "/r9", "9 is the tenth of ten");
  assert.equal(tabAtDigit(ROW, 9), "/c", "9 is the third of three");
  assert.equal(tabAtDigit(ROW, 5), undefined, "no fifth tab: nothing, not the last by accident");
  assert.equal(tabAtDigit(ROW, 0), undefined);
  assert.equal(tabAtDigit([], 1), undefined);
});

test("after a close, the renderer and main agree on who is in front — every position", async () => {
  for (const active of ROW) {
    for (const closing of ROW) {
      const store = new RepoStore([], {
        discover: async (c) => c,
        realpath: (p) => p,
        createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
      });
      for (const r of ROW) await store.openTab(r);
      store.activate(active);
      store.closeTab(closing);
      assert.equal(
        afterClose(ROW, closing, active),
        store.state().active,
        `closing ${closing} with ${active} in front`,
      );
    }
  }
  assert.equal(afterClose(["/a"], "/a", "/a"), undefined, "the last tab leaves nothing in front");
});

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}, code?: string) => ({
  key: k,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

test("the keyboard table, macOS", () => {
  const mac = (e: ReturnType<typeof key>) => tabKeyAction(e, true);
  assert.deepEqual(mac(key("Tab", { ctrl: true })), { kind: "next" });
  assert.deepEqual(mac(key("Tab", { ctrl: true, shift: true })), { kind: "prev" });
  assert.deepEqual(mac(key("PageDown", { ctrl: true })), { kind: "next" });
  assert.deepEqual(mac(key("PageUp", { ctrl: true })), { kind: "prev" });
  assert.deepEqual(mac(key("3", { ctrl: true }, "Digit3")), { kind: "digit", n: 3 });
  assert.equal(mac(key("3", { meta: true }, "Digit3")), undefined, "⌘3 is the rail's third view, not a tab");
  assert.equal(mac(key("£", { alt: true }, "Digit3")), undefined, "⌥3 types a character on a Mac");
  assert.deepEqual(mac(key("w", { meta: true })), { kind: "close" });
  assert.equal(mac(key("w", { meta: true, shift: true })), undefined, "⌘⇧W is not ⌘W");
  assert.equal(mac(key("w", { ctrl: true })), undefined, "⌃W is kill-word in a text field");
  assert.equal(mac(key("Tab")), undefined, "plain Tab moves focus");
  assert.equal(mac(key("Tab", { meta: true })), undefined, "⌘Tab is the OS's app switcher");
});

test("the keyboard table, Windows and Linux", () => {
  const pc = (e: ReturnType<typeof key>) => tabKeyAction(e, false);
  assert.deepEqual(pc(key("Tab", { ctrl: true })), { kind: "next" });
  assert.deepEqual(pc(key("Tab", { ctrl: true, shift: true })), { kind: "prev" });
  assert.deepEqual(pc(key("2", { alt: true }, "Digit2")), { kind: "digit", n: 2 });
  assert.equal(pc(key("2", { ctrl: true }, "Digit2")), undefined, "Ctrl+2 is the rail's second view");
  assert.deepEqual(pc(key("w", { ctrl: true })), { kind: "close" });
  assert.equal(pc(key("w", { meta: true })), undefined);
  assert.equal(pc(key("w", { ctrl: true, shift: true })), undefined, "Ctrl+Shift+W closes the window, not the tab");
});

test("the change mark: a count, or nothing — never zero", () => {
  assert.equal(changeMark(3), "●3");
  assert.equal(changeMark(0), "", "a clean tree wears nothing");
  assert.equal(changeMark(undefined), "", "an unanswered probe wears nothing");
  assert.equal(tabLabel("webapp", 1, undefined), "webapp, 1 changed file");
  assert.equal(tabLabel("webapp", 4, "a push"), "webapp, 4 changed files, a push running");
  assert.equal(tabLabel("webapp", 0, undefined), "webapp");
});

test("row 14: a tab whose folder is gone says so in its name — and claims no count", () => {
  assert.equal(tabLabel("webapp", undefined, undefined, true), "webapp, folder not found");
  assert.equal(tabLabel("webapp", 4, undefined, true), "webapp, folder not found", "a stale count is not repeated");
  assert.equal(tabLabel("webapp", undefined, "a push", true), "webapp, folder not found, a push running");
});
