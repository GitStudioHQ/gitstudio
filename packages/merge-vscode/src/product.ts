// The MergeProduct: everything that differs between the two extensions that
// mount this package (GitStudio and Merge Studio). Ids, brand, where settings
// live, how a question is asked, and how repositories are found. Everything
// else — the merge editor, the dashboard, routing, JetBrains hand-off, the
// diff panel — is the same code for both (PLAN §3.7 W14, decision D5).
//
// This module is vscode-free AT RUNTIME (type-only imports), so the pure
// helpers below are unit-tested under plain node.

import type * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/GitContext";
import {
  DEFAULT_MERGE_SETTINGS,
  JETBRAINS_IDES,
  type ConflictsState,
  type JetBrainsIdeId,
  type MergeSettings,
} from "@gitstudio/host-bridge/conflictsProtocol";

/**
 * The command ids a product registers, by role. GitStudio and Merge Studio use
 * different ids for the same command (`gitstudio.showConflicts` ↔
 * `jbMerge.showConflicts`); the pairing is what the parity tests check.
 */
export interface MergeCommandIds {
  /** "Resolve Conflicts…" — open the conflicts dashboard. */
  showConflicts: string;
  /** Open a conflicted file in the embedded 3-pane merge editor. */
  resolveInMergeEditor: string;
  /** Open a conflicted file in the installed JetBrains IDE's merge window. */
  mergeWithJetBrains: string;
  /** Diff in the installed JetBrains IDE (two selected files, or vs HEAD). */
  diffWithJetBrains: string;
  /** The routed Compare: honours the diffTool setting; two selected files diff each other. */
  compare: string;
  /** Always the embedded diff (two selected files, or the file vs HEAD). */
  openDiff: string;
  /** Working tree vs HEAD for the active / clicked file. */
  openChanges: string;
  /** HEAD vs working tree on the embedded diff page, with a staging tick per change. */
  stageWithTicks: string;
  /** The walkthrough's sample merge and sample diff (no git setup needed). */
  openDemo: string;
  openDemoDiff: string;
  /** Continue / Skip / Abort the stopped operation (palette, banners). */
  operationContinue: string;
  operationSkip: string;
  operationAbort: string;
}

/** The webview view types a product contributes. */
export interface MergeViewTypes {
  /** The custom text editor (package.json `customEditors`). */
  mergeEditor: string;
  /** The diff panel (restored after reload by a serializer). */
  diffView: string;
  /** The conflicts dashboard panel. */
  conflicts: string;
}

/** One question, asked in the product's own way (GitStudio: its in-view dialog; Merge Studio: a modal). */
export interface AskSpec {
  title: string;
  message: string;
  confirmLabel: string;
  /** Destructive: styled as danger and never the default. */
  danger?: boolean;
}

/**
 * A repository the merge experience can act on. `ctx` is the git-service
 * context (operation, conflictOps, conflict, process, staging).
 */
export interface MergeRepo {
  /** Absolute worktree root, as the host's git provider reports it. */
  readonly root: string;
  readonly ctx: GitContext;
  /** Ask the host's git provider to rescan now (vscode.git's `repo.status()`); best effort. */
  poke?(): void | Promise<void>;
}

/** How the experience finds repositories. GitStudio adapts its RepoManager; Merge Studio uses vscodeGitLocator. */
export interface RepoLocator {
  all(): readonly MergeRepo[];
  /** The repository containing this absolute path (longest root wins), if any. */
  forPath(fsPath: string): MergeRepo | undefined;
  /** The repository of the active editor, else the first one. */
  active(): MergeRepo | undefined;
  /** Fires (debounced by the locator) when any repository's state may have changed. */
  onDidChange(listener: () => void): { dispose(): void };
}

/** MergeSettings plus the one setting that is not shared with the desktop: automatic routing. */
export interface MergeHostSettings extends MergeSettings {
  /**
   * One meaning in both extensions (PLAN matrix row 6): route the active
   * conflicted editor into the resolver, take over VS Code's built-in merge
   * tab, and show the conflicts dashboard when an operation stops.
   */
  autoOpen: boolean;
}

