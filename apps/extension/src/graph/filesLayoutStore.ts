// Where the details pane's View as Tree / View as List choice (#81) is
// remembered: ONE choice, in globalState, shared by every graph surface in
// every window. The editor tab and the bottom panel are separate webviews,
// each with a localStorage of its own, so a choice kept only in the page was
// a different choice in each. The page still keeps its copy (the desktop app,
// which has no host between it and the pane, relies on that alone).
//
// Free of `vscode`, as refFilterStore.ts is: the memento is injected and
// change notification is a plain listener set.

import type { GraphFilesLayout } from "@gitstudio/host-bridge/graphProtocol";
import type { RefFilterMemento } from "./refFilterStore";

const STATE_KEY = "gitstudio.graph.filesLayout";

export class FilesLayoutStore {
  private readonly listeners = new Set<(layout: GraphFilesLayout) => void>();

  /** globalState in production. */
  constructor(private readonly memento: RefFilterMemento) {}

  /** The choice, or undefined while none has been made — each page then keeps its own. */
  get(): GraphFilesLayout | undefined {
    const v = this.memento.get<unknown>(STATE_KEY);
    return v === "list" || v === "tree" ? v : undefined;
  }

  /** Remember a choice and tell every graph — the one it was made in too, so
   *  a change has one path. The same choice again is no news. */
  async set(layout: GraphFilesLayout): Promise<void> {
    if ((layout !== "list" && layout !== "tree") || layout === this.get()) return;
    await this.memento.update(STATE_KEY, layout);
    for (const fn of [...this.listeners]) fn(layout);
  }

  /** Subscribe to changes; returns the unsubscribe. */
  onDidChange(fn: (layout: GraphFilesLayout) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

let current: FilesLayoutStore | undefined;

/** Installed once at activation (see extension.ts); graph hosts read it. */
export function setFilesLayoutStore(store: FilesLayoutStore | undefined): void {
  current = store;
}
export function getFilesLayoutStore(): FilesLayoutStore | undefined {
  return current;
}
