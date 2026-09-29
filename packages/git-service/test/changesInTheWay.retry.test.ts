// Stash & Retry (stashAndRetry / stashAndRetryPull) when something goes wrong
// on the way: the stash can't be made, the stash asked for disappears while
// ours is being made, the retry is refused in a new way, git won't hand our
// stash back — and in every case the user's work is either back where it was
// or named as waiting in a stash that really holds it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, type Repo } from "./opRepo";
import { GitProcess } from "../src/GitProcess";
import {
  stashAndRetry,
  stashAndRetryPull,
  stashRetryNote,
  type ApplyOp,
  type StashRetryOutcome,
} from "../src/changesInTheWay";
import type { PullResult } from "../src/SyncOps";
import { cmd, fail, tap, type Rule } from "./stashProvider.kit";

const repos: Repo[] = [];
const procs: { dispose(): void }[] = [];
after(() => {
  for (const p of procs.splice(0)) p.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

const signal = new AbortController().signal;

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");

/** master: base (a.txt, b.txt) → "master changes b"; feature: base → "feature changes a" → "feature adds c". */
function repo(name: string): Repo {
  const r = makeRepo(name);
  repos.push(r);
  r.write("a.txt", LINES("line 0", 0));
  r.write("b.txt", LINES("line 0", 0));
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "feature");
  r.write("a.txt", LINES("feature", 0));
  r.commitAll("feature changes a");
  r.write("c.txt", "new\n");
  r.commitAll("feature adds c");
  r.git("checkout", "-q", "master");
  r.write("b.txt", LINES("master", 0));
  r.commitAll("master changes b");
  return r;
}

function procOf(r: Repo, rule: Rule = () => undefined): { proc: GitProcess; ran: string[][] } {
  const t = tap(r.root, rule);
  procs.push(t);
  return { proc: t.proc, ran: t.ran };
}

const status = (r: Repo): string => r.git("status", "--porcelain").replace(/\n$/, "");
const stashes = (r: Repo): string[] => r.git("stash", "list", "--format=%gs").split("\n").filter(Boolean);
const checkout = (target: string): ApplyOp => ({ kind: "checkout", target, args: ["checkout", target] });

// ── The stash asked for ───────────────────────────────────────────────────

test("a stash op whose stash doesn't resolve is gone before anything is asked or stashed", async () => {
  const r = repo("retry-unresolved");
  r.write("a.txt", "edit\n");
  const { proc, ran } = procOf(r);
  const out = await stashAndRetry(proc, { kind: "stash", stash: "stash@{7}" }, { signal });
  assert.equal(out.stashGone, true);
  assert.equal(out.stashFailed, "That stash no longer exists.");
  assert.deepEqual(ran.map(cmd), ["rev-parse --verify --quiet stash@{7}"]);
  assert.equal(status(r), " M a.txt");
});

test("the stash asked for, dropped elsewhere while ours was being made: ours comes straight back, nothing is applied", async () => {
  const r = repo("retry-target-dropped");
  r.write("a.txt", LINES("stashed", 3));
  r.git("stash", "push", "-q", "-m", "wanted");
  const wanted = r.git("rev-parse", "refs/stash").trim();
  r.write("a.txt", LINES("mine", 3)); // in the way of the stash
  const { proc } = procOf(r, (a) => {
    if (a[0] === "stash" && a[1] === "push") {
      // Another window drops the stash the user asked for, just as ours is made.
      execFileSync("git", ["stash", "drop", "-q", "stash@{0}"], { cwd: r.root });
    }
    return undefined;
  });
  const out = await stashAndRetry(proc, { kind: "stash", stash: wanted, pop: true });
  assert.equal(out.stashGone, true);
  assert.equal(out.stashFailed, "That stash no longer exists.");
  assert.equal(out.fate, "restored", "our stash was popped back");
  assert.deepEqual(out.stashed?.paths, ["a.txt"]);
  assert.equal(r.read("a.txt"), LINES("mine", 3));
  assert.deepEqual(stashes(r), []);
});

test("--index over the user's own staged changes: nothing is stashed or run (indexBusy)", async () => {
  const r = repo("retry-index-busy");
  r.write("a.txt", LINES("staged in stash", 2));
  r.git("add", "a.txt");
  r.git("stash", "push", "-q", "-m", "holds staged");
  const sha = r.git("rev-parse", "refs/stash").trim();
  r.write("b.txt", LINES("mine, staged", 4));
  r.git("add", "b.txt");
  const { proc } = procOf(r);
  const out = await stashAndRetry(proc, { kind: "stash", stash: sha, index: true });
  assert.equal(out.indexBusy, true);
  assert.equal(out.stashed, undefined);
  assert.deepEqual(stashes(r), ["On master: holds staged"]);
  assert.equal(status(r), "M  b.txt");
});

test("--index whose staged half git refuses even with the edit in the way stashed: said as that, and the edit is back", async () => {
  const r = repo("retry-index-refused");
  // The stash: a.txt staged, b.txt edited (unstaged).
  r.write("a.txt", LINES("stash staged", 0));
  r.git("add", "a.txt");
  r.write("b.txt", LINES("stash edit", 5));
  r.git("stash", "push", "-q");
  const sha = r.git("rev-parse", "refs/stash").trim();
  // HEAD moves under the staged file, so its staged half no longer applies…
  r.write("a.txt", LINES("head moved", 0));
  r.commitAll("head moves a");
  // …and an edit of the user's sits on a file the stash touches.
  r.write("b.txt", LINES("mine", 8));
  const { proc } = procOf(r);
  const out = await stashAndRetry(proc, { kind: "stash", stash: sha, index: true });
  assert.equal(out.indexRefused, true);
  assert.deepEqual(out.stashed?.paths, ["b.txt"], "the edit in the way was stashed for the retry");
  assert.equal(out.fate, "restored");
  assert.equal(r.read("b.txt"), LINES("mine", 8), "and it is back");
  assert.equal(r.git("stash", "list", "--format=%H").trim(), sha, "only the stash asked for is left");
});

// ── Our stash can't be made ───────────────────────────────────────────────

test("a Stash & Retry whose stash git refuses hands back the refusal, and the work is untouched", async () => {
  const r = repo("retry-push-fails");
  r.write("a.txt", "edit\n");
  const { proc } = procOf(r, (a) => (a[0] === "stash" && a[1] === "push" ? fail("error: could not write index\n") : undefined));
  const out = await stashAndRetry(proc, checkout("feature"));
  assert.deepEqual(out.inTheWay, { kind: "checkout", paths: ["a.txt"], untracked: [] });
  assert.equal(out.stashFailed, "error: could not write index");
  assert.notEqual(out.result.code, 0);
  assert.equal(r.git("symbolic-ref", "--short", "HEAD").trim(), "master");
  assert.equal(r.read("a.txt"), "edit\n");
});

test("a staged deletion whose stash git refuses is staged again, exactly as it was", async () => {
  const r = repo("retry-deletion-back");
  r.git("rm", "-q", "a.txt");
  assert.equal(status(r), "D  a.txt");
  const { proc, ran } = procOf(r, (a) => (a[0] === "stash" && a[1] === "push" ? fail("") : undefined));
  const out = await stashAndRetry(proc, checkout("feature"));
  assert.equal(out.stashFailed, "Nothing could be stashed.");
  assert.ok(ran.some((a) => a[0] === "reset"), "it was unstaged to be stashable");
  assert.equal(status(r), "D  a.txt", "and staged again when the stash failed");
});

test("a staged deletion git won't unstage for the stash: refused with its words, or plainly", async () => {
  for (const stderr of ["fatal: index is locked\n", ""]) {
    const r = repo(`retry-reset-fails-${stderr ? "worded" : "plain"}`);
    r.git("rm", "-q", "a.txt");
    const { proc, ran } = procOf(r, (a) => (a[0] === "reset" ? fail(stderr) : undefined));
    const out = await stashAndRetry(proc, checkout("feature"));
    assert.equal(out.stashFailed, stderr ? "fatal: index is locked" : "The staged deletions could not be stashed.");
    assert.equal(ran.some((a) => a[0] === "stash" && a[1] === "push"), false, "nothing was stashed");
    assert.equal(status(r), "D  a.txt");
  }
});

test("when git can't list what is staged, only the paths in the way are stashed — and they come back", async () => {
  const r = repo("retry-staged-unknown");
  r.write("a.txt", "edit\n");
  const { proc } = procOf(r, (a) => (cmd(a).startsWith("diff --cached --name-status") ? fail("fatal: bad") : undefined));
  const out = await stashAndRetry(proc, checkout("feature"));
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.deepEqual(out.stashed?.paths, ["a.txt"]);
  assert.equal(r.git("symbolic-ref", "--short", "HEAD").trim(), "feature", "the switch ran");
});

// ── The retry stops ───────────────────────────────────────────────────────

test("a pick that turns out empty once the staged change is stashed stops — and the change waits in the stash", async () => {
  const r = repo("retry-empty-pick");
  // `dup` makes master's own change again: picking it onto master is empty.
  r.git("checkout", "-q", "-b", "dup", "master~1");
  r.write("b.txt", LINES("master", 0));
  r.commitAll("the same change to b");
  r.git("checkout", "-q", "master");
  r.write("x.txt", "staged elsewhere\n");
  r.git("add", "x.txt");
  const commit = r.sha("dup");
  const { proc } = procOf(r);
  const out = await stashAndRetry(proc, { kind: "cherry-pick", commit, args: ["cherry-pick", commit] }, { signal });
  assert.notEqual(out.result.code, 0);
  assert.equal(out.fate, "waiting");
  assert.equal(r.exists(".git/CHERRY_PICK_HEAD"), true, "git is stopped on the empty pick");
  assert.deepEqual(stashes(r), [`On master: GitStudio: before cherry-pick of ${commit.slice(0, 7)}`]);
  assert.match(stashRetryNote(out) ?? "", /x\.txt are waiting in the stash .* — apply it once the cherry-pick is finished\.$/);
});

// ── Putting ours back ─────────────────────────────────────────────────────

test("when our stash's sha can't be read back, it is never popped blind: the changes are kept in it", async () => {
  const r = repo("retry-ours-unknown");
  r.write("x.txt", "staged elsewhere\n");
  r.git("add", "x.txt");
  const { proc } = procOf(r, (a) => (cmd(a) === "rev-parse --verify --quiet refs/stash" ? fail("") : undefined));
  const out = await stashAndRetry(proc, { kind: "cherry-pick", commit: r.sha("feature"), args: ["cherry-pick", r.sha("feature")] });
  assert.equal(out.result.code, 0, "the pick ran");
  assert.equal(out.fate, "kept");
  assert.equal(stashes(r).length, 1, "the change is in the stash the note names");
  assert.match(stashRetryNote(out) ?? "", /^Your changes to x\.txt are kept in the stash "GitStudio: before cherry-pick of [0-9a-f]{7}" — git won't put them back/);
});

test("when git can't say what our stash had staged, it stays in the list rather than lose a staged version", async () => {
  const r = repo("retry-staged-in-unknown");
  r.write("x.txt", "staged elsewhere\n");
  r.git("add", "x.txt");
  const { proc } = procOf(r, (a) => (a[0] === "diff" && /\^1$/.test(a[4] ?? "") && /\^2$/.test(a[5] ?? "") ? fail("") : undefined));
  const out = await stashAndRetry(proc, { kind: "cherry-pick", commit: r.sha("feature"), args: ["cherry-pick", r.sha("feature")] });
  assert.equal(out.result.code, 0);
  assert.equal(out.fate, "kept");
  assert.equal(stashes(r).length, 1);
  assert.equal(r.exists("x.txt"), false, "x.txt waits in the stash");
});

test("our stash that won't pop, with or without its staging, and leaves nothing unmerged, is kept", async () => {
  const r = repo("retry-pop-refused");
  r.write("a.txt", LINES("mine", 5));
  const { proc } = procOf(r, (a) => (a[0] === "stash" && a[1] === "pop" ? fail("error: could not restore") : undefined));
  const out = await stashAndRetry(proc, checkout("feature"));
  assert.equal(out.result.code, 0);
  assert.equal(out.fate, "kept");
  assert.deepEqual(stashes(r), ["On master: GitStudio: before checking out feature"]);
  assert.equal(r.read("a.txt"), LINES("feature", 0), "feature's a.txt, the edit safe in the stash");
});

test("a staged edit that comes back without its staging is staged again only where the file is still the stash's", async () => {
  const r = repo("retry-restage");
  r.write("b.txt", LINES("staged elsewhere", 6));
  r.git("add", "b.txt");
  // --index refused: the plain pop runs, then the staging is redone by hand.
  const { proc, ran } = procOf(r, (a) => (a[0] === "stash" && a[1] === "pop" && a[2] === "--index" ? fail("error: conflicts in index") : undefined));
  const out = await stashAndRetry(proc, { kind: "cherry-pick", commit: r.sha("feature"), args: ["cherry-pick", r.sha("feature")] });
  assert.equal(out.fate, "restored");
  assert.equal(status(r), "M  b.txt", "staged again");
  assert.ok(ran.some((a) => a[0] === "add" && a.includes(":(literal)b.txt")));
});

test("…and when git can't compare them, nothing is guessed: the change is back, unstaged", async () => {
  const r = repo("retry-restage-unknown");
  r.write("b.txt", LINES("staged elsewhere", 6));
  r.git("add", "b.txt");
  let popped = false;
  const { proc } = procOf(r, (a) => {
    if (a[0] === "stash" && a[1] === "pop" && a[2] === "--index") return fail("error: conflicts in index");
    if (a[0] === "stash" && a[1] === "pop") popped = true;
    if (popped && a[0] === "diff" && a.includes(":(literal)b.txt")) return fail("");
    return undefined;
  });
  const out = await stashAndRetry(proc, { kind: "cherry-pick", commit: r.sha("feature"), args: ["cherry-pick", r.sha("feature")] });
  assert.equal(out.fate, "restored");
  assert.equal(status(r), " M b.txt");
  assert.equal(r.read("b.txt"), LINES("staged elsewhere", 6));
});

// ── Pull ──────────────────────────────────────────────────────────────────

test("a pull whose stash git refuses: the pull's refusal and the stash's words, the work untouched", async () => {
  const r = repo("pull-stash-fails");
  r.write("a.txt", "edit\n");
  rmSync(join(r.root, "b.txt"));
  let pulls = 0;
  const pull = async (): Promise<PullResult> => {
    pulls++;
    return { ok: false, stderr: "", dirty: { paths: ["b.txt", "a.txt"] } };
  };
  const { proc } = procOf(r, (a) => {
    if (a[0] === "status") return fail("fatal: bad");
    if (a[0] === "stash" && a[1] === "push") return fail("error: no room");
    return undefined;
  });
  const out = await stashAndRetryPull(proc, pull, { signal });
  assert.equal(pulls, 1, "the pull was not run again");
  assert.deepEqual(out.inTheWay, { kind: "pull", paths: ["a.txt", "b.txt"], untracked: [] });
  assert.equal(out.stashFailed, "error: no room");
  assert.deepEqual(out.result, { code: 1, stdout: "", stderr: "" });
  assert.equal(status(r), " M a.txt\n D b.txt");
});

// ── The note ──────────────────────────────────────────────────────────────

test("the note says nothing when nothing was stashed, and names where the changes wait for each kind", () => {
  assert.equal(stashRetryNote({ result: { code: 0, stdout: "", stderr: "" } }), undefined);
  const waiting = (kind: NonNullable<StashRetryOutcome["stashed"]>["kind"]): string =>
    stashRetryNote({ result: { code: 1, stdout: "", stderr: "" }, stashed: { kind, message: "m", paths: ["a"] }, fate: "waiting" }) ?? "";
  assert.match(waiting("checkout"), /apply it once the conflicts are resolved\.$/);
  assert.match(waiting("pull"), /apply it once the conflicts are resolved\.$/);
  assert.match(waiting("merge"), /apply it once the merge is finished\.$/);
  assert.match(waiting("rebase"), /apply it once the rebase is finished\.$/);
});
