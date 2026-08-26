import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRun, mapJob, mapUser } from "../src/main/github/maps";

test("mapRun keeps the full run identity (number, attempt, actors, commit)", () => {
  const run = mapRun({
    id: 18234567890,
    run_number: 42,
    run_attempt: 2,
    name: "Desktop CI",
    display_title: "fix: stream job logs with backpressure",
    status: "completed",
    conclusion: "success",
    head_branch: "fix/log-stream",
    head_sha: "a1b2c3d4e5f6a7b8",
    event: "pull_request",
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:08:30Z",
    run_started_at: "2026-08-25T10:00:40Z",
    html_url: "https://github.com/o/r/actions/runs/18234567890",
    actor: { login: "s-ohta", avatar_url: "https://a/1" },
    triggering_actor: { login: "anton", avatar_url: "https://a/2" },
    workflow_id: 77,
    path: ".github/workflows/desktop.yml",
    head_commit: { message: "fix: stream job logs\n\nlong body", author: { name: "S. Ohta" } },
    pull_requests: [{ number: 104 }],
  });
  assert.equal(run.id, 18234567890);
  assert.equal(run.runNumber, 42);
  assert.equal(run.runAttempt, 2);
  assert.equal(run.name, "Desktop CI");
  assert.equal(run.displayTitle, "fix: stream job logs with backpressure");
  assert.equal(run.headSha, "a1b2c3d4e5f6a7b8");
  assert.equal(run.runStartedAt, "2026-08-25T10:00:40Z");
  assert.equal(run.actor?.login, "s-ohta");
  assert.equal(run.triggeringActor?.login, "anton");
  assert.equal(run.workflowId, 77);
  assert.equal(run.workflowPath, ".github/workflows/desktop.yml");
  assert.equal(run.headCommitMessage.split("\n")[0], "fix: stream job logs");
  assert.equal(run.headCommitAuthor, "S. Ohta");
  assert.deepEqual(run.pullRequests, [{ number: 104 }]);
});

test("mapRun degrades sparse payloads to concrete defaults", () => {
  const run = mapRun({ id: 1 });
  assert.equal(run.runNumber, 0);
  assert.equal(run.runAttempt, 1);
  assert.equal(run.name, "(run)");
  assert.equal(run.displayTitle, "(run)");
  assert.equal(run.actor, null);
  assert.equal(run.triggeringActor, null);
  assert.equal(run.headCommitMessage, "");
  assert.deepEqual(run.pullRequests, []);
});

test("mapRun display title falls back across name/display_title symmetrically", () => {
  assert.equal(mapRun({ id: 1, name: "CI" }).displayTitle, "CI");
  assert.equal(mapRun({ id: 1, display_title: "the change" }).name, "the change");
});

test("mapJob keeps runner + timing depth (queue latency, step timestamps)", () => {
  const job = mapJob({
    id: 9,
    run_id: 18234567890,
    run_attempt: 2,
    name: "build (macos-latest)",
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-25T10:00:00Z",
    started_at: "2026-08-25T10:00:42Z",
    completed_at: "2026-08-25T10:05:00Z",
    runner_name: "GitHub Actions 12",
    runner_group_name: "Default",
    labels: ["macos-latest"],
    workflow_name: "Desktop CI",
    head_branch: "main",
    steps: [
      {
        name: "Checkout",
        status: "completed",
        conclusion: "success",
        number: 1,
        started_at: "2026-08-25T10:00:42Z",
        completed_at: "2026-08-25T10:00:50Z",
      },
    ],
  });
  assert.equal(job.runId, 18234567890);
  assert.equal(job.runAttempt, 2);
  assert.equal(job.createdAt, "2026-08-25T10:00:00Z");
  assert.equal(job.runnerName, "GitHub Actions 12");
  assert.deepEqual(job.labels, ["macos-latest"]);
  assert.equal(job.workflowName, "Desktop CI");
  assert.equal(job.steps[0].startedAt, "2026-08-25T10:00:42Z");
  assert.equal(job.steps[0].completedAt, "2026-08-25T10:00:50Z");
});

test("mapJob null runner fields (queued jobs) become empty strings", () => {
  const job = mapJob({ id: 1, runner_name: null, runner_group_name: null, steps: [{ started_at: null, completed_at: null }] });
  assert.equal(job.runnerName, "");
  assert.equal(job.runnerGroupName, "");
  assert.equal(job.steps[0].startedAt, "");
});

test("mapUser maps to null for absent users", () => {
  assert.equal(mapUser(null), null);
  assert.equal(mapUser(undefined), null);
  assert.deepEqual(mapUser({ login: "x" }), { login: "x", avatarUrl: null });
});
