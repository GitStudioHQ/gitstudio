import { test } from "node:test";
import assert from "node:assert/strict";
import { reporterRepo, germanLocale } from "./opRepo";

// GitStudioHQ/merge-studio#12, the reporter's exact steps:
//
//   1. master and test each change line 3 of the same file
//   2. git checkout test
//   3. git rebase master
//   4. resolve with the merge tool
//
// Every product showed stage 2 on the left as "yours". During a rebase stage 2
// is MASTER — the branch you are rebasing onto — so "Accept Yours" followed by
// Continue removed the reporter's only commit from `test` (git-semantics
// products.out: "test is now: master change,base"). Decision D1: Yours is your
// commit (stage 3), on the left, labelled with the branch.

const sha7 = (s: string): string => s.slice(0, 7);

test("the reporter's rebase names both sides with real branch names, Yours on the left", async () => {
  const r = reporterRepo();
  try {
    const mine = r.sha("test");
    assert.notEqual(r.tryGit("rebase", "master"), 0, "the rebase stops on the conflict");
    const ctx = r.ctx();

    const op = await ctx.operation.view();
    assert.equal(op.kind, "rebase");
    assert.equal(op.backend, "merge");
    assert.equal(op.yours.stage, 3, "Yours is git's stage 3 — the commit being replayed");
    assert.equal(op.theirs.stage, 2);
    assert.equal(op.yours.name, "test");
    assert.equal(op.theirs.name, "master");
    assert.equal(op.yours.paneTitle, `Rebasing ${sha7(mine)} from test`);
    assert.equal(op.theirs.paneTitle, "Already rebased commits and commits from master");
    assert.equal(op.title, `Rebasing test onto master · commit 1 of 1: ${sha7(mine)} test change`);
    assert.ok(op.title.startsWith("Rebasing test onto master · commit 1 of 1"));
    assert.deepEqual(op.direction, { from: "yours", verb: "onto", to: "theirs" }, "test → onto → master");
    assert.deepEqual(op.step, { n: 1, m: 1, unit: "commit" });
    assert.equal(op.commit?.sha, mine);
    assert.equal(op.commit?.subject, "test change");
    assert.equal(op.canContinue, false);
    assert.equal(op.continueBlocked, "f.txt still has conflicts");
    assert.equal(op.canSkip, false, "the merge backend never offers a hard-resetting Skip");
    assert.equal(op.verbs.continue, "Continue Rebase");
    assert.equal(op.verbs.abort, "Abort Rebase");

    // The contents are swapped, not only the titles.
    const sides = await ctx.conflictOps.readSides("f.txt", { op });
    assert.equal(sides.yours.split("\n")[2], "three-test", "the LEFT pane holds the reporter's own line");
    assert.equal(sides.theirs.split("\n")[2], "three-master");
    assert.equal(sides.base.split("\n")[2], "three");
    assert.equal(sides.shape, "text");

    const snap = await ctx.conflictOps.snapshot({ op });
    assert.deepEqual(snap.files, [{ path: "f.txt", status: "pending", shape: "text" }]);

    // Accept Yours → Continue Rebase.
    const took = await ctx.conflictOps.takeRole("f.txt", "yours", { op });
    assert.equal(took.ok, true, took.message);
    assert.equal(r.read("f.txt").split("\n")[2], "three-test");
    const ready = await ctx.operation.view();
    assert.equal(ready.canContinue, true);
    assert.equal(ready.willDrop, undefined, "keeping your own line leaves a real commit");
    const resolved = await ctx.conflictOps.snapshot({ op: ready });
    assert.deepEqual(resolved.files, [{ path: "f.txt", status: "resolved", choice: "yours", shape: "text" }]);

    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Rebase complete");
    assert.equal(out.view.kind, "none");
    assert.equal(out.remainingConflicts, 0);
    assert.equal(r.git("log", "--format=%s", "master..test").trim(), "test change", "the reporter's commit survived");
    assert.equal(r.git("show", "test:f.txt").split("\n")[2], "three-test");
    assert.equal(r.exists(".git/rebase-merge"), false, "the rebase is over");
  } finally {
    r.cleanup();
  }
});

test("the reporter's data loss — taking master's side — is caught before Continue drops the commit", async () => {
  // What every product's "Accept Yours" did: `checkout --ours`, i.e. stage 2,
  // i.e. master. The commit is now empty, and the merge backend's --continue
  // drops it without a word. The provider refuses until the user confirms.
  const r = reporterRepo();
  try {
    r.tryGit("rebase", "master");
    const ctx = r.ctx();
    const took = await ctx.conflictOps.takeRole("f.txt", "theirs");
    assert.equal(took.ok, true);
    assert.equal(r.read("f.txt").split("\n")[2], "three-master");

    const op = await ctx.operation.view();
    assert.equal(op.canContinue, true);
    assert.deepEqual(op.willDrop, { sha: r.sha("REBASE_HEAD"), subject: "test change", branch: "test" });

    const refused = await ctx.operation.continue();
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, "confirm-drop");
    assert.equal(refused.expected, true);
    assert.match(refused.message ?? "", /drop .* “test change” from test/);
    assert.equal(r.exists(".git/rebase-merge"), true, "nothing ran");

    // Confirmed: git drops it, as asked.
    const out = await ctx.operation.continue({ confirmDrop: true });
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("log", "--format=%s", "master..test").trim(), "", "the commit is gone — by choice");
  } finally {
    r.cleanup();
  }
});

test("the reporter's rebase reads the same under a German git", async (t) => {
  const de = germanLocale();
  if (!de) {
    t.skip("no German git catalog on this machine");
    return;
  }
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  Object.assign(process.env, { LANG: de.LANG, LC_ALL: de.LC_ALL, LANGUAGE: de.LANGUAGE });
  const r = reporterRepo();
  try {
    r.tryGit("rebase", "master");
    const ctx = r.ctx();
    const op = await ctx.operation.view();
    assert.equal(op.kind, "rebase");
    assert.equal(op.yours.stage, 3);
    assert.ok(op.title.startsWith("Rebasing test onto master · commit 1 of 1"), op.title);
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "yours", { op })).ok, true);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("log", "--format=%s", "master..test").trim(), "test change");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    r.cleanup();
  }
});
