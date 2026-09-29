import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { mergeCommitFiles, parseCommitStatsZ, parseNumstatZ } from "../src/CommitDetailsProvider";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// Read-provider edges: what a failed git read answers (an error for stats, an
// empty/false answer for conflict reads), and the parsers' tolerance of the
// odd field git can emit.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

function outside(): GitContext {
  const dir = mkdtempSync(join(tmpdir(), "gs-readers-norepo-"));
  const ctx = new GitContext({ root: dir });
  cleanup.push(() => {
    ctx.dispose();
    removeTempRepo(dir);
  });
  return ctx;
}

test("getCommitStats throws git's reason when git can't run the log, and asks nothing for no shas", async () => {
  const ctx = outside();
  assert.deepEqual(await ctx.commitDetails.getCommitStats([]), []);
  await assert.rejects(ctx.commitDetails.getCommitStats(["a".repeat(40)]), /not a git repository/i);
});

test("getCommitStats counts a merge against its first parent, and an empty commit as nothing", async () => {
  const r: Repo = makeRepo("readers-stats");
  cleanup.push(() => r.cleanup());
  r.write("f.txt", "1\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  r.write("s.txt", "s1\ns2\n");
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  r.git("commit", "-q", "--allow-empty", "-m", "empty");
  const empty = r.sha("HEAD");
  r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  const merge = r.sha("HEAD");
  const stats = await r.ctx().commitDetails.getCommitStats([merge, empty]);
  assert.deepEqual(stats, [
    { sha: merge, files: 1, additions: 2, deletions: 0 },
    { sha: empty, files: 0, additions: 0, deletions: 0 },
  ]);
});

test("parseCommitStatsZ skips a stray field before any commit and a malformed numstat entry", () => {
  const sha = "b".repeat(40);
  const out = parseCommitStatsZ(`1\t2\tbefore-any-commit\0${sha}\0\n3\t1\ta.txt\0junk\0-\t-\tbin.dat\0`);
  assert.deepEqual(out, [{ sha, files: 2, additions: 3, deletions: 1 }], "the binary file counts as a file, not lines");
});

test("parseNumstatZ skips malformed entries, marks binary counts -1, and reads a rename's two paths", () => {
  const out = parseNumstatZ("junk\0" + "-\t-\timg.png\0" + "4\t0\t\0old.txt\0new.txt\0" + "x\ty\tweird.txt\0");
  assert.deepEqual(out, [
    { additions: -1, deletions: -1, path: "img.png" },
    { additions: 4, deletions: 0, path: "new.txt", oldPath: "old.txt" },
    { additions: 0, deletions: 0, path: "weird.txt" },
  ]);
  // A truncated rename record still yields an entry with empty paths.
  assert.deepEqual(parseNumstatZ("1\t1\t"), [{ additions: 1, deletions: 1, path: "", oldPath: "" }]);
});

test("mergeCommitFiles keeps name-status order and gives a file with no numstat line zero counts", () => {
  const files = mergeCommitFiles("2\t1\tb.txt\0", "M\0b.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0");
  assert.deepEqual(files, [
    { path: "b.txt", oldPath: undefined, status: "M", additions: 2, deletions: 1 },
    { path: "new.txt", oldPath: "old.txt", status: "R", additions: 0, deletions: 0 },
    { path: "gone.txt", oldPath: undefined, status: "D", additions: 0, deletions: 0 },
  ]);
  // A truncated record is read as far as it goes.
  assert.deepEqual(mergeCommitFiles("", "C75\0src.txt"), [{ path: "", oldPath: "src.txt", status: "C", additions: 0, deletions: 0 }]);
  assert.deepEqual(mergeCommitFiles("", "A"), [{ path: "", oldPath: undefined, status: "A", additions: 0, deletions: 0 }]);
});

test("conflict reads outside a repository answer 'no conflicts' rather than throw", async () => {
  const ctx = outside();
  assert.equal(await ctx.conflict.isConflicted("f.txt"), false);
  assert.deepEqual(await ctx.conflict.listConflicts(), []);
  assert.equal(await ctx.conflict.unmergedCount(), 0);
  assert.equal(await ctx.conflict.getHeadVersion("f.txt"), "");
});

test("walkReaches answers true (fall back to paging) when git can't answer", async () => {
  const ctx = outside();
  assert.equal(await ctx.log.walkReaches("a".repeat(40), ["refs/heads/main"]), true);
  // Nothing to walk at all reaches nothing, without asking git.
  assert.equal(await ctx.log.walkReaches("a".repeat(40), [], { head: false }), false);
});
