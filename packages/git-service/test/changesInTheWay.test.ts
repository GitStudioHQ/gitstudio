// A command that applies commits, refused because the user's uncommitted work
// is in its way — recognised from git's state, never from its words.
//
// Crash report #18: a revert over "Your local changes to the following files
// would be overwritten by merge … Aborting / fatal: revert failed", filed as a
// crash with git's text. Nothing was broken and nothing had changed: the user
// had an edit to a file the revert touches. The same refusal waits behind
// every door that applies commits — cherry-pick, merge, rebase, a branch
// checkout, a stash apply or pop — so each is pinned here against real git,
// together with the cases that must NOT be read as it (a stop on conflicts, a
// failure for some other reason, git's own autostash), and the Stash & Retry
// that answers it.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitProcess } from "../src/GitProcess";
import {
  changesInTheWayMessage,
  runApplying,
  stashAndRetry,
  stashRetryNote,
  type ApplyOp,
} from "../src/changesInTheWay";

const trash: string[] = [];
afterEach(() => {
  for (const d of trash.splice(0)) removeTempRepo(d);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");

/**
 * main:    base (a.txt, b.txt nine lines each) → "main changes b"
 * feature: base → "feature changes a" (line 0) → "feature adds c"
 * HEAD on main.
 */
function repo(): { dir: string; proc: GitProcess } {
  const dir = mkdtempSync(join(tmpdir(), "gitstudio-inway-"));
  trash.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Me");
  git(dir, "config", "user.email", "me@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0));
  writeFileSync(join(dir, "b.txt"), LINES("line 0", 0));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("feature", 0));
  git(dir, "commit", "-q", "-am", "feature changes a");
  writeFileSync(join(dir, "c.txt"), "new\n");
  git(dir, "add", "c.txt");
  git(dir, "commit", "-q", "-m", "feature adds c");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), LINES("main", 0));
  git(dir, "commit", "-q", "-am", "main changes b");
  return { dir, proc: new GitProcess({ cwd: dir }) };
}

const sha = (dir: string, ref: string): string => git(dir, "rev-parse", ref).trim();
const head = (dir: string): string => sha(dir, "HEAD");
const status = (dir: string): string => git(dir, "status", "--porcelain").trim();

const pick = (dir: string, ref: string): ApplyOp => {
  const commit = sha(dir, ref);
  return { kind: "cherry-pick", commit, args: ["cherry-pick", commit] };
};
const revert = (dir: string, ref: string): ApplyOp => {
  const commit = sha(dir, ref);
  return { kind: "revert", commit, args: ["revert", "--no-edit", commit] };
};
const merge = (target: string, noFf = false): ApplyOp => ({
  kind: "merge",
  target,
  noFf,
  args: ["merge", "--no-edit", ...(noFf ? ["--no-ff"] : []), target],
});
const checkout = (target: string): ApplyOp => ({ kind: "checkout", target, args: ["checkout", target] });

// ── the refusal, per door ─────────────────────────────────────────────────────

test("report #18: a revert over an edit to a file it touches is the user's changes, not a crash", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4));
  const before = head(dir);
  const { result, inTheWay } = await runApplying(proc, revert(dir, "HEAD"));
  assert.notEqual(result.code, 0, "git refused");
  assert.deepEqual(inTheWay, { kind: "revert", paths: ["b.txt"], untracked: [] });
  assert.equal(head(dir), before, "nothing ran");
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), LINES("mine", 4), "the edit is untouched");
  assert.match(changesInTheWayMessage(inTheWay!), /^Your uncommitted changes to b\.txt are in the way of the revert/);
});

test("a cherry-pick is refused over ANY staged change, touched or not", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("staged", 5));
  git(dir, "add", "b.txt");
  const { inTheWay } = await runApplying(proc, pick(dir, "feature~1"));
  assert.deepEqual(inTheWay?.paths, ["b.txt"], "the pick touches only a.txt; the index must still match HEAD");
});

test("…and over an untracked file where the commit adds one", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "c.txt"), "mine\n");
  const { inTheWay } = await runApplying(proc, pick(dir, "feature"));
  assert.deepEqual(inTheWay, { kind: "cherry-pick", paths: ["c.txt"], untracked: ["c.txt"] });
});

