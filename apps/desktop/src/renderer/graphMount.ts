// Mounts the SHARED <gitstudio-graph> Lit element and drives it off the desktop
// host. The element is imported and used UNCHANGED from @gitstudio/webview-ui;
// we only adapt at the boundary: GraphHostAdapter pages via IPC and hands the
// element the `graphInit`/`graphAppend` messages it already knows how to apply,
// and the element's `onAction` callback (select/open/context/loadMore) is routed
// to desktop handlers + the adapter. This is the exact reuse the brief calls for.

import "@gitstudio/webview-ui/graph/commit-graph";
import type { CommitGraph, GraphAction } from "@gitstudio/webview-ui/graph/commit-graph";
import { GraphHostAdapter, host } from "./bridge";

export interface GraphCallbacks {
  onSelect(sha: string): void;
  onOpen(sha: string): void;
  onContext(sha: string, x: number, y: number): void;
}

export class GraphMount {
  private readonly element: CommitGraph;
  private readonly adapter: GraphHostAdapter;

  constructor(container: HTMLElement, cb: GraphCallbacks) {
    this.element = document.createElement("gitstudio-graph") as CommitGraph;
    this.element.status = "loading";
    this.element.onAction = (action: GraphAction) => {
      switch (action.type) {
        case "select":
          cb.onSelect(action.sha);
          break;
        case "open":
          cb.onOpen(action.sha);
          break;
        case "context":
          cb.onContext(action.sha, action.x, action.y);
          break;
        case "loadMore":
          void this.adapter.loadMore();
          break;
        case "refresh":
          void this.reload();
          break;
        case "requestStats":
          void host
            .invoke("commit:rowStats", action.shas)
            .then((stats) => this.element.setRowStats(stats))
            .catch(() => {});
          break;
      }
    };
    container.replaceChildren(this.element);

    // Feed host messages straight into the element exactly as the VS Code graph
    // webview entry does (graphInit replaces rows; graphAppend concatenates).
    this.adapter = new GraphHostAdapter((message) => {
      switch (message.type) {
        case "graphInit":
          this.element.head = message.head;
          this.element.rows = message.rows;
          this.element.totalColumns = message.totalColumns;
          this.element.hasMore = message.hasMore;
          this.element.status = message.rows.length === 0 ? "empty" : "ready";
          break;
        case "graphAppend":
          this.element.rows = this.element.rows.concat(message.rows);
          this.element.totalColumns = Math.max(
            this.element.totalColumns,
            message.totalColumns,
          );
          this.element.hasMore = message.hasMore;
          if (this.element.status !== "ready" && this.element.rows.length > 0) {
            this.element.status = "ready";
          }
          break;
      }
    });
  }

  /** (Re)load the graph from the first page — call on open + on repo change. */
  async reload(): Promise<void> {
    this.element.status = "loading";
    this.element.rows = [];
    await this.adapter.loadInitial();
  }

  /** Clear to the empty state (no repo open). */
  clear(): void {
    this.adapter.reset();
    this.element.rows = [];
    this.element.status = "empty";
  }

  /** Select + scroll a commit (e.g. a branch tip) into view. */
  reveal(sha: string): void {
    this.element.reveal(sha);
  }
}
