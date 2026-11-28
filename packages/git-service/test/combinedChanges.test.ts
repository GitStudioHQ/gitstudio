import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import {
  combinedChanges,
  combinePieces,
  EMPTY_TREE,
  EMPTY_TREE_SHA256,
  parseCommitChangesZ,
  stackOf,
  type CommitChanges,
} from "../src/combinedChanges";

// Several selected commits' files as one change (#161). A selection that is
// one unbroken run is diffed as one change, base to tip — what a squash would
// make. Anything else is combined per file, each from before the first
// selected commit that changed it to after the last.

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const P = "e".repeat(40);

// ── Parsing ──────────────────────────────────────────────────────────────────

test("parseCommitChangesZ reads each commit's parents and changes, a root's empty parents, and an empty commit", () => {
  const out = parseCommitChangesZ(
    `${A} ${B}\0\nM\0src/a.ts\0D\0gone.txt\0` +
      `${B} ${C} ${D}\0` + // a merge that changed nothing against its first parent
      `${C} \0\nA\0first.txt\0`, // a root: "%H %P" with no parents
  );
  assert.deepEqual(out, [
    { sha: A, parents: [B], changes: [{ status: "M", path: "src/a.ts" }, { status: "D", path: "gone.txt" }] },
    { sha: B, parents: [C, D], changes: [] },
    { sha: C, parents: [], changes: [{ status: "A", path: "first.txt" }] },
  ]);
});

test("parseCommitChangesZ takes paths by position: a path that looks like a status or a sha stays a path", () => {
  const out = parseCommitChangesZ(`${A} ${B}\0\nR100\0M\0${C}\0M\0R100\0`);
  assert.deepEqual(out, [
    {
      sha: A,
      parents: [B],
      changes: [
        { status: "R", oldPath: "M", path: C },
        { status: "M", path: "R100" },
      ],
    },
  ]);
});

test("parseCommitChangesZ reads a copy as an addition: its source stays where it was", () => {
  const out = parseCommitChangesZ(`${A} ${B}\0\nC75\0orig.ts\0copy.ts\0`);
  assert.deepEqual(out[0].changes, [{ status: "A", path: "copy.ts" }]);
});

// ── Which selections are one run ─────────────────────────────────────────────

const commit = (sha: string, parents: string[], changes: CommitChanges["changes"] = []): CommitChanges => ({
  sha,
  parents,
  changes,
});

test("stackOf: each the first parent of the next is a run, in any order given", () => {
  const run = [commit(A, [B]), commit(B, [C]), commit(C, [P])];
  assert.deepEqual(stackOf(run), { tip: A, base: P });
  assert.deepEqual(stackOf([run[2], run[0], run[1]]), { tip: A, base: P });
});

test("stackOf: a run down to a root commit starts from the empty tree", () => {
  assert.deepEqual(stackOf([commit(A, [B]), commit(B, [])]), { tip: A, base: EMPTY_TREE });
});

test("stackOf: a merge in the run is followed down its first parent", () => {
  assert.deepEqual(stackOf([commit(A, [B, D]), commit(B, [C])]), { tip: A, base: C });
  // Its second parent is not the line: B reached only that way is not a run.
  assert.equal(stackOf([commit(A, [D, B]), commit(B, [C])]), undefined);
});

test("stackOf: a gap, two lines, one commit or a repeated one is not a run", () => {
  assert.equal(stackOf([commit(A, [B]), commit(C, [P])]), undefined, "B between them is not selected");
  assert.equal(stackOf([commit(A, [P]), commit(B, [P])]), undefined, "two children of one commit");
  assert.equal(stackOf([commit(A, [B])]), undefined);
  assert.equal(stackOf([commit(A, [B]), commit(A, [B])]), undefined);
});

// ── Combining a selection that is not one run ────────────────────────────────

test("combinePieces follows a file through a rename, from before its first change to after its last", () => {
  // Newest first, as the graph lists them.
  const files = combinePieces([
    commit(C, [D], [{ status: "M", path: "b.txt" }]),
    commit(A, [B], [{ status: "R", oldPath: "a.txt", path: "b.txt" }]),
  ]);
  assert.deepEqual(files, [
    { path: "b.txt", oldPath: "a.txt", status: "R", additions: 0, deletions: 0, from: B, to: C },
  ]);
});

