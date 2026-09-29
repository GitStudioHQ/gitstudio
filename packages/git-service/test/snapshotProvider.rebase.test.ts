import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENV, snapRepo, words, type SnapRepo } from "./snapshotProvider.fixture";

// A rebase that goes on after the envelope returns (an interactive rebase in a
// terminal, or one that stopped and was continued by hand) is read back from
// the reflogs at Undo time. On a detached HEAD there is no branch to finish,
// so it is followed through HEAD's own reflog.

const short = (sha: string) => sha.slice(0, 7);

/** base; t: T (t.txt, or f.txt when `clash`); main: M (m.txt, or f.txt when `clash`). HEAD detached at t. */
function detachedTopic(r: SnapRepo, clash = false): { t: string; m: string } {
  r.commit("base", "f.txt", "base\n");
  r.git("checkout", "-q", "-b", "t");
  const t = clash ? r.commit("T", "f.txt", "topic\n") : r.commit("T", "t.txt");
  r.git("checkout", "-q", "main");
  const m = clash ? r.commit("M", "f.txt", "main\n") : r.commit("M", "m.txt");
  r.git("checkout", "-q", "--detach", t);
  return { t, m };
}

async function deferred(r: SnapRepo, onto?: string) {
  const snap = await r.snap.capture("Interactive rebase", { deferred: onto ? { onto } : {} });
  await r.snap.settle(snap);
  return snap;
}

test("a deferred rebase of a detached HEAD, run to the end: HEAD goes back to where it was", async () => {
  const r = snapRepo("det-rebase");
  try {
    const { t, m } = detachedTopic(r);
    const snap = await deferred(r, m);
    r.git("rebase", "-q", "main");
    assert.notEqual(r.git("rev-parse", "HEAD"), t);
    assert.deepEqual(words(await r.snap.plan(snap)), [`HEAD goes back to ${short(t)}.`]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), t);
    assert.equal(r.tryGit("symbolic-ref", "-q", "HEAD").code, 1, "still detached");
    assert.equal(r.git("rev-parse", "main"), m, "main was never the rebase's");
  } finally {
    r.dispose();
  }
});

test("a deferred rebase of a detached HEAD that never started changed nothing — a later commit is the user's", async () => {
  const r = snapRepo("det-nostart");
  try {
    detachedTopic(r);
    const snap = await deferred(r);
    assert.deepEqual(await r.snap.plan(snap), { kind: "nothing", reason: "the rebase didn't change anything." });
    r.commit("mine");
    assert.deepEqual(await r.snap.plan(snap), { kind: "nothing", reason: "the rebase didn't change anything." });
  } finally {
    r.dispose();
  }
});

test("a deferred rebase of a detached HEAD, then a commit on top: refused rather than thrown away", async () => {
  const r = snapRepo("det-after");
  try {
    const { m } = detachedTopic(r);
    const snap = await deferred(r, m);
    r.git("rebase", "-q", "main");
    const later = r.commit("later");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `HEAD has moved since (it is at ${short(later)} now), and putting it back would throw that away.`,
    );
    assert.equal(r.git("rev-parse", "HEAD"), later);
  } finally {
    r.dispose();
  }
});

test("a deferred rebase of a detached HEAD without a HEAD reflog: nothing when HEAD hasn't moved, refused when it has", async () => {
  const r = snapRepo("det-noreflog");
  try {
    detachedTopic(r);
    r.git("config", "core.logAllRefUpdates", "false");
    const snap = await deferred(r);
    rmSync(join(r.dir, ".git", "logs", "HEAD"));
    assert.deepEqual(await r.snap.plan(snap), { kind: "nothing", reason: "the rebase didn't change anything." });
    r.commit("moved");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `GitStudio can't tell what moved HEAD since "Interactive rebase" (it keeps no reflog), so it won't guess. Nothing was changed.`,
    );
  } finally {
    r.dispose();
  }
});

test("a deferred rebase of a detached HEAD that stopped is abandoned by its undo, HEAD said as HEAD", async () => {
  const r = snapRepo("det-stopped");
  try {
    const { t } = detachedTopic(r, true);
    const snap = await deferred(r);
    assert.notEqual(r.tryGit("rebase", "main").code, 0, "the rebase stops on f.txt");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), [`Abandon the rebase in progress: HEAD goes back to ${short(t)}.`]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), t);
    assert.equal(existsSync(join(r.dir, ".git", "rebase-merge")), false, "the rebase is over");
  } finally {
    r.dispose();
  }
});

test("abandoning the rebase is reported when git refuses it", async () => {
  const r = snapRepo("abort-fails");
  try {
    detachedTopic(r, true);
    const snap = await deferred(r);
    r.tryGit("rebase", "main");
    const p = r.intercepted((args) => (args[0] === "rebase" && args[1] === "--abort" ? { code: 1, stdout: "", stderr: "" } : undefined));
    await assert.rejects(p.restore(snap), { message: "Undo couldn't abandon the rebase: git refused" });
    assert.ok(existsSync(join(r.dir, ".git", "rebase-merge")), "still in progress");
    r.git("rebase", "--abort");
  } finally {
    r.dispose();
  }
});

