import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { restoreStash, stashStack } from "../src/stashRestore";
import { stashAndRetry } from "../src/changesInTheWay";
import type { Snapshot } from "../src/SnapshotProvider";

// Undo puts back what an operation changed, and only that — the states the
// extension's and the desktop's state tables don't reach: what happens when
// the user has moved on since, and the stash insert both products call. (The
// drop's own undo, which the desktop calls, is in dropCommit.test.ts.)

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  read: (file: string) => string;
  ctx: GitContext;
  dispose: () => void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gs-undo-scope-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  for (const [k, v] of [["user.email", "u@e.com"], ["user.name", "U"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const ctx = new GitContext({ root: dir });
  return {
    dir,
    git,
    commit,
    read: (file) => readFileSync(join(dir, file), "utf8"),
    ctx,
    dispose: () => {
      ctx.dispose();
      removeTempRepo(dir);
    },
  };
}

/** Run `op` inside a snapshot, the way the Undo envelope does. */
async function around(r: Repo, label: string, op: () => void | Promise<void>): Promise<Snapshot> {
  const snap = await r.ctx.snapshot.capture(label);
  await op();
  await r.ctx.snapshot.settle(snap);
  return snap;
}

// ── Checkout ─────────────────────────────────────────────────────────────────

test("a checkout's undo switches back — it never moves the branch it switched to", async () => {
  const r = repo();
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    const f = r.commit("F");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    const snap = await around(r, "Checkout feature", () => void r.git("checkout", "-q", "feature"));
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore");
    assert.deepEqual(plan.kind === "restore" && plan.lines, ["Switch back to 'main'."]);
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(r.git("rev-parse", "main"), m);
    assert.equal(r.git("rev-parse", "feature"), f, "feature was never touched");
  } finally {
    r.dispose();
  }
});

test("a detach's undo refuses once commits were made on the detached HEAD — they'd be on no branch", async () => {
  const r = repo();
  try {
    const base = r.commit("base");
    r.commit("M");
    const snap = await around(r, "Checkout base", () => void r.git("checkout", "-q", "--detach", base));
    const orphan = r.commit("made while detached");
    const why = await r.ctx.snapshot.whyNotRestorable(snap);
    assert.match(why ?? "", /commits on the detached HEAD since .* leave them on no branch/);
    assert.equal(r.git("rev-parse", "HEAD"), orphan, "nothing moved");
    // Once they have a branch, switching back loses nothing.
    r.git("branch", "keep");
    assert.equal(await r.ctx.snapshot.whyNotRestorable(snap), undefined);
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/main");
  } finally {
    r.dispose();
  }
});

test("a branch the checkout created is deleted by its undo — but not once it has moved", async () => {
  const r = repo();
  try {
    const base = r.commit("base");
    r.commit("M");
    // A remote-tracking ref stands in for origin/x; the checkout makes x from it.
    r.git("remote", "add", "origin", join(r.dir, "no-such-remote.git"));
    r.git("update-ref", "refs/remotes/origin/x", base);
    const made = await around(r, "Checkout origin/x", () => void r.git("checkout", "-q", "-b", "x", "--track", "origin/x"));
    const plan = await r.ctx.snapshot.plan(made);
    assert.deepEqual(plan.kind === "restore" && plan.lines, [
      "Switch back to 'main'.",
      `Delete branch 'x', which "Checkout origin/x" created.`,
    ]);
    r.commit("X2");
    const why = await r.ctx.snapshot.whyNotRestorable(made);
    assert.match(why ?? "", /'x' has moved since/);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/x", "refused, so nothing moved");
  } finally {
    r.dispose();
  }
});

// ── A branch moved while checked out ─────────────────────────────────────────

test("commits made after the op are never thrown away: refused, in words", async () => {
  const r = repo();
  try {
    r.commit("base");
    const snap = await around(r, "Cherry-pick", () => void r.commit("picked"));
    const later = r.commit("later");
    assert.match((await r.ctx.snapshot.whyNotRestorable(snap)) ?? "", /'main' has moved since \(it is at .* now\), and putting it back would throw that away/);
    assert.equal(r.git("rev-parse", "HEAD"), later);
  } finally {
    r.dispose();
  }
});

test("an edit made after the op is kept by reset --keep, or named as discarded when it can't be", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    const m = r.git("rev-parse", "HEAD");
    const snap = await around(r, "Commit g", () => void r.commit("G", "g.txt", "g\n"));
    // An edit to a file the undo doesn't touch: kept.
    writeFileSync(join(r.dir, "f.txt"), "edited since\n");
    const keep = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(keep.kind === "restore" && keep.lines, ["'main' goes back to " + m.slice(0, 7) + ".", "Your uncommitted changes are kept."]);
    assert.equal(keep.kind === "restore" && keep.danger, false);
    // An edit to the file the undo removes: said, with danger.
    writeFileSync(join(r.dir, "g.txt"), "g, edited since\n");
    const lose = await r.ctx.snapshot.plan(snap);
    assert.equal(lose.kind === "restore" && lose.danger, true);
    assert.ok(lose.kind === "restore" && lose.lines.includes("Uncommitted changes you have made since are discarded."));
    // With only the first edit, Undo keeps it.
    r.git("checkout", "--", "g.txt");
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), m);
    assert.equal(r.read("f.txt"), "edited since\n");
  } finally {
    r.dispose();
  }
});

