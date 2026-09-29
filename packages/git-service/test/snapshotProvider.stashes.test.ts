import { test } from "node:test";
import assert from "node:assert/strict";
import { stashStack } from "../src/stashRestore";
import { around, snapRepo, words, type SnapRepo } from "./snapshotProvider.fixture";

// Stashes the op made. When Undo puts back a stash the op took apart — some
// of its files moved out into the tree, the rest pushed as a new, smaller
// stash — that smaller stash goes too, or the list would hold those files
// twice. A stash holding anything the whole didn't is the user's, and kept.

/** base: f.txt, g.txt. Stash "S" changes both (and adds untracked u.txt with `untracked`). */
async function stashS(r: SnapRepo, untracked = false): Promise<string> {
  r.write("f.txt", "base f\n");
  r.write("g.txt", "base g\n");
  r.commit("base");
  r.write("f.txt", "S f\n");
  r.write("g.txt", "S g\n");
  if (untracked) r.write("u.txt", "S u\n");
  r.git("stash", "push", "-q", ...(untracked ? ["-u"] : []), "-m", "S");
  return r.git("rev-parse", "stash@{0}");
}

/** The op: move f.txt out of S — apply S, stash the rest as "S rest", drop S. */
async function moveFOut(r: SnapRepo, rest: string[], untracked = false) {
  return around(r, "Move f.txt out of the stash", () => {
    r.git("stash", "apply", "-q", "stash@{0}");
    r.git("stash", "push", "-q", ...(untracked ? ["-u"] : []), "-m", "S rest", "--", ...rest);
    r.git("stash", "drop", "-q", "stash@{1}");
  });
}

test("undo of moving files out of a stash puts the whole stash back and drops what was left of it", async () => {
  const r = snapRepo("part-plain");
  try {
    const s = await stashS(r);
    const snap = await moveFOut(r, ["g.txt"]);
    assert.equal(r.read("f.txt"), "S f\n", "f.txt came out into the tree");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), [
      "The changes it made to your working tree are taken back.",
      "Put the stash “S” back on top of the stash list.",
    ]);
    assert.ok(p.kind === "restore" && p.steps.some((st) => st.do === "drop-stash"), JSON.stringify(p));
    await r.snap.restore(snap);
    assert.deepEqual((await stashStack(r.ctx.process)).map((x) => x.sha), [s], "S alone, as it was");
    assert.equal(r.read("f.txt"), "base f\n");
  } finally {
    r.dispose();
  }
});

test("the same undo with untracked files in the stash: the rest, untracked part and all, goes too", async () => {
  const r = snapRepo("part-untracked");
  try {
    const s = await stashS(r, true);
    const snap = await moveFOut(r, ["g.txt", "u.txt"], true);
    await r.snap.restore(snap);
    assert.deepEqual((await stashStack(r.ctx.process)).map((x) => x.sha), [s]);
  } finally {
    r.dispose();
  }
});

test("a stash the op made that differs from the one it took is the user's — kept, and said", async () => {
  const r = snapRepo("part-differs");
  try {
    await stashS(r);
    const snap = await around(r, "Move f.txt out of the stash", () => {
      r.git("stash", "apply", "-q", "stash@{0}");
      r.write("g.txt", "changed before stashing the rest\n");
      r.git("stash", "push", "-q", "-m", "S rest", "--", "g.txt");
      r.git("stash", "drop", "-q", "stash@{1}");
    });
    const p = await r.snap.plan(snap);
    assert.ok(
      p.kind === "restore" && p.lines.includes("The stash “On main: S rest” it made is kept: it holds more than Undo puts back."),
      JSON.stringify(p),
    );
    await r.snap.restore(snap);
    assert.equal((await stashStack(r.ctx.process)).length, 2, "S back, and the different one kept");
  } finally {
    r.dispose();
  }
});

test("a stash the op made with untracked files the one it took never had is kept", async () => {
  const r = snapRepo("part-extra-untracked");
  try {
    await stashS(r);
    const snap = await around(r, "Move f.txt out of the stash", () => {
      r.git("stash", "apply", "-q", "stash@{0}");
      r.write("new.txt", "never in S\n");
      r.git("stash", "push", "-q", "-u", "-m", "S rest", "--", "g.txt", "new.txt");
      r.git("stash", "drop", "-q", "stash@{1}");
    });
    const p = await r.snap.plan(snap);
    assert.ok(p.kind === "restore" && p.lines.some((l) => /“On main: S rest” it made is kept/.test(l)), JSON.stringify(p));
  } finally {
    r.dispose();
  }
});

test("a stash the op made on another commit is not part of one it took, whatever it holds", async () => {
  const r = snapRepo("part-other-base");
  try {
    await stashS(r);
    const snap = await around(r, "Move f.txt out of the stash", () => {
      r.git("stash", "apply", "-q", "stash@{0}");
      r.git("stash", "drop", "-q", "stash@{0}");
      r.write("h.txt", "h\n");
      r.git("add", "h.txt");
      r.git("commit", "-q", "-m", "moved on");
      r.git("stash", "push", "-q", "-m", "S rest", "--", "g.txt");
    });
    const p = await r.snap.plan(snap);
    // Same files, same contents — but made on another commit, so not a part of S.
    assert.ok(
      p.kind === "restore" && p.lines.includes("The stash “On main: S rest” it made is kept: it holds more than Undo puts back."),
      JSON.stringify(p),
    );
    assert.ok(p.kind === "restore" && !p.steps.some((st) => st.do === "drop-stash"));
  } finally {
    r.dispose();
  }
});

