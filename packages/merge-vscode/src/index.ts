// @gitstudio/merge-vscode — the VS Code host glue for the merge experience
// GitStudio and Merge Studio share (PLAN §3.7 W14). A product describes itself
// with a MergeProduct and calls registerMergeExperience; everything else is
// shared. Modules marked vscode-free (product, autoRoute, exitGuard, payload,
// mergeSession, dashboardController, outcome, stageResolved, gitWatch,
// contract, demoContent) are unit-tested under plain node.
export { registerMergeExperience } from "./register";
export type { MergeExperience, OperationVerbOptions } from "./register";
export {
  normalizeMergeSettings,
  shouldDeferToGitStudio,
  hasSharedMergeExperience,
  GITSTUDIO_SHARED_MERGE_COMMAND,
  competingBuiltIns,
  COMPETING_BUILT_INS,
} from "./product";
export type {
  AskSpec,
  DeferralNotice,
  MergeCommandIds,
  MergeHostSettings,
  MergeProduct,
  MergeRepo,
  MergeViewTypes,
  RepoLocator,
} from "./product";
export { VscodeGitLocator, longestRootMatch } from "./vscodeGitLocator";
export { gitWatchTargets, OP_STATE_ENTRIES } from "./gitWatch";
export type { GitWatchTargets } from "./gitWatch";
export { mergeWebviewHtml, conflictsWebviewHtml, getNonce } from "./webviewHtml";
export { outcomeLine, operationNoun } from "./outcome";
export type { OperationVerb, OutcomeLine } from "./outcome";
export { stageResolvedPath } from "./stageResolved";
export {
  checkManifest,
  COMMAND_TITLES,
  JB_MERGE_COMMAND_TWINS,
  JB_MERGE_SETTING_TWINS,
  MERGE_MENU_RULES,
  MERGE_SETTINGS_SPEC,
  WHEN,
} from "./contract";
