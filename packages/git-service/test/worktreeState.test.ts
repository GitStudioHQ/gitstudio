// What the Worktrees view reads about each worktree, cell by cell against real
// git: the tier-0 snapshot (every worktree in a fixed number of spawns), a
// row's working tree and stopped operation, the commits it has not pushed —
// counted by the push review's rule — and Stash & Remove.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { sameFolder } from "../src/folderPath";
import { parseWorktreePorcelain, parseWorktreePorcelainZ, WorktreeProvider } from "../src/WorktreeProvider";
import { parseRefFacts, unpublishedRange, unpublishedRule, type WorktreeSummary, type WorktreesSnapshot } from "../src/worktreeState";
import type { GitProcess } from "../src/GitProcess";
import { removeTempRepo } from "./tmpRepo";

// Resolved natively: on Windows that is the long spelling (RUNNER~1 → runneradmin),
// as git writes it. Folders are still compared with sameFolder — git spells
// them C:/Users/…, node C:\Users\….
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "gitstudio-wt-state-")));
const contexts: GitContext[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  removeTempRepo(scratch);
});
let seq = 0;

function at(cwd: string) {
  return (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const identity = [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]];

interface Repo {
  base: string;
  app: string;
  git: (...a: string[]) => string;
  ctx: GitContext;
  spawns: string[][];
  wt: (name: string) => string;
  commit: (dir: string, file: string, text: string) => void;
}

/** A main worktree on `main`, optionally cloned from a bare origin (so it has one remote). */
function repo(opts: { origin?: boolean; remoteName?: string } = {}): Repo {
  const base = join(scratch, `r${++seq}`);
  const app = join(base, "app");
  mkdirSync(base, { recursive: true });
  if (opts.origin) {
    const seed = join(base, "seed");
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    for (const [k, v] of identity) at(seed)("config", k, v);
    writeFileSync(join(seed, "a.txt"), "a\n");
    at(seed)("add", ".");
    at(seed)("commit", "-qm", "base");
    execFileSync("git", ["clone", "-q", "--bare", seed, join(base, "origin.git")]);
    execFileSync("git", ["clone", "-q", ...(opts.remoteName ? ["-o", opts.remoteName] : []), join(base, "origin.git"), app]);
  } else {
    execFileSync("git", ["init", "-q", "-b", "main", app]);
  }
  const git = at(app);
  for (const [k, v] of identity) git("config", k, v);
  if (!opts.origin) {
    writeFileSync(join(app, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
  }
  const spawns: string[][] = [];
  const ctx = new GitContext({ root: app, onRun: (e) => spawns.push(e.args) });
  contexts.push(ctx);
  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    at(dir)("add", file);
    at(dir)("commit", "-qm", `${file}: ${text.trim()}`);
  };
  return { base, app, git, ctx, spawns, wt: (n) => join(base, "wt", n), commit };
}

const byBranch = (snap: WorktreesSnapshot, b: string): WorktreeSummary => {
  const w = snap.worktrees.find((x) => x.branch === b);
  assert.ok(w, `a worktree on ${b}`);
  return w;
};

// ── The list itself ──────────────────────────────────────────────────────────

test("-z: a path with a newline and a lock reason with quotes read whole, never C-quoted", () => {
  const parsed = parseWorktreePorcelainZ(
    ["worktree /r", "HEAD a", "branch refs/heads/main", "",
      "worktree /r/fe\nat x", "HEAD b", "branch refs/heads/feat", 'locked agent "7"\nline two é', "",
      "worktree /r/det", "HEAD c", "detached", "prunable gitdir file points to non-existent location", "", ""].join("\0"),
  );
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].path, "/r/fe\nat x");
  assert.equal(parsed[1].lockReason, 'agent "7"\nline two é');
  assert.equal(parsed[2].branch, undefined);
  assert.equal(parsed[2].prunable, true);
  assert.equal(parsed[2].prunableReason, "gitdir file points to non-existent location");
});

