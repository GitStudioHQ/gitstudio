// Merge Studio's ids for the shared merge experience (@gitstudio/merge-vscode).
// vscode-free, so the parity and manifest tests can check package.json against
// them without an editor.
//
// Every id Merge Studio 0.3.4 shipped is kept exactly as it was — command ids,
// setting ids, the custom editor, the walkthrough and its context key — so a
// user's settings.json, keybindings and muscle memory keep working across the
// move onto the shared packages. The roles that are new in 1.0.0 (Continue /
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
  // New in 1.0.0.
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
 * globalState: the ANSWER to the question about VS Code's own merge editor
 * (merge-vscode's coexistence.ts writes it only after an answer).
 *
 * 0.3.4 asked the same question at its first activation and wrote its own key
 * (below) before asking. An upgrader carrying that key was asked, so it counts
 * as an answer here (shell.ts legacyStateUpdates): nothing asks twice.
 */
export const MS_COEXISTENCE_PROMPT_KEY = "jbMerge.coexistence.answered";

/** Merge Studio 0.3.4's "asked about the built-ins" flag: read once, never written since 1.0. */
export const MS_034_COEXIST_KEY = "jbMerge.coexistPromptShown";

/** globalState: Merge Studio said, once, that it stands down for GitStudio (POLISH A5.8). */
export const MS_DEFERRAL_NOTICE_KEY = "jbMerge.deferralNoticeShown";

/**
 * globalState: Merge Studio said, once per GitStudio version, that an OLDER
 * GitStudio (1.13.0 and before, no dashboard) also opens conflicts (POLISH A5.1).
 */
export const MS_OUTDATED_GITSTUDIO_NOTICE_KEY = "jbMerge.outdatedGitStudioNotice";

/** globalState: the version that ran last (POLISH A5.9's upgrade test; 0.3.4 wrote none). */
export const MS_LAST_VERSION_KEY = "jbMerge.lastVersion";

/** globalState: the upgrader's tip about which side is Yours was dismissed (POLISH A5.9). */
export const MS_SIDES_TIP_KEY = "jbMerge.sidesTipDismissed";
