// A menu command with no window to hear it (issue #32).
//
// Menu items hand their work to the renderer, and on macOS the app keeps
// running with its window closed: File ▸ Open Recent ▸ <repo> went nowhere
// and did nothing. The census at the bottom holds main.ts to routing every
// menu command through the one function that knows this.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuDelivery } from "../src/main/menuDelivery";

test("a window that is ready hears every command at once", () => {
  for (const c of ["openPath", "openRepo", "cloneRepo", "refresh", "undo", "closeTab"] as const) {
    assert.equal(menuDelivery("ready", c), "send");
  }
});

test("a window still loading hears it once it has loaded", () => {
  assert.equal(menuDelivery("loading", "openPath"), "afterLoad");
  assert.equal(menuDelivery("loading", "refresh"), "afterLoad");
});

test("with no window, opening a repository brings one back and then opens it", () => {
  assert.equal(menuDelivery("none", "openPath"), "createThenSend");
  assert.equal(menuDelivery("none", "openRepo"), "createThenSend");
  assert.equal(menuDelivery("none", "cloneRepo"), "createThenSend");
});

test("with no window, a command about the window's contents has nothing to act on", () => {
  for (const c of ["refresh", "closeTab", "closeRepo", "undo", "redo", "palette", "toggleSidebar", "toggleTerminal"] as const) {
    assert.equal(menuDelivery("none", c), "drop", c);
  }
});

test("main.ts sends every menu command through menuCommand, never straight at the window", () => {
  const src = readFileSync(join(__dirname, "../src/main/main.ts"), "utf8");
  const start = src.indexOf("function menuCommand(");
  assert.ok(start >= 0, "main.ts has menuCommand");
  const end = src.indexOf("\n}\n", start);
  const outside = src.slice(0, start) + src.slice(end);
  const direct = outside.split("\n").filter((l) => /send\(\s*"menu:command"/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(direct, [], "only menuCommand sends menu:command");
  const clicks = src.match(/click: \(\) => menuCommand\(/g) ?? [];
  assert.ok(clicks.length >= 10, `the menu's items go through it (${clicks.length})`);
});