test("nothing uncommitted now means nothing is discarded — the question doesn't say it is", async () => {
  const r = repo();
  try {
    r.commit("base");
    const m1 = r.commit("M1");
    r.commit("M2");
    // A soft reset leaves M2's change staged; the user then throws it away.
    const snap = await around(r, "Reset to M1 (--soft)", () => void r.git("reset", "--soft", m1));
    r.git("reset", "-q", "--hard");
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore");
    assert.equal(plan.kind === "restore" && plan.danger, false);
    assert.ok(plan.kind === "restore" && !plan.lines.some((l) => /discarded/.test(l)), JSON.stringify(plan));
  } finally {
    r.dispose();
  }
});

test("an untracked file where going back puts a file is never overwritten — refused, by name", async () => {
  const r = repo();
  try {
    r.commit("base");
    const a = r.commit("A", "a.txt", "a\n");
    // Undo would bring a.txt back; a new, untracked a.txt is in its place.
    const snap = await around(r, "Reset to base (--hard)", () => void r.git("reset", "-q", "--hard", "HEAD~1"));
    writeFileSync(join(r.dir, "a.txt"), "mine, new since\n");
    assert.match(
      (await r.ctx.snapshot.whyNotRestorable(snap)) ?? "",
      /'a\.txt' is untracked here, and going back to .* would overwrite it\. Move it aside, then undo\./,
    );
    await assert.rejects(r.ctx.snapshot.restore(snap));
    assert.equal(r.read("a.txt"), "mine, new since\n", "the untracked file is untouched");
    assert.notEqual(r.git("rev-parse", "HEAD"), a, "and nothing moved");

    // A mixed reset's own leftover — the file it untracked, unchanged — is
    // what going back puts there anyway: not in the way.
    r.git("reset", "-q", "--hard", a);
    const mixed = await around(r, "Reset to base (--mixed)", () => void r.git("reset", "-q", "--mixed", "HEAD~1"));
    assert.equal(await r.ctx.snapshot.whyNotRestorable(mixed), undefined);
    await r.ctx.snapshot.restore(mixed);
    assert.equal(r.git("rev-parse", "HEAD"), a);
    assert.equal(r.git("status", "--porcelain"), "");
  } finally {
    r.dispose();
  }
});

// ── A rebase that stopped ────────────────────────────────────────────────────

/** feature (F) and main (M) both edit f.txt: rebasing feature onto main stops. */
function conflicting(r: Repo): string {
  r.commit("base", "f.txt", "base\n");
  r.git("checkout", "-q", "-b", "feature");
  const f = r.commit("F", "f.txt", "feature\n");
  r.git("checkout", "-q", "main");
  r.commit("M", "f.txt", "main\n");
  r.git("checkout", "-q", "feature");
  return f;
}

function rebaseStops(r: Repo): void {
  try {
    r.git("rebase", "main");
    assert.fail("the rebase was meant to stop");
  } catch {
    /* stopped on the conflict */
  }
}