test("an unstaged edit the commit does not touch is not in the way — it simply picks", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4));
  const { result, inTheWay } = await runApplying(proc, pick(dir, "feature~1"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(inTheWay, undefined);
});

test("a merge is refused over an edit to a file the incoming side touches", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const { result, inTheWay } = await runApplying(proc, merge("feature"));
  assert.notEqual(result.code, 0);
  assert.deepEqual(inTheWay?.paths, ["a.txt"]);
  assert.equal(inTheWay?.kind, "merge");
});

test("a fast-forward merge is refused over an untracked file it would write, and carries a staged one it would not", async () => {
  const { dir, proc } = repo();
  git(dir, "reset", "-q", "--hard", "HEAD~1"); // main at base: feature is a fast-forward
  writeFileSync(join(dir, "c.txt"), "mine\n");
  let r = await runApplying(proc, merge("feature"));
  assert.deepEqual(r.inTheWay, { kind: "merge", paths: ["c.txt"], untracked: ["c.txt"] });
  git(dir, "clean", "-q", "-f");
  writeFileSync(join(dir, "b.txt"), LINES("staged", 5));
  git(dir, "add", "b.txt");
  r = await runApplying(proc, merge("feature"));
  assert.equal(r.result.code, 0, "a fast-forward carries an unrelated staged change");
});

test("a rebase is refused over any tracked change, and an untracked file the new base has", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4));
  let r = await runApplying(proc, { kind: "rebase", onto: "feature", args: ["rebase", "feature"] });
  assert.deepEqual(r.inTheWay, { kind: "rebase", paths: ["b.txt"], untracked: [] });
  assert.match(changesInTheWayMessage(r.inTheWay!), /^A rebase needs a clean working tree/);
  git(dir, "checkout", "-q", "--", "b.txt");
  writeFileSync(join(dir, "c.txt"), "mine\n");
  r = await runApplying(proc, { kind: "rebase", onto: "feature", args: ["rebase", "feature"] });
  assert.deepEqual(r.inTheWay?.paths, ["c.txt"]);
});

test("checking out a branch is refused over an edit to a file that differs, or an untracked file it has", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  let r = await runApplying(proc, checkout("feature"));
  assert.deepEqual(r.inTheWay, { kind: "checkout", paths: ["a.txt"], untracked: [] });
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD").trim(), "main", "still on main");
  git(dir, "checkout", "-q", "--", "a.txt");
  writeFileSync(join(dir, "c.txt"), "mine\n");
  r = await runApplying(proc, checkout("feature"));
  assert.deepEqual(r.inTheWay?.untracked, ["c.txt"]);
});

// `git checkout release` looks refs/heads/ up FIRST and switches to the branch
// (with a warning that the name is ambiguous); `git diff HEAD release` resolves
// the TAG. So the paths a branch switch writes were read from the wrong commit,
// the edit truly in its way was not among them, and the refusal was handed on
// as git's text — the crash report this module exists to prevent. Both hosts
// send a branch switch as `checkout <name>` (planRefCheckout, the Branches view).
test("a branch that shares its name with a tag is read as the branch, as git's checkout reads it", async () => {
  const { dir, proc } = repo();
  git(dir, "tag", "feature", "main~1"); // the tag sits at base, the branch changes a.txt
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const r = await runApplying(proc, checkout("feature"));
  assert.notEqual(r.result.code, 0, "git refused the switch to the branch");
  assert.deepEqual(r.inTheWay, { kind: "checkout", paths: ["a.txt"], untracked: [] });
  const out = await stashAndRetry(proc, checkout("feature"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(git(dir, "symbolic-ref", "HEAD").trim(), "refs/heads/feature", "on the branch, not the tag");
  assert.equal(out.fate, "restored");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("feature", 0).replace("line 4\n", "mine\n"));
});

test("a stash apply or pop is refused over an edit to a file the stash touches", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
  git(dir, "stash", "-q");
  writeFileSync(join(dir, "a.txt"), LINES("mine", 6));
  for (const pop of [false, true]) {
    const r = await runApplying(proc, { kind: "stash", stash: "stash@{0}", pop });
    assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["a.txt"], untracked: [] }, `pop: ${pop}`);
  }
  assert.equal(git(dir, "stash", "list").trim().split("\n").length, 1, "the stash is still there");
});

