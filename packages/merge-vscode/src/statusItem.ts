// The status-bar item (PLAN matrix row 11; POLISH A5.3): "⚠ Resolve
// Conflicts" while any open repository has unmerged files, and — once every
// file is resolved but the operation is still in progress — "Continue Rebase"
// (or "Rebase paused"), so there is always a visible way back to Continue. It
// opens the conflicts dashboard. Hidden while another product owns the
// automatic behaviour (D4), so two installed extensions show one item, not two.
// What it says is product.ts's statusItemLook.

import * as vscode from "vscode";
import type { MergeProduct, StatusItemLook } from "./product";

export class ConflictStatusItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(product: MergeProduct) {
    this.item = vscode.window.createStatusBarItem(
      product.statusItemId,
      vscode.StatusBarAlignment.Left,
      10000,
    );
    this.item.name = `${product.displayName}: Conflicts`;
    this.item.text = "$(warning) Resolve Conflicts";
    this.item.command = product.commands.showConflicts;
  }

  /** Show `look`, or hide the item when there is none. */
  update(look: StatusItemLook | undefined): void {
    if (!look) {
      this.item.hide();
      return;
    }
    this.item.text = look.text;
    this.item.tooltip = look.tooltip;
    this.item.backgroundColor = look.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
