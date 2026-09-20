import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import {
  parseNumstatZ,
  parseNameStatusZ,
  mergeCommitFiles,
  parseBatchNumstat,
} from "../src/CommitDetailsProvider";

// ── Pure parsing (deterministic, no git) ─────────────────────────────────────

test("parseNumstatZ: normal, add, delete, binary", () => {
  const out = parseNumstatZ("5\t2\tsrc/a.ts\x0010\t0\tnew.ts\x000\t8\told.ts\x00-\t-\timg.png\x00");
  assert.deepEqual(out, [
    { additions: 5, deletions: 2, path: "src/a.ts" },
    { additions: 10, deletions: 0, path: "new.ts" },
    { additions: 0, deletions: 8, path: "old.ts" },
    { additions: -1, deletions: -1, path: "img.png" },
  ]);
});

test("parseNumstatZ: rename emits old + new path", () => {
  const out = parseNumstatZ("3\t1\t\x00src/old.ts\x00src/new.ts\x00");
  assert.deepEqual(out, [
    { additions: 3, deletions: 1, path: "src/new.ts", oldPath: "src/old.ts" },
  ]);
});

test("parseNameStatusZ: statuses + renames", () => {
  const out = parseNameStatusZ("M\x00src/a.ts\x00A\x00new.ts\x00R096\x00src/old.ts\x00src/new.ts\x00");
  assert.deepEqual(out, [
    { status: "M", path: "src/a.ts" },
    { status: "A", path: "new.ts" },
    { status: "R", path: "src/new.ts", oldPath: "src/old.ts" },
  ]);
});

test("mergeCommitFiles: counts attach to authoritative name-status order", () => {
  const numstat = "3\t1\t\x00a.ts\x00b.ts\x005\t0\tc.ts\x00";
  const nameStatus = "R096\x00a.ts\x00b.ts\x00A\x00c.ts\x00";
  const out = mergeCommitFiles(numstat, nameStatus);
  assert.deepEqual(out, [
    { path: "b.ts", oldPath: "a.ts", status: "R", additions: 3, deletions: 1 },
    { path: "c.ts", oldPath: undefined, status: "A", additions: 5, deletions: 0 },
  ]);
});

test("mergeCommitFiles: pure rename with no content change defaults to 0/0", () => {
  const out = mergeCommitFiles("", "R100\x00a.ts\x00b.ts\x00");
  assert.deepEqual(out, [
    { path: "b.ts", oldPath: "a.ts", status: "R", additions: 0, deletions: 0 },
  ]);
});

test("parseBatchNumstat: one block per sha; binary counts as a file, not lines", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const out = parseBatchNumstat(
    `${sha1}\n\n5\t2\tsrc/a.ts\n-\t-\timg.png\n${sha2}\n\n1\t0\t"odd\\tname.txt"\n`,
  );
  assert.deepEqual(out, [
    { sha: sha1, files: 2, additions: 5, deletions: 2 },
    { sha: sha2, files: 1, additions: 1, deletions: 0 },
  ]);
});

test("parseBatchNumstat: a commit that changed nothing is still answered", () => {
  const sha1 = "c".repeat(40);
  const sha2 = "d".repeat(40);
  const out = parseBatchNumstat(`${sha1}\n${sha2}\n\n3\t3\tx\n`);
  assert.deepEqual(out, [
    { sha: sha1, files: 0, additions: 0, deletions: 0 },
    { sha: sha2, files: 1, additions: 3, deletions: 3 },
  ]);
});

test("parseBatchNumstat: stray lines before the first sha are ignored", () => {
  assert.deepEqual(parseBatchNumstat("warning: something\n1\t1\tx\n"), []);
  assert.deepEqual(parseBatchNumstat(""), []);
});

// ── Hermetic integration (real git) ──────────────────────────────────────────

let repo: string;
let ctx: GitContext;
let firstSha = "";
let secondSha = "";

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

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gs-commit-details-"));
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "first"]);
  firstSha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(repo, "b.txt"), "new file\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "second"]);
  secondSha = git(["rev-parse", "HEAD"]);
  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    removeTempRepo(repo);
  }
});

test("getCommitFiles: second commit (vs first parent) reports M + A with counts", async () => {
  const files = await ctx.commitDetails.getCommitFiles(secondSha, firstSha);
  const byPath = new Map(files.map((f) => [f.path, f]));
  assert.equal(files.length, 2);
  assert.equal(byPath.get("a.txt")?.status, "M");
  assert.equal(byPath.get("a.txt")?.additions, 2);
  assert.equal(byPath.get("a.txt")?.deletions, 1);
  assert.equal(byPath.get("b.txt")?.status, "A");
  assert.equal(byPath.get("b.txt")?.additions, 1);
  assert.equal(byPath.get("b.txt")?.deletions, 0);
});

test("getCommitFiles: root commit (no parent) reports the initial add", async () => {
  const files = await ctx.commitDetails.getCommitFiles(firstSha);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "a.txt");
  assert.equal(files[0].status, "A");
  assert.equal(files[0].additions, 3);
});

// The graph's CHANGES column asks for every visible row at once. One spawn
// must answer with exactly what a per-commit getCommitFiles would have summed:
// a merge against its first parent only, a root against the empty tree, a
// binary file counted but not measured — and a sha git cannot find skipped
// rather than failing the whole window.
test("getCommitStats: one call answers a root, a plain commit, a merge and a binary", async () => {
  // A merge whose first-parent delta is ONE file (c.txt from the side branch),
  // whereas its second-parent delta would be everything main did meanwhile.
  git(["checkout", "-q", "-b", "side", firstSha]);
  writeFileSync(join(repo, "c.txt"), "side\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "side"]);
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
  const mergeSha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(["add", "."]);
  git(["commit", "-q", "-m", "binary"]);
  const binSha = git(["rev-parse", "HEAD"]);

  const missing = "f".repeat(40);
  const stats = await ctx.commitDetails.getCommitStats([
    binSha,
    mergeSha,
    secondSha,
    firstSha,
    missing,
  ]);
  const bySha = new Map(stats.map((s) => [s.sha, s]));
  assert.equal(stats.length, 4, "the missing sha is skipped, not fatal");
  assert.equal(bySha.has(missing), false);
  assert.deepEqual(bySha.get(firstSha), { sha: firstSha, files: 1, additions: 3, deletions: 0 });
  assert.deepEqual(bySha.get(secondSha), { sha: secondSha, files: 2, additions: 3, deletions: 1 });
  assert.deepEqual(bySha.get(mergeSha), { sha: mergeSha, files: 1, additions: 1, deletions: 0 });
  assert.deepEqual(bySha.get(binSha), { sha: binSha, files: 1, additions: 0, deletions: 0 });

  // The same totals the per-commit path produces, so the two can never
  // disagree about a row.
  for (const [sha, parent] of [
    [secondSha, firstSha],
    [firstSha, undefined],
  ] as const) {
    const files = await ctx.commitDetails.getCommitFiles(sha, parent);
    const add = files.reduce((n, f) => n + Math.max(0, f.additions), 0);
    const del = files.reduce((n, f) => n + Math.max(0, f.deletions), 0);
    assert.deepEqual(bySha.get(sha), { sha, files: files.length, additions: add, deletions: del });
  }
});

test("getCommitStats: an empty request spawns nothing and answers nothing", async () => {
  assert.deepEqual(await ctx.commitDetails.getCommitStats([]), []);
});
