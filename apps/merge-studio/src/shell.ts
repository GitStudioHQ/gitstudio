// The few decisions that belong to Merge Studio's shell rather than to the
// shared merge experience: when the walkthrough opens, how a question is
// asked, which facts about GitStudio decide D4 (the RULE is merge-vscode's
// shouldDeferToGitStudio — this only reads its inputs), and the one legacy
// setting value 0.3.4 users may have.
//
// vscode-free: the editor is reached through the small function types below,
// so every decision is unit-tested under plain node.

import type { AskSpec } from "@gitstudio/merge-vscode/product";

// ── The walkthrough ─────────────────────────────────────────────────────────

export type WalkthroughDecision =
  /** Open it now and remember that it was shown. */
  | "open"
  /** Not now: something is in progress. Try again at the next activation. */
  | "later"
  /** Never automatically (already shown, or the user turned it off). */
  | "skip";

/**
 * POLISH B2: the walkthrough opens once, by itself, on a fresh install —
 * unless the user turned off walkthroughs opening on install, and never in
 * the same activation as the dashboard or a question. A window that starts
 * mid-merge gets the dashboard; the walkthrough waits for a calm activation.
 */
export function decideWalkthrough(facts: {
  /** globalState: it was already shown (0.3.4's key, so upgraders are not shown it again). */
  shown: boolean;
  /** `workbench.welcomePage.walkthroughs.openOnInstall` (unset reads as VS Code's default, on). */
  openOnInstall: unknown;
  /** Any open repository has an operation in progress or unmerged files. */
  busy: boolean;
}): WalkthroughDecision {
  if (facts.shown || facts.openOnInstall === false) {
    return "skip";
  }
  return facts.busy ? "later" : "open";
}

// ── Asking ──────────────────────────────────────────────────────────────────

/** vscode.window.showWarningMessage's modal overload, as a plain function type. */
export type ShowModal = (
  message: string,
  options: { modal: true; detail?: string },
  ...items: string[]
) => PromiseLike<string | undefined>;

/**
 * Merge Studio asks its few yes/no questions (Continue and drop an emptied
 * commit, Skip, Abort from the palette; hand a half-merged file to the IDE)
 * with a modal, as 0.3.4 did. The dashboard's and the merge editor's own
 * buttons confirm inline instead; the question about VS Code's merge editor is
 * a toast (merge-vscode's coexistence.ts).
 */
export function modalAsk(show: ShowModal): (spec: AskSpec) => Promise<boolean> {
  return async (spec) => {
    const choice = await show(spec.title, { modal: true, detail: spec.message }, spec.confirmLabel);
    return choice === spec.confirmLabel;
  };
}

// ── D4: the facts about GitStudio ───────────────────────────────────────────

export const GITSTUDIO_EXTENSION_ID = "gitstudio.gitstudio";
export const GITSTUDIO_AUTO_OPEN_SECTION = "gitstudio.merge";
export const GITSTUDIO_AUTO_OPEN_KEY = "autoOpen";

/**
 * The inputs merge-vscode's shouldDeferToGitStudio decides on: is GitStudio
 * installed, and what does its `gitstudio.merge.autoOpen` say (undefined when
 * unset or when GitStudio is not there to declare it).
 */
export function gitStudioFacts(editor: {
  hasExtension(id: string): boolean;
  setting(section: string, key: string): unknown;
}): { installed: boolean; autoOpen: boolean | undefined } {
  const installed = editor.hasExtension(GITSTUDIO_EXTENSION_ID);
  const value = installed ? editor.setting(GITSTUDIO_AUTO_OPEN_SECTION, GITSTUDIO_AUTO_OPEN_KEY) : undefined;
  return { installed, autoOpen: typeof value === "boolean" ? value : undefined };
}

// ── Legacy setting values ───────────────────────────────────────────────────

/** What `WorkspaceConfiguration.inspect` reports, reduced to the scope we touch. */
export interface InspectedSetting {
  globalValue?: unknown;
}

/**
 * 0.3.4 called the embedded editor `"webview"`; 0.4 calls it `"embedded"`
 * (the shared settings contract). The old value still works — the shared
 * settings reader maps it — but the Settings editor would flag it as invalid,
 * so a USER-level `"webview"` is rewritten once. A workspace value is left
 * alone: it lives in the user's repository (.vscode/settings.json), and
 * rewriting it would put a change in their working tree.
 */
export function legacySettingUpdates(
  inspect: (key: string) => InspectedSetting | undefined,
): { key: string; value: string }[] {
  const resolver = inspect("conflictResolver");
  return resolver?.globalValue === "webview" ? [{ key: "conflictResolver", value: "embedded" }] : [];
}