export interface MergeProduct {
  /** Stable product key, for telemetry-free bookkeeping only. */
  readonly key: "gitstudio" | "merge-studio";
  /** The dashboard's brand slot. */
  readonly brand: ConflictsState["brand"];
  /** Toast prefix and display name: "GitStudio" / "Merge Studio". */
  readonly displayName: string;
  /** Configuration section holding the MergeHostSettings keys ("gitstudio.merge" / "jbMerge"). */
  readonly settingsSection: string;
  readonly viewTypes: MergeViewTypes;
  readonly commands: MergeCommandIds;
  /** `setContext` key that is true while a JetBrains IDE can be launched. */
  readonly ideAvailableContextKey: string;
  /** Status-bar item id ("⚠ Resolve Conflicts"). */
  readonly statusItemId: string;
  /** globalState key remembering that the coexistence question was asked. */
  readonly coexistencePromptKey: string;
  /**
   * When to ask about VS Code's built-in merge UI. Merge Studio asks at first
   * activation (it is a merge tool); GitStudio asks the first time a conflict
   * actually appears, so a user who never merges is never asked.
   */
  readonly coexistencePromptAt: "activation" | "first-conflict";
  /** The dashboard's support-link slot (Merge Studio's "Report an issue" / "Rate"). */
  readonly supportLinks?: { label: string; url: string }[];
  readonly locator: RepoLocator;
  /** Ask a yes/no question. GitStudio: promptConfirm (never a modal). Merge Studio: a modal. */
  ask(spec: AskSpec): Promise<boolean>;
  /** Wrap a resolution in the product's undo envelope (GitStudio's UndoLedger). */
  runWithUndo?<T>(repo: MergeRepo, label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * D4: another product owns the automatic behaviour (auto-route, built-in tab
   * reroute, status item, dashboard auto-show, coexistence prompt). Commands
   * keep working. Merge Studio returns true while GitStudio is installed with
   * `gitstudio.merge.autoOpen` on; GitStudio never defers.
   */
  defersTo?(): boolean;
  /** GitStudio: "Open Changes" in the editor's own diff (the embedded one is `openDiff`). */
  openChangesEmbedded?(uri: vscode.Uri): Promise<void>;
  /** A single-file Compare with no second file selected (GitStudio asks HEAD or another file). */
  compareSingle?(uri: vscode.Uri): Promise<void>;
  /** A conflict was resolved or an operation moved: refresh the product's own views. */
  onRepositoryChanged?(repo: MergeRepo): void;
}

const RESOLVERS = new Set(["embedded", "jetbrains"]);
const IDE_IDS = new Set<string>(JETBRAINS_IDES.map((i) => i.id));

/**
 * Reads the six settings from a raw getter, with every unknown value falling
 * back to the default rather than reaching the code as garbage. Merge Studio's
 * legacy `conflictResolver: "webview"` means the embedded editor.
 */
export function normalizeMergeSettings(
  get: (key: keyof MergeHostSettings) => unknown,
): MergeHostSettings {
  const bool = (key: keyof MergeHostSettings, dflt: boolean): boolean => {
    const v = get(key);
    return typeof v === "boolean" ? v : dflt;
  };
  const choice = (key: "conflictResolver" | "diffTool"): "embedded" | "jetbrains" => {
    const v = get(key);
    if (v === "webview") {
      return "embedded";
    }
    return typeof v === "string" && RESOLVERS.has(v)
      ? (v as "embedded" | "jetbrains")
      : DEFAULT_MERGE_SETTINGS[key];
  };
  const ide = get("preferredIde");
  const path = get("jetbrainsPath");
  return {
    autoOpen: bool("autoOpen", true),
    autoApplyNonConflicting: bool(
      "autoApplyNonConflicting",
      DEFAULT_MERGE_SETTINGS.autoApplyNonConflicting,
    ),
    conflictResolver: choice("conflictResolver"),
    diffTool: choice("diffTool"),
    preferredIde:
      typeof ide === "string" && (ide === "auto" || IDE_IDS.has(ide))
        ? (ide as JetBrainsIdeId | "auto")
        : DEFAULT_MERGE_SETTINGS.preferredIde,
    jetbrainsPath: typeof path === "string" ? path.trim() : "",
  };
}

/**
 * D4, as a pure rule: Merge Studio stands down its automatic behaviour while
 * GitStudio is installed AND GitStudio's `merge.autoOpen` is on (unset reads as
 * the default, on). Turning GitStudio's off — or uninstalling it — hands the
 * automatic behaviour back.
 */
export function shouldDeferToGitStudio(gitStudio: {
  installed: boolean;
  autoOpen: boolean | undefined;
}): boolean {
  return gitStudio.installed && gitStudio.autoOpen !== false;
}

/**
 * VS Code's own merge UI that competes with ours, and the value that turns each
 * off. `git.mergeEditor` defaults to false; the two merge-conflict ones default
 * to true.
 */
export const COMPETING_BUILT_INS: ReadonlyArray<{ key: string; off: boolean; dflt: boolean }> = [
  { key: "git.mergeEditor", off: false, dflt: false },
  { key: "merge-conflict.codeLens.enabled", off: false, dflt: true },
  { key: "merge-conflict.decorators.enabled", off: false, dflt: true },
];

/** The built-in settings currently on (so worth asking about). Empty = nothing competes. */
export function competingBuiltIns(get: (key: string) => unknown): string[] {
  return COMPETING_BUILT_INS.filter(({ key, off, dflt }) => {
    const v = get(key);
    const value = typeof v === "boolean" ? v : dflt;
    return value !== off;
  }).map(({ key }) => key);
}
