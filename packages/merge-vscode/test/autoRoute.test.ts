import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideActiveEditorRoute,
  decideExplicitOpen,
  decideMergeTabReroute,
  mergeTabResult,
  type ActiveEditorInput,
  type MergeTabInput,
} from "../src/autoRoute";
import { ExitGuard } from "../src/exitGuard";

// The automatic-routing decision table, one row per test case.

const base: ActiveEditorInput = {
  scheme: "file",
  autoOpen: true,
  defers: false,
  recentlyRouted: false,
  exited: false,
  launchedInIde: false,
  conflicted: true,
  resolver: "embedded",
  ideAvailable: false,
};

const rows: [string, Partial<ActiveEditorInput>, ReturnType<typeof decideActiveEditorRoute>][] = [
  ["a conflicted file opens the embedded editor", {}, { kind: "embedded", fallbackNotice: false }],
  ["autoOpen off: never routed", { autoOpen: false }, { kind: "skip", reason: "auto-open-off" }],
  ["D4: another product owns automatic behaviour", { defers: true }, { kind: "skip", reason: "deferred" }],
  ["an untitled / virtual document is left alone", { scheme: "untitled" }, { kind: "skip", reason: "not-a-file" }],
  ["a git: revision document is left alone", { scheme: "git" }, { kind: "skip", reason: "not-a-file" }],
  ["the 1500 ms guard stops a focus bounce re-opening it", { recentlyRouted: true }, { kind: "skip", reason: "just-routed" }],
  ["the user exited the viewer for this file", { exited: true }, { kind: "skip", reason: "exited" }],
  ["not conflicted (any more): forget the exit guard", { conflicted: false }, { kind: "forget" }],
  ["not conflicted beats exited: the guard lifts", { conflicted: false, exited: true }, { kind: "forget" }],
  ["resolver jetbrains + an IDE: hand it to the IDE", { resolver: "jetbrains", ideAvailable: true }, { kind: "jetbrains" }],
  [
    "resolver jetbrains, IDE already launched for the file: no second window",
    { resolver: "jetbrains", ideAvailable: true, launchedInIde: true },
    { kind: "skip", reason: "launched-in-ide" },
  ],
  [
    "resolver jetbrains but no IDE installed: embedded, with the one-time notice",
    { resolver: "jetbrains", ideAvailable: false },
    { kind: "embedded", fallbackNotice: true },
  ],
  ["an exited file is not handed to the IDE either", { exited: true, resolver: "jetbrains", ideAvailable: true }, { kind: "skip", reason: "exited" }],
];

for (const [name, over, want] of rows) {
  test(`active editor: ${name}`, () => {
    assert.deepEqual(decideActiveEditorRoute({ ...base, ...over }), want);
  });
}

const tab: MergeTabInput = {
  autoOpen: true,
  defers: false,
  recentlyRerouted: false,
  exited: false,
  resolver: "embedded",
  ideAvailable: false,
};

const tabRows: [string, Partial<MergeTabInput>, ReturnType<typeof decideMergeTabReroute>][] = [
  ["VS Code's merge tab is replaced by ours", {}, { kind: "reroute", to: "embedded", fallbackNotice: false }],
  ["autoOpen off keeps the built-in tab", { autoOpen: false }, { kind: "keep", reason: "auto-open-off" }],
  ["D4 keeps the built-in tab (the other product decides)", { defers: true }, { kind: "keep", reason: "deferred" }],
  ["just rerouted: the 3 s guard", { recentlyRerouted: true }, { kind: "keep", reason: "just-rerouted" }],
  // Merge Studio's reroute ignored the exit guard (PLAN matrix row 3).
  ["the user exited OUR viewer for this file: the built-in tab they chose stays", { exited: true }, { kind: "keep", reason: "exited" }],
  ["resolver jetbrains + IDE: rerouted to the IDE", { resolver: "jetbrains", ideAvailable: true }, { kind: "reroute", to: "jetbrains", fallbackNotice: false }],
  ["resolver jetbrains, no IDE: embedded with the notice", { resolver: "jetbrains" }, { kind: "reroute", to: "embedded", fallbackNotice: true }],
];

for (const [name, over, want] of tabRows) {
  test(`built-in merge tab: ${name}`, () => {
    assert.deepEqual(decideMergeTabReroute({ ...tab, ...over }), want);
  });
}

test("the built-in merge tab is recognised by its three URIs, and nothing else is", () => {
  assert.equal(mergeTabResult({ input1: "a", input2: "b", result: "r" }), "r");
  assert.equal(mergeTabResult({ uri: "x", viewType: "gitstudio.mergeEditor" }), undefined);
  assert.equal(mergeTabResult({ original: "a", modified: "b" }), undefined);
  assert.equal(mergeTabResult(undefined), undefined);
});

test("exit guard: suppress, query, clear", () => {
  const g = new ExitGuard();
  g.suppress("file:///r/a.txt");
  assert.equal(g.isSuppressed("file:///r/a.txt"), true);
  assert.equal(g.isSuppressed("file:///r/b.txt"), false);
  g.clear("file:///r/a.txt");
  assert.equal(g.isSuppressed("file:///r/a.txt"), false);
  assert.equal(g.size, 0);
});

// An EXPLICIT open (a Changes row, the SCM row's Resolve) of a file with no
// working copy — both sides deleted it — opened a text editor on a file that
// does not exist, and failed. Its resolution ("Delete the file") lives in the
// dashboard, so that is where it goes.
test("an explicit open of a file with no working copy goes to the dashboard", () => {
  assert.equal(decideExplicitOpen({ onDisk: false, resolver: "embedded", ideAvailable: false }), "dashboard");
  assert.equal(decideExplicitOpen({ onDisk: false, resolver: "jetbrains", ideAvailable: true }), "dashboard");
  assert.equal(decideExplicitOpen({ onDisk: true, resolver: "embedded", ideAvailable: true }), "embedded");
  assert.equal(decideExplicitOpen({ onDisk: true, resolver: "jetbrains", ideAvailable: true }), "jetbrains");
  assert.equal(decideExplicitOpen({ onDisk: true, resolver: "jetbrains", ideAvailable: false }), "embedded-fallback");
});

test("register.ts routes an explicit open through decideExplicitOpen, with the file's existence", () => {
  const src = readFileSync(join(__dirname, "../src/register.ts"), "utf8");
  const at = src.indexOf("const openConflict = async");
  assert.ok(at > 0);
  const body = src.slice(at, at + 1400);
  assert.match(body, /decideExplicitOpen\(/);
  assert.match(body, /fs\.stat\(uri\)/);
  assert.match(body, /showConflicts\(/);
});