test("a rebase that stopped and was then CONTINUED by hand is undone by its reflog: the branch goes back", async () => {
  const r = repo();
  try {
    const f = conflicting(r);
    const snap = await around(r, "Rebase onto main", () => rebaseStops(r));
    writeFileSync(join(r.dir, "f.txt"), "resolved\n");
    r.git("add", "f.txt");
    execFileSync("git", ["rebase", "--continue"], { cwd: r.dir, env: { ...ENV, GIT_EDITOR: "true" }, stdio: "ignore" });
    assert.notEqual(r.git("rev-parse", "feature"), f);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(plan.kind === "restore" && plan.lines, [`'feature' goes back to ${f.slice(0, 7)}.`]);
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "feature"), f);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/feature");
  } finally {
    r.dispose();
  }
});

test("a rebase that stopped and was then ABORTED by hand leaves nothing to undo", async () => {
  const r = repo();
  try {
    const f = conflicting(r);
    const snap = await around(r, "Rebase onto main", () => rebaseStops(r));
    r.git("rebase", "--abort");
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "nothing");
    assert.equal(r.git("rev-parse", "feature"), f);
  } finally {
    r.dispose();
  }
});

test("a rebase this op didn't start is never aborted by its undo", async () => {
  const r = repo();
  try {
    conflicting(r);
    r.git("checkout", "-q", "main");
    const snap = await around(r, "Commit X", () => void r.commit("X"));
    r.git("checkout", "-q", "feature");
    rebaseStops(r);
    const why = await r.ctx.snapshot.whyNotRestorable(snap);
    assert.ok(why, "refused");
    assert.ok(existsSync(join(r.dir, ".git", "rebase-merge")), "the other rebase is still there");
  } finally {
    r.dispose();
  }
});

// ── Nothing changed ──────────────────────────────────────────────────────────

test("an op that changed nothing is reported as such — the envelope records nothing", async () => {
  const r = repo();
  try {
    r.commit("base");
    r.git("branch", "feature");
    const snap = await around(r, "Delete branch feature (cancelled)", () => {});
    assert.equal(r.ctx.snapshot.changed(snap), false);
    const deleted = await around(r, "Delete branch feature", () => void r.git("branch", "-D", "feature"));
    assert.equal(r.ctx.snapshot.changed(deleted), true);
  } finally {
    r.dispose();
  }
});

// ── Stashes ──────────────────────────────────────────────────────────────────

test("a dropped stash goes back where it was — and on top when the stack has changed since", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    for (const m of ["one", "two", "three"]) {
      writeFileSync(join(r.dir, "f.txt"), `${m}\n`);
      r.git("stash", "push", "-q", "-m", m);
    }
    const before = await stashStack(r.ctx.process);
    const snap = await around(r, "Drop stash@{1}", () => void r.git("stash", "drop", "-q", "stash@{1}"));
    const plan = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(plan.kind === "restore" && plan.lines, ["Put the stash “On main: two” back as stash@{1}."]);
    await r.ctx.snapshot.restore(snap);
    assert.deepEqual(await stashStack(r.ctx.process), before, "the same stashes, in the same order");

    // Dropped again, then a new stash on top: the old place no longer means
    // what it did, so it goes on top — and says so.
    const [top] = await stashStack(r.ctx.process);
    const two = before[1];
    r.git("stash", "drop", "-q", "stash@{1}");
    writeFileSync(join(r.dir, "f.txt"), "four\n");
    r.git("stash", "push", "-q", "-m", "four");
    const back = await restoreStash(r.ctx.process, two, { index: 1, above: [top.sha] });
    assert.deepEqual(back, { ok: true, index: 0 });
    assert.equal((await stashStack(r.ctx.process))[0].sha, two.sha);
  } finally {
    r.dispose();
  }
});

// ── While a conflict is unresolved ───────────────────────────────────────────
//
// `git stash create` refuses an index with unmerged entries ("Cannot save the
// current index state"), and the capture used to throw with it — so an op run
// during a stopped merge ran unguarded and recorded nothing, while its
// question promised Undo. The branches and stashes are still recorded now;
// what can't be copied is said, and never "put back".

