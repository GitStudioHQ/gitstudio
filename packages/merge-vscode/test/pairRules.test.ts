import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasMergeStudioSharedExperience,
  MERGE_STUDIO_SHARED_MERGE_COMMAND,
  settingWithFallback,
  shouldDeferToMergeStudio,
  statusItemLook,
} from "../src/product";

// The rules between the two products of the pair, and the status item's look
// (POLISH A5.1, A5.3, A5.7, A5.8). Pure; register.test / registerDeferral
// drive them through registerMergeExperience.

test("A5.7: an explicit Merge Studio value is read while GitStudio's twin is unset — never a default, never autoOpen", () => {
  const unset = {};
  // explicit jbMerge + unset gitstudio → the jbMerge value
  assert.equal(settingWithFallback("conflictResolver", unset, { globalValue: "jetbrains" }, "embedded"), "jetbrains");
  assert.equal(settingWithFallback("preferredIde", unset, { workspaceValue: "pycharm" }, "auto"), "pycharm");
  assert.equal(
    settingWithFallback("diffTool", unset, { globalValue: "embedded", workspaceFolderValue: "jetbrains" }, "embedded"),
    "jetbrains",
    "the narrowest scope wins, as VS Code's own get() would",
  );
  // both set → gitstudio
  assert.equal(settingWithFallback("conflictResolver", { globalValue: "embedded" }, { globalValue: "jetbrains" }, "embedded"), "embedded");
  // jbMerge default only → the gitstudio default
  assert.equal(settingWithFallback("conflictResolver", unset, {}, "embedded"), "embedded");
  assert.equal(settingWithFallback("conflictResolver", unset, undefined, "embedded"), "embedded");
  // autoOpen is each product's own switch (and the hand-over): never borrowed.
  assert.equal(settingWithFallback("autoOpen", unset, { globalValue: false }, true), true);
  // jetbrainsPath: a USER value only — a workspace must not pick the program launched.
  assert.equal(settingWithFallback("jetbrainsPath", unset, { globalValue: "/Apps/ws" }, ""), "/Apps/ws");
  assert.equal(settingWithFallback("jetbrainsPath", unset, { workspaceValue: "/tmp/evil" }, ""), "");
  assert.equal(settingWithFallback("jetbrainsPath", { globalValue: "/mine" }, { globalValue: "/theirs" }, "/mine"), "/mine");
});

test("A5.8 the other way: GitStudio stands down only for a Merge Studio 1.0 the user handed conflicts to", () => {
  const rows: Array<[Parameters<typeof shouldDeferToMergeStudio>[0], boolean]> = [
    [{ installed: true, sharedMerge: true, autoOpen: false }, true],
    [{ installed: true, sharedMerge: true, autoOpen: true }, false],
    [{ installed: true, sharedMerge: false, autoOpen: false }, false], // 0.3.x: never stand down for it
    [{ installed: false, sharedMerge: false, autoOpen: false }, false], // alone: keep the status item
  ];
  for (const [facts, want] of rows) assert.equal(shouldDeferToMergeStudio(facts), want, JSON.stringify(facts));
});

test("A5.1: Merge Studio's manifest says whether it runs this experience (1.0) or the old one (0.3.x)", () => {
  const v1 = { contributes: { commands: [{ command: "jbMerge.showConflicts" }, { command: MERGE_STUDIO_SHARED_MERGE_COMMAND }] } };
  const v034 = { contributes: { commands: [{ command: "jbMerge.showConflicts" }, { command: "jbMerge.openDemo" }] } };
  assert.equal(hasMergeStudioSharedExperience(v1), true);
  assert.equal(hasMergeStudioSharedExperience(v034), false);
  assert.equal(hasMergeStudioSharedExperience(undefined), false);
});

test("A5.3: the status item stays once every file is resolved, as the way back to Continue", () => {
  assert.deepEqual(statusItemLook({ unmerged: 2, defers: false }), {
    text: "$(warning) Resolve Conflicts",
    tooltip: "2 conflicted files — open the Conflicts view",
    warning: true,
  });
  // update(0, op=rebase) → Continue Rebase, in the neutral colour
  const cont = statusItemLook({ unmerged: 0, defers: false, op: { continueVerb: "Continue Rebase" } });
  assert.equal(cont?.text, "$(debug-continue) Continue Rebase");
  assert.equal(cont?.warning, false);
  assert.match(cont?.tooltip ?? "", /All conflicts are resolved/);
  for (const verb of ["Continue Merge", "Continue Cherry-pick", "Continue Revert", "Continue (git am)"]) {
    assert.equal(statusItemLook({ unmerged: 0, defers: false, op: { continueVerb: verb } })?.text, `$(debug-continue) ${verb}`);
  }
  const paused = statusItemLook({ unmerged: 0, defers: false, op: { continueVerb: "Continue Rebase", pause: { detail: "Paused to edit 1a2b3c4 fix" } } });
  assert.equal(paused?.text, "$(debug-pause) Rebase paused");
  assert.match(paused?.tooltip ?? "", /^Paused to edit 1a2b3c4 fix\. Open the Conflicts view/);
  // Nothing in progress: hidden. Another product owns it: hidden, conflicts or not.
  assert.equal(statusItemLook({ unmerged: 0, defers: false }), undefined);
  assert.equal(statusItemLook({ unmerged: 3, defers: true }), undefined);
  assert.equal(statusItemLook({ unmerged: 0, defers: true, op: { continueVerb: "Continue Rebase" } }), undefined);
});
