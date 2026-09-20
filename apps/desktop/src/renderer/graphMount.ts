// Mounts the SHARED <gitstudio-graph> Lit element and drives it off the desktop
// host. The element is imported and used UNCHANGED from @gitstudio/webview-ui;
// we only adapt at the boundary: GraphHostAdapter pages via IPC and hands the
// element the `graphInit`/`graphAppend` messages it already knows how to apply,
// and the element's `onAction` callback (select/open/context/loadMore) is routed
// to desktop handlers + the adapter. This is the exact reuse the brief calls for.

import "@gitstudio/webview-ui/graph/commit-graph";
import type { CommitGraph, GraphAction } from "@gitstudio/webview-ui/graph/commit-graph";
import type { GraphRefFilter } from "@gitstudio/host-bridge/graphProtocol";
import { GraphHostAdapter, host } from "./bridge";

export interface GraphCallbacks {
  onSelect(sha: string): void;
  onOpen(sha: string): void;
  onContext(sha: string, x: number, y: number): void;
  /** The already-selected row was clicked again — reveal the details pane. */
  onShowDetails(sha: string): void;
  /** A branch/remote/tag chip on a row was clicked — navigate to that ref. */
  onRefClick(name: string, kind: string): void;
  /** "Checkout <ref>" from a chip's own menu (issue #30) — the same request,
   *  with the same questions, as the commit menu's item of that name. */
  onCheckoutRef(sha: string, name: string, kind: string): void;
  /** The history is empty (or stopped being). Lets the shell stand the details
   *  pane down instead of asking you to select a commit that doesn't exist. */
  onEmpty?(empty: boolean): void;
}

