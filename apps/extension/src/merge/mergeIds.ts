// GitStudio's ids for the shared merge experience (@gitstudio/merge-vscode).
// vscode-free, so the manifest test can check package.json against them.
//
// Merge Studio registers the same roles under `jbMerge.*`; the pairing is
// contract.ts's JB_MERGE_COMMAND_TWINS.

import type { MergeCommandIds, MergeViewTypes } from "@gitstudio/merge-vscode/product";

export const GITSTUDIO_MERGE_COMMANDS: MergeCommandIds = {
  showConflicts: "gitstudio.showConflicts",
  resolveInMergeEditor: "gitstudio.resolveInMergeEditor",
  compare: "gitstudio.compare",
  openDiff: "gitstudio.openDiff",
  openChanges: "gitstudio.openChanges",
  stageWithTicks: "gitstudio.stageWithTicks",
  openDemo: "gitstudio.merge.openDemo",
  openDemoDiff: "gitstudio.merge.openDemoDiff",
  operationContinue: "gitstudio.operation.continue",
  operationSkip: "gitstudio.operation.skip",
  operationAbort: "gitstudio.operation.abort",
  restoreBuiltInMergeEditor: "gitstudio.merge.restoreBuiltInMergeEditor",
};

export const GITSTUDIO_MERGE_VIEW_TYPES: MergeViewTypes = {
  mergeEditor: "gitstudio.mergeEditor",
  diffView: "gitstudio.diffView",
  conflicts: "gitstudio.conflicts",
};

/** The configuration section holding autoOpen and autoApplyNonConflicting. */
export const GITSTUDIO_MERGE_SECTION = "gitstudio.merge";

/** The walkthrough (a brand slot, Merge Studio's is jbMerge.openWalkthrough). */
export const GITSTUDIO_WALKTHROUGH_COMMAND = "gitstudio.openWalkthrough";

/** globalState: the ANSWER to the question about VS Code's own merge UI (merge-vscode coexistence.ts). */
export const GITSTUDIO_COEXISTENCE_PROMPT_KEY = "gitstudio.merge.coexistencePromptShown";

/** The other product of the pair, and the section of its twin settings (read while ours are unset). */
export const MERGE_STUDIO_EXTENSION_ID = "gitstudio.merge-studio";
export const MERGE_STUDIO_SETTINGS_SECTION = "jbMerge";
