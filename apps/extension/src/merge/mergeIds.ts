// GitStudio's ids for the shared merge experience (@gitstudio/merge-vscode).
// vscode-free, so the manifest test can check package.json against them.
//
// Merge Studio registers the same roles under `jbMerge.*`; the pairing is
// contract.ts's JB_MERGE_COMMAND_TWINS.

import type { MergeCommandIds, MergeViewTypes } from "@gitstudio/merge-vscode/product";

export const GITSTUDIO_MERGE_COMMANDS: MergeCommandIds = {
  showConflicts: "gitstudio.showConflicts",
  resolveInMergeEditor: "gitstudio.resolveInMergeEditor",
  mergeWithJetBrains: "gitstudio.mergeWithJetBrains",
  diffWithJetBrains: "gitstudio.diffWithJetBrains",
  compare: "gitstudio.compare",
  openDiff: "gitstudio.openDiff",
  openChanges: "gitstudio.openChanges",
  stageWithTicks: "gitstudio.stageWithTicks",
  openDemo: "gitstudio.merge.openDemo",
  openDemoDiff: "gitstudio.merge.openDemoDiff",
  operationContinue: "gitstudio.operation.continue",
  operationSkip: "gitstudio.operation.skip",
  operationAbort: "gitstudio.operation.abort",
};

export const GITSTUDIO_MERGE_VIEW_TYPES: MergeViewTypes = {
  mergeEditor: "gitstudio.mergeEditor",
  diffView: "gitstudio.diffView",
  conflicts: "gitstudio.conflicts",
};

/** The configuration section holding autoOpen, autoApplyNonConflicting, conflictResolver, … */
export const GITSTUDIO_MERGE_SECTION = "gitstudio.merge";

/** True while a JetBrains IDE can be launched (hides the IDE menus otherwise). */
export const GITSTUDIO_IDE_CONTEXT_KEY = "gitstudio.merge.ideAvailable";

/** The walkthrough (a brand slot, Merge Studio's is jbMerge.openWalkthrough). */
export const GITSTUDIO_WALKTHROUGH_COMMAND = "gitstudio.openWalkthrough";
