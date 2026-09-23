import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MERGE_SETTINGS } from "@gitstudio/host-bridge/conflictsProtocol";
import {
  competingBuiltIns,
  normalizeMergeSettings,
  shouldDeferToGitStudio,
  type MergeHostSettings,
} from "../src/product";

const read = (raw: Partial<Record<keyof MergeHostSettings, unknown>>) =>
  normalizeMergeSettings((key) => raw[key]);

test("unset settings are the contract's defaults — auto-apply OFF, embedded tools, auto IDE, routing on", () => {
  const s = read({});
  assert.deepEqual(s, { ...DEFAULT_MERGE_SETTINGS, autoOpen: true });
  assert.equal(s.autoApplyNonConflicting, false, "D3 as overridden: JetBrains' own default");
});

test("Merge Studio's legacy conflictResolver 'webview' means the embedded editor", () => {
  assert.equal(read({ conflictResolver: "webview" }).conflictResolver, "embedded");
  assert.equal(read({ conflictResolver: "jetbrains" }).conflictResolver, "jetbrains");
});

test("garbage never reaches the code: unknown enums and wrong types fall back to defaults", () => {
  const s = read({
    conflictResolver: "vim",
    diffTool: 3,
    preferredIde: "notepad",
    jetbrainsPath: { path: "/x" },
    autoOpen: "yes",
    autoApplyNonConflicting: 1,
  });
  assert.equal(s.conflictResolver, "embedded");
  assert.equal(s.diffTool, "embedded");
  assert.equal(s.preferredIde, "auto");
  assert.equal(s.jetbrainsPath, "");
  assert.equal(s.autoOpen, true);
  assert.equal(s.autoApplyNonConflicting, false);
});

test("real values pass through (a padded launcher path is trimmed)", () => {
  const s = read({
    conflictResolver: "jetbrains",
    diffTool: "jetbrains",
    preferredIde: "pycharm",
    jetbrainsPath: "  /Applications/PyCharm.app/Contents/MacOS/pycharm ",
    autoOpen: false,
    autoApplyNonConflicting: true,
  });
  assert.deepEqual(s, {
    conflictResolver: "jetbrains",
    diffTool: "jetbrains",
    preferredIde: "pycharm",
    jetbrainsPath: "/Applications/PyCharm.app/Contents/MacOS/pycharm",
    autoOpen: false,
    autoApplyNonConflicting: true,
  });
});

test("D4: Merge Studio defers exactly while GitStudio is installed with merge.autoOpen not turned off", () => {
  assert.equal(shouldDeferToGitStudio({ installed: true, autoOpen: true }), true);
  assert.equal(shouldDeferToGitStudio({ installed: true, autoOpen: undefined }), true, "unset = GitStudio's default, on");
  assert.equal(shouldDeferToGitStudio({ installed: true, autoOpen: false }), false, "GitStudio's routing off → Merge Studio takes over");
  assert.equal(shouldDeferToGitStudio({ installed: false, autoOpen: true }), false, "uninstalled → Merge Studio takes over");
});

test("the coexistence question is asked only about built-ins that are actually on", () => {
  assert.deepEqual(competingBuiltIns(() => undefined), [
    "merge-conflict.codeLens.enabled",
    "merge-conflict.decorators.enabled",
  ]);
  const all: Record<string, boolean> = {
    "git.mergeEditor": true,
    "merge-conflict.codeLens.enabled": true,
    "merge-conflict.decorators.enabled": false,
  };
  assert.deepEqual(competingBuiltIns((k) => all[k]), ["git.mergeEditor", "merge-conflict.codeLens.enabled"]);
  const off: Record<string, boolean> = {
    "git.mergeEditor": false,
    "merge-conflict.codeLens.enabled": false,
    "merge-conflict.decorators.enabled": false,
  };
  assert.deepEqual(competingBuiltIns((k) => off[k]), []);
});
