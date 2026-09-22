import * as vscode from "vscode";
import type { MergeProduct, MergeRepo, RepoLocator } from "@gitstudio/merge-vscode/product";
import { registerMergeExperience, type MergeExperience } from "@gitstudio/merge-vscode/register";
import type { RepoEntry, RepoManager } from "../git/repoManager";
import { promptConfirm, promptPick } from "../ui/dialogs";
import { isSamePathOrInside } from "../util/repoScope";
import {
  GITSTUDIO_IDE_CONTEXT_KEY,
  GITSTUDIO_MERGE_COMMANDS,
  GITSTUDIO_MERGE_SECTION,
  GITSTUDIO_MERGE_VIEW_TYPES,
} from "./mergeIds";

// GitStudio's side of the shared merge experience (@gitstudio/merge-vscode):
// the MergeProduct that says what is GitStudio's — ids, brand, settings under
// `gitstudio.merge`, questions asked in GitStudio's own dialog (never a modal),
// the UndoLedger, and repositories from the RepoManager. Everything else — the
// merge editor, the conflicts dashboard, routing, the JetBrains hand-off, the
// diff panel — is the code Merge Studio runs too.
//
// GitStudio never defers (D4): when Merge Studio is also installed, it is Merge
// Studio that stands down its automatic behaviour.

export interface GitStudioMergeHooks {
  /** "Open Changes" in the editor's own diff (the revision navigator's). */
  openChangesNative(uri: vscode.Uri): Promise<void>;
  /** A resolution or an operation verb changed git state: refresh GitStudio's views. */
  refresh(): void;
}

export function registerGitStudioMerge(
  context: vscode.ExtensionContext,
  repos: RepoManager,
  hooks: GitStudioMergeHooks,
): MergeExperience {
  const locator = repoManagerLocator(repos);
  const product: MergeProduct = {
    key: "gitstudio",
    brand: { name: "GitStudio", mark: "gitstudio" },
    displayName: "GitStudio",
    settingsSection: GITSTUDIO_MERGE_SECTION,
    viewTypes: GITSTUDIO_MERGE_VIEW_TYPES,
    commands: GITSTUDIO_MERGE_COMMANDS,
    ideAvailableContextKey: GITSTUDIO_IDE_CONTEXT_KEY,
    statusItemId: "gitstudio.conflicts",
    coexistencePromptKey: "gitstudio.merge.coexistencePromptShown",
    // Asked the first time a conflict appears, so someone who never merges is
    // never asked about merge tools.
    coexistencePromptAt: "first-conflict",
    locator,
    ask: (spec) =>
      promptConfirm({
        title: spec.title,
        message: spec.message,
        confirmLabel: spec.confirmLabel,
        danger: spec.danger,
      }),
    runWithUndo: async (repo, label, fn) => {
      const ledger = repos.getUndoLedger();
      const entry = repos.getAll().find((e) => e.root === repo.root);
      return ledger && entry ? ledger.runWithUndo(entry, label, fn) : fn();
    },
    openChangesEmbedded: (uri) => hooks.openChangesNative(uri),
    compareSingle: (uri) => compareSingle(uri),
    onRepositoryChanged: () => hooks.refresh(),
  };
  return registerMergeExperience(context, product);
}

/**
 * A single-file Compare, GitStudio's way: ask whether to compare with HEAD or
 * with another file, then open the embedded diff (the Explorer's two-file
 * selection skips the question).
 */
async function compareSingle(left: vscode.Uri): Promise<void> {
  const name = left.fsPath.split(/[\\/]/).pop() ?? left.fsPath;
  const choice = await promptPick({
    title: `Compare ${name} with…`,
    choices: [
      { id: "head", label: "HEAD", icon: "git-commit", description: "The last committed version of this file." },
      { id: "file", label: "Another file…", icon: "file", description: "Pick any file on disk to diff against." },
    ],
  });
  if (choice === "head") {
    await vscode.commands.executeCommand(GITSTUDIO_MERGE_COMMANDS.openDiff, left);
    return;
  }
  if (choice !== "file") {
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Compare",
    title: `Compare ${name} with…`,
  });
  const right = picked?.[0];
  if (right) {
    await vscode.commands.executeCommand(GITSTUDIO_MERGE_COMMANDS.openDiff, undefined, [left, right]);
  }
}

/**
 * The RepoManager as a RepoLocator. A MergeRepo is kept per root and follows
 * the RepoManager's entry for it, so the eager → vscode.git upgrade (a new
 * RepoEntry object around the same GitContext) is the same repository to the
 * dashboard, not a new one.
 */
export function repoManagerLocator(repos: RepoManager): RepoLocator {
  const cache = new Map<string, { entry: RepoEntry; repo: MergeRepo }>();
  const wrap = (entry: RepoEntry): MergeRepo => {
    const hit = cache.get(entry.root);
    if (hit && hit.entry.ctx === entry.ctx) {
      hit.entry = entry;
      return hit.repo;
    }
    const slot = { entry, repo: undefined as unknown as MergeRepo };
    slot.repo = {
      root: entry.root,
      ctx: entry.ctx,
      poke: () => slot.entry.repo?.status?.(),
    };
    cache.set(entry.root, slot);
    return slot.repo;
  };
  return {
    all: () => repos.getAll().map(wrap),
    forPath: (fsPath) => {
      let best: RepoEntry | undefined;
      for (const entry of repos.getAll()) {
        if (isSamePathOrInside(fsPath, entry.root) && (!best || entry.root.length > best.root.length)) {
          best = entry;
        }
      }
      return best ? wrap(best) : undefined;
    },
    active: () => {
      const entry = repos.getActive();
      return entry ? wrap(entry) : undefined;
    },
    onDidChange: (listener) => repos.onDidChange(listener),
  };
}