test("a stash pop is refused over an untracked file it would restore", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "d.txt"), "stashed\n");
  git(dir, "stash", "-q", "-u");
  writeFileSync(join(dir, "d.txt"), "mine\n");
  const r = await runApplying(proc, { kind: "stash", stash: "stash@{0}", pop: true });
  assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["d.txt"], untracked: ["d.txt"] });
});

// A stash made with -u does not refuse cleanly: git 2.49 restores its
// untracked half even when it refuses the tracked half, and applies the
// tracked half before it refuses over an untracked file of the user's. Read
// afterwards, the stash's own files looked like the user's changes in its
// way — "nothing ran" said over a half-applied stash. Asked before it runs.

/** A stash made with -u: line 2 of a.txt, and an untracked d.txt. */
function untrackedStash(dir: string): void {
  writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
  writeFileSync(join(dir, "d.txt"), "from the stash\n");
  git(dir, "stash", "push", "-q", "-u", "-m", "with untracked");
}

const snapshot = (dir: string): string => git(dir, "status", "--porcelain=v1", "--untracked-files=all");

test("a stash made with -u, over an edit its tracked half changes: said before git runs, and none of its untracked files appear", async () => {
  for (const pop of [false, true]) {
    const { dir, proc } = repo();
    untrackedStash(dir);
    writeFileSync(join(dir, "a.txt"), LINES("mine", 6));
    const before = snapshot(dir);
    const r = await runApplying(proc, { kind: "stash", stash: "stash@{0}", pop });
    assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["a.txt"], untracked: [] }, `pop: ${pop} — the user's edit, and nothing of the stash's`);
    assert.equal(snapshot(dir), before, "nothing changed: d.txt was not restored");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("mine", 6));
    assert.equal(git(dir, "stash", "list").trim().split("\n").length, 1, "the stash is still there");
  }
});

test("a stash made with -u, over an untracked file of the user's where one of its own goes: nothing of it is applied", async () => {
  const { dir, proc } = repo();
  untrackedStash(dir);
  writeFileSync(join(dir, "d.txt"), "mine\n");
  const before = snapshot(dir);
  const r = await runApplying(proc, { kind: "stash", stash: "stash@{0}", pop: true });
  assert.deepEqual(r.inTheWay, { kind: "stash", paths: ["d.txt"], untracked: ["d.txt"] }, "only the user's file");
  assert.equal(snapshot(dir), before, "nothing changed: a.txt's half was not merged");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("line 0", 0));

  // …and Stash & Retry pops it, keeping the user's file safe in a stash of its own.
  const out = await stashAndRetry(proc, { kind: "stash", stash: "stash@{0}", pop: true });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(readFileSync(join(dir, "d.txt"), "utf8"), "from the stash\n", "the stash asked for is applied");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("stashed", 2));
  assert.equal(out.fate, "kept");
  assert.equal(git(dir, "show", "stash@{0}^3:d.txt"), "mine\n", "the user's file, exactly, in its own stash");
});

test("a stash made with -u that fails over something else: what git half-applied is git's failure, never blamed on the user", async () => {
  const { dir, proc } = repo();
  untrackedStash(dir);
  // d.txt now TRACKED and clean: not the user's uncommitted work, so not
  // asked about — but git will not restore the stash's d.txt over it.
  writeFileSync(join(dir, "d.txt"), "committed since\n");
  git(dir, "add", "d.txt");
  git(dir, "commit", "-q", "-m", "d is tracked now");
  const r = await runApplying(proc, { kind: "stash", stash: "stash@{0}" });
  assert.notEqual(r.result.code, 0, "git failed");
  assert.equal(r.inTheWay, undefined, "a.txt changed under it — git's half, not the user's edit");
});

// ── the index's own shapes: a staged rename, and a staged deletion ───────────

