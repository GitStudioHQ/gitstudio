// Pure translation from a desktop `GraphPage` (the IPC response shape) into the
// `graphInit` / `graphAppend` host message the shared `<gitstudio-graph>`
// element consumes. Kept free of any DOM/Electron import so it is hermetically
// unit-testable: the renderer's GraphHostAdapter is a thin paging loop around
// this function.

import type {
  GraphAppendMessage,
  GraphInitMessage,
} from "@gitstudio/host-bridge/graphProtocol";
import type { GraphPage } from "./ipc";

/**
 * The first page becomes a full `graphInit` (replacing the element's rows);
 * every later page becomes a `graphAppend` (the element concatenates and keeps
 * its scroll offset). Mirrors the extension graph webview's host→webview
 * protocol exactly, so the element's handler is reused verbatim.
 */
export function nextGraphMessage(
  page: GraphPage,
  initial: boolean,
): GraphInitMessage | GraphAppendMessage {
  if (initial) {
    return {
      type: "graphInit",
      rows: page.rows,
      head: page.head,
      totalColumns: page.totalColumns,
      hasMore: page.hasMore,
      refFilter: page.refFilter,
      ...(page.refPreset ? { refPreset: page.refPreset } : {}),
      // Only when the page carried one: absent means the element's list is
      // current (the request said which one it holds — see GraphHostAdapter).
      ...(page.refList ? { refList: page.refList } : {}),
    };
  }
  return {
    type: "graphAppend",
    rows: page.rows,
    totalColumns: page.totalColumns,
    hasMore: page.hasMore,
  };
}