test("the newline form keeps the prunable reason too", () => {
  const parsed = parseWorktreePorcelain(
    "worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /r/det\nHEAD c\ndetached\nprunable gitdir file points to non-existent location\n",
  );
  assert.equal(parsed[1].prunableReason, "gitdir file points to non-existent location");
});

test("a git without `list -z` (usage, exit 129) is asked once, then read the old way", async () => {
  const calls: string[][] = [];
  const fake = {
    run: async (args: string[]) => {
      calls.push(args);
      if (args.includes("-z")) return { code: 129, stdout: "", stderr: "error: unknown switch `z'" };
      return { code: 0, stdout: "worktree /r\nHEAD a\nbranch refs/heads/main\n", stderr: "" };
    },
  } as unknown as GitProcess;
  const p = new WorktreeProvider(fake);
  assert.equal((await p.list())[0].branch, "main");
  assert.equal((await p.list())[0].branch, "main");
  assert.equal(calls.filter((a) => a.includes("-z")).length, 1, "the -z form is tried once");
});

test("a path holding a newline lists whole through the provider (real git, -z)", { skip: process.platform === "win32" && "Windows allows no newline in a file name" }, async () => {
  const r = repo();
  const odd = join(r.base, "wt", "fe\nat x");
  r.git("worktree", "add", "-q", "-b", "feat", odd);
  const list = await r.ctx.worktrees.list();
  assert.ok(list.some((e) => e.path === odd && e.branch === "feat"), JSON.stringify(list.map((e) => e.path)));
});

// ── Tier 0: the snapshot ─────────────────────────────────────────────────────

test("the snapshot costs three spawns however many worktrees there are", async () => {
  const r = repo({ origin: true });
  for (let i = 0; i < 12; i++) r.git("worktree", "add", "-q", "-b", `f${i}`, r.wt(`f${i}`));
  await r.ctx.worktrees.snapshot(); // the -z probe is settled on the first read
  r.spawns.length = 0;
  const snap = await r.ctx.worktrees.snapshot();
  assert.equal(snap.worktrees.length, 13);
  assert.equal(r.spawns.length, 3, r.spawns.map((a) => a.join(" ")).join("\n"));
});

test("main, linked, detached, locked (with and without a reason), missing, missing+locked", async () => {
  const r = repo();
  for (const b of ["feat-clean", "feat-locked", "feat-lock-bare", "feat-gone", "feat-gone-locked"]) {
    r.git("worktree", "add", "-q", "-b", b, r.wt(b));
  }
  r.git("worktree", "add", "-q", "--detach", r.wt("detached"), "HEAD");
  r.git("worktree", "lock", "--reason", "on a USB drive", r.wt("feat-locked"));
  r.git("worktree", "lock", r.wt("feat-lock-bare"));
  r.git("worktree", "lock", "--reason", "agent 42", r.wt("feat-gone-locked"));
  rmSync(r.wt("feat-gone"), { recursive: true, force: true });
  rmSync(r.wt("feat-gone-locked"), { recursive: true, force: true });

  const snap = await r.ctx.worktrees.snapshot();
  const main = snap.worktrees[0];
  assert.equal(main.main, true);
  assert.equal(main.branch, "main");
  assert.equal(snap.worktrees.filter((w) => w.main).length, 1);
  assert.equal(byBranch(snap, "feat-clean").main, false);
  assert.equal(byBranch(snap, "feat-locked").lockReason, "on a USB drive");
  assert.equal(byBranch(snap, "feat-lock-bare").locked, true);
  assert.equal(byBranch(snap, "feat-lock-bare").lockReason, undefined);
  assert.equal(byBranch(snap, "feat-gone").missing, true);
  assert.equal(byBranch(snap, "feat-gone").prunable, true);
  const goneLocked = byBranch(snap, "feat-gone-locked");
  assert.equal(goneLocked.missing, true, "the filesystem says so");
  assert.equal(goneLocked.prunable, false, "git never calls a locked one prunable");
  const det = snap.worktrees.find((w) => sameFolder(w.path, r.wt("detached")));
  assert.ok(det);
  assert.equal(det.detached, true);
  assert.equal(det.branch, undefined);
  assert.deepEqual(snap.remotes, []);
  assert.deepEqual(snap.defaultBranch, { ref: "refs/heads/main", name: "main", local: "main" });
});

