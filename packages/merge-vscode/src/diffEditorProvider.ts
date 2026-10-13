// Stable VS Code custom editors resolve each side of a diff separately. Keep
// the native comparison before Reopen With replaces its tab, then hand both
// sides to our single comparison panel instead of reopening changes vs HEAD.
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { DiffPanel, headState, twoFileState, type DiffPanelState } from "./diffPanel";
import type { MergeHostCore } from "./host";

interface Comparison {
  original: vscode.Uri;
  modified: vscode.Uri;
  title: string;
}

export class DiffEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly comparisons = new Map<vscode.ViewColumn, Comparison>();

  static register(host: MergeHostCore): vscode.Disposable | undefined {
    const viewType = host.product.viewTypes.diffEditor;
    if (!viewType) return undefined;
    const provider = new DiffEditorProvider(host);
    const tabs = vscode.window.tabGroups.onDidChangeTabs(() => provider.rememberComparisons());
    const registration = vscode.window.registerCustomEditorProvider(viewType, provider);
    return new vscode.Disposable(() => {
      tabs.dispose();
      registration.dispose();
    });
  }

  constructor(private readonly host: MergeHostCore) {
    this.rememberComparisons();
  }

  private rememberComparisons(): void {
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.activeTab;
      if (tab?.input instanceof vscode.TabInputTextDiff) {
        this.comparisons.set(group.viewColumn, {
          original: tab.input.original,
          modified: tab.input.modified,
          title: tab.label,
        });
      }
    }
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const column = panel.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
    const comparison = this.comparisons.get(column);
    const matches = comparison && [comparison.original, comparison.modified].some(
      (uri) => uri.toString() === document.uri.toString(),
    );
    let state: DiffPanelState;
    if (matches) {
      state = twoFileState(comparison.original, comparison.modified);
      state.title = comparison.title;
      state.rightEditable = comparison.modified.scheme === "untitled" ||
        vscode.workspace.fs.isWritableFileSystem(comparison.modified.scheme) === true;
      state.keepRightDocumentOpen = state.rightEditable;
    } else {
      // Reopen With on a regular file still means compare it with HEAD.
      state = headState(document.uri, { editable: true });
    }
    // Let VS Code finish constructing the custom tab before replacing it.
    setTimeout(() => {
      void (async () => {
        try {
          await Promise.all([
            vscode.workspace.openTextDocument(vscode.Uri.parse(state.leftUri!)),
            vscode.workspace.openTextDocument(vscode.Uri.parse(state.rightUri!)),
          ]);
          const options = { viewColumn: column, preserveFocus: false };
          await DiffPanel.create(this.host, state, options);
          panel.dispose();
          // Closing the temporary editor can activate the previous text tab.
          // Reveal again so the comparison remains the selected editor.
          await DiffPanel.create(this.host, state, options);
        } catch (error) {
          void this.host.notify("error", l10n.t("couldn't load the diff — {0}",
            error instanceof Error ? error.message : String(error)));
        }
      })();
    }, 0);
  }
}