test("a staged rename is in the way under BOTH names, and Stash & Retry gives it back staged", async () => {
  const { dir, proc } = repo();
  git(dir, "mv", "b.txt", "renamed.txt");
  const { inTheWay } = await runApplying(proc, pick(dir, "feature~1"));
  assert.deepEqual(inTheWay?.paths, ["b.txt", "renamed.txt"], "the old name's deletion is staged too");
  const before = head(dir);
  const out = await stashAndRetry(proc, pick(dir, "feature~1"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.notEqual(head(dir), before, "picked");
  assert.equal(out.fate, "restored");
  assert.equal(status(dir), "R  b.txt -> renamed.txt", "the rename, staged, as it was");
  assert.equal(git(dir, "stash", "list").trim(), "", "no stash left behind");
});

test("a staged deletion — no path `git stash push` will take — is stashed, and staged again", async () => {
  const { dir, proc } = repo();
  git(dir, "rm", "-q", "a.txt");
  const out = await stashAndRetry(proc, revert(dir, "HEAD"));
  assert.equal(out.stashFailed, undefined, out.stashFailed);
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(git(dir, "log", "-1", "--format=%s").trim(), 'Revert "main changes b"');
  assert.equal(out.fate, "restored");
  assert.equal(status(dir), "D  a.txt", "deleted in the index, as it was");
  assert.equal(git(dir, "stash", "list").trim(), "");
});

test("a staged edit in a checkout's way, beside a staged edit elsewhere: BOTH come back staged", async () => {
  const { dir, proc } = repo();
  // "side" differs from main in a.txt alone, so b.txt is carried, not in the way.
  git(dir, "checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "a.txt"), LINES("side", 0));
  git(dir, "commit", "-q", "-am", "side changes a");
  git(dir, "checkout", "-q", "main");
  const inWay = LINES("line 0", 0).replace("line 6\n", "staged, in the way\n");
  const elsewhere = LINES("main", 0).replace("line 4\n", "staged elsewhere\n");
  writeFileSync(join(dir, "a.txt"), inWay);
  writeFileSync(join(dir, "b.txt"), elsewhere);
  git(dir, "add", "a.txt", "b.txt");
  assert.deepEqual((await runApplying(proc, checkout("side"))).inTheWay?.paths, ["a.txt"], "precondition: a.txt alone");
  const out = await stashAndRetry(proc, checkout("side"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(out.fate, "restored");
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD").trim(), "side");
  // `stash pop --index` refuses while anything else is staged, and the plain
  // pop it fell back to put the edit in the way back unstaged.
  assert.equal(status(dir), "M  a.txt\nM  b.txt", "both staged, as they were");
  assert.equal(git(dir, "show", ":a.txt"), LINES("side", 0).replace("line 6\n", "staged, in the way\n"));
  assert.equal(git(dir, "show", ":b.txt"), elsewhere);
  assert.equal(git(dir, "stash", "list").trim(), "");
});

test("a retry refused AGAIN over work the stash did not cover is said as work in the way, not as git failing", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("staged", 5));
  git(dir, "add", "b.txt");
  // An editor's autosave writes a file the pick touches the moment the stash
  // is made — so the pick is refused again after it.
  const real = new GitProcess({ cwd: dir });
  const run = real.run.bind(real);
  real.run = async (args, opts) => {
    const r = await run(args, opts);
    if (args[0] === "stash" && args[1] === "push" && r.code === 0) {
      writeFileSync(join(dir, "a.txt"), LINES("line 0", 0).replace("line 7\n", "meanwhile\n"));
    }
    return r;
  };
  const out = await stashAndRetry(real, pick(dir, "feature~1"));
  assert.notEqual(out.result.code, 0, "refused again");
  assert.equal(out.fate, "restored", "what was stashed is back");
  assert.equal(git(dir, "show", ":b.txt"), LINES("staged", 5), "b.txt staged again, as it was");
  assert.deepEqual(out.inTheWay?.paths, ["a.txt", "b.txt"], "said as the user's work in the way");
  assert.equal(git(dir, "stash", "list").trim(), "");
});

// ── what it must NOT be read as ───────────────────────────────────────────────

test("a pick that STOPS on conflicts is a stop, not changes in the way", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("main's own", 0));
  git(dir, "commit", "-q", "-am", "main changes a too");
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4)); // dirty, but not in the pick's way
  const { result, inTheWay } = await runApplying(proc, pick(dir, "feature~1"));
  assert.notEqual(result.code, 0);
  assert.equal(inTheWay, undefined);
  git(dir, "cherry-pick", "--abort");
});