test("a bare repository's entry is the bare one, and never missing", async () => {
  const base = join(scratch, `bare${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of identity) at(seed)("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  at(seed)("add", ".");
  at(seed)("commit", "-qm", "base");
  const bare = join(base, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  at(bare)("worktree", "add", "-q", join(base, "main-wt"), "main");
  const ctx = new GitContext({ root: join(base, "main-wt") });
  contexts.push(ctx);
  const snap = await ctx.worktrees.snapshot();
  assert.equal(snap.worktrees[0].bare, true);
  assert.equal(snap.worktrees[0].missing, false);
  assert.equal(snap.worktrees[0].detached, false);
  assert.equal(snap.worktrees[1].branch, "main");
});

test("upstream: up to date, ahead, behind, diverged, gone, none — each worktree's own branch", async () => {
  const r = repo({ origin: true });
  // Branches published to origin, each checked out in its own worktree.
  for (const b of ["even", "ahead", "behind", "diverged", "gone"]) {
    r.git("branch", b, "origin/main");
    r.git("push", "-q", "-u", "origin", b);
    r.git("worktree", "add", "-q", r.wt(b), b);
  }
  r.git("worktree", "add", "-q", "-b", "local-only", r.wt("local-only"));
  r.commit(r.wt("ahead"), "x.txt", "1");
  r.commit(r.wt("ahead"), "x.txt", "2");
  // Someone else pushes to behind and diverged.
  const other = join(r.base, "other");
  execFileSync("git", ["clone", "-q", join(r.base, "origin.git"), other]);
  for (const [k, v] of identity) at(other)("config", k, v);
  for (const b of ["behind", "diverged"]) {
    at(other)("checkout", "-q", b);
    r.commit(other, "o.txt", b);
    at(other)("push", "-q", "origin", b);
  }
  r.commit(r.wt("diverged"), "d.txt", "mine");
  at(other)("push", "-q", "origin", "--delete", "gone");
  r.git("fetch", "-q", "--prune", "origin");

  const snap = await r.ctx.worktrees.snapshot();
  const w = (b: string) => byBranch(snap, b);
  assert.deepEqual([w("even").ahead, w("even").behind, w("even").upstream], [0, 0, "refs/remotes/origin/even"]);
  assert.deepEqual([w("ahead").ahead, w("ahead").behind], [2, 0]);
  assert.deepEqual([w("behind").ahead, w("behind").behind], [0, 1]);
  assert.deepEqual([w("diverged").ahead, w("diverged").behind], [1, 1]);
  assert.equal(w("gone").upstreamGone, true);
  assert.equal(w("local-only").upstream, undefined);
  assert.deepEqual(snap.remotes, ["origin"]);
  assert.deepEqual(snap.defaultBranch, { ref: "refs/remotes/origin/main", name: "origin/main", local: "main" });
});

test("the default branch is read from any remote's HEAD — a clone -o upstream too — never a literal origin", async () => {
  const r = repo({ origin: true, remoteName: "upstream" });
  const snap = await r.ctx.worktrees.snapshot();
  assert.deepEqual(snap.defaultBranch, { ref: "refs/remotes/upstream/main", name: "upstream/main", local: "main" });
});

test("ref facts: ahead and behind parse in every combination git prints", () => {
  const f = parseRefFacts(
    [
      ["refs/heads/a", "refs/remotes/o/a", "ahead 3, behind 2", ""],
      ["refs/heads/b", "refs/remotes/o/b", "behind 7", ""],
      ["refs/heads/c", "refs/remotes/o/c", "gone", ""],
      ["refs/heads/d", "", "", ""],
      ["refs/remotes/o/HEAD", "", "", "refs/remotes/o/trunk"],
    ]
      .map((x) => x.join("\0"))
      .join("\n"),
  );
  assert.deepEqual(f.branches.get("refs/heads/a"), { upstream: "refs/remotes/o/a", ahead: 3, behind: 2, gone: false });
  assert.deepEqual(f.branches.get("refs/heads/b"), { upstream: "refs/remotes/o/b", ahead: 0, behind: 7, gone: false });
  assert.equal(f.branches.get("refs/heads/c")?.gone, true);
  assert.equal(f.branches.get("refs/heads/d")?.upstream, undefined);
  assert.equal(f.remoteHeads.get("o"), "refs/remotes/o/trunk");
});

// ── Tier 1: a row's working tree ─────────────────────────────────────────────

test("status: staged, unstaged, untracked, a rename and a delete — read in THAT worktree", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "dirty", r.wt("dirty"));
  const d = r.wt("dirty");
  writeFileSync(join(d, "b.txt"), "b\n");
  at(d)("add", "b.txt");
  at(d)("commit", "-qm", "b");
  writeFileSync(join(d, "staged.txt"), "s\n");
  at(d)("add", "staged.txt");
  writeFileSync(join(d, "a.txt"), "changed\n");
  at(d)("mv", "b.txt", "b moved.txt");
  mkdirSync(join(d, "deep", "er"), { recursive: true });
  writeFileSync(join(d, "deep", "er", "new.txt"), "n\n");
  // The main worktree is clean: a read in the wrong one would say so.
  const snap = await r.ctx.worktrees.snapshot();
  const st = await r.ctx.worktrees.status(byBranch(snap, "dirty"), snap);
  assert.ok(st);
  assert.equal(st.staged, 2, "staged.txt and the rename");
  assert.equal(st.unstaged, 1);
  assert.equal(st.untracked, 1, "every untracked FILE, not its folder");
  assert.equal(st.conflicted, 0);
  assert.equal(st.changed, 4);
  assert.deepEqual(
    st.files.map((f) => [f.area, f.status, f.path, f.oldPath ?? ""]),
    [
      ["staged", "R", "b moved.txt", "b.txt"],
      ["staged", "A", "staged.txt", ""],
      ["unstaged", "M", "a.txt", ""],
      ["untracked", "U", "deep/er/new.txt", ""],
    ],
  );
  assert.equal(st.operation, undefined);
  const clean = await r.ctx.worktrees.status(snap.worktrees[0], snap);
  assert.equal(clean?.changed, 0);
});

test("status names what git is stopped in there: merge, rebase (both backends), cherry-pick, revert — and a stale REBASE_HEAD alone is nothing", async () => {
  const r = repo();
  r.commit(r.app, "a.txt", "base2");
  const cases = ["merge", "rebase-merge", "rebase-apply", "cherry-pick", "revert", "stale"] as const;
  for (const c of cases) {
    r.git("worktree", "add", "-q", "-b", `op-${c}`, r.wt(c), "HEAD~1");
  }
  // A commit on main and a conflicting one on each operation branch.
  r.commit(r.app, "a.txt", "main side");
  for (const c of cases) r.commit(r.wt(c), "a.txt", `${c} side`);
  const expectFail = (fn: () => void) => assert.throws(fn);
  expectFail(() => at(r.wt("merge"))("merge", "main"));
  expectFail(() => at(r.wt("rebase-merge"))("rebase", "--merge", "main"));
  expectFail(() => at(r.wt("rebase-apply"))("rebase", "--apply", "main"));
  expectFail(() => at(r.wt("cherry-pick"))("cherry-pick", "main"));
  // A revert that conflicts: revert main's edit on a branch that has its own.
  r.commit(r.wt("revert"), "a.txt", "main side");
  r.commit(r.wt("revert"), "a.txt", "revert side 2");
  expectFail(() => at(r.wt("revert"))("revert", "--no-edit", "HEAD~1"));
  const gitDir = at(r.wt("stale"))("rev-parse", "--absolute-git-dir");
  writeFileSync(join(gitDir, "REBASE_HEAD"), at(r.wt("stale"))("rev-parse", "HEAD") + "\n");

  const snap = await r.ctx.worktrees.snapshot();
  // Mid-rebase git lists the worktree detached; it is found by its folder.
  const row = (c: string) => snap.worktrees.find((w) => sameFolder(w.path, r.wt(c)))!;
  const op = async (c: string) => (await r.ctx.worktrees.status(row(c), snap))?.operation;
  assert.equal(await op("merge"), "merge");
  assert.equal(await op("rebase-merge"), "rebase");
  assert.equal(await op("rebase-apply"), "rebase");
  assert.equal(await op("cherry-pick"), "cherry-pick");
  assert.equal(await op("revert"), "revert");
  assert.equal(await op("stale"), undefined);
  // …and names the branch being rebased, which the list cannot.
  assert.equal(row("rebase-merge").detached, true);
  assert.equal((await r.ctx.worktrees.status(row("rebase-merge"), snap))?.rebasing, "op-rebase-merge");
  assert.equal((await r.ctx.worktrees.status(row("rebase-apply"), snap))?.rebasing, "op-rebase-apply");
  assert.equal((await r.ctx.worktrees.status(row("merge"), snap))?.rebasing, undefined);
  const merging = await r.ctx.worktrees.status(byBranch(snap, "op-merge"), snap);
  assert.equal(merging?.conflicted, 1);
  assert.deepEqual(merging?.files.find((f) => f.area === "conflicted"), { path: "a.txt", status: "!", area: "conflicted" });
});

test("no upstream: 'not pushed' is what no remote has (the push review's count); with no remote, what the default branch lacks", async () => {
  const r = repo({ origin: true });
  r.git("worktree", "add", "-q", "-b", "fresh", r.wt("fresh"));
  r.git("worktree", "add", "-q", "-b", "work", r.wt("work"));
  r.commit(r.wt("work"), "w.txt", "1");
  r.commit(r.wt("work"), "w.txt", "2");
  r.commit(r.wt("work"), "w.txt", "3");
  const snap = await r.ctx.worktrees.snapshot();
  const fresh = byBranch(snap, "fresh");
  assert.deepEqual(unpublishedRule(fresh, snap), { kind: "remotes" });
  assert.equal((await r.ctx.worktrees.status(fresh, snap))?.unpublished, 0);
  const work = byBranch(snap, "work");
  assert.equal((await r.ctx.worktrees.status(work, snap))?.unpublished, 3);
  const expected = Number(at(r.wt("work"))("rev-list", "--count", "HEAD", "--not", "--remotes"));
  assert.equal(expected, 3);
  // With an upstream the count is for-each-ref's `ahead`, and nothing else is spawned for it.
  assert.equal((await r.ctx.worktrees.status(snap.worktrees[0], snap))?.unpublished, undefined);

  // No remote at all: against the default branch; the default branch itself has nothing.
  const l = repo();
  l.git("worktree", "add", "-q", "-b", "topic", l.wt("topic"));
  l.commit(l.wt("topic"), "t.txt", "1");
  l.commit(l.wt("topic"), "t.txt", "2");
  const ls = await l.ctx.worktrees.snapshot();
  assert.deepEqual(unpublishedRule(byBranch(ls, "topic"), ls), { kind: "default", ref: "refs/heads/main" });
  assert.equal((await l.ctx.worktrees.status(byBranch(ls, "topic"), ls))?.unpublished, 2);
  assert.deepEqual(unpublishedRule(ls.worktrees[0], ls), { kind: "none" });
  assert.equal((await l.ctx.worktrees.status(ls.worktrees[0], ls))?.unpublished, undefined);
});

test("a missing worktree or a bare entry has no status to read (and nothing is spawned for it)", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "gone", r.wt("gone"));
  rmSync(r.wt("gone"), { recursive: true, force: true });
  const snap = await r.ctx.worktrees.snapshot();
  r.spawns.length = 0;
  assert.equal(await r.ctx.worktrees.status(byBranch(snap, "gone"), snap), undefined);
  assert.equal(r.spawns.length, 0);
});

// ── Tier 2: the commits ──────────────────────────────────────────────────────

test("commits: the not-pushed range per rule, newest first, capped with `more`", async () => {
  const r = repo({ origin: true });
  r.git("branch", "pub", "origin/main");
  r.git("push", "-q", "-u", "origin", "pub");
  r.git("worktree", "add", "-q", r.wt("pub"), "pub");
  for (let i = 1; i <= 4; i++) r.commit(r.wt("pub"), "p.txt", String(i));
  const snap = await r.ctx.worktrees.snapshot();
  const pub = byBranch(snap, "pub");
  const range = unpublishedRange(unpublishedRule(pub, snap));
  assert.deepEqual(range, ["refs/remotes/origin/pub..HEAD"]);
  const all = await r.ctx.worktrees.commits(pub.path, range!, 10);
  assert.deepEqual(all.commits.map((c) => c.subject), ["p.txt: 4", "p.txt: 3", "p.txt: 2", "p.txt: 1"]);
  assert.equal(all.more, false);
  const capped = await r.ctx.worktrees.commits(pub.path, range!, 3);
  assert.equal(capped.commits.length, 3);
  assert.equal(capped.more, true);
  assert.equal(capped.commits[0].parents.length, 1);
  assert.equal(capped.commits[0].author, "T");
});

// ── Stash & Remove ───────────────────────────────────────────────────────────

test("Stash & Remove: every change — staged, unstaged, untracked, a rename — is in the stash, the folder is gone, the branch stays", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "dirty", r.wt("dirty"));
  const d = r.wt("dirty");
  r.commit(d, "b.txt", "b");
  writeFileSync(join(d, "staged.txt"), "s\n");
  at(d)("add", "staged.txt");
  writeFileSync(join(d, "a.txt"), "changed\n");
  at(d)("mv", "b.txt", "c.txt");
  writeFileSync(join(d, "new.txt"), "n\n");
  const removal = await r.ctx.worktrees.removal(d);
  assert.equal(removal.kind, "present");
  const listed = removal.kind === "present" ? removal.changes : undefined;
  const res = await r.ctx.worktrees.removeAsAgreed(d, { stashChanges: { listed, message: "Stashed before removing worktree dirty" } });
  assert.equal(res.ok, true, res.stderr);
  assert.ok(res.stashed && /^[0-9a-f]{40}$/.test(res.stashed));
  assert.equal(existsSync(d), false);
  assert.equal(r.git("branch", "--list", "dirty"), "dirty");
  assert.match(r.git("stash", "list"), /Stashed before removing worktree dirty/);
  const inStash = r.git("stash", "show", "--include-untracked", "--name-only", "--no-renames", "stash@{0}").split("\n").sort();
  assert.deepEqual(inStash, ["a.txt", "b.txt", "c.txt", "new.txt", "staged.txt"]);
});

test("Stash & Remove: a change the question never listed runs nothing", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "dirty", r.wt("dirty"));
  const d = r.wt("dirty");
  writeFileSync(join(d, "a.txt"), "changed\n");
  const removal = await r.ctx.worktrees.removal(d);
  writeFileSync(join(d, "late.txt"), "agent\n");
  const res = await r.ctx.worktrees.removeAsAgreed(d, {
    stashChanges: { listed: removal.kind === "present" ? removal.changes : [], message: "m" },
  });
  assert.equal(res.changedSince, true);
  assert.ok(existsSync(join(d, "late.txt")));
  assert.equal(r.git("stash", "list"), "", "no stash made");
});

test("Stash & Remove on a locked worktree: unlocked, stashed, removed", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "held", r.wt("held"));
  r.git("worktree", "lock", "--reason", "agent 7", r.wt("held"));
  writeFileSync(join(r.wt("held"), "a.txt"), "x\n");
  const res = await r.ctx.worktrees.removeAsAgreed(r.wt("held"), {
    stashChanges: { listed: ["a.txt"], message: "m" },
    pastLock: { reason: "agent 7" },
  });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(existsSync(r.wt("held")), false);
  assert.match(r.git("stash", "list"), /: m$/);
});

test("removal() counts what is left unmerged — git stash refuses those", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "m", r.wt("m"));
  r.commit(r.app, "a.txt", "main");
  r.commit(r.wt("m"), "a.txt", "mine");
  assert.throws(() => at(r.wt("m"))("merge", "main"));
  const removal = await r.ctx.worktrees.removal(r.wt("m"));
  assert.equal(removal.kind === "present" && removal.unmerged, 1);
  const res = await r.ctx.worktrees.removeAsAgreed(r.wt("m"), {
    stashChanges: { listed: removal.kind === "present" ? removal.changes : [], message: "m" },
  });
  assert.equal(res.ok, false, "the stash is refused");
  assert.ok(existsSync(r.wt("m")), "and nothing was removed");
});

test("a worktree moved away (as an unplugged drive) reads missing, and back again present", async () => {
  const r = repo();
  r.git("worktree", "add", "-q", "-b", "usb", r.wt("usb"));
  r.git("worktree", "lock", "--reason", "on a USB drive", r.wt("usb"));
  renameSync(r.wt("usb"), join(r.base, "away"));
  assert.equal(byBranch(await r.ctx.worktrees.snapshot(), "usb").missing, true);
  renameSync(join(r.base, "away"), r.wt("usb"));
  assert.equal(byBranch(await r.ctx.worktrees.snapshot(), "usb").missing, false);
});

// ── A folder that is not a worktree any more ─────────────────────────────────
//
// git lists it (prunable, or — locked, which git never prunes — still
// registered), but its .git is gone, so `git -C <folder>` finds whatever
// repository is AROUND it: the main worktree, for one nested in it
// (…/app/.claude/worktrees/x). Nothing may be read or run in it — its "changes"
// are the main worktree's, and a stash there empties the main one.

/** The main worktree with work in progress, and three folders whose .git is gone. */
function unlinkedScene() {
  const r = repo();
  writeFileSync(join(r.app, ".git", "info", "exclude"), ".claude/\n");
  const nested = join(r.app, ".claude", "worktrees", "x");
  r.git("worktree", "add", "-q", "-b", "x", nested);
  r.git("worktree", "add", "-q", "-b", "side", r.wt("side"));
  r.git("worktree", "add", "-q", "-b", "held", r.wt("held"));
  r.git("worktree", "lock", "--reason", "agent 9", r.wt("held"));
  for (const d of [nested, r.wt("side"), r.wt("held")]) {
    writeFileSync(join(d, "mine.txt"), "the folder's own file\n");
    rmSync(join(d, ".git"));
  }
  writeFileSync(join(r.app, "a.txt"), "a\nmain's edit\n");
  writeFileSync(join(r.app, "notes.md"), "main's new file\n");
  const mainIntact = () => {
    assert.equal(readFileSync(join(r.app, "a.txt"), "utf8"), "a\nmain's edit\n", "the main worktree's edit is where it was");
    assert.ok(existsSync(join(r.app, "notes.md")), "the main worktree's new file is where it was");
    assert.equal(r.git("stash", "list"), "", "nothing was stashed");
  };
  return { r, nested, mainIntact };
}

test("a folder whose .git is gone — nested in the main worktree, beside it, or locked — is unlinked, and its tree is never read", async () => {
  const { r, nested, mainIntact } = unlinkedScene();
  const snap = await r.ctx.worktrees.snapshot();
  const x = byBranch(snap, "x");
  const side = byBranch(snap, "side");
  const held = byBranch(snap, "held");
  assert.ok(sameFolder(x.path, nested), `${x.path} is ${nested}`);
  for (const w of [x, side, held]) {
    assert.equal(w.missing, false, `${w.branch}: its folder is there`);
    assert.equal(w.unlinked, true, `${w.branch}: but it is not a worktree any more`);
  }
  assert.equal(x.prunable, true, "git would prune it");
  assert.equal(held.prunable, false, "git never calls a locked one prunable — the .git says it");
  assert.equal(snap.worktrees[0].unlinked, false);
  assert.equal(byBranch(snap, "main").unlinked, false);
  r.spawns.length = 0;
  for (const w of [x, side, held]) assert.equal(await r.ctx.worktrees.status(w, snap), undefined);
  assert.deepEqual(r.spawns, [], "nothing is run in any of them");
  assert.deepEqual(unpublishedRule(x, snap), { kind: "none" });
  mainIntact();
});

test("removal() says an unlinked folder is to be forgotten — never 'present' with the main worktree's changes", async () => {
  const { r, nested, mainIntact } = unlinkedScene();
  const x = await r.ctx.worktrees.removal(nested);
  assert.equal(x.kind, "stale");
  assert.equal(x.kind === "stale" ? x.entry.branch : undefined, "x");
  assert.equal((await r.ctx.worktrees.removal(r.wt("side"))).kind, "stale");
  const held = await r.ctx.worktrees.removal(r.wt("held"));
  assert.equal(held.kind, "stale");
  assert.equal(held.kind === "stale" ? held.entry.lockReason : undefined, "agent 9");
  mainIntact();
});

test("Stash & Remove or Discard on a folder that stopped being a worktree runs nothing in the main one", async () => {
  const { r, nested, mainIntact } = unlinkedScene();
  const listed = ["a.txt", "notes.md"];
  const stash = await r.ctx.worktrees.removeAsAgreed(nested, { stashChanges: { listed, message: "Changes from worktree x" } });
  assert.deepEqual(stash, { ok: false, stderr: "", changedSince: true }, "asked again, as for any change since the question");
  const discard = await r.ctx.worktrees.removeAsAgreed(nested, { discardChanges: { listed } });
  assert.deepEqual(discard, { ok: false, stderr: "", changedSince: true });
  const unread = await r.ctx.worktrees.removeAsAgreed(r.wt("side"), { discardChanges: { listed: undefined } });
  assert.equal(unread.changedSince, true, "even when the question could not read its changes");
  assert.ok(existsSync(nested) && existsSync(r.wt("side")));
  mainIntact();
});

test("Forget on an unlinked folder drops git's record of it alone — the folder and its files stay; past its lock too", async () => {
  const { r, nested, mainIntact } = unlinkedScene();
  r.git("worktree", "add", "-q", "-b", "gone", r.wt("gone"));
  rmSync(r.wt("gone"), { recursive: true, force: true });
  const forgot = await r.ctx.worktrees.removeAsAgreed(nested, {});
  assert.equal(forgot.ok, true, forgot.stderr);
  assert.equal(readFileSync(join(nested, "mine.txt"), "utf8"), "the folder's own file\n", "nothing on disk changes");
  const listed = () => r.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice(18)).sort();
  assert.deepEqual(listed(), ["gone", "held", "main", "side"], "only x is forgotten — the others git would prune stay");
  assert.equal((await r.ctx.worktrees.removeAsAgreed(r.wt("side"), {})).ok, true);
  const held = await r.ctx.worktrees.removeAsAgreed(r.wt("held"), { pastLock: { reason: "agent 9" } });
  assert.equal(held.ok, true, held.stderr);
  assert.deepEqual(listed(), ["gone", "main"]);
  for (const d of [nested, r.wt("side"), r.wt("held")]) assert.ok(existsSync(join(d, "mine.txt")));
  assert.deepEqual(r.git("branch", "--list", "x", "side", "held").split("\n").map((b) => b.trim()), ["held", "side", "x"], "their branches stay");
  mainIntact();
});

test("Forget never drops the record of a folder that is a worktree again, nor of a locked one without agreeing to pass the lock", async () => {
  const { r, nested } = unlinkedScene();
  // Its .git is back (as `git worktree repair` writes it): a worktree again, removed as one.
  writeFileSync(join(nested, ".git"), `gitdir: ${join(r.app, ".git", "worktrees", "x")}\n`);
  assert.ok(sameFolder(at(nested)("rev-parse", "--show-toplevel"), nested));
  assert.equal((await r.ctx.worktrees.removal(nested)).kind, "present");
  const held = await r.ctx.worktrees.removeAsAgreed(r.wt("held"), {});
  assert.equal(held.ok, false, "locked: nothing is forgotten");
  assert.ok(r.git("worktree", "list", "--porcelain").includes("branch refs/heads/held"));
});
