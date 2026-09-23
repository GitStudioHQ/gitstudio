// What every host module of the merge experience shares: the product, its
// settings, one exit guard, one way to tell the user something, and the
// merge-editor tab helpers. Built once by `registerMergeExperience`.

import * as vscode from "vscode";
import type { MergeHostSettings, MergeProduct, MergeRepo } from "./product";
import { normalizeMergeSettings } from "./product";
import type { ExitGuard } from "./exitGuard";

export type NoticeKind = "info" | "warn" | "error";

export interface MergeHostCore {
  readonly context: vscode.ExtensionContext;
  readonly product: MergeProduct;
  readonly exitGuard: ExitGuard;
  /** The product's merge settings, read fresh. */
  settings(): MergeHostSettings;
  /** D4: another product owns the automatic behaviour right now. */
  defers(): boolean;
  /**
   * Tell the user something, prefixed with the product's name. Successes are a
   * status-bar flash; warnings and errors are toasts (never modal).
   */
  notify(kind: NoticeKind, text: string, ...actions: string[]): Thenable<string | undefined>;
  /** A resolution changed repository state: poke the git provider, refresh the product's views. */
  changed(repo: MergeRepo): void;
}

export function createHostCore(
  context: vscode.ExtensionContext,
  product: MergeProduct,
  exitGuard: ExitGuard,
): MergeHostCore {
  return {
    context,
    product,
    exitGuard,
    settings: () => readHostSettings(product.settingsSection),
    defers: () => {
      try {
        return product.defersTo?.() ?? false;
      } catch {
        return false;
      }
    },
    notify: (kind, text, ...actions) => {
      const line = `${product.displayName}: ${text}`;
      if (kind === "info" && actions.length === 0) {
        vscode.window.setStatusBarMessage(`$(check) ${line}`, 3000);
        return Promise.resolve(undefined);
      }
      if (kind === "error") {
        return vscode.window.showErrorMessage(line, ...actions);
      }
      if (kind === "warn") {
        return vscode.window.showWarningMessage(line, ...actions);
      }
      return vscode.window.showInformationMessage(line, ...actions);
    },
    changed: (repo) => {
      try {
        void repo.poke?.();
      } catch {
        // best effort — the locator's own watchers catch up
      }
      product.onRepositoryChanged?.(repo);
    },
  };
}

/** MergeHostSettings from a configuration section, every value normalised. */
export function readHostSettings(section: string): MergeHostSettings {
  const cfg = vscode.workspace.getConfiguration(section);
  return normalizeMergeSettings((key) => cfg.get(key));
}

/** Close the product's merge-editor tabs — all of them, or just one file's. */
export async function closeMergeEditorTabs(viewType: string, matching?: vscode.Uri): Promise<void> {
  const target = matching?.toString();
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      // Duck-typed TabInputCustom, so no newer vscode API is needed.
      const input = tab.input as { viewType?: string; uri?: vscode.Uri } | undefined;
      if (input?.viewType !== viewType) {
        return false;
      }
      return !target || input.uri?.toString() === target;
    });
  if (tabs.length === 0) {
    return;
  }
  try {
    await vscode.window.tabGroups.close(tabs);
  } catch {
    // already gone
  }
}

/** The absolute file Uri of a repo-relative path. */
export function fileUri(repo: MergeRepo, rel: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(repo.root), ...rel.split("/"));
}
