// Renderer-side access to the host. `window.gitstudio` is the typed surface the
// preload exposed over the contextBridge; this module gives the rest of the
// renderer a single import for it plus the graph-protocol adapter that lets the
// UNCHANGED `<gitstudio-graph>` element speak to the desktop host.
//
// The shared graph element was written for a VS Code webview: it expects to
// receive `graphInit` / `graphAppend` messages and to post `selectCommit` /
// `openCommit` / `contextMenu` / `loadMore` back. The desktop host instead
// answers a single `graph:load` IPC call returning a page. `GraphHostAdapter`
// bridges the two — it pages via IPC and feeds the element host messages — so
// the component itself needs no desktop-specific code.

import type { GitStudioBridge } from "../shared/ipc";
import type { GraphInitMessage, GraphAppendMessage } from "@gitstudio/host-bridge/graphProtocol";
import { nextGraphMessage } from "../shared/graphAdapterCore";

declare global {
  interface Window {
    gitstudio: GitStudioBridge;
  }
}

export const host: GitStudioBridge = window.gitstudio;

/**
 * Drives the `<gitstudio-graph>` element off the desktop `graph:load` IPC.
 * Owns the paging cursor and translates each page into the host message the
 * element expects; the pure page→message translation lives in graphAdapterCore
 * so it can be unit-tested without a browser.
 */
export class GraphHostAdapter {
  private skip = 0;
  private loading = false;
  private exhausted = false;

  constructor(
    private readonly onMessage: (msg: GraphInitMessage | GraphAppendMessage) => void,
  ) {}

  /** Resets to the first page (e.g. after the active repo changes). */
  reset(): void {
    this.skip = 0;
    this.loading = false;
    this.exhausted = false;
  }

  /** Loads the first page and feeds a `graphInit` to the element. */
  async loadInitial(): Promise<void> {
    this.reset();
    await this.page(true);
  }

  /** Loads the next page (called when the element nears its bottom). */
  async loadMore(): Promise<void> {
    if (this.exhausted) {
      return;
    }
    await this.page(false);
  }

  private async page(initial: boolean): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    try {
      const result = await host.invoke("graph:load", { skip: this.skip });
      this.skip = result.nextSkip;
      this.exhausted = !result.hasMore;
      this.onMessage(nextGraphMessage(result, initial));
    } finally {
      this.loading = false;
    }
  }
}
