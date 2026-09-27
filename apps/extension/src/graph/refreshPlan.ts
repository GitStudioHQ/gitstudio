// What the commit graph does about a repository change (repoChange.ts).
//
// Every surface of the graph (the Commits rail, the bottom panel, the tab)
// re-read its log, refs and layout on every event — every save, every window
// focus, because vscode.git runs status then. History moves only with refs,
// an operation or a different repository; when only the working tree moved,
// the one row that can change is "Uncommitted changes": it appears when the
// tree gets dirty and goes when it is clean (a new top row moves every lane,
// so that is a reload), and while it stays, only its details — the files it
// lists — can be out of date.
//
// vscode-free, so the table is unit-tested.

import { touches, type RepoChangeEvent } from "../git/repoChange";

export type GraphRefresh = "reload" | "wipDetails" | "nothing";

export interface WipFacts {
  /** The graph is showing an Uncommitted changes row now. */
  shown: boolean;
  /** The working tree, as it is now, would get one. */
  wanted: boolean;
  /** Its details are what the details pane shows. */
  detailsOnWip: boolean;
}

export function planGraphRefresh(e: RepoChangeEvent | undefined | void, wip: WipFacts): GraphRefresh {
  if (touches(e, "refs", "operation", "repos")) return "reload";
  if (wip.shown !== wip.wanted) return "reload";
  return wip.shown && wip.detailsOnWip ? "wipDetails" : "nothing";
}