test("a failure for another reason is never blamed on the user's edits", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  // A ref that does not exist: nothing to compare, nothing claimed.
  const r1 = await runApplying(proc, checkout("no-such-branch"));
  assert.notEqual(r1.result.code, 0);
  assert.equal(r1.inTheWay, undefined);
  // A merge commit reverted with no -m is refused for THAT, before any file.
  git(dir, "checkout", "-q", "--", "a.txt");
  git(dir, "merge", "-q", "--no-ff", "--no-edit", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const r2 = await runApplying(proc, revert(dir, "HEAD"));
  assert.notEqual(r2.result.code, 0);
  assert.equal(r2.inTheWay, undefined, "unstaged edits are not what a missing -m is refused over");
});

test("with merge.autoStash git stashes by itself, so nothing is claimed", async () => {
  const { dir, proc } = repo();
  git(dir, "config", "merge.autoStash", "true");
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const { inTheWay } = await runApplying(proc, merge("feature"));
  assert.equal(inTheWay, undefined);
});

test("git's words are never read: a refusal in any language is recognised", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4));
  const real = new GitProcess({ cwd: dir });
  const run = real.run.bind(real);
  // Every stream rewritten, as a localised git would write it.
  real.run = async (args, opts) => {
    const r = await run(args, opts);
    return { ...r, stderr: r.stderr ? "ошибка: ваши локальные изменения будут перезаписаны" : "" };
  };
  const { inTheWay } = await runApplying(real, revert(dir, "HEAD"));
  assert.deepEqual(inTheWay?.paths, ["b.txt"]);
});

// ── Stash & Retry ─────────────────────────────────────────────────────────────

test("Stash & Retry: a staged change the pick does not touch is stashed, the pick runs, and it comes back staged", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("staged", 5));
  git(dir, "add", "b.txt");
  const before = head(dir);
  const out = await stashAndRetry(proc, pick(dir, "feature~1"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.notEqual(head(dir), before, "picked");
  assert.equal(out.fate, "restored");
  assert.equal(status(dir), "M  b.txt", "back where it was — staged");
  assert.equal(git(dir, "stash", "list").trim(), "", "and no stash left behind");
  assert.equal(stashRetryNote(out), undefined, "nothing more to say");
});

test("Stash & Retry puts a file back EXACTLY: staged half in the index, the rest in the working tree", async () => {
  const { dir, proc } = repo();
  // b.txt, which a pick of feature~1 does not touch — but a staged change is
  // always in a pick's way — staged at line 5 and edited further at line 7.
  const staged = LINES("main", 0).replace("line 5\n", "staged\n");
  const both = staged.replace("line 7\n", "unstaged\n");
  writeFileSync(join(dir, "b.txt"), staged);
  git(dir, "add", "b.txt");
  writeFileSync(join(dir, "b.txt"), both);
  const out = await stashAndRetry(proc, pick(dir, "feature~1"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(out.fate, "restored");
  assert.equal(status(dir), "MM b.txt", "staged AND modified, as it was");
  assert.equal(git(dir, "show", ":b.txt"), staged, "the index holds the staged half");
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), both, "the working tree holds both");
  assert.equal(git(dir, "stash", "list").trim(), "");
});

test("Stash & Retry: report #18's revert — the edit comes back, merged into what the revert changed", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("main", 0).replace("line 6\n", "mine\n"));
  const out = await stashAndRetry(proc, revert(dir, "HEAD"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(git(dir, "log", "-1", "--format=%s").trim(), 'Revert "main changes b"');
  assert.equal(out.fate, "restored");
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), LINES("line 0", 0).replace("line 6\n", "mine\n"));
});

test("Stash & Retry: changes that conflict with what came in are put back as a conflict, and kept", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 0)); // the same line the pick changes
  const out = await stashAndRetry(proc, pick(dir, "feature~1"));
  assert.equal(out.result.code, 0, "the pick itself went through");
  assert.equal(out.fate, "conflicted");
  assert.match(status(dir), /^UU a\.txt/m);
  assert.match(git(dir, "stash", "list"), /GitStudio: before cherry-pick of/, "git keeps a stash it could not pop cleanly");
  assert.match(stashRetryNote(out) ?? "", /conflict with what came in — resolve them in Changes/);
});

