import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import {
  parseNumstatZ,
  parseNameStatusZ,
  mergeCommitFiles,
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
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
