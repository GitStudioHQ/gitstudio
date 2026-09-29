import { test, after } from "node:test";
import assert from "node:assert/strict";
import { planMany, rewriteMany } from "../src/multiCommit";
import { commitsWord } from "../src/prBranch";
import type { RebaseOutcome } from "../src/RebaseRunner";
import { makeRepo, type Repo } from "./opRepo";

// A confirmed drop or squash of several commits whose plan no longer holds
// when it runs is refused as an expected user state — and the rebase runner
// is never called.

const repos: Repo[] = [];
after(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

test("rewriteMany refuses commits that are not on the branch (any more) without running the rebase", async () => {
  const r = makeRepo("many-edges");
  repos.push(r);
  r.write("f.txt", "0\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  r.write("s.txt", "s\n");
  const offBranch = r.commitAll("on side only");
  r.git("checkout", "-q", "master");
  r.write("a.txt", "a\n");
  const a = r.commitAll("a");
  r.write("b.txt", "b\n");
  r.commitAll("b");
  const head = r.sha("HEAD");
  const ctx = r.ctx();

  // What the plan itself says about them, for comparison.
  const planned = await planMany(ctx.process, "drop", [offBranch, a]);
  assert.equal(planned.ok, false);
  assert.equal(planned.ok ? undefined : planned.reason, "not-on-branch");
  const expectedMessage = "Not all of those commits are on the current branch, so they can't be dropped from it.";
  assert.equal(planned.ok ? "" : planned.message, expectedMessage);

  let ran = 0;
  const run = async (): Promise<RebaseOutcome> => {
    ran++;
    return { status: "done" };
  };
  const out = await rewriteMany(ctx.process, "drop", { shas: [offBranch, a], head }, run);
  assert.deepEqual(out, { status: "failed", expected: true, message: expectedMessage });

  // A sha git has never heard of is refused the same way.
  const ghost = await rewriteMany(ctx.process, "squash", { shas: [a, "f".repeat(40)], head, message: "m" }, run);
  assert.equal(ghost.status, "failed");
  assert.equal(ghost.status === "failed" && ghost.expected, true);
  assert.equal(ghost.status === "failed" ? ghost.message : "", "Not all of those commits are on the current branch, so they can't be squashed from it.");

  assert.equal(ran, 0, "the rebase runner was never asked");
  assert.equal(r.sha("HEAD"), head);
  assert.equal(r.sha("HEAD~1"), a);
});

test("commitsWord says how many commits, or just 'commits' when the count is unknown", () => {
  assert.equal(commitsWord(undefined), "commits");
  assert.equal(commitsWord(1), "1 commit");
  assert.equal(commitsWord(0), "0 commits");
  assert.equal(commitsWord(12), "12 commits");
});