/** main (M) and other (O) both edit f.txt: merging other stops on it. */
function mergeStops(r: Repo): { m: string } {
  r.commit("base", "f.txt", "base\n");
  r.git("checkout", "-q", "-b", "other");
  r.commit("O", "f.txt", "other\n");
  r.git("checkout", "-q", "main");
  const m = r.commit("M", "f.txt", "main\n");
  try {
    r.git("merge", "other");
    assert.fail("the merge was meant to stop");
  } catch {
    /* stopped on the conflict */
  }
  return { m };
}

test("during a conflict a force-deleted branch still comes back — the snapshot records it though git won't copy the tree", async () => {
  const r = repo();
  try {
    r.commit("seed", "seed.txt");
    r.git("branch", "feature");
    r.git("checkout", "-q", "feature");
    const f = r.commit("F", "only-here.txt");
    r.git("checkout", "-q", "main");
    mergeStops(r);
    writeFileSync(join(r.dir, "f.txt"), "my hand resolution\n");
    const snap = await around(r, "Delete branch feature", () => void r.git("branch", "-D", "feature"));
    assert.equal(r.ctx.snapshot.changed(snap), true);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(plan.kind === "restore" && plan.lines, [`Bring back branch 'feature' at ${f.slice(0, 7)}.`], JSON.stringify(plan));
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "refs/heads/feature"), f);
    assert.equal(r.read("f.txt"), "my hand resolution\n", "the resolution in progress is untouched");
    assert.ok(existsSync(join(r.dir, ".git", "MERGE_HEAD")), "and the merge is still stopped");
  } finally {
    r.dispose();
  }
});

test("a dropped stash during a conflict comes back", async () => {
  const r = repo();
  try {
    r.commit("seed", "seed.txt", "seed\n");
    writeFileSync(join(r.dir, "seed.txt"), "stashed\n");
    r.git("stash", "push", "-q", "-m", "keep me");
    mergeStops(r);
    const before = await stashStack(r.ctx.process);
    const snap = await around(r, "Drop stash@{0}", () => void r.git("stash", "drop", "-q"));
    assert.equal(r.ctx.snapshot.changed(snap), true);
    await r.ctx.snapshot.restore(snap);
    assert.deepEqual(await stashStack(r.ctx.process), before);
  } finally {
    r.dispose();
  }
});

test("a hard reset during a conflict: Undo puts the branch back and says the edits it threw away can't come back", async () => {
  const r = repo();
  try {
    const { m } = mergeStops(r);
    writeFileSync(join(r.dir, "f.txt"), "my hand resolution\n");
    const snap = await around(r, "Reset to base (--hard)", () => void r.git("reset", "-q", "--hard", "HEAD~1"));
    assert.equal(snap.stashSha, null);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore", JSON.stringify(plan));
    assert.deepEqual(plan.kind === "restore" && plan.lines, [
      `'main' goes back to ${m.slice(0, 7)}.`,
      "The uncommitted changes you had before it can't come back — git couldn't keep a copy of them while a conflict was unresolved.",
    ]);
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "main"), m);
    assert.equal(r.git("status", "--porcelain"), "");
  } finally {
    r.dispose();
  }
});

test("a mixed reset during a conflict: Undo puts the branch back and leaves the working tree — the resolution in it — alone", async () => {
  const r = repo();
  try {
    const { m } = mergeStops(r);
    writeFileSync(join(r.dir, "f.txt"), "my hand resolution\n");
    const snap = await around(r, "Reset to base (--mixed)", () => void r.git("reset", "-q", "--mixed", "HEAD~1"));
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore", JSON.stringify(plan));
    assert.equal(plan.kind === "restore" && plan.danger, false);
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "main"), m);
    assert.equal(r.read("f.txt"), "my hand resolution\n", "a reset that kept the files is undone without touching them");
  } finally {
    r.dispose();
  }
});

