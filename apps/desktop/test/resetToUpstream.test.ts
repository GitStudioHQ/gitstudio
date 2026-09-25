import { test } from "node:test";
import assert from "node:assert/strict";
import { resetItemLabel, resetQuestion, resetToUpstream, type ResetQuestion } from "../src/renderer/resetToUpstream";
import type { BranchResetPlan, BranchResetResult } from "../src/shared/ipc";

// The words a person reads before "Reset to 'origin/feature'…" throws local
// work away (#32), for every shape the plan can take, and the order the three
// calls run in. The git is tested against real repositories in
// branchReset.test.ts; this is the confirm.

const plan = (over: Partial<BranchResetPlan> = {}): BranchResetPlan => ({
  ok: true,
  branch: "feature",
  upstream: "origin/feature",
  remote: "origin",
  current: true,
  from: "aaaaaaa",
  to: "bbbbbbb",
  lost: 0,
  lostSubjects: [],
  gained: 0,
  dirty: 0,
  ...over,
});

test("the menu item says the same thing the extension says", () => {
  assert.equal(resetItemLabel("origin/feature"), "Reset to 'origin/feature'…");
});

test("equal and clean: nothing to ask", () => {
  assert.equal(resetQuestion(plan()), undefined);
  assert.equal(resetQuestion(plan({ current: false, dirty: undefined })), undefined);
});

test("strictly behind and clean: says nothing is lost, and is not a red button", () => {
  const q = resetQuestion(plan({ gained: 3 }))!;
  assert.equal(q.danger, false);
  assert.match(q.message, /^Nothing is lost: feature has no commits that aren't on origin\/feature, and no uncommitted changes\. It moves forward 3 commits to match\.$/);
  assert.doesNotMatch(q.message, /lose|discard/i, "no scary wording over a fast-forward");
});

test("a branch you are not on never mentions uncommitted changes", () => {
  const q = resetQuestion(plan({ current: false, dirty: undefined, gained: 1 }))!;
  assert.equal(q.danger, false);
  assert.match(q.message, /no commits that aren't on origin\/feature\. It moves forward 1 commit to match/);
  // …even when a stale `dirty` is present: it describes another branch's tree.
  const odd = resetQuestion(plan({ current: false, dirty: 4, lost: 1, lostSubjects: ["x"] }))!;
  assert.doesNotMatch(odd.message, /Uncommitted/);
  assert.match(odd.message, /You're not on feature, so nothing in your working tree changes\./);
});

test("ahead: counts the commits that go and names them by subject", () => {
  const q = resetQuestion(plan({ lost: 2, lostSubjects: ["wip", "try again"] }))!;
  assert.equal(q.danger, true);
  assert.equal(q.title, "Reset feature to 'origin/feature'?");
  assert.match(q.message, /feature loses 2 commits that aren't on origin\/feature:\n {2}• wip\n {2}• try again\n/);
  assert.match(q.message, /feature then matches origin\/feature exactly\./);
  assert.match(q.message, /You can undo this straight afterwards\./);
});

test("one commit reads as one", () => {
  const q = resetQuestion(plan({ lost: 1, lostSubjects: ["wip"] }))!;
  assert.match(q.message, /feature loses 1 commit that isn't on origin\/feature:/);
});

test("more than five: five by name, and the rest counted", () => {
  const q = resetQuestion(plan({ lost: 8, lostSubjects: ["a", "b", "c", "d", "e"] }))!;
  assert.match(q.message, /• e\n {2}…and 3 more\n/);
});

test("dirty and equal: only the uncommitted changes go, said as a count of files", () => {
  const q = resetQuestion(plan({ dirty: 4 }))!;
  assert.equal(q.danger, true);
  assert.doesNotMatch(q.message, /loses/);
  assert.match(q.message, /Uncommitted changes to 4 files are discarded\. Untracked files are kept\./);
});

test("diverged and dirty: both, in that order", () => {
  const q = resetQuestion(plan({ lost: 1, lostSubjects: ["mine"], gained: 2, dirty: 1 }))!;
  const at = (re: RegExp): number => q.message.search(re);
  assert.ok(at(/loses 1 commit/) < at(/Uncommitted changes to 1 file are/), q.message);
});

test("a failed fetch is said first, with what the plan used instead", () => {
  const q = resetQuestion(plan({ lost: 1, lostSubjects: ["x"], fetchError: "Could not resolve host: github.com" }))!;
  assert.match(q.message, /^Couldn't fetch from origin \(Could not resolve host: github\.com\), so this uses origin\/feature as it was last fetched\./);
});

// ── the flow ────────────────────────────────────────────────────────────────

function deps(p: BranchResetPlan, answer: boolean, r: BranchResetResult = { ok: true, changed: true, was: "aaaaaaa" }) {
  const seen = { asked: [] as ResetQuestion[], resets: 0 };
  let here = true;
  return {
    seen,
    leave: () => {
      here = false;
    },
    d: {
      plan: async () => p,
      ask: async (q: ResetQuestion) => {
        seen.asked.push(q);
        return answer;
      },
      reset: async () => {
        seen.resets++;
        return r;
      },
      stillHere: () => here,
    },
  };
}

test("a refused plan asks nothing and resets nothing, in the tone the refusal says", async () => {
  const t = deps({ ok: false, expected: true, message: "'feature' is checked out in the worktree at /w." }, true);
  const out = await resetToUpstream(t.d);
  assert.deepEqual(out, { kind: "refused", message: "'feature' is checked out in the worktree at /w.", tone: "info" });
  assert.equal(t.seen.asked.length, 0);
  assert.equal(t.seen.resets, 0);
});

test("already 1:1: nothing to ask, and it says so", async () => {
  const t = deps(plan(), true);
  const out = await resetToUpstream(t.d);
  assert.equal(out.kind, "nothing");
  assert.match((out as { message: string }).message, /already matches origin\/feature/);
  assert.equal(t.seen.resets, 0);
});

test("Cancel resets nothing", async () => {
  const t = deps(plan({ lost: 1, lostSubjects: ["x"] }), false);
  assert.deepEqual(await resetToUpstream(t.d), { kind: "cancelled" });
  assert.equal(t.seen.resets, 0);
});

test("a repository switch under the question resets nothing", async () => {
  const t = deps(plan({ lost: 1, lostSubjects: ["x"] }), true);
  t.d.ask = async (q) => {
    t.seen.asked.push(q);
    t.leave();
    return true;
  };
  assert.deepEqual(await resetToUpstream(t.d), { kind: "cancelled" });
  assert.equal(t.seen.resets, 0);
});

test("confirmed: resets, and names what it did", async () => {
  const t = deps(plan({ lost: 1, lostSubjects: ["x"] }), true);
  const out = await resetToUpstream(t.d);
  assert.equal(out.kind, "reset");
  assert.equal((out as { message: string }).message, "Reset feature to origin/feature.");
  assert.equal(t.seen.resets, 1);
});

test("a refused reset is a neutral message when git's state refused it", async () => {
  const t = deps(plan({ lost: 1, lostSubjects: ["x"] }), true, {
    ok: false,
    changed: false,
    expected: true,
    message: "'feature' or origin/feature moved after you were asked, so nothing was changed.",
  });
  const out = await resetToUpstream(t.d);
  assert.equal(out.kind, "failed");
  assert.equal((out as { tone: string }).tone, "info");
});
