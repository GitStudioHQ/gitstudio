// What every host module of the merge experience shares: the product, its
// settings, one exit guard, one way to tell the user something, and the
// merge-editor tab helpers. Built once by `registerMergeExperience`.

import * as vscode from "vscode";
import type { MergeHostSettings, MergeProduct, MergeRepo } from "./product";
import { normalizeMergeSettings, settingWithFallback, sidesTipText } from "./product";
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
    settings: () => readHostSettings(product.settingsSection, product.settingsFallbackSection),
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

/**
 * MergeHostSettings from a configuration section, every value normalised. With
 * a `fallback` section (the peer product's), a setting unset in `section` is
 * read from an explicit value there (settingWithFallback, POLISH A5.7).
 */
export function readHostSettings(section: string, fallback?: string): MergeHostSettings {
  const cfg = vscode.workspace.getConfiguration(section);
  const fb = fallback ? vscode.workspace.getConfiguration(fallback) : undefined;
  return normalizeMergeSettings((key) =>
    fb ? settingWithFallback(key, cfg.inspect(key), fb.inspect(key), cfg.get(key)) : cfg.get(key),
  );
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

/**
 * Close the plain TEXT tabs of one file — the tab a routed file was opened
 * in, once the merge editor has it (POLISH A1.3). A second text editor on the
 * same file was a way to overwrite the merge (and clicking it bounced straight
 * back to the merge editor). A tab with unsaved edits is left alone: closing
 * it would ask, and those edits are the user's.
 */
export async function closeTextTabs(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      // Duck-typed TabInputText: a uri and nothing else (a custom editor has a
      // viewType, a notebook a notebookType, a diff original/modified).
      const input = tab.input as
        | { uri?: vscode.Uri; viewType?: unknown; notebookType?: unknown; original?: unknown; modified?: unknown }
        | undefined;
      if (!input?.uri || input.viewType !== undefined || input.notebookType !== undefined) return false;
      if (input.original !== undefined || input.modified !== undefined) return false;
      return !tab.isDirty && input.uri.toString() === target;
    });
  if (tabs.length === 0) {
    return;
  }
  try {
    await vscode.window.tabGroups.close(tabs, true);
  } catch {
    // already gone
  }
}

/**
 * POLISH A5.9: the one-time tip for an upgrader at a stop whose sides changed
 * meaning (a rebase, a stash apply) — until they press "Got it". Shown in the
 * dashboard and the merge editor alike.
 */
export function sidesTipFor(
  host: Pick<MergeHostCore, "context" | "product">,
  op: { kind: string; yours: { name: string } } | undefined,
): { id: string; text: string; why?: string } | undefined {
  const facts = host.product.sidesTip;
  if (!facts || !op || host.context.globalState.get<boolean>(facts.dismissedKey)) {
    return undefined;
  }
  const text = sidesTipText(host.product, facts.version, op);
  return text ? { id: facts.dismissedKey, text, ...(facts.why ? { why: facts.why } : {}) } : undefined;
}

/** "Got it": the tip is not shown again. */
export async function dismissSidesTip(host: Pick<MergeHostCore, "context" | "product">, id: string): Promise<void> {
  const facts = host.product.sidesTip;
  if (facts && id === facts.dismissedKey) {
    await host.context.globalState.update(facts.dismissedKey, true);
  }
}

/** The absolute file Uri of a repo-relative path. */
export function fileUri(repo: MergeRepo, rel: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(repo.root), ...rel.split("/"));
}
