// A pull request's ONE checks state, from both places GitHub keeps CI results.
//
// Pure — unit-tested on its own (test/checkState.test.ts).

import { rollupCi } from "@gitstudio/engine/forge/pullRequests";
import type { CheckRun } from "../../shared/ipc";

/** What `GET /commits/{ref}/status` answers, as githubClient maps it. */
export interface CombinedStatusLike {
  state: string;
  totalCount: number;
}

/**
 * The state the PR page's Checks pill shows and its CI poll watches:
 * "success" | "failure" | "pending", or "" when the commit has no checks.
 *
 * The combined-status endpoint answers `{ state: "pending", total_count: 0 }`
 * for a commit with NO legacy statuses — a merged PR with no CI at all read
 * "Pending" beside "Checks (0)" and polled forever. Its state counts only when
 * it is built from at least one status. The check runs (GitHub Actions and
 * every other Checks API app) are the other half: any failure wins, then
 * anything still running, then success.
 */
export function prCheckState(status: CombinedStatusLike, runs: readonly CheckRun[]): string {
  const statuses = status.totalCount > 0 && status.state ? [{ state: status.state }] : [];
  const state = rollupCi(runs, statuses).state;
  return state === "none" ? "" : state;
}