test("combinePieces: added then deleted is nothing; deleted then added again is a change", () => {
  const files = combinePieces([
    commit(C, [D], [
      { status: "D", path: "temp.txt" },
      { status: "A", path: "back.txt" },
    ]),
    commit(A, [B], [
      { status: "A", path: "temp.txt" },
      { status: "D", path: "back.txt" },
    ]),
  ]);
  assert.deepEqual(files, [{ path: "back.txt", status: "M", additions: 0, deletions: 0, from: B, to: C }]);
});

test("combinePieces: two files swapping names are two changed paths, as a diff of the range says", () => {
  const files = combinePieces([
    commit(C, [D], [
      { status: "R", oldPath: "x", path: "y" },
      { status: "R", oldPath: "y", path: "x" },
    ]),
    commit(A, [B], [{ status: "M", path: "x" }]),
  ]);
  assert.deepEqual(files, [
    { path: "x", status: "M", additions: 0, deletions: 0, from: B, to: C },
    { path: "y", status: "M", additions: 0, deletions: 0, from: D, to: C },
  ]);
});

test("combinePieces: a rename onto a name deleted earlier is that name changing, and the deletion is not lost", () => {
  const files = combinePieces([
    commit(C, [D], [{ status: "R", oldPath: "a.txt", path: "b.txt" }]),
    commit(A, [B], [{ status: "D", path: "b.txt" }]),
  ]);
  assert.deepEqual(files, [
    { path: "a.txt", status: "D", additions: 0, deletions: 0, from: D, to: C },
    { path: "b.txt", status: "M", additions: 0, deletions: 0, from: B, to: C },
  ]);
});

test("combinePieces: a name renamed away and later added again is one row, never two of one path", () => {
  const files = combinePieces([
    commit(P, [A], [{ status: "A", path: "a.txt" }]),
    commit(C, [D], [{ status: "D", path: "b.txt" }]),
    commit(A, [B], [{ status: "R", oldPath: "a.txt", path: "b.txt" }]),
  ]);
  assert.deepEqual(files, [{ path: "a.txt", status: "M", additions: 0, deletions: 0, from: B, to: P }]);
});

test("combinePieces: renames chain through each name a file had, while each is its whole story", () => {
  const files = combinePieces([
    commit(P, [A], [{ status: "M", path: "c" }]),
    commit(C, [D], [{ status: "R", oldPath: "b", path: "c" }]),
    commit(A, [B], [{ status: "R", oldPath: "a", path: "b" }]),
  ]);
  assert.deepEqual(files, [{ path: "c", oldPath: "a", status: "R", additions: 0, deletions: 0, from: B, to: P }]);
});

test("combinePieces: a deletion is shown under the name the file had before the selection", () => {
  const files = combinePieces([
    commit(C, [D], [{ status: "D", path: "b.txt" }]),
    commit(A, [B], [{ status: "R", oldPath: "a.txt", path: "b.txt" }]),
  ]);
  assert.deepEqual(files, [{ path: "a.txt", status: "D", additions: 0, deletions: 0, from: B, to: C }]);
});

// ── Against a real repository ────────────────────────────────────────────────

let repo: string;
let ctx: GitContext;
let spawns: string[][] = [];
const sha: Record<string, string> = {};

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function commitAll(name: string, files: Record<string, string>, remove: string[] = []): void {
  for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body);
  if (remove.length) git(["rm", "-q", ...remove]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", name]);
  sha[name] = git(["rev-parse", "HEAD"]);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gs-combined-"));
  git(["init", "-q", "-b", "main"]);
  commitAll("root", { "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n", "x.txt": "x\n" });
  commitAll("c1", { "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n", "n.txt": "new\n" });
  // A rename with an edit: one change a.txt → b.txt across the run.
  git(["mv", "a.txt", "b.txt"]);
  commitAll("c2", { "b.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" });
  commitAll("c3", { "x.txt": "changed\n" });
  // …and changed back: across the run, x.txt did not change.
  commitAll("c4", { "x.txt": "x\n", "n.txt": "new\nmore\n" });
  // A side line from c1, and a commit on main after it.
  git(["checkout", "-q", "-b", "side", sha.c1]);
  commitAll("s1", { "side.txt": "s\n" });
  git(["checkout", "-q", "main"]);
  ctx = new GitContext({ root: repo, onRun: (e) => void spawns.push(e.args) });
});