export class GraphMount {
  private readonly element: CommitGraph;
  private readonly adapter: GraphHostAdapter;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement, cb: GraphCallbacks) {
    this.container = container;
    this.element = document.createElement("gitstudio-graph") as CommitGraph;
    this.element.status = "loading";
    this.element.onAction = (action: GraphAction) => {
      switch (action.type) {
        case "select":
          cb.onSelect(action.sha);
          break;
        case "showDetails":
          cb.onShowDetails(action.sha);
          break;
        case "open":
          cb.onOpen(action.sha);
          break;
        case "context":
          cb.onContext(action.sha, action.x, action.y);
          break;
        case "refClick":
          cb.onRefClick(action.name, action.kind);
          break;
        case "checkoutRef":
          cb.onCheckoutRef(action.sha, action.name, action.kind);
          break;
        case "loadMore":
          this.adapter.loadMore().catch(() => {
            /* a paging failure is non-fatal; keep what's already shown */
          });
          break;
        case "refresh":
          void this.reload();
          break;
        case "setRefFilter":
          void this.setRefFilter(action.refs);
          break;
        case "requestStats":
          void host
            .invoke("commit:rowStats", action.shas)
            // A short answer is as bad as no answer: anything the host did not
            // return stays pending, and a pending sha renders no CHANGES cell.
            // Release the whole batch, keep what came back.
            .then((stats) => {
              this.element.setRowStats(stats);
              // Anything the host did not return is an ANSWER of "no stats for
              // this commit" — recorded, not re-asked.
              this.element.failRowStats(action.shas, true);
            })
            // An ERROR is worth retrying, but not immediately: `false` releases
            // the shas without recording them, and the next repaint asks.
            .catch(() => this.element.failRowStats(action.shas, false));
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
          this.element.refFilter = message.refFilter ?? null;
          this.element.refList = message.refList ?? [];
          if (message.rows.length === 0 && !message.hasMore) {
            // A genuinely empty history gets the crafted tile, not the shared
            // element's bare "No commits yet" — consistent with every other view.
            this.renderEmpty();
            cb.onEmpty?.(true);
          } else {
            this.element.status = message.rows.length === 0 ? "empty" : "ready";
            cb.onEmpty?.(false);
          }
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

  /** (Re)load the graph from the first page — call on open + on repo change.
   *  On failure, render an in-view error + Retry instead of spinning forever. */
  async reload(): Promise<void> {
    this.container.replaceChildren(this.element);
    // Keep the rows you are looking at. Blanking them turned Refresh into a
    // re-mount: the history vanished, a spinner took the whole pane, your scroll
    // position and selection went with it — for an operation that usually
    // returns the same list plus one commit. The graph's own placeholder only
    // appears when there is nothing to show, so `status = "loading"` over a
    // populated list marks the toolbar busy and leaves the list alone.
    this.element.status = "loading";
    try {
      await this.adapter.loadInitial();
    } catch (err) {
      this.renderError(err);
    }
  }

  /** Build the shared crafted state tile (accent icon badge + title + desc + CTA),
   *  matching the desktop `.list-empty` empty/error states used across every view. */
  private buildTile(
    iconName: string,
    title: string,
    desc: string,
    action?: { icon: string; label: string; onClick: () => void; primary?: boolean },
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "list-empty";
    const badge = document.createElement("div");
    badge.className = "list-empty-badge";
    const icon = document.createElement("span");
    icon.className = `glyph codicon codicon-${iconName}`;
    badge.appendChild(icon);
    const titleEl = document.createElement("div");
    titleEl.className = "list-empty-title";
    titleEl.textContent = title;
    const descEl = document.createElement("div");
    descEl.className = "list-empty-desc";
    descEl.textContent = desc;
    wrap.append(badge, titleEl, descEl);
    if (action) {
      const btn = document.createElement("button");
      btn.className = `${action.primary ? "btn btn-primary" : "mini-btn"} list-empty-action`;
      // Built as nodes, not as an HTML string. Both callers pass literals today,
      // so this is not a live hole — but a template that interpolates a label
      // straight into innerHTML becomes one the moment somebody passes a branch
      // name or an error string through it, and the label right above this is
      // already `desc`, which IS remote text.
      const gi = document.createElement("span");
      gi.className = `glyph codicon codicon-${action.icon}`;
      const gl = document.createElement("span");
      gl.textContent = action.label;
      btn.append(gi, gl);
      btn.addEventListener("click", action.onClick);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  /** Replace the graph with a centered "couldn't load history" + Retry panel. */
  private renderError(err: unknown): void {
    const desc =
      (err instanceof Error ? err.message : String(err ?? "")).replace(
        /^Error invoking remote method '[^']*':\s*/i,
        "",
      ) || "The git log couldn't be read for this repository.";
    const wrap = this.buildTile("warning", "Couldn't load history", desc, {
      icon: "refresh",
      label: "Retry",
      onClick: () => void this.reload(),
    });
    wrap.classList.add("list-error");
    this.container.replaceChildren(wrap);
  }

  /** Replace the graph with a crafted "no commits yet" tile. */
  private renderEmpty(): void {
    const wrap = this.buildTile(
      "git-commit",
      "No commits yet",
      "This branch has no history. Make your first commit and it'll appear here.",
    );
    this.container.replaceChildren(wrap);
  }

  /** Clear to the empty state (no repo open). */
  clear(): void {
    this.adapter.reset();
    this.element.rows = [];
    this.element.status = "empty";
  }

  /** Select + scroll a commit (e.g. a branch tip) into view.
   *  Returns whether the row was found — the graph holds only its loaded
   *  pages, and a commit further back cannot be revealed at all. */
  reveal(sha: string): boolean {
    return this.element.reveal(sha);
  }

  /** The branch filter the loaded rows were built under; null for all. */
  get refFilter(): GraphRefFilter {
    return this.element.refFilter;
  }

  /**
   * Rebuild the graph around `refs` (issue #30) — the picker's tick, and the
   * "Show all branches" a hidden reveal offers, through one door. Same
   * discipline as a refresh: the rows stay while the filtered history loads,
   * and a failure lands on the error tile with Retry. Resolves once the new
   * first page is on screen, or the error is.
   */
  async setRefFilter(refs: GraphRefFilter): Promise<void> {
    this.element.status = "loading";
    try {
      await this.adapter.setRefFilter(refs);
    } catch (err) {
      this.renderError(err);
    }
  }

  /** Detach the Lit element so its disconnectedCallback tears down listeners. */
  dispose(): void {
    this.adapter.reset();
    this.element.remove();
  }
}
