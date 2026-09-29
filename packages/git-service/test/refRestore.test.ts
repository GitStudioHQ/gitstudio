import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess } from "../src/GitProcess";
import {
  branchShort,
  checkedOutAt,
  headBranch,
  isBranchRef,
  isSha,
  localBranches,
  putRefBack,
  shortSha,
  whyRefsNotRestorable,
  type RefMove,
} from "../src/refRestore";
import { sameFolder } from "../src/folderPath";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// Undo's ref restore: put back exactly the branches an operation moved, by
// full name and compare-and-swap, and say — before anything runs — why a
// branch can't be put back as things stand.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

/** master with commits A, B; returns the repo, a process on it, and the shas. */
function scene(name: string): { r: Repo; proc: GitProcess; A: string; B: string } {
  const r = makeRepo(`refrestore-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("f.txt", "a\n");
  const A = r.commitAll("A");
  r.write("f.txt", "b\n");
  const B = r.commitAll("B");
  const proc = new GitProcess({ cwd: r.root });
  cleanup.push(() => proc.dispose());
  return { r, proc, A, B };
}

const refOf = (r: Repo, ref: string): string | null => {
  const out = r.git("for-each-ref", "--format=%(objectname)", ref).trim();
  return out === "" ? null : out;
};

test("the small helpers: short names and shas for words, and what counts as a branch ref or a sha", () => {
  assert.equal(branchShort("refs/heads/feature/x"), "feature/x");
  assert.equal(branchShort("refs/tags/v1"), "refs/tags/v1", "only a branch prefix is dropped");
  assert.equal(shortSha("0123456789abcdef"), "0123456");
  assert.equal(isBranchRef("refs/heads/x"), true);
  assert.equal(isBranchRef("refs/heads/-f"), true, "an option-like name is still a full ref");
  assert.equal(isBranchRef("refs/tags/x"), false);
  assert.equal(isBranchRef("refs/heads/a..b"), false);
  assert.equal(isBranchRef("refs/heads/"), false);
  assert.equal(isBranchRef(42), false);
  assert.equal(isSha("a".repeat(40)), true);
  assert.equal(isSha("A".repeat(64)), true, "sha-256 too");
  assert.equal(isSha("a".repeat(39)), false);
  assert.equal(isSha(undefined), false);
});

test("localBranches, checkedOutAt and headBranch read the repository's branches, worktrees and HEAD", async () => {
  const { r, proc, A, B } = scene("read");
  r.git("branch", "old", A);
  // A tag named like a branch never shows among branches.
  r.git("tag", "old", B);
  const wt = join(mkdtempSync(join(tmpdir(), "gs-refrestore-wt-")), "wt");
  cleanup.push(() => removeTempRepo(join(wt, "..")));
  r.git("worktree", "add", "-q", wt, "old");

  assert.deepEqual(await localBranches(proc), { "refs/heads/master": B, "refs/heads/old": A });
  const where = await checkedOutAt(proc);
  assert.ok(sameFolder(where.get("refs/heads/master")!, r.root));
  assert.ok(sameFolder(where.get("refs/heads/old")!, wt));
  assert.equal(realpathSync.native(where.get("refs/heads/old")!), realpathSync.native(wt), "spelled the system's way");
  assert.equal(await headBranch(proc), "refs/heads/master");

  r.git("checkout", "-q", "--detach");
  assert.equal(await headBranch(proc), null, "detached");

  const nowhere = mkdtempSync(join(tmpdir(), "gs-refrestore-norepo-"));
  cleanup.push(() => removeTempRepo(nowhere));
  const outside = new GitProcess({ cwd: nowhere });
  cleanup.push(() => outside.dispose());
  assert.deepEqual(await localBranches(outside), {});
  assert.equal((await checkedOutAt(outside)).size, 0);
  assert.equal(await headBranch(outside), null);
});

test("whyRefsNotRestorable: nothing to say when every ref is where the op left it, or already back", async () => {
  const { r, proc, A, B } = scene("ok");
  r.git("branch", "moved", B);
  const moves: RefMove[] = [
    { ref: "refs/heads/moved", before: A, after: B }, // where the op left it
    { ref: "refs/heads/master", before: B, after: A }, // already back
  ];
  assert.equal(await whyRefsNotRestorable(proc, moves, "Rebase"), undefined);
});

test("whyRefsNotRestorable names each reason a ref can't be put back", async () => {
  const { r, proc, A, B } = scene("why");
  // Deleted by the op, but a branch of that name exists again.
  r.git("branch", "again", A);
  assert.equal(
    await whyRefsNotRestorable(proc, [{ ref: "refs/heads/again", before: B, after: null }], "Delete Branch"),
    `A branch named 'again' exists again, so Undo won't bring back the one "Delete Branch" deleted. Nothing was changed.`,
  );
  // Moved by the op, deleted since.
  assert.equal(
    await whyRefsNotRestorable(proc, [{ ref: "refs/heads/vanished", before: A, after: B }], "Reset"),
    `'vanished' has been deleted since "Reset", so there is nothing to put back.`,
  );
  // Moved by the op, moved again since.
  r.git("branch", "drifted", A);
  const drifted = await whyRefsNotRestorable(proc, [{ ref: "refs/heads/drifted", before: B, after: "f".repeat(40) }], "Reset");
  assert.equal(drifted, `'drifted' has moved since (it is at ${A.slice(0, 7)} now), and putting it back would throw that away.`);
  // Created by the op and checked out here: switch away first.
  r.git("checkout", "-q", "-b", "made");
  assert.equal(
    await whyRefsNotRestorable(proc, [{ ref: "refs/heads/made", before: null, after: B }], "New Branch"),
    "'made' is checked out. Switch to another branch, then undo.",
  );
  // …unless HEAD is about to leave it.
  assert.equal(
    await whyRefsNotRestorable(proc, [{ ref: "refs/heads/made", before: null, after: B }], "New Branch", { leaving: "refs/heads/made" }),
    undefined,
  );
  // Moved (not created) and checked out here: the caller moves it with reset --keep.
  assert.equal(await whyRefsNotRestorable(proc, [{ ref: "refs/heads/made", before: A, after: B }], "Commit"), undefined);
});

