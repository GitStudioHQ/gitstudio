// A PR's one checks state (main/github/checkState.ts): the legacy combined
// status and the check runs, rolled up — and nothing at all when there are
// neither, though the combined-status API says "pending" for that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prCheckState } from "../src/main/github/checkState";
import type { CheckRun } from "../src/shared/ipc";

const run = (status: string, conclusion = ""): CheckRun => ({ name: "ci", status, conclusion });
const NO_STATUSES = { state: "pending", totalCount: 0 }; // what GitHub really answers

test("prCheckState: no statuses and no check runs is no checks, not 'pending'", () => {
  assert.equal(prCheckState(NO_STATUSES, []), "");
  assert.equal(prCheckState({ state: "", totalCount: 0 }, []), "");
});

test("prCheckState: every mix of legacy statuses and check runs", () => {
  const cases: Array<[string, { state: string; totalCount: number }, CheckRun[], string]> = [
    // Only legacy statuses.
    ["status success", { state: "success", totalCount: 2 }, [], "success"],
    ["status pending", { state: "pending", totalCount: 1 }, [], "pending"],
    ["status failure", { state: "failure", totalCount: 3 }, [], "failure"],
    ["status error", { state: "error", totalCount: 1 }, [], "failure"],
    // Only check runs (every Actions-only repo: the status says pending/0).
    ["runs passed", NO_STATUSES, [run("completed", "success"), run("completed", "skipped")], "success"],
    ["run in progress", NO_STATUSES, [run("completed", "success"), run("in_progress")], "pending"],
    ["run queued", NO_STATUSES, [run("queued")], "pending"],
    ["run failed", NO_STATUSES, [run("completed", "failure"), run("in_progress")], "failure"],
    // Both: failure > pending > success.
    ["status fails, runs pass", { state: "failure", totalCount: 1 }, [run("completed", "success")], "failure"],
    ["status passes, run fails", { state: "success", totalCount: 1 }, [run("completed", "timed_out")], "failure"],
    ["status pending, runs pass", { state: "pending", totalCount: 1 }, [run("completed", "success")], "pending"],
    ["status passes, run running", { state: "success", totalCount: 1 }, [run("in_progress")], "pending"],
    ["both pass", { state: "success", totalCount: 1 }, [run("completed", "success")], "success"],
  ];
  for (const [what, status, runs, want] of cases) {
    assert.equal(prCheckState(status, runs), want, what);
  }
});