after(() => {
  ctx?.dispose();
  if (repo) removeTempRepo(repo);
});

test("an unbroken run is one change, base to tip: renames, exact counts, and a file changed back is not listed", async () => {
  spawns = [];
  const r = await combinedChanges(ctx.process, [sha.c4, sha.c3, sha.c2, sha.c1]);
  assert.equal(r.kind, "stack");
  assert.deepEqual(r.files, [
    { path: "b.txt", oldPath: "a.txt", status: "R", additions: 2, deletions: 0, from: sha.root, to: sha.c4 },
    { path: "n.txt", status: "A", additions: 2, deletions: 0, from: sha.root, to: sha.c4 },
  ]);
  assert.equal(spawns.length, 3, "one log for the commits, and the run's numstat and name-status");
});

test("a run that starts at the root commit is diffed from the empty tree", async () => {
  const r = await combinedChanges(ctx.process, [sha.c1, sha.root]);
  assert.equal(r.kind, "stack");
  assert.deepEqual(
    r.files.map((f) => [f.path, f.status, f.from, f.to]),
    [
      ["a.txt", "A", EMPTY_TREE, sha.c1],
      ["n.txt", "A", EMPTY_TREE, sha.c1],
      ["x.txt", "A", EMPTY_TREE, sha.c1],
    ],
  );
});

test("a selection with a gap is combined per file, on one line of history", async () => {
  spawns = [];
  const r = await combinedChanges(ctx.process, [sha.c4, sha.c2]);
  assert.equal(r.kind, "pieces");
  assert.equal(r.divergent, undefined, "c2 is an ancestor of c4: one line");
  assert.deepEqual(r.files, [
    { path: "b.txt", oldPath: "a.txt", status: "R", additions: 0, deletions: 0, from: sha.c1, to: sha.c2 },
    { path: "n.txt", status: "M", additions: 0, deletions: 0, from: sha.c3, to: sha.c4 },
    { path: "x.txt", status: "M", additions: 0, deletions: 0, from: sha.c3, to: sha.c4 },
  ]);
  assert.equal(spawns.length, 2, "the commits' changes, and one walk to ask whether they are one line");
});

test("commits from two lines are combined per file, and said to be on more than one line", async () => {
  const r = await combinedChanges(ctx.process, [sha.s1, sha.c2]);
  assert.equal(r.kind, "pieces");
  assert.equal(r.divergent, true);
  assert.deepEqual(
    r.files.map((f) => [f.path, f.status, f.from, f.to]),
    [
      ["b.txt", "R", sha.c1, sha.c2],
      ["side.txt", "A", sha.c1, sha.s1],
    ],
  );
});

test("a commit git cannot find is left out, and anything that is not a sha never reaches git", async () => {
  spawns = [];
  const gone = "0".repeat(40);
  const r = await combinedChanges(ctx.process, [sha.c4, gone, sha.c3, "--all"]);
  assert.equal(r.kind, "stack", "c4 and c3 are still a run");
  assert.deepEqual(r.files, [{ path: "n.txt", status: "M", additions: 1, deletions: 0, from: sha.c2, to: sha.c4 }]);
  assert.ok(!spawns.flat().includes("--all"));
  assert.deepEqual(await combinedChanges(ctx.process, ["HEAD", "-p"]), { kind: "pieces", files: [] });
});

// ── The review's shapes, against git ────────────────────────────────────────

function scratch(args: string[] = []): { dir: string; run: (a: string[]) => string; ctx: GitContext; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gs-combined-x-"));
  const run = (a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" },
    }).trim();
  run(["init", "-q", "-b", "main", ...args]);
  const x = new GitContext({ root: dir });
  return { dir, run, ctx: x, done: () => { x.dispose(); removeTempRepo(dir); } };
}

