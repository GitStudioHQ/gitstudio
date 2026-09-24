// Headless-test entry for the merge shell: the real MergeShell, driven over a
// FAKE MergeViewApi, so the shell's own behaviour — labels, confirms, what it
// posts to the host, when Continue appears — is tested without Monaco and
// without depending on the real view's internals (P1 owns those).
//
// The page script reaches everything through `window.__shell`.

import { MergeShell } from "../../src/mergeShell";
import { MergeLegend } from "../../src/mergeLegend";
import {
  emptyCategoryCounts,
  emptyMergeCounts,
  type AcceptMode,
  type EolMismatchInfo,
  type MergeCategory,
  type MergeCountsView,
  type MergeHistoryView,
  type MergeRenderInit,
  type MergeRenderOptions,
  type MergeViewApi,
  type SeedInfo,
} from "../../src/mergeViewApi";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { ChangeBlock, Side } from "@gitstudio/engine/types";

export class FakeMergeView implements MergeViewApi {
  onCountsChanged?: (counts: MergeCountsView) => void;
  onResultChanged?: () => void;
  onLargeFile?: (large: boolean) => void;
  onHistoryChanged?: () => void;
  onEolMismatch?: (info: EolMismatchInfo | undefined) => void;
  onSeeded?: (info: SeedInfo | undefined) => void;
  /** What getUnsettledText answers; undefined = the Result itself. */
  unsettled?: string;

  /** Every call the shell made, by method name. */
  calls: Array<{ name: string; args: unknown[] }> = [];
  renders: Array<{ payload: MergeInitPayload; init?: MergeRenderInit }> = [];
  counts: MergeCountsView = emptyMergeCounts();
  legendSlot?: HTMLElement;
  result = "RESULT TEXT";
  sync = true;
  history: MergeHistoryView = { undo: [], redo: [] };
  disposed = false;

  constructor(readonly container: HTMLElement) {
    const marker = document.createElement("div");
    marker.className = "fake-view";
    marker.textContent = "fake merge view";
    marker.tabIndex = 0;
    container.appendChild(marker);
  }

  private note(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  /** How many times the shell called `name`. */
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  /** Report counts, the way the real view does on every build and action. */
  setCounts(over: Partial<MergeCountsView>): void {
    this.counts = { ...emptyMergeCounts(), byCategory: emptyCategoryCounts(), ...over };
    this.onCountsChanged?.(this.counts);
  }

  emitEol(info: EolMismatchInfo | undefined): void {
    this.onEolMismatch?.(info);
  }

  emitSeed(info: SeedInfo | undefined): void {
    this.onSeeded?.(info);
  }

  /** The Result changed, the way the real view reports it. */
  emitResult(): void {
    this.onResultChanged?.();
  }

  render(payload: MergeInitPayload, init?: MergeRenderInit): void {
    this.note("render", payload, init);
    this.renders.push({ payload, init });
    this.onCountsChanged?.(this.counts);
    this.onEolMismatch?.(undefined);
  }
  setRenderOptions(options: Partial<MergeRenderOptions>): void {
    this.note("setRenderOptions", options);
  }
  layout(): void {
    this.note("layout");
  }
  attachLegend(slot: HTMLElement): void {
    this.note("attachLegend", slot);
    this.legendSlot = slot;
  }
  acceptSide(block: ChangeBlock, side: Side, mode: AcceptMode): void {
    this.note("acceptSide", block, side, mode);
  }
  ignoreSide(block: ChangeBlock, side: Side): void {
    this.note("ignoreSide", block, side);
  }
  applyAllNonConflicting(): void {
    this.note("applyAllNonConflicting");
  }
  applyNonConflictingSide(side: Side): void {
    this.note("applyNonConflictingSide", side);
  }
  acceptAllLeft(): void {
    this.note("acceptAllLeft");
  }
  acceptAllRight(): void {
    this.note("acceptAllRight");
  }
  resolveSimpleConflicts(): void {
    this.note("resolveSimpleConflicts");
  }
  hasSimpleConflicts(): boolean {
    return this.counts.resolvableConflictsPending > 0;
  }
  goToNextChange(category?: MergeCategory): void {
    this.note("goToNextChange", category);
  }
  goToPrevChange(category?: MergeCategory): void {
    this.note("goToPrevChange", category);
  }
  getResultText(): string {
    return this.result;
  }
  getUnsettledText(): string {
    return this.unsettled ?? this.result;
  }
  revealSeeded(): boolean {
    this.note("revealSeeded");
    return true;
  }
  reset(): void {
    this.note("reset");
  }
  undo(): void {
    this.note("undo");
  }
  redo(): void {
    this.note("redo");
  }
  undoTo(index: number): void {
    this.note("undoTo", index);
  }
  canUndo(): boolean {
    return this.history.undo.length > 0;
  }
  canRedo(): boolean {
    return this.history.redo.length > 0;
  }
  getHistory(): MergeHistoryView {
    return this.history;
  }
  setSyncScroll(enabled: boolean): void {
    this.note("setSyncScroll", enabled);
    this.sync = enabled;
  }
  getSyncScroll(): boolean {
    return this.sync;
  }
  dispose(): void {
    this.note("dispose");
    this.disposed = true;
  }
}

// MergeLegend is the real one: the view's legend, in the shell's slot, under
// the shell's own container queries (shell.css).
(window as unknown as { __shell: unknown }).__shell = { MergeShell, FakeMergeView, MergeLegend, emptyMergeCounts };
