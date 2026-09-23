// A git command that fails and says NOTHING — not on stderr, not on stdout.
//
// Three bridge paths turn a failed git command into an IPC result — staged()
// (every working-tree mutation), commitAction (the graph's commit menu) and
// checkoutRef — and all three used to mark a failure with an empty stderr as
// `expected`. That rule was written for git DECLINING on stdout ("nothing to
// commit, working tree clean" from a revert already made): the explanation is
// there, and it describes the user's repository. It also caught the case with
// no explanation at all, the placeholder "The operation failed." — which no
// user state produces. git speaks when it refuses: a hook that rejects a merge,
// a rebase or a ref update still gets "fatal: ref updates aborted by hook" or
// "The pre-rebase hook refused to rebase." on stderr (checked against real
// git). Silence on both streams is a process that died, a git that is not git,
// something we did — exactly what the crash report is for. Marked expected, it
// was also painted in the neutral tone of a state the user is in.
//
// The user still reads a plain sentence; only the verdict changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { reportableResultMessage } from "../src/main/expectedError";

type Out = { code: number; stdout: string; stderr: string };

/** A repository whose every git command exits `out.code` with `out`'s streams. */
function bridgeAnswering(out: Out): GitBridge {
  const failed = { ok: false, ...out };
  const ctx = {
    process: { run: async () => out },
    branches: {
      rename: async () => failed,
      merge: async () => failed,
      rebaseOnto: async () => failed,
      setUpstream: async () => failed,
    },
    stashes: { drop: async () => failed },
    conflict: { unmergedCount: async () => 0 },
  } as unknown as GitContext;
  return new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
}

const SILENT: Out = { code: 1, stdout: "", stderr: "" };

test("a working-tree mutation git fails in silence is reported, in a plain sentence", async () => {
  const bridge = bridgeAnswering(SILENT);
  for (const [name, run] of [
    ["branch rename", () => bridge.branchRename({ from: "topic", to: "topic-2" })],
    ["branch merge", () => bridge.branchMerge({ name: "topic" })],
    ["stash drop", () => bridge.stashDrop("stash@{0}")],
  ] as const) {
    const r = await run();
    assert.equal(r.ok, false, name);
    assert.notEqual(r.expected, true, `${name}: silence is not a state the user is in`);
    assert.equal(reportableResultMessage(r), r.message, `${name}: crash-report material`);
    assert.match(r.message ?? "", /^[A-Z][^\n]*\.$/, `${name}: one plain sentence (got ${r.message})`);
    assert.doesNotMatch(r.message ?? "", /exit|code \d|stderr|stdout/i, `${name}: nothing a terminal would say`);
  }
});

test("a commit-menu action git fails in silence is reported too", async () => {
  const bridge = bridgeAnswering(SILENT);
  const r = await bridge.commitAction({ action: "cherry-pick", sha: "a".repeat(40) });
  assert.equal(r.ok, false);
  assert.notEqual(r.expected, true);
  assert.ok(reportableResultMessage(r), "filed");
});

test("a checkout git fails in silence is reported too", async () => {
  const bridge = bridgeAnswering(SILENT);
  const r = await bridge.commitAction({
    action: "checkout-ref",
    sha: "a".repeat(40),
    name: "topic",
    refKind: "local",
  });
  assert.equal(r.ok, false);
  assert.notEqual(r.expected, true);
  assert.ok(reportableResultMessage(r), "filed");
});

// The rule it narrows stays: git explaining itself on stdout alone is git
// declining — the user's repository, not our defect.
test("git declining on stdout alone is still a state, not a report — at all three", async () => {
  const bridge = bridgeAnswering({
    code: 1,
    stdout: "On branch main\nnothing to commit, working tree clean",
    stderr: "",
  });
  const staged = await bridge.branchRename({ from: "topic", to: "topic-2" });
  const menu = await bridge.commitAction({ action: "revert", sha: "a".repeat(40) });
  const checkout = await bridge.commitAction({
    action: "checkout-ref",
    sha: "a".repeat(40),
    name: "topic",
    refKind: "local",
  });
  for (const [name, r] of [
    ["staged", staged],
    ["commit menu", menu],
    ["checkout", checkout],
  ] as const) {
    assert.equal(r.ok, false, name);
    assert.equal(r.expected, true, name);
    assert.match(r.message ?? "", /nothing to commit/, name);
  }
});

test("…and a failure git explains on stderr is still reported, as it always was", async () => {
  const bridge = bridgeAnswering({ code: 128, stdout: "", stderr: "fatal: something only we could cause" });
  const r = await bridge.branchRename({ from: "topic", to: "topic-2" });
  assert.equal(reportableResultMessage(r), "fatal: something only we could cause");
});
