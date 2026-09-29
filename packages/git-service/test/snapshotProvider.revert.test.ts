import { test } from "node:test";
import assert from "node:assert/strict";
import { around, bareRemote, snapRepo, type SnapRepo } from "./snapshotProvider.fixture";

// Once what the op did to HEAD's branch has been pushed, putting it back would
// rewrite published history: the undo is a new commit instead.

const short = (sha: string) => sha.slice(0, 7);

function withRemote(name: string): { r: SnapRepo; dispose: () => void; push: (ref?: string) => void } {
  const r = snapRepo(name);
  const remote = bareRemote();
  r.git("remote", "add", "origin", remote.dir);
  return {
    r,
    push: (ref = "refs/heads/main:refs/heads/main") => void r.git("push", "-q", "-f", "origin", ref),
    dispose: () => {
      r.dispose();
      remote.dispose();
    },
  };
}

test("commits the op added and that were pushed since are reverted one by one, never rewound", async () => {
  const { r, push, dispose } = withRemote("rev-range");
  try {
    const base = r.commit("base", "f.txt", "base\n");
    push();
    const snap = await around(r, "Cherry-pick", () => void r.commit("X"));
    const x = r.git("rev-parse", "HEAD");
    push();
    const p = await r.snap.plan(snap);
    assert.deepEqual(p, { kind: "revert", mode: "range", from: base, to: x, branch: "refs/heads/main" });
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      "It has been pushed since, so putting it back would rewrite published history — it can only be reverted.",
    );
    await assert.rejects(r.snap.restore(snap), /can only be reverted/);
    assert.equal(r.git("rev-parse", "HEAD"), x, "restore refused, nothing moved");

    const res = await r.snap.revert(snap, p as Extract<typeof p, { kind: "revert" }>);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(r.git("rev-parse", "HEAD^"), x, "a new commit on top");
    assert.equal(r.git("ls-tree", "--name-only", "HEAD", "--", "X.txt"), "", "X's file is reverted");
    assert.equal(r.git("ls-tree", "--name-only", "HEAD^", "--", "X.txt"), "X.txt");
    assert.match(r.git("log", "-1", "--format=%s"), /^Revert "X"$/);
  } finally {
    dispose();
  }
});

test("a pushed op whose range holds a merge is undone by one commit restoring the files from before", async () => {
  const { r, push, dispose } = withRemote("rev-tree");
  try {
    const base = r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "s.txt");
    r.git("checkout", "-q", "main");
    push();
    const snap = await around(r, "Merge side", () => void r.git("merge", "-q", "--no-ff", "--no-edit", "side"));
    const merged = r.git("rev-parse", "HEAD");
    push();
    const p = await r.snap.plan(snap);
    assert.deepEqual(p, { kind: "revert", mode: "tree", from: base, to: merged, branch: "refs/heads/main" });
    const res = await r.snap.revert(snap, p as Extract<typeof p, { kind: "revert" }>);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(r.git("rev-parse", "HEAD^"), merged);
    assert.equal(r.git("rev-parse", "HEAD^{tree}"), r.git("rev-parse", `${base}^{tree}`), "the files are base's again");
    assert.equal(r.git("log", "-1", "--format=%B"), `Revert "Merge side"\n\nThis puts back the files as they were before "Merge side" (${short(base)}), which had already been pushed as ${short(merged)}.`);
  } finally {
    dispose();
  }
});

test("when git can't count the merges in the range, the one-commit undo is used", async () => {
  const { r, push, dispose } = withRemote("rev-count-fails");
  try {
    const base = r.commit("base");
    push();
    const snap = await around(r, "Commit", () => void r.commit("X"));
    push();
    const p = r.intercepted((args) => (args[0] === "rev-list" && args[1] === "--merges" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    const plan = await p.plan(snap);
    assert.equal(plan.kind === "revert" && plan.mode, "tree");
    assert.equal(plan.kind === "revert" && plan.from, base);
  } finally {
    dispose();
  }
});

test("the one-commit undo moves nothing when another branch is checked out now, or when git can't write the commit", async () => {
  const { r, push, dispose } = withRemote("rev-tree-guard");
  try {
    r.commit("base", "f.txt", "base\n");
    push();
    const snap = await around(r, "Amend", () => {
      r.write("f.txt", "amended\n");
      r.git("commit", "-q", "-a", "--amend", "--no-edit");
    });
    push();
    const p = await r.snap.plan(snap);
    assert.equal(p.kind === "revert" && p.mode, "tree");
    const plan = p as Extract<typeof p, { kind: "revert" }>;

    const failing = r.intercepted((args) => (args[0] === "commit-tree" ? { code: 128, stdout: "", stderr: "fatal: no tree" } : undefined));
    const res1 = await failing.revert(snap, plan);
    assert.deepEqual(res1, { code: 128, stdout: "", stderr: "fatal: no tree" });

    const tip = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "-b", "elsewhere");
    const res2 = await r.snap.revert(snap, plan);
    assert.equal(res2.code, 1);
    assert.equal(res2.stderr, "'main' moved while you were being asked (a different branch is checked out now), so nothing was reverted. Try Undo again.");
    assert.equal(r.git("rev-parse", "HEAD"), tip, "nothing moved");
    assert.equal(r.git("rev-parse", "main"), tip);
  } finally {
    dispose();
  }
});

test("a pushed commit made on a detached HEAD is reverted with no branch named", async () => {
  const { r, push, dispose } = withRemote("rev-detached");
  try {
    const base = r.commit("base");
    push();
    r.git("checkout", "-q", "--detach");
    const snap = await around(r, "Cherry-pick", () => void r.commit("X"));
    const x = r.git("rev-parse", "HEAD");
    push("HEAD:refs/heads/published");
    r.git("fetch", "-q", "origin");
    const p = await r.snap.plan(snap);
    assert.deepEqual(p, { kind: "revert", mode: "range", from: base, to: x, branch: null });
    // The detached HEAD moved while the question was open: nothing is reverted, and HEAD is named as HEAD.
    const tip = r.commit("meanwhile");
    const res = await r.snap.revert(snap, { ...(p as Extract<typeof p, { kind: "revert" }>), mode: "tree" });
    assert.equal(res.stderr, `HEAD moved while you were being asked (it is at ${short(tip)} now), so nothing was reverted. Try Undo again.`);
    assert.equal(r.git("rev-parse", "HEAD"), tip);
  } finally {
    dispose();
  }
});

test("a pushed op that also moved another branch can't be undone by a revert — refused, nothing changed", async () => {
  const { r, push, dispose } = withRemote("rev-others");
  try {
    r.commit("base");
    r.git("branch", "other");
    push();
    const snap = await around(r, "Squash", () => {
      r.commit("X");
      r.git("branch", "-f", "other", "HEAD");
    });
    push();
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `'main' has been pushed since, so Undo would have to revert it — and it can't put the rest of what "Squash" changed back that way. Nothing was changed.`,
    );
  } finally {
    dispose();
  }
});