test("Stash & Retry: a command that stops part-way leaves the changes in the stash, and says where", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("main's own", 0));
  git(dir, "commit", "-q", "-am", "main changes a too");
  writeFileSync(join(dir, "b.txt"), LINES("staged", 5));
  git(dir, "add", "b.txt");
  const out = await stashAndRetry(proc, pick(dir, "feature~1"));
  assert.notEqual(out.result.code, 0, "the pick stopped on its conflict");
  assert.equal(out.fate, "waiting");
  assert.match(git(dir, "stash", "list"), /GitStudio: before cherry-pick of/);
  assert.match(
    stashRetryNote(out) ?? "",
    /waiting in the stash "GitStudio: before cherry-pick of [0-9a-f]{7}" — apply it once the cherry-pick is finished/,
  );
  git(dir, "cherry-pick", "--abort");
});

test("Stash & Retry on a checkout: the edit travels to the branch", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0).replace("line 7\n", "mine\n"));
  const out = await stashAndRetry(proc, checkout("feature"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD").trim(), "feature");
  assert.equal(out.fate, "restored");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("feature", 0).replace("line 7\n", "mine\n"));
});

// A stash applied over a stash: once the one asked for is in the working tree,
// git will not pop ours onto the same files (a stash is never merged into
// uncommitted work), so the edits that were in the way stay in THEIR stash —
// named, and said. That is the honest end of "swap my changes for that stash".
test("Stash & Retry on a stash pop: the stash asked for is found again by its sha and popped; the edits in its way stay stashed", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
  git(dir, "stash", "-q", "-m", "the one I asked for");
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0).replace("line 7\n", "mine\n"));
  const out = await stashAndRetry(proc, { kind: "stash", stash: "stash@{0}", pop: true });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("stashed", 2), "the stash asked for is applied");
  assert.equal(out.fate, "kept");
  const list = git(dir, "stash", "list");
  assert.doesNotMatch(list, /the one I asked for/, "popped: dropped");
  assert.match(list, /GitStudio: before applying a stash/, "the edits that were in its way are safe in their own");
  assert.match(
    stashRetryNote(out) ?? "",
    /a\.txt are kept in the stash "GitStudio: before applying a stash" — git won't put them back/,
  );
});

test("Stash & Retry on a stash apply applies the right one even though ours pushed it down the list", async () => {
  const { dir, proc } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
  git(dir, "stash", "-q", "-m", "the one I asked for");
  writeFileSync(join(dir, "b.txt"), LINES("older", 3));
  git(dir, "stash", "-q", "-m", "another one"); // stash@{0} now; the asked-for is @{1}
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0).replace("line 7\n", "mine\n"));
  const out = await stashAndRetry(proc, { kind: "stash", stash: "stash@{1}" });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), LINES("stashed", 2), "@{1} as it was when asked, not as it is after ours");
  assert.match(git(dir, "stash", "list"), /: On main: the one I asked for$/m, "applied, not dropped");
});

test("Stash & Retry with nothing in the way any more just runs it", async () => {
  const { dir, proc } = repo();
  const out = await stashAndRetry(proc, pick(dir, "feature~1"));
  assert.equal(out.result.code, 0);
  assert.equal(out.stashed, undefined, "nothing was stashed");
});

test("the sentence names the files, and says what they are in the way of", () => {
  const v = (paths: string[], kind: ApplyOp["kind"] = "revert") => ({ kind, paths, untracked: [] });
  assert.match(changesInTheWayMessage(v(["a.txt"])), /changes to a\.txt are in the way of the revert/);
  assert.match(changesInTheWayMessage(v(["a.txt", "b.txt"])), /a\.txt and b\.txt/);
  assert.match(changesInTheWayMessage(v(["a", "b", "c", "d"])), /a, b and 2 other files/);
  assert.match(changesInTheWayMessage(v(["a"], "checkout")), /in the way of switching to it/);
  assert.match(changesInTheWayMessage(v(["a"], "stash")), /in the way of applying the stash/);
  assert.doesNotMatch(changesInTheWayMessage(v(["a"])), /overwritten by merge|Aborting|fatal/);
});
