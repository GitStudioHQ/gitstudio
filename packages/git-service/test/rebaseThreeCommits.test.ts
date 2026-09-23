import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, FIVE, edit } from "./opRepo";

// A rebase walked to the end by Continue alone (PLAN §4 P2, scenario T of §5):
// each stop is a NEW episode (a new REBASE_HEAD, the file list reset, "commit
// N of M" moving on) even when the same path conflicts again, and the one
// resolution that would silently drop a commit is caught before it happens.
//
// Note on the fixture: a whole-file "Accept Yours" takes the replayed commit's
// ENTIRE file, which also discards the other side's unrelated lines — so the
// next commit then applies cleanly. To keep the SAME path conflicting at every
// step, steps 1 and 2 are resolved the way the merge editor does (the
// conflicting block from Yours, everything else merged), which is also the
// path through `writeResolution` (the desktop's Apply).

const line = (text: string, n: number): string => text.split("\n")[n - 1];

test("every commit conflicts on the same file: Continue walks 1 → 2 → 3, and an emptied T3 is caught", async () => {
  const r = makeRepo("three-all");
  try {
    r.write("f.txt", FIVE);
    r.commitAll("base");
    r.git("checkout", "-q", "-b", "test");
    r.write("f.txt", edit(FIVE, { one: "one-test" }));
    r.commitAll("T1");
    r.write("f.txt", edit(FIVE, { one: "one-test", three: "three-test" }));
    r.commitAll("T2");
    r.write("f.txt", edit(FIVE, { one: "one-test", three: "three-test", five: "five-test" }));
    r.commitAll("T3");
    r.git("checkout", "-q", "master");
    r.write("f.txt", edit(FIVE, { one: "one-master", three: "three-master", five: "five-master" }));
    r.commitAll("M");
    r.git("checkout", "-q", "test");
    const shas = r.git("rev-list", "--reverse", "master..test").trim().split("\n");
    assert.equal(shas.length, 3);

    assert.notEqual(r.tryGit("rebase", "master"), 0);
    const ctx = r.ctx();

    // ── Step 1: a hand merge (T1's line 1, master's lines 3 and 5) ─────────
    let op = await ctx.operation.view();
    assert.deepEqual(op.step, { n: 1, m: 3, unit: "commit" });
    assert.equal(op.commit?.sha, shas[0]);
    assert.equal(r.sha("REBASE_HEAD"), shas[0]);
    const ep1 = op.episode;
    const s1 = await ctx.conflictOps.writeResolution(
      "f.txt",
      edit(FIVE, { one: "one-test", three: "three-master", five: "five-master" }),
      { op },
    );
    assert.equal(s1.ok, true, s1.message);
    assert.deepEqual((await ctx.conflictOps.snapshot()).files.map((f) => [f.status, f.choice]), [["resolved", "merged"]]);

    let out = await ctx.operation.continue();
    assert.equal(out.ok, false);
    assert.equal(out.stopped, true, "stopped on the NEXT commit — not a failure");
    assert.equal(out.expected, true);
    assert.equal(out.remainingConflicts, 1);
    assert.equal(out.view.commit?.sha, shas[1], "a new REBASE_HEAD");
    assert.equal(r.sha("REBASE_HEAD"), shas[1]);
    assert.deepEqual(out.view.step, { n: 2, m: 3, unit: "commit" });
    assert.notEqual(out.view.episode, ep1, "a new episode");
    assert.equal(out.message, `Stopped at commit 2 of 3: ${shas[1].slice(0, 7)} T2 — 1 file to resolve`);
    assert.ok(out.view.title.includes("commit 2 of 3"), out.view.title);

    // The SAME path conflicts again, and the list starts over.
    let snap = await ctx.conflictOps.snapshot({ op: out.view });
    assert.deepEqual(
      snap.files.map((f) => [f.path, f.status, f.choice]),
      [["f.txt", "pending", undefined]],
      "the resolved row of step 1 does not leak into step 2",
    );

    // ── Step 2: the merge editor — the Yours arrow on the conflict, Apply ──
    op = out.view;
    const sides = await ctx.conflictOps.readSides("f.txt", { op });
    assert.equal(line(sides.yours, 3), "three-test", "Yours = T2's own line, on the left");
    assert.equal(line(sides.theirs, 3), "three-master");
    const s2 = await ctx.conflictOps.writeResolution(
      "f.txt",
      edit(FIVE, { one: "one-test", three: "three-test", five: "five-master" }),
      { op },
    );
    assert.equal(s2.ok, true, s2.message);
    assert.equal((await ctx.operation.view()).canContinue, true);

    out = await ctx.operation.continue();
    assert.equal(out.stopped, true, out.message);
    assert.deepEqual(out.view.step, { n: 3, m: 3, unit: "commit" });
    assert.equal(out.view.commit?.sha, shas[2]);

    // ── Step 3: Accept Theirs would EMPTY T3 ───────────────────────────────
    op = out.view;
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "theirs", { op })).ok, true);
    op = await ctx.operation.view();
    assert.deepEqual(op.willDrop, { sha: shas[2], subject: "T3", branch: "test" });
    const refused = await ctx.operation.continue();
    assert.equal(refused.refused, "confirm-drop");
    assert.equal(refused.ok, false);
    assert.equal(r.sha("REBASE_HEAD"), shas[2], "nothing ran");

    // Hold-to-undo, then Accept Yours, then Continue.
    const back = await ctx.conflictOps.restore("f.txt");
    assert.equal(back.ok, true, back.message);
    assert.equal(r.git("ls-files", "-u", "--", "f.txt").trim().split("\n").length, 3, "unmerged again, all three stages");
    assert.match(r.read("f.txt"), /^<{7} /m, "with the markers back in the file");
    assert.equal((await ctx.conflictOps.snapshot()).files[0].status, "pending");
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "yours")).ok, true);
    assert.equal((await ctx.operation.view()).willDrop, undefined);

    out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Rebase complete");
    assert.deepEqual(
      r.git("log", "--format=%s", "master..test").trim().split("\n"),
      ["T3", "T2", "T1"],
      "all three commits are on the branch",
    );
    assert.equal(r.git("status", "--porcelain").trim(), "", "and the tree is clean");
    assert.equal(r.read("f.txt"), "one-test\ntwo\nthree-test\nfour\nfive-test\n");
  } finally {
    r.cleanup();
  }
});