test("an op that changed only an uncopied tree records nothing — there is nothing Undo could put back", async () => {
  const r = repo();
  try {
    mergeStops(r);
    const snap = await around(r, "Accept Yours: f.txt", () => {
      r.git("checkout", "--ours", "--", "f.txt");
      r.git("add", "f.txt");
    });
    assert.equal(r.ctx.snapshot.changed(snap), false);
  } finally {
    r.dispose();
  }
});

// ── An op that moves only refs ───────────────────────────────────────────────
//
// Delete branch, Drop stash and a reset of a branch that isn't checked out
// never touch the working tree — but their doors can ask a question inside the
// envelope ("not fully merged — Force Delete?"), and an edit saved while it
// was open was taken as the op's own: a CANCELLED delete was recorded, and
// its Undo ran `reset --hard HEAD` over the edit.

test("a refs-only op doesn't own an edit made while it ran: a cancel records nothing, and Undo never touches the tree", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("branch", "feature");
    const cancelled = await r.ctx.snapshot.capture("Delete branch feature", { refsOnly: true });
    writeFileSync(join(r.dir, "f.txt"), "typed while the question was open\n");
    await r.ctx.snapshot.settle(cancelled);
    assert.equal(r.ctx.snapshot.changed(cancelled), false, "the delete was cancelled: nothing to undo");

    const deleted = await r.ctx.snapshot.capture("Delete branch feature", { refsOnly: true });
    writeFileSync(join(r.dir, "f.txt"), "typed again\n");
    r.git("branch", "-D", "feature");
    await r.ctx.snapshot.settle(deleted);
    const plan = await r.ctx.snapshot.plan(deleted);
    assert.equal(plan.kind === "restore" && plan.steps.some((s) => s.do === "tree"), false, JSON.stringify(plan));
    await r.ctx.snapshot.restore(deleted);
    assert.ok(r.git("rev-parse", "--verify", "refs/heads/feature"));
    assert.equal(r.read("f.txt"), "typed again\n", "the edit is the user's, and stays");
  } finally {
    r.dispose();
  }
});

test("a reset of a branch that isn't checked out never takes back the working tree — work from before it included", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("branch", "x");
    r.commit("M", "m.txt");
    writeFileSync(join(r.dir, "f.txt"), "work from before the op\n");
    const snap = await r.ctx.snapshot.capture("Reset x to origin/x", { branch: "refs/heads/x" });
    r.git("update-ref", "refs/heads/x", "HEAD");
    writeFileSync(join(r.dir, "m.txt"), "saved by the editor meanwhile\n");
    await r.ctx.snapshot.settle(snap);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(plan.kind === "restore" && plan.steps.map((s) => s.do), ["ref"], JSON.stringify(plan));
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.read("f.txt"), "work from before the op\n");
    assert.equal(r.read("m.txt"), "saved by the editor meanwhile\n");
  } finally {
    r.dispose();
  }
});

test("a tree step never runs without a copy of the tree it replaces — refused instead", async () => {
  const r = repo();
  try {
    mergeStops(r);
    r.git("branch", "side");
    // Both a branch deleted and the tree changed, during a conflict: the
    // branch can come back; the tree can't, and Undo says so rather than
    // resetting it.
    const snap = await around(r, "Something", () => {
      r.git("branch", "-D", "side");
      r.git("checkout", "--theirs", "--", "f.txt");
      r.git("add", "f.txt");
    });
    assert.equal(r.ctx.snapshot.changed(snap), true);
    const why = await r.ctx.snapshot.whyNotRestorable(snap);
    assert.match(why ?? "", /couldn't keep a copy of your uncommitted changes/);
    assert.equal(r.read("f.txt"), "other\n", "nothing was reset");
  } finally {
    r.dispose();
  }
});

// ── What a rebase that went on after the op changed ──────────────────────────
//
// A deferred interactive rebase (handed to a terminal) and a rebase that
// stopped are read back from the reflogs at Undo time. Only THIS rebase's
// moves are the op's: the HEAD branch's own "rebase (finish): … onto <onto>"
// after the capture, and a branch it carried ("rewritten during rebase") by
// that same finish. A rebase the user ran later, of another branch, is theirs.

test("a deferred interactive rebase the user quit changed nothing — a later rebase of another branch is not the op's", async () => {
  const r = repo();
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "topic");
    const t = r.commit("T");
    r.git("checkout", "-q", "main");
    const a = r.commit("A");
    r.commit("B");
    const onto = r.git("rev-parse", `${a}^`);
    const snap = await r.ctx.snapshot.capture(`Interactive rebase onto ${a.slice(0, 7)}^`, { deferred: { onto } });
    await r.ctx.snapshot.settle(snap);
    // The todo is quit: nothing happens. Later, in a terminal:
    r.git("rebase", "-q", "main", "topic");
    r.git("checkout", "-q", "main");
    const rebased = r.git("rev-parse", "topic");
    assert.notEqual(rebased, t);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "nothing", JSON.stringify(plan));
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "topic"), rebased, "the user's own rebase of topic stays");
  } finally {
    r.dispose();
  }
});