// ── On a branch ──────────────────────────────────────────────────────────────

function feature(r: SnapRepo): { f: string; m: string } {
  r.commit("base", "f.txt", "base\n");
  r.git("checkout", "-q", "-b", "feature");
  const f = r.commit("F");
  r.git("checkout", "-q", "main");
  const m = r.commit("M");
  r.git("checkout", "-q", "feature");
  return { f, m };
}

test("a deferred rebase whose branch was committed to after it finished is refused, naming where it is", async () => {
  const r = snapRepo("br-after");
  try {
    const { m } = feature(r);
    const snap = await deferred(r, m);
    r.git("rebase", "-q", "main");
    const later = r.commit("later");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `'feature' has moved since the rebase (it is at ${short(later)} now), and putting it back would throw that away.`,
    );
  } finally {
    r.dispose();
  }
});

test("a deferred rebase onto a different base than the one recorded is not the op's: nothing to undo", async () => {
  const r = snapRepo("br-other-onto");
  try {
    const { f } = feature(r);
    const base = r.git("rev-parse", "main~1");
    const snap = await deferred(r, base);
    r.git("rebase", "-q", "main");
    assert.deepEqual(await r.snap.plan(snap), { kind: "nothing", reason: "the rebase didn't change any branch." });
    assert.notEqual(r.git("rev-parse", "feature"), f, "and the user's rebase stays");
  } finally {
    r.dispose();
  }
});

test("a deferred rebase of a branch that keeps no reflog is refused rather than guessed", async () => {
  const r = snapRepo("br-noreflog");
  try {
    feature(r);
    r.git("config", "core.logAllRefUpdates", "false");
    const snap = await deferred(r);
    rmSync(join(r.dir, ".git", "logs", "refs", "heads", "feature"));
    r.commit("moved");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `GitStudio can't tell what moved 'feature' since "Interactive rebase" (it keeps no reflog), so it won't guess. Nothing was changed.`,
    );
  } finally {
    r.dispose();
  }
});

test("a deferred rebase is refused while a rebase it didn't start is in progress", async () => {
  const r = snapRepo("br-foreign");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "other");
    r.commit("O", "f.txt", "other\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    const snap = await deferred(r);
    r.git("checkout", "-q", "other");
    assert.notEqual(r.tryGit("rebase", "main").code, 0);
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `A rebase is in progress that "Interactive rebase" didn't start. Finish or abort it first, then undo.`,
    );
    assert.ok(existsSync(join(r.dir, ".git", "rebase-merge")), "and it is left alone");
  } finally {
    r.dispose();
  }
});

test("a leftover rebase-merge folder with nothing in it still counts as a rebase in progress", async () => {
  const r = snapRepo("br-empty-marker");
  try {
    r.commit("base");
    const snap = await r.snap.capture("Commit");
    r.commit("X");
    mkdirSync(join(r.dir, ".git", "rebase-merge"));
    await r.snap.settle(snap);
    assert.deepEqual(snap.scope?.settled?.op, { kind: "rebase", headName: undefined, origHead: undefined, onto: undefined });
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `A rebase is in progress that "Commit" didn't start. Finish or abort it first, then undo.`,
    );
  } finally {
    r.dispose();
  }
});

test("a deferred --update-refs rebase whose carried branch moved again is refused, by that branch's name", async () => {
  const r = snapRepo("carried-moved");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("A");
    r.git("branch", "mid");
    r.commit("B");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    const snap = await deferred(r, m);
    execFileSync("git", ["rebase", "-q", "-i", "--update-refs", "main"], {
      cwd: r.dir,
      env: { ...ENV, GIT_SEQUENCE_EDITOR: "true" },
      stdio: "ignore",
    });
    const carried = r.git("rev-parse", "mid");
    const moved = r.git("commit-tree", "-p", carried, "-m", "more", `${carried}^{tree}`);
    r.git("update-ref", "refs/heads/mid", moved);
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `'mid' has moved since the rebase (it is at ${short(moved)} now), and putting it back would throw that away.`,
    );
  } finally {
    r.dispose();
  }
});

test("a deferred detached --update-refs rebase carries its branch back too", async () => {
  const r = snapRepo("det-carried");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    const a = r.commit("A");
    r.git("branch", "mid");
    const b = r.commit("B");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "--detach", b);
    const snap = await deferred(r, m);
    execFileSync("git", ["rebase", "-q", "-i", "--update-refs", "main"], {
      cwd: r.dir,
      env: { ...ENV, GIT_SEQUENCE_EDITOR: "true" },
      stdio: "ignore",
    });
    assert.notEqual(r.git("rev-parse", "mid"), a);
    const p = await r.snap.plan(snap);
    // feature's tip was among the commits rebased, so git carried it too.
    assert.deepEqual(words(p), [`HEAD goes back to ${short(b)}.`, `'feature' goes back to ${short(b)}.`, `'mid' goes back to ${short(a)}.`]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), b);
    assert.equal(r.git("rev-parse", "mid"), a);
    assert.equal(r.git("rev-parse", "feature"), b);
    assert.equal(r.git("rev-parse", "main"), m, "main, the base, never moved");
  } finally {
    r.dispose();
  }
});
