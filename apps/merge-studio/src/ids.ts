// Merge Studio's ids for the shared merge experience (@gitstudio/merge-vscode).
// vscode-free, so the parity and manifest tests can check package.json against
// them without an editor.
//
// Every id Merge Studio 0.3.4 shipped is kept exactly as it was — command ids,
// setting ids, the custom editor, the walkthrough and its context key — so a
// user's settings.json, keybindings and muscle memory keep working across the
// move onto the shared packages. The roles that are new in 0.4.0 (Continue /
// Skip / Abort, staging ticks, restoring VS Code's merge editor) follow the
// same `jbMerge.` prefix. GitStudio registers the same roles under
// `gitstudio.*` (apps/extension/src/merge/mergeIds.ts); the pairing is what
// test/parity.test.ts checks.

import type { MergeCommandIds, MergeViewTypes } from "@gitstudio/merge-vscode/product";

export const MS_EXTENSION_ID = "gitstudio.merge-studio";

export const MS_MERGE_COMMANDS: MergeCommandIds = {
  // 0.3.4 ids, unchanged.
  showConflicts: "jbMerge.showConflicts",
  resolveInMergeEditor: "jbMerge.resolveInMergeEditor",
  mergeWithJetBrains: "jbMerge.mergeWithJetBrains",
  diffWithJetBrains: "jbMerge.diffWithJetBrains",
  compare: "jbMerge.compare",
  openDiff: "jbMerge.openDiff",
  openChanges: "jbMerge.openChanges",
  openDemo: "jbMerge.openDemo",
  openDemoDiff: "jbMerge.openDemoDiff",
  // New in 0.4.0.
  stageWithTicks: "jbMerge.stageWithTicks",
  operationContinue: "jbMerge.operation.continue",
  operationSkip: "jbMerge.operation.skip",
  operationAbort: "jbMerge.operation.abort",
  restoreBuiltInMergeEditor: "jbMerge.restoreBuiltInMergeEditor",
};

export const MS_MERGE_VIEW_TYPES: MergeViewTypes = {
  // 0.3.4's custom editor, diff panel and conflicts panel view types: a diff
  // tab restored after a reload keeps finding its serializer.
  mergeEditor: "jbMerge.mergeEditor",
  diffView: "jbMerge.diffView",
  conflicts: "jbMerge.conflicts",
};

/** The configuration section holding autoOpen, autoApplyNonConflicting, conflictResolver, … */
export const MS_SETTINGS_SECTION = "jbMerge";

/** True while a JetBrains IDE can be launched (0.3.4's key; hides the IDE menus otherwise). */
export const MS_IDE_CONTEXT_KEY = "jbMerge.ideAvailable";

/**
 * True while GitStudio owns the automatic behaviour (decision D4). The
 * walkthrough shows "Using GitStudio too?" instead of "Choose your merge
 * editor" while it is set.
 */
export const MS_DEFERS_CONTEXT_KEY = "jbMerge.defersToGitStudio";

/** The "⚠ Resolve Conflicts" status-bar item (0.3.4's id). */
export const MS_STATUS_ITEM_ID = "jbMerge.conflicts";

/** The walkthrough (a brand slot; GitStudio's is gitstudio.openWalkthrough). */
export const MS_WALKTHROUGH_COMMAND = "jbMerge.openWalkthrough";
export const MS_WALKTHROUGH_ID = "mergeStudio.gettingStarted";
export const MS_WALKTHROUGH_FULL_ID = `${MS_EXTENSION_ID}#${MS_WALKTHROUGH_ID}`;

/** globalState: the walkthrough opened once (0.3.4's key, so upgraders are not shown it again). */
export const MS_WALKTHROUGH_SHOWN_KEY = "jbMerge.walkthroughShown";

/**
 * globalState: the ANSWER to the question about VS Code's own merge editor.
 *
 * Deliberately NOT 0.3.4's `jbMerge.coexistPromptShown`: 0.3.4 wrote that key
 * before it asked, so it is set for every 0.3.4 user whether they answered or
 * never saw the toast. The shared question is asked at the first conflict,
 * non-modally, and skipped when the built-ins are already off — so an upgrader
 * who turned them off is not asked again, and one who never saw it is asked
 * once.
 */
export const MS_COEXISTENCE_PROMPT_KEY = "jbMerge.coexistence.answered";

/** Merge Studio 0.3.4's globalState keys, for the record (never written by 0.4). */
export const MS_034_COEXIST_KEY = "jbMerge.coexistPromptShown";