test("a rebase that stopped and was continued by hand: a later rebase of another branch is not put back with it", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "other");
    r.commit("O");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.git("checkout", "-q", "-b", "feature", "HEAD~1");
    const f = r.commit("F", "f.txt", "feature\n");
    const snap = await around(r, "Rebase onto main", () => rebaseStops(r));
    writeFileSync(join(r.dir, "f.txt"), "resolved\n");
    r.git("add", "f.txt");
    execFileSync("git", ["rebase", "--continue"], { cwd: r.dir, env: { ...ENV, GIT_EDITOR: "true" }, stdio: "ignore" });
    r.git("rebase", "-q", "main", "other");
    r.git("checkout", "-q", "feature");
    const other = r.git("rev-parse", "other");
    const plan = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(plan.kind === "restore" && plan.lines, [`'feature' goes back to ${f.slice(0, 7)}.`], JSON.stringify(plan));
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "feature"), f);
    assert.equal(r.git("rev-parse", "other"), other, "other was never the op's");
  } finally {
    r.dispose();
  }
});

test("a deferred rebase with --update-refs, run to the end: the branch it carried goes back with it", async () => {
  const r = repo();
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    const a = r.commit("A");
    r.git("branch", "mid");
    const b = r.commit("B");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    const snap = await r.ctx.snapshot.capture("Interactive rebase onto main", { deferred: { onto: m } });
    await r.ctx.snapshot.settle(snap);
    execFileSync("git", ["rebase", "-q", "-i", "--update-refs", "main"], {
      cwd: r.dir,
      env: { ...ENV, GIT_SEQUENCE_EDITOR: "true" },
      stdio: "ignore",
    });
    assert.notEqual(r.git("rev-parse", "mid"), a);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.deepEqual(
      plan.kind === "restore" && [...plan.lines].sort(),
      [`'feature' goes back to ${b.slice(0, 7)}.`, `'mid' goes back to ${a.slice(0, 7)}.`].sort(),
      JSON.stringify(plan),
    );
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "feature"), b);
    assert.equal(r.git("rev-parse", "mid"), a);
  } finally {
    r.dispose();
  }
});

// ── Stash & Retry ────────────────────────────────────────────────────────────
//
// A door whose command was refused over uncommitted work stashes it ("GitStudio:
// before rebasing onto main") and runs the command again. When the command
// then stops, the work waits in that stash. Undo used to abandon the rebase and
// leave it there — the tree clean, the edits nowhere the question mentioned.

test("undo of a Stash & Retry rebase that stopped: the rebase is abandoned AND the uncommitted work comes back", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    r.commit("g", "g.txt", "g\n");
    r.git("checkout", "-q", "-b", "feature");
    const f = r.commit("F", "f.txt", "feature\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.git("checkout", "-q", "feature");
    writeFileSync(join(r.dir, "g.txt"), "my uncommitted edit\n");
    const snap = await around(r, "Rebase onto main", async () => {
      const out = await stashAndRetry(r.ctx.process, { kind: "rebase", onto: "refs/heads/main", args: ["rebase", "refs/heads/main"] });
      assert.equal(out.fate, "waiting");
    });
    assert.equal((await stashStack(r.ctx.process)).length, 1, "the work waits in the stash");
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore", JSON.stringify(plan));
    assert.deepEqual(plan.kind === "restore" && plan.lines, [
      `Abandon the rebase in progress: 'feature' stays at ${f.slice(0, 7)}, as it was.`,
      "Your uncommitted changes come back as they were before it.",
    ]);
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/feature");
    assert.equal(r.git("rev-parse", "HEAD"), f);
    assert.equal(r.read("g.txt"), "my uncommitted edit\n", "the edit is back in the tree");
    assert.deepEqual(await stashStack(r.ctx.process), [], "and the stash the op made for it is gone again");
  } finally {
    r.dispose();
  }
});

