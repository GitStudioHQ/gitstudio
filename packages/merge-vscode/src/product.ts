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
  /** Put back VS Code's own merge editor and conflict highlights (coexistence.ts). */
  restoreBuiltInMergeEditor: string;
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

/** The other product of the pair, as MergeProduct.peer describes it. */
export interface MergePeer {
  /** Its extension id ("gitstudio.merge-studio"). */
  readonly extensionId: string;
  /** Its display name ("Merge Studio"). */
  readonly displayName: string;
  /**
   * Whether an installed peer's manifest (its `packageJSON`, readable without
   * activating it) carries THIS merge experience. False for Merge Studio 0.3.x
   * and GitStudio 1.13.0 and older.
   */
  sharedMerge(packageJSON: unknown): boolean;
  /** globalState key: the "update the peer" notice was said (holds the version it was said for). */
  readonly outdatedNoticeKey: string;
}

/**
 * What each extension's `activate` returns under `mergePeer`, for the other
 * product of the pair to read (vscode.extensions.getExtension(id).exports).
 */
export interface MergePeerApi {
  /** The question about VS Code's own merge UI was answered here (or asked by 0.3.4). */
  coexistenceAnswered(): boolean;
  /** This product opened its own walkthrough in this window's session. */
  walkthroughOpenedThisSession?(): boolean;
}

