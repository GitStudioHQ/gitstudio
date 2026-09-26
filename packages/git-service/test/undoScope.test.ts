import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { restoreStash, stashStack } from "../src/stashRestore";
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
