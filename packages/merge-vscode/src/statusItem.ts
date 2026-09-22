// "⚠ Resolve Conflicts" in the status bar while any open repository has
// unmerged files (PLAN matrix row 11). It opens the conflicts dashboard.
// Hidden while another product owns the automatic behaviour (D4), so two
// installed extensions show one item, not two.

import * as vscode from "vscode";
import type { MergeProduct } from "./product";

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
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  /** `unmerged`: conflicted files across the open repositories. */
  update(unmerged: number, defers: boolean): void {
    if (unmerged === 0 || defers) {
      this.item.hide();
      return;
    }
    this.item.tooltip =
      (unmerged === 1 ? "1 conflicted file" : `${unmerged} conflicted files`) +
      " — open the conflicts dashboard";
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
