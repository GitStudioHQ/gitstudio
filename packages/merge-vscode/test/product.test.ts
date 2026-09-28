import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MERGE_SETTINGS } from "@gitstudio/host-bridge/conflictsProtocol";
import {
  competingBuiltIns,
  GITSTUDIO_SHARED_MERGE_COMMAND,
  hasSharedMergeExperience,
  normalizeMergeSettings,
  shouldDeferToGitStudio,
  type MergeHostSettings,
} from "../src/product";

const read = (raw: Partial<Record<keyof MergeHostSettings, unknown>>) =>
  normalizeMergeSettings((key) => raw[key]);

test("unset settings are the contract's defaults — auto-apply OFF, routing on", () => {
  const s = read({});
  assert.deepEqual(s, { ...DEFAULT_MERGE_SETTINGS, autoOpen: true });
  assert.equal(s.autoApplyNonConflicting, false, "D3 as overridden: JetBrains' own default");
});

test("garbage never reaches the code: wrong types fall back to defaults", () => {
  const s = read({ autoOpen: "yes", autoApplyNonConflicting: 1 });
  assert.equal(s.autoOpen, true);
  assert.equal(s.autoApplyNonConflicting, false);
});

test("real values pass through", () => {
  assert.deepEqual(read({ autoOpen: false, autoApplyNonConflicting: true }), {
    autoOpen: false,
    autoApplyNonConflicting: true,
  });
});

// The external-IDE hand-off is gone. A user who had chosen it still has the
// old values stored; they are never read, so conflicts and diffs simply open
// in the embedded editors, with no error and no question.
test("a stored conflictResolver / diffTool from the removed IDE hand-off is ignored", () => {
  const legacy = {
    conflictResolver: "jetbrains",
    diffTool: "jetbrains",
    preferredIde: "pycharm",
    jetbrainsPath: "/Applications/PyCharm.app/Contents/MacOS/pycharm",
  } as unknown as Partial<Record<keyof MergeHostSettings, unknown>>;
  assert.deepEqual(read(legacy), { ...DEFAULT_MERGE_SETTINGS, autoOpen: true });
});

test("D4: Merge Studio defers exactly while a GitStudio with this merge experience is installed with merge.autoOpen not turned off", () => {
  const gs = { installed: true, sharedMerge: true };
  assert.equal(shouldDeferToGitStudio({ ...gs, autoOpen: true }), true);
  assert.equal(shouldDeferToGitStudio({ ...gs, autoOpen: undefined }), true, "unset = GitStudio's default, on");
  assert.equal(shouldDeferToGitStudio({ ...gs, autoOpen: false }), false, "GitStudio's routing off → Merge Studio takes over");
  assert.equal(
    shouldDeferToGitStudio({ installed: false, sharedMerge: false, autoOpen: true }),
    false,
    "uninstalled → Merge Studio takes over",
  );
  // POLISH A5.1 (skew-a): GitStudio 1.13.0 has merge.autoOpen but no
  // dashboard, and still shows a rebase's sides swapped. Standing down for it
  // would hand merge-studio#12 straight back.
  assert.equal(
    shouldDeferToGitStudio({ installed: true, sharedMerge: false, autoOpen: undefined }),
    false,
    "an older GitStudio is never deferred to",
  );
  assert.equal(shouldDeferToGitStudio({ installed: true, sharedMerge: false, autoOpen: true }), false);
});

test("D4's capability test reads GitStudio's manifest: its Resolve Conflicts… command marks the shared experience", () => {
  const manifest = (commands: unknown) => ({ contributes: { commands } });
  assert.equal(GITSTUDIO_SHARED_MERGE_COMMAND, "gitstudio.showConflicts");
  assert.equal(
    hasSharedMergeExperience(manifest([{ command: "gitstudio.graph" }, { command: "gitstudio.showConflicts" }])),
    true,
  );
  // GitStudio 1.13.0 (ext-v1.13.0): its merge editor and ticks, no dashboard.
  assert.equal(
    hasSharedMergeExperience(manifest([{ command: "gitstudio.resolveInMergeEditor" }, { command: "gitstudio.stageWithTicks" }])),
    false,
  );
  for (const junk of [undefined, null, {}, { contributes: {} }, manifest("gitstudio.showConflicts"), manifest([null, 3])]) {
    assert.equal(hasSharedMergeExperience(junk), false, JSON.stringify(junk));
  }
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
