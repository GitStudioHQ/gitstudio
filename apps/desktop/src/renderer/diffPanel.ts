// Mounts the SHARED Monaco surfaces — @gitstudio/webview-ui/diffView (2-pane,
// JetBrains-style, word-level) and mergeView (3-pane conflict resolver) — into
// a desktop container. The views are reused unchanged; this only feeds them the
// payload shapes they already expect (DiffInitPayload / MergeInitPayload), which
// the main process produced from git-service + the engine diff/merge models.

import { DiffView } from "@gitstudio/webview-ui/diffView";
import { MergeView } from "@gitstudio/webview-ui/mergeView";
import type { DiffInitPayload, MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { ConflictModel, FileDiff } from "../shared/ipc";
import { bootMonaco } from "./monacoBoot";

/**
 * A single reusable diff/merge surface. Swaps between the 2-pane DiffView and
 * the 3-pane MergeView depending on whether the opened file is conflicted,
 * disposing the previous view so Monaco editors never leak.
 */
export class DiffPanel {
  private diff?: DiffView;
  private merge?: MergeView;

  constructor(private readonly container: HTMLElement) {
    bootMonaco();
  }

  /** Renders a normal 2-pane diff (left read-only HEAD/parent, right working/commit). */
  showDiff(file: FileDiff): void {
    this.teardown();
    const payload: DiffInitPayload = {
      leftLabel: file.leftLabel,
      rightLabel: file.rightLabel,
      leftText: file.leftText,
      rightText: file.rightText,
      fileName: file.path,
      rightEditable: false,
    };
    this.diff = new DiffView(this.container);
    this.diff.render(payload);
  }

  /** Renders the 3-pane merge for a conflicted file via the engine merge model. */
  showMerge(model: ConflictModel): void {
    this.teardown();
    const payload: MergeInitPayload = {
      fileName: model.path,
      conflictType: "content",
      source: "git-stages",
      hasBase: model.hasBase,
      oursLabel: model.oursLabel,
      theirsLabel: model.theirsLabel,
      base: model.base,
      ours: model.ours,
      theirs: model.theirs,
      result: model.result,
    };
    this.merge = new MergeView(this.container);
    this.merge.render(payload);
  }

  /** Shows a centered placeholder when nothing is selected. */
  showEmpty(text: string): void {
    this.teardown();
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = text;
    this.container.replaceChildren(empty);
  }

  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    this.diff?.dispose();
    this.diff = undefined;
    this.merge?.dispose();
    this.merge = undefined;
    this.container.replaceChildren();
  }
}
