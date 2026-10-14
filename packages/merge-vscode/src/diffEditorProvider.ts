// "GitStudio Diff" in VS Code's editor picker (Reopen Editor With…, a tab's
// context menu, or a "diff only" default editor). Stable VS Code resolves a
// custom editor chosen for a DIFF once per side, in the same group, while the
// tab being opened (whose input the API leaves undefined) is the active one
// there; chosen for a single file, that tab is a TabInputCustom of this view
// type. So the two sides of one diff are paired as they arrive, and handed to
// GitStudio's comparison panel; a single file is compared with HEAD.
import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { DiffPanel, headState, twoFileState, type DiffPanelState } from "./diffPanel";
import type { MergeHostCore } from "./host";

interface Comparison {
  original: vscode.Uri;
  modified: vscode.Uri;
}

interface WaitingSide {
  uri: vscode.Uri;
  panel: vscode.WebviewPanel;
  title?: string;
  timer: ReturnType<typeof setTimeout>;
}

/** How long one side of a diff waits for the other before it is shown on its own. */
export const PAIR_WAIT_MS = 2000;
/** Native diff tabs remembered for which side is which (most recent last). */
const REMEMBERED = 50;

/** Schemes that are a working copy: beside a revision, they are the modified side. */
const WORKING_SCHEMES: ReadonlySet<string> = new Set(["file", "vscode-remote", "untitled"]);

export class DiffEditorProvider implements vscode.CustomTextEditorProvider {
  /** The first side of a diff, per group, until the second arrives. */
  private readonly waiting = new Map<vscode.ViewColumn, WaitingSide>();
  /** Diffs seen open in VS Code's diff editor: the orientation of one reopened with this editor. */
  private readonly seen: Comparison[] = [];

  static register(host: MergeHostCore): vscode.Disposable | undefined {
    const viewType = host.product.viewTypes.diffEditor;
    if (!viewType) return undefined;
    const provider = new DiffEditorProvider(host);
    const tabs = vscode.window.tabGroups.onDidChangeTabs(() => provider.rememberComparisons());
    const registration = vscode.window.registerCustomEditorProvider(viewType, provider);
    return new vscode.Disposable(() => {
      tabs.dispose();
      registration.dispose();
      provider.dispose();
    });
  }

  constructor(private readonly host: MergeHostCore) {
    this.rememberComparisons();
  }

  dispose(): void {
    for (const side of this.waiting.values()) clearTimeout(side.timer);
    this.waiting.clear();
  }

  private rememberComparisons(): void {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
        const { original, modified } = tab.input;
        const at = this.seen.findIndex((c) => same(c.original, original) && same(c.modified, modified));
        if (at >= 0) this.seen.splice(at, 1);
        this.seen.push({ original, modified });
      }
    }
    this.seen.splice(0, Math.max(0, this.seen.length - REMEMBERED));
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const column = panel.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
    const tab = vscode.window.tabGroups.all.find((group) => group.viewColumn === column)?.activeTab;
    const input = tab?.input;
    if (input instanceof vscode.TabInputCustom && same(input.uri, document.uri)) {
      // Chosen for a single file: compare it with HEAD.
      this.show(headState(document.uri, { editable: true }), column, [panel]);
      return;
    }
    const first = this.waiting.get(column);
    if (!first) {
      const timer = setTimeout(() => {
        // The other side never came: show this one as a file would be.
        if (this.waiting.get(column)?.panel !== panel) return;
        this.waiting.delete(column);
        this.show(headState(document.uri, { editable: true }), column, [panel]);
      }, PAIR_WAIT_MS);
      this.waiting.set(column, { uri: document.uri, panel, title: tab?.label, timer });
      return;
    }
    clearTimeout(first.timer);
    this.waiting.delete(column);
    const { original, modified } = this.orient(first.uri, document.uri);
    const state = twoFileState(original, modified);
    state.title = first.title ?? tab?.label;
    state.rightEditable = modified.scheme === "untitled" ||
      vscode.workspace.fs.isWritableFileSystem(modified.scheme) === true;
    state.keepRightDocumentOpen = state.rightEditable;
    this.show(state, column, [first.panel, panel]);
  }

  /**
   * Which arrived side is the original. VS Code resolves the two sides
   * concurrently, so arrival order alone is not the answer: the diff tab
   * this one replaced says, then a revision beside a working copy, then order.
   */
  private orient(a: vscode.Uri, b: vscode.Uri): Comparison {
    for (let i = this.seen.length - 1; i >= 0; i--) {
      const c = this.seen[i];
      if (same(c.original, a) && same(c.modified, b)) return { original: a, modified: b };
      if (same(c.original, b) && same(c.modified, a)) return { original: b, modified: a };
    }
    if (WORKING_SCHEMES.has(a.scheme) && !WORKING_SCHEMES.has(b.scheme)) return { original: b, modified: a };
    return { original: a, modified: b };
  }

  private show(state: DiffPanelState, column: vscode.ViewColumn, panels: vscode.WebviewPanel[]): void {
    const { leftUri, rightUri } = state;
    // Let VS Code finish constructing the custom tab before replacing it.
    setTimeout(() => {
      void (async () => {
        try {
          await Promise.all(
            [leftUri, rightUri].map((uri) => uri && vscode.workspace.openTextDocument(vscode.Uri.parse(uri))),
          );
          const options = { viewColumn: column, preserveFocus: false };
          await DiffPanel.create(this.host, state, options);
          for (const panel of panels) panel.dispose();
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

function same(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}