test("whyRefsNotRestorable sends a branch checked out in another worktree to that worktree", async () => {
  const { r, proc, A, B } = scene("elsewhere");
  r.git("branch", "there", B);
  const base = mkdtempSync(join(tmpdir(), "gs-refrestore-else-"));
  cleanup.push(() => removeTempRepo(base));
  r.git("worktree", "add", "-q", join(base, "wt"), "there");
  const why = await whyRefsNotRestorable(proc, [{ ref: "refs/heads/there", before: A, after: B }], "Commit");
  assert.match(why ?? "", /^'there' is checked out in another worktree, at .+\. Undo it there\.$/);
  const shownPath = /at (.+)\. Undo/.exec(why!)![1];
  assert.ok(sameFolder(shownPath, join(base, "wt")));
});

test("putRefBack deletes what the op created, brings back what it deleted, and moves back what it moved — by full name", async () => {
  const { r, proc, A, B } = scene("put");
  // A tag shares each branch's name: a short name would be ambiguous.
  for (const n of ["created", "deleted", "moved"]) r.git("tag", n, A);

  r.git("branch", "created", B);
  await putRefBack(proc, { ref: "refs/heads/created", before: null, after: B }, "undo: branch");
  assert.equal(refOf(r, "refs/heads/created"), null);

  await putRefBack(proc, { ref: "refs/heads/deleted", before: A, after: null }, "undo: delete");
  assert.equal(refOf(r, "refs/heads/deleted"), A);

  r.git("branch", "moved", B);
  await putRefBack(proc, { ref: "refs/heads/moved", before: A, after: B }, "undo: reset");
  assert.equal(refOf(r, "refs/heads/moved"), A);
  assert.match(r.git("reflog", "-1", "--format=%gs", "refs/heads/moved"), /undo: reset/, "the reflog says why");

  for (const n of ["created", "deleted", "moved"]) assert.equal(refOf(r, `refs/tags/${n}`), A, `tag ${n} untouched`);

  // Already back: nothing runs, nothing changes.
  await putRefBack(proc, { ref: "refs/heads/moved", before: A, after: B }, "undo again");
  assert.equal(refOf(r, "refs/heads/moved"), A);
});

test("putRefBack of HEAD's own branch moves the files with it (reset --keep)", async () => {
  const { r, proc, A, B } = scene("here");
  await putRefBack(proc, { ref: "refs/heads/master", before: A, after: B }, "undo: commit", { here: true });
  assert.equal(r.sha("HEAD"), A);
  assert.equal(r.read("f.txt"), "a\n", "the working tree followed");
});

test("putRefBack throws a sentence naming what it could not do when git refuses", async () => {
  const { r, proc, A, B } = scene("refused");
  const other = "e".repeat(40).replace(/^e{7}/, B.slice(0, 7)); // a sha the ref is NOT at

  // Created by the op, but moved since: the compare-and-swap delete refuses.
  r.git("branch", "c", A);
  await assert.rejects(
    putRefBack(proc, { ref: "refs/heads/c", before: null, after: B }, "undo"),
    /^Error: Undo couldn't delete 'c': /,
  );
  assert.equal(refOf(r, "refs/heads/c"), A, "left where it is");

  // Deleted by the op, but the name exists again.
  r.git("branch", "d", B);
  await assert.rejects(putRefBack(proc, { ref: "refs/heads/d", before: A, after: null }, "undo"), /Undo couldn't bring back 'd': /);
  assert.equal(refOf(r, "refs/heads/d"), B);

  // Moved by the op, moved since.
  r.git("branch", "m", B);
  await assert.rejects(
    putRefBack(proc, { ref: "refs/heads/m", before: A, after: other }, "undo"),
    new RegExp(`Undo couldn't move 'm' back to ${A.slice(0, 7)}: `),
  );
  assert.equal(refOf(r, "refs/heads/m"), B);

  // HEAD's branch with a local edit reset --keep would lose.
  r.write("f.txt", "local edit\n");
  await assert.rejects(
    putRefBack(proc, { ref: "refs/heads/master", before: A, after: B }, "undo", { here: true }),
    /Undo couldn't move 'master' back to/,
  );
  assert.equal(r.sha("HEAD"), B);
  assert.equal(r.read("f.txt"), "local edit\n", "the edit survives");
});