test("undo of a Stash & Retry merge that stopped: the work comes back, and the op's own stash of it goes", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("F", "f.txt", "feature\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    writeFileSync(join(r.dir, "f.txt"), "dirty\n");
    const snap = await around(r, "Merge feature", async () => {
      const out = await stashAndRetry(r.ctx.process, { kind: "merge", target: "refs/heads/feature", args: ["merge", "--no-edit", "refs/heads/feature"] });
      assert.equal(out.fate, "waiting");
    });
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.read("f.txt"), "dirty\n");
    assert.equal(existsSync(join(r.dir, ".git", "MERGE_HEAD")), false);
    assert.deepEqual(await stashStack(r.ctx.process), [], "the op's stash is dropped once its work is back");
  } finally {
    r.dispose();
  }
});

test("a stash the op made that holds MORE than Undo puts back is kept, and the question says where it is", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("F", "f.txt", "feature\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    writeFileSync(join(r.dir, "f.txt"), "dirty\n");
    const snap = await around(r, "Merge feature", async () => {
      // As Stash & Retry does, but with an untracked file in the stash too —
      // the snapshot's copy never holds untracked files.
      writeFileSync(join(r.dir, "new.txt"), "untracked\n");
      r.git("stash", "push", "-q", "-u", "-m", "GitStudio: before merging feature");
      try {
        r.git("merge", "--no-edit", "feature");
      } catch {
        /* stops */
      }
    });
    const plan = await r.ctx.snapshot.plan(snap);
    assert.ok(
      plan.kind === "restore" && plan.lines.includes("The stash “On main: GitStudio: before merging feature” it made is kept: it holds more than Undo puts back."),
      JSON.stringify(plan),
    );
    await r.ctx.snapshot.restore(snap);
    assert.equal((await stashStack(r.ctx.process)).length, 1);
  } finally {
    r.dispose();
  }
});

test("an op that asked a question inside the envelope: an undo that rewrites the tree says it takes edits made meanwhile, in red", async () => {
  // The question is DOM, not modal: an edit saved while it was open lands
  // inside the op's window and can't be told from the op's own changes.
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    writeFileSync(join(r.dir, "g.txt"), "stashed\n");
    r.git("add", "g.txt");
    r.git("stash", "push", "-q", "-m", "work");
    const snap = await r.ctx.snapshot.capture("Pop stash@{0}");
    writeFileSync(join(r.dir, "f.txt"), "typed while the question was open\n");
    r.git("stash", "pop", "-q");
    r.ctx.snapshot.markAsked(snap);
    await r.ctx.snapshot.settle(snap);
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind === "restore" && plan.danger, true, JSON.stringify(plan));
    assert.ok(plan.kind === "restore" && plan.lines.includes("Anything you changed while its question was open is discarded too."), JSON.stringify(plan));

    // Without a question there is no window: the same undo is not red.
    r.git("reset", "-q", "--hard");
    writeFileSync(join(r.dir, "g.txt"), "stashed\n");
    r.git("add", "g.txt");
    r.git("stash", "push", "-q", "-m", "work");
    const quiet = await around(r, "Pop stash@{0}", () => void r.git("stash", "pop", "-q"));
    const calm = await r.ctx.snapshot.plan(quiet);
    assert.equal(calm.kind === "restore" && calm.danger, false, JSON.stringify(calm));
  } finally {
    r.dispose();
  }
});