/** What a deferring product says when it stands down (see MergeProduct.deferral). */
export interface DeferralNotice {
  /** The product that owns the automatic behaviour instead ("GitStudio"). */
  readonly owner: string;
  /** globalState key remembering the notice was seen. */
  readonly noticeKey: string;
  /** The owner's setting that, set to false, hands the automatic behaviour back. */
  readonly handBack: { readonly section: string; readonly key: string };
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
  /**
   * globalState key remembering the ANSWER to the question about VS Code's
   * built-in merge UI (coexistence.ts). Both products ask at the first
   * conflict, non-modally; there is no activation-time question any more.
   */
  readonly coexistencePromptKey: string;
  /**
   * The dashboard's support-link slot (Merge Studio's "Report a problem" /
   * "Rate" / "Sponsor"). The first is the only one shown mid-operation, so
   * it is the problem report; the rest wait until the work is done.
   */
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
  /**
   * D4's notice, said ONCE — the first conflict at which this product stands
   * down — so a user who installed it and sees another product open their
   * conflicts knows why, and how to have it the other way (POLISH A5.8).
   * Only a product that can defer has one (Merge Studio).
   */
  readonly deferral?: DeferralNotice;
  /**
   * The other product of the pair (GitStudio ↔ Merge Studio), when this one
   * knows it. Its answer to the coexistence question counts as this one's
   * (nothing asks twice); an installed peer WITHOUT this merge experience
   * (Merge Studio 0.3.x beside a new GitStudio) races it for every conflict
   * and still shows a rebase's sides swapped, so it is named once (POLISH A5.1).
   */
  readonly peer?: MergePeer;
  /**
   * The peer's settings section, read when this product's own twin is UNSET
   * (POLISH A5.7): a Merge Studio user's `jbMerge.conflictResolver:
   * "jetbrains"` keeps working after GitStudio takes the automatic behaviour.
   */
  readonly settingsFallbackSection?: string;
  /**
   * The product's own globalState keys that follow the user to their other
   * machines (Settings Sync), besides the ones this package keeps. VS Code
   * keeps ONE list per extension — each setKeysForSync call replaces the last —
   * so the list is set in one place, by registerMergeExperience.
   */
  readonly syncedStateKeys?: readonly string[];
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
 * The command only a GitStudio that runs THIS shared merge experience
 * contributes (its "Resolve Conflicts…", the dashboard). GitStudio 1.13.0 and
 * older have `gitstudio.merge.autoOpen` but no dashboard: they open every
 * conflicted file in the old editor, with a rebase's sides still swapped.
 */
export const GITSTUDIO_SHARED_MERGE_COMMAND = "gitstudio.showConflicts";

/**
 * The command only a Merge Studio that runs THIS shared merge experience
 * contributes (Continue, new in 1.0.0). Merge Studio 0.3.x has a dashboard
 * too, but no Continue, and shows a rebase's sides swapped.
 */
export const MERGE_STUDIO_SHARED_MERGE_COMMAND = "jbMerge.operation.continue";

function manifestHasCommand(packageJSON: unknown, id: string): boolean {
  const commands = (packageJSON as { contributes?: { commands?: unknown } } | undefined)?.contributes?.commands;
  return Array.isArray(commands) && commands.some((c) => (c as { command?: unknown } | null)?.command === id);
}

/**
 * Whether an installed GitStudio's manifest (its `packageJSON`, readable
 * without activating it) carries the shared merge experience.
 */
export function hasSharedMergeExperience(packageJSON: unknown): boolean {
  return manifestHasCommand(packageJSON, GITSTUDIO_SHARED_MERGE_COMMAND);
}

/** The same question about an installed Merge Studio (1.0.0 and later: yes; 0.3.x: no). */
export function hasMergeStudioSharedExperience(packageJSON: unknown): boolean {
  return manifestHasCommand(packageJSON, MERGE_STUDIO_SHARED_MERGE_COMMAND);
}

/**
 * D4 the other way round: GitStudio stands down its automatic behaviour — the
 * status item, the dashboard's auto-show, routing, the coexistence question —
 * once the user has handed it to a Merge Studio with the same experience
 * ("Let Merge Studio open conflicts", i.e. `gitstudio.merge.autoOpen` set to
 * false). Without that, GitStudio kept its "Resolve Conflicts" item and
 * dashboard beside Merge Studio's (P-11: one item even with both installed).
 * With no Merge Studio, or an older one, GitStudio never stands down: its
 * status item stays as the way to the dashboard.
 */
export function shouldDeferToMergeStudio(mergeStudio: {
  installed: boolean;
  /** hasMergeStudioSharedExperience of the installed Merge Studio's manifest. */
  sharedMerge: boolean;
  /** GitStudio's own `gitstudio.merge.autoOpen` (false = handed over). */
  autoOpen: boolean;
}): boolean {
  return mergeStudio.installed && mergeStudio.sharedMerge && !mergeStudio.autoOpen;
}

/** What `WorkspaceConfiguration.inspect` reports, reduced to the scopes a person sets. */
export interface InspectedValue {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * One merge setting, read from the product's own section and, when that is
 * UNSET in every scope, from the peer's (POLISH A5.7). Only an explicit peer
 * value counts — never its default — and `autoOpen` never falls back: it is
 * each product's own switch, and the one that hands the automatic behaviour
 * from one to the other. `jetbrainsPath` falls back to a USER value only: a
 * workspace must not choose the program GitStudio launches, and the peer's key
 * carries no machine scope when the peer is not installed to declare it.
 */
export function settingWithFallback(
  key: keyof MergeHostSettings,
  own: InspectedValue | undefined,
  fallback: InspectedValue | undefined,
  ownValue: unknown,
): unknown {
  if (!fallback || key === "autoOpen") return ownValue;
  const set = (i: InspectedValue | undefined): boolean =>
    !!i && (i.globalValue !== undefined || i.workspaceValue !== undefined || i.workspaceFolderValue !== undefined);
  if (set(own)) return ownValue;
  if (key === "jetbrainsPath") return fallback.globalValue !== undefined ? fallback.globalValue : ownValue;
  if (!set(fallback)) return ownValue;
  return fallback.workspaceFolderValue ?? fallback.workspaceValue ?? fallback.globalValue;
}

/** What the status item shows, or undefined when it is hidden. */
export interface StatusItemLook {
  text: string;
  tooltip: string;
  /** The warning background: files still conflicted. */
  warning: boolean;
}

/**
 * The status item (PLAN matrix row 11; POLISH A5.3). While files are
 * conflicted: "⚠ Resolve Conflicts". Once none are but the operation is still
 * in progress, it stays, as the way back to Continue: "Continue Rebase" (a
 * paused rebase: "Rebase paused"). Hidden with nothing in progress, and while
 * another product owns the automatic behaviour (one item, not two).
 */
export function statusItemLook(s: {
  unmerged: number;
  defers: boolean;
  /** The operation in progress with nothing conflicted: its Continue verb and pause, when known. */
  op?: { continueVerb?: string; pause?: { detail: string } };
}): StatusItemLook | undefined {
  if (s.defers) return undefined;
  if (s.unmerged > 0) {
    return {
      text: "$(warning) Resolve Conflicts",
      tooltip: `${s.unmerged === 1 ? "1 conflicted file" : `${s.unmerged} conflicted files`} — open the Conflicts view`,
      warning: true,
    };
  }
  if (s.op?.pause) {
    return {
      text: "$(debug-pause) Rebase paused",
      tooltip: `${s.op.pause.detail || "Paused"}. Open the Conflicts view to continue.`,
      warning: false,
    };
  }
  if (s.op?.continueVerb) {
    return {
      text: `$(debug-continue) ${s.op.continueVerb}`,
      tooltip: "All conflicts are resolved. Open the Conflicts view to continue.",
      warning: false,
    };
  }
  return undefined;
}

/**
 * D4, as a pure rule: Merge Studio stands down its automatic behaviour while a
 * GitStudio WITH THE SAME MERGE EXPERIENCE is installed AND GitStudio's
 * `merge.autoOpen` is on (unset reads as the default, on). Turning GitStudio's
 * off — or uninstalling it — hands the automatic behaviour back. An older
 * GitStudio (no dashboard, sides still swapped in a rebase) is never deferred
 * to: standing down for it would bring merge-studio#12 back (POLISH A5.1).
 */
export function shouldDeferToGitStudio(gitStudio: {
  installed: boolean;
  /** hasSharedMergeExperience of the installed GitStudio's manifest. */
  sharedMerge: boolean;
  autoOpen: boolean | undefined;
}): boolean {
  return gitStudio.installed && gitStudio.sharedMerge && gitStudio.autoOpen !== false;
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