test("a sha-256 repository: a run down to its root commit is diffed from ITS empty tree", async () => {
  const r = scratch(["--object-format=sha256"]);
  try {
    writeFileSync(join(r.dir, "a.txt"), "a\n");
    r.run(["add", "-A"]);
    r.run(["commit", "-qm", "root"]);
    const root = r.run(["rev-parse", "HEAD"]);
    writeFileSync(join(r.dir, "b.txt"), "b\n");
    r.run(["add", "-A"]);
    r.run(["commit", "-qm", "c1"]);
    const c1 = r.run(["rev-parse", "HEAD"]);
    const out = await combinedChanges(r.ctx.process, [c1, root]);
    assert.equal(out.kind, "stack");
    assert.deepEqual(out.files.map((f) => [f.path, f.status, f.from]), [
      ["a.txt", "A", EMPTY_TREE_SHA256],
      ["b.txt", "A", EMPTY_TREE_SHA256],
    ]);
  } finally {
    r.done();
  }
});

test("a merge in a selection lists its first-parent files, whatever log.diffMerges the user set", async () => {
  const r = scratch();
  try {
    writeFileSync(join(r.dir, "a"), "a\n");
    r.run(["add", "-A"]);
    r.run(["commit", "-qm", "root"]);
    r.run(["checkout", "-qb", "side"]);
    writeFileSync(join(r.dir, "side.txt"), "s\n");
    r.run(["add", "-A"]);
    r.run(["commit", "-qm", "side"]);
    r.run(["checkout", "-q", "main"]);
    writeFileSync(join(r.dir, "a"), "a\nb\n");
    r.run(["commit", "-qam", "c1"]);
    const c1 = r.run(["rev-parse", "HEAD"]);
    writeFileSync(join(r.dir, "x"), "x\n");
    r.run(["add", "-A"]);
    r.run(["commit", "-qm", "c2"]);
    r.run(["merge", "-q", "--no-ff", "side", "-m", "merge"]);
    const merge = r.run(["rev-parse", "HEAD"]);
    for (const mode of ["combined", "dense-combined", "remerge", "separate"]) {
      r.run(["config", "log.diffMerges", mode]);
      const out = await combinedChanges(r.ctx.process, [merge, c1]);
      assert.equal(out.kind, "pieces", mode);
      assert.deepEqual(out.files.map((f) => f.path), ["a", "side.txt"], `log.diffMerges=${mode}`);
    }
    r.run(["config", "log.diffMerges", "remerge"]);
    const stats = await r.ctx.commitDetails.getCommitStats([merge]);
    assert.equal(stats[0]?.files, 1, "the CHANGES column's merge count too");
  } finally {
    r.done();
  }
});

test("a side line's commit and a main one: said to be on more than one line, though both are under the merge", async () => {
  const r = scratch();
  try {
    writeFileSync(join(r.dir, "f.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
    r.run(["add", "-A"]);
    r.run(["commit", "-qm", "root"]);
    r.run(["checkout", "-qb", "side"]);
    writeFileSync(join(r.dir, "f.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n");
    r.run(["commit", "-qam", "s1"]);
    const s1 = r.run(["rev-parse", "HEAD"]);
    r.run(["checkout", "-q", "main"]);
    writeFileSync(join(r.dir, "f.txt"), "1\n2\n3\n4\n5\n6\n7\nEIGHT\n");
    r.run(["commit", "-qam", "m1"]);
    const m1 = r.run(["rev-parse", "HEAD"]);
    r.run(["merge", "-q", "--no-ff", "side", "-m", "merge"]);
    const merge = r.run(["rev-parse", "HEAD"]);
    const two = await combinedChanges(r.ctx.process, [m1, s1]);
    assert.equal(two.divergent, true, "neither is the other's ancestor");
    const three = await combinedChanges(r.ctx.process, [merge, m1, s1]);
    assert.equal(three.divergent, true, "all under the merge, but s1 is not m1's ancestor");
    const line = await combinedChanges(r.ctx.process, [merge, s1]);
    assert.equal(line.divergent, undefined, "s1 is the merge's ancestor: one line");
  } finally {
    r.done();
  }
});