test("the pushed-history revert never moves HEAD from anywhere but where the op left it", async () => {
  const r = repo();
  try {
    const remote = mkdtempSync(join(tmpdir(), "gs-undo-scope-origin-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
    r.git("remote", "add", "origin", remote);
    r.commit("base");
    r.commit("M");
    r.git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
    const snap = await around(r, "Amend commit", () => {
      writeFileSync(join(r.dir, "base.txt"), "amended in\n");
      r.git("add", "base.txt");
      r.git("commit", "-q", "--amend", "--no-edit");
    });
    r.git("push", "-q", "-f", "origin", "refs/heads/main:refs/heads/main");
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "revert", JSON.stringify(plan));
    const c = r.commit("C meanwhile");
    const out = await r.ctx.snapshot.revert(snap, plan as Extract<typeof plan, { kind: "revert" }>);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /'main' moved while you were being asked/);
    assert.equal(r.git("rev-parse", "HEAD"), c, "C is still the tip");
    removeTempRepo(remote);
  } finally {
    r.dispose();
  }
});

test("undo of a Stash & Retry pop whose put-back git refused: the work, the popped stash in its place, and no stash of the op's", async () => {
  const r = repo();
  try {
    r.commit("base", "f.txt", "base\n");
    writeFileSync(join(r.dir, "f.txt"), "stashed A\n");
    r.git("stash", "push", "-q", "-m", "A");
    writeFileSync(join(r.dir, "g.txt"), "stashed X\n");
    r.git("stash", "push", "-q", "-u", "-m", "X");
    const before = (await stashStack(r.ctx.process)).map((x) => x.sha); // [X, A]
    writeFileSync(join(r.dir, "f.txt"), "my edit, in the way\n");
    const snap = await around(r, "Pop stash@{1}", async () => {
      const out = await stashAndRetry(r.ctx.process, { kind: "stash", stash: "stash@{1}", pop: true });
      assert.equal(out.fate, "kept", "git won't pop the op's stash over what the pop brought in");
    });
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore", JSON.stringify(plan));
    assert.ok(plan.kind === "restore" && plan.lines.includes("Put the stash “On main: A” back as stash@{1}."), JSON.stringify(plan));
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.read("f.txt"), "my edit, in the way\n");
    assert.deepEqual((await stashStack(r.ctx.process)).map((x) => x.sha), before, "A back below X, as it was, and the op's own stash gone");
  } finally {
    r.dispose();
  }
});

test("a mixed reset during a conflict with a new file staged: Undo still leaves every file alone", async () => {
  // The reset leaves the staged new file untracked — same content, same
  // place — so the working tree is still exactly what it was.
  const r = repo();
  try {
    const { m } = mergeStops(r);
    writeFileSync(join(r.dir, "f.txt"), "my hand resolution\n");
    writeFileSync(join(r.dir, "g.txt"), "a staged new file\n");
    r.git("add", "g.txt");
    const snap = await around(r, "Reset to base (--mixed)", () => void r.git("reset", "-q", "--mixed", "HEAD~1"));
    const plan = await r.ctx.snapshot.plan(snap);
    assert.equal(plan.kind, "restore", JSON.stringify(plan));
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "main"), m);
    assert.equal(r.read("f.txt"), "my hand resolution\n");
    assert.equal(r.read("g.txt"), "a staged new file\n");
  } finally {
    r.dispose();
  }
});

test("undo of a stopped rebase that git's own autostash set the work aside for: it comes back once, not twice", async () => {
  const r = repo();
  try {
    const f = conflicting(r);
    r.git("config", "rebase.autoStash", "true");
    writeFileSync(join(r.dir, "g.txt"), "untracked is not the point\n");
    writeFileSync(join(r.dir, "feat-only.txt"), "x\n");
    r.git("add", "feat-only.txt");
    r.git("commit", "-q", "-m", "feat-only");
    const tip = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "feat-only.txt"), "my uncommitted edit\n");
    const snap = await around(r, "Rebase onto main", () => rebaseStops(r));
    assert.ok(existsSync(join(r.dir, ".git", "rebase-merge", "autostash")), "git holds the work in its autostash");
    await r.ctx.snapshot.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), tip);
    assert.equal(r.read("feat-only.txt"), "my uncommitted edit\n");
    assert.equal(r.git("status", "--porcelain", "--untracked-files=no"), "M feat-only.txt");
    void f;
  } finally {
    r.dispose();
  }
});
