// The "N commits selected" summary's commits, named from the graph's own rows
// (issue #32) — shared by the extension's graph webview and the desktop's
// graph view, so both panes list a selection the same way.

import type { SelectionCommit } from "../commit-details";
import type { CommitGraph } from "./commit-graph";

/** The selected commits as the summary lists them, newest first. */
export function summaryCommits(graph: Pick<CommitGraph, "rowsFor">, shas: readonly string[]): SelectionCommit[] {
  return graph.rowsFor(shas).map((r) => ({
    sha: r.sha,
    shortSha: r.shortSha,
    subject: r.subject,
    author: r.author,
    authorDate: r.authorDate,
  }));
}
