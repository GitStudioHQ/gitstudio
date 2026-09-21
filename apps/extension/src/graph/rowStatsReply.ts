import type { GraphRowStatsMessage, RowStat } from "@gitstudio/host-bridge/graphProtocol";

/**
 * The `rowStats` reply for one window of shas, from what `git log --numstat`
 * said about them.
 *
 * Pure, and separate from graphPanel.ts, so the two cases can be tested
 * without a vscode host. They are not the same case, and the webview treats
 * them differently (CommitGraph.failRowStats):
 *
 *   • git ran and SKIPPED a sha (`--ignore-missing`: rewritten away under a
 *     live graph, or a dangling ref). That is an answer — "no stats for this
 *     commit" — so it is answered with zeros, renders as an empty cell like a
 *     commit that changed nothing, and is never asked about again.
 *   • git could not run the batch at all (`answered` is undefined). Zeros
 *     here would be recorded as answers too, and the webview never re-asks a
 *     recorded sha — so one transient failure kept an empty CHANGES cell on
 *     the whole visible window for the rest of the session. These shas go
 *     back as `unanswered`, released without being recorded, and the next
 *     repaint asks again.
 */
export function rowStatsReply(
  wanted: readonly string[],
  answered: readonly RowStat[] | undefined,
): GraphRowStatsMessage {
  if (!answered) {
    return { type: "rowStats", stats: [], unanswered: [...wanted] };
  }
  const bySha = new Map<string, RowStat>();
  for (const s of answered) {
    bySha.set(s.sha, s);
  }
  return {
    type: "rowStats",
    stats: wanted.map(
      (sha) => bySha.get(sha) ?? { sha, files: 0, additions: 0, deletions: 0 },
    ),
  };
}