test("a Stash & Retry stash the user already dropped is left out of the undo — the work still comes back from the copy", async () => {
  const r = snapRepo("sr-dropped");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("F", "f.txt", "feature\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.write("f.txt", "dirty\n");
    const snap = await around(r, "Merge feature", () => {
      r.git("stash", "push", "-q", "-m", "GitStudio: before merging feature");
      r.tryGit("merge", "--no-edit", "feature");
    });
    r.git("stash", "drop", "-q");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), ["The merge in progress is abandoned.", "Your uncommitted changes go back to how they were before it."]);
    assert.ok(p.kind === "restore" && !p.steps.some((st) => st.do === "drop-stash"));
    await r.snap.restore(snap);
    assert.equal(r.read("f.txt"), "dirty\n");
  } finally {
    r.dispose();
  }
});

test("a deferred rebase after a Stash & Retry: the branch goes back, the work comes back, and the op's stash goes", async () => {
  const r = snapRepo("sr-deferred");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "feature");
    const f = r.commit("F");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    r.write("f.txt", "dirty\n");
    const snap = await around(r, "Interactive rebase onto main", () => void r.git("stash", "push", "-q", "-m", "GitStudio: before rebasing"), { deferred: { onto: m } });
    assert.equal(snap.scope?.settled?.pushed?.length, 1);
    r.git("rebase", "-q", "main");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), [`'feature' goes back to ${f.slice(0, 7)}.`, "The uncommitted changes you had then come back too."]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "feature"), f);
    assert.equal(r.read("f.txt"), "dirty\n");
    assert.deepEqual(await stashStack(r.ctx.process), [], "the op's stash of that work is gone");
  } finally {
    r.dispose();
  }
});

test("a deferred detached rebase after a Stash & Retry: HEAD and the work come back, the stash goes", async () => {
  const r = snapRepo("sr-deferred-det");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "t");
    const t = r.commit("T");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "--detach", t);
    r.write("f.txt", "dirty\n");
    const snap = await around(r, "Interactive rebase onto main", () => void r.git("stash", "push", "-q", "-m", "GitStudio: before rebasing"), { deferred: { onto: m } });
    r.git("rebase", "-q", "main");
    assert.deepEqual(words(await r.snap.plan(snap)), [`HEAD goes back to ${t.slice(0, 7)}.`, "The uncommitted changes you had then come back too."]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), t);
    assert.equal(r.read("f.txt"), "dirty\n");
    assert.deepEqual(await stashStack(r.ctx.process), []);
  } finally {
    r.dispose();
  }
});

test("a deferred rebase from a dirty tree that git's autostash carried: the work comes back from the copy, and later edits are named", async () => {
  const r = snapRepo("autostash-deferred");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "feature");
    const f = r.commit("F");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    r.write("f.txt", "dirty\n");
    const snap = await r.snap.capture("Interactive rebase onto main", { deferred: { onto: m } });
    await r.snap.settle(snap);
    r.git("rebase", "-q", "--autostash", "main");
    assert.equal(r.read("f.txt"), "dirty\n", "the autostash put it back");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), [
      `'feature' goes back to ${f.slice(0, 7)}.`,
      "The uncommitted changes you had then come back too.",
      "Uncommitted changes you have made since are discarded.",
    ]);
    assert.equal(p.kind === "restore" && p.danger, true);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "feature"), f);
    assert.equal(r.read("f.txt"), "dirty\n");
  } finally {
    r.dispose();
  }
});

test("an op from a dirty tree, then more edits since: the old work comes back and the new edits are named as discarded", async () => {
  const r = snapRepo("dirty-then-more");
  try {
    const base = r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "before the op\n");
    const snap = await around(r, "Commit g", () => {
      r.write("g.txt", "g\n");
      r.git("add", "g.txt");
      r.git("commit", "-q", "-m", "G");
    });
    r.write("f.txt", "after the op\n");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), [
      `'main' goes back to ${base.slice(0, 7)}.`,
      "The uncommitted changes you had then come back too.",
      "Uncommitted changes you have made since are discarded.",
    ]);
    await r.snap.restore(snap);
    assert.equal(r.read("f.txt"), "before the op\n");
    assert.equal(r.git("rev-parse", "HEAD"), base);
  } finally {
    r.dispose();
  }
});

test("a pop whose tree was put back by hand only needs its stash back", async () => {
  const r = snapRepo("pop-tree-back");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "stashed\n");
    r.git("stash", "push", "-q", "-m", "work");
    const snap = await around(r, "Pop", () => void r.git("stash", "pop", "-q"));
    r.git("checkout", "--", "f.txt");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), ["Put the stash “work” back on top of the stash list."]);
    await r.snap.restore(snap);
    assert.equal(r.git("stash", "list", "--format=%gs"), "On main: work");
    assert.equal(r.read("f.txt"), "base\n");
  } finally {
    r.dispose();
  }
});