test("conflicts on commits 1 and 3 only: Continue from 1 goes straight to 3 of 3", async () => {
  const r = makeRepo("three-13");
  try {
    r.write("f.txt", FIVE);
    r.write("k.txt", FIVE);
    r.commitAll("base");
    r.git("checkout", "-q", "-b", "test");
    r.write("f.txt", edit(FIVE, { one: "one-test" }));
    r.commitAll("T1");
    r.write("h.txt", "new in T2\n");
    r.commitAll("T2");
    r.write("k.txt", edit(FIVE, { two: "two-test" }));
    r.commitAll("T3");
    r.git("checkout", "-q", "master");
    r.write("f.txt", edit(FIVE, { one: "one-master" }));
    r.write("k.txt", edit(FIVE, { two: "two-master" }));
    r.commitAll("M");
    r.git("checkout", "-q", "test");
    const shas = r.git("rev-list", "--reverse", "master..test").trim().split("\n");

    r.tryGit("rebase", "master");
    const ctx = r.ctx();
    let op = await ctx.operation.view();
    assert.deepEqual(op.step, { n: 1, m: 3, unit: "commit" });
    assert.equal((await ctx.conflictOps.snapshot({ op })).files[0].path, "f.txt");
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "yours", { op })).ok, true);

    let out = await ctx.operation.continue();
    assert.equal(out.stopped, true, out.message);
    assert.deepEqual(out.view.step, { n: 3, m: 3, unit: "commit" }, "T2 applied cleanly on the way");
    assert.equal(out.view.commit?.sha, shas[2]);
    const snap = await ctx.conflictOps.snapshot({ op: out.view });
    assert.deepEqual(snap.files.map((f) => [f.path, f.status]), [["k.txt", "pending"]], "only this step's file");

    op = out.view;
    assert.equal((await ctx.conflictOps.takeRole("k.txt", "yours", { op })).ok, true);
    out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(r.git("log", "--format=%s", "master..test").trim().split("\n"), ["T3", "T2", "T1"]);
    assert.equal(line(r.read("f.txt"), 1), "one-test");
    assert.equal(line(r.read("k.txt"), 2), "two-test");
    assert.equal(r.read("h.txt"), "new in T2\n");
  } finally {
    r.cleanup();
  }
});
