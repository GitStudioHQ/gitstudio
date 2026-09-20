import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { parseCommitStatsZ } from "../src/CommitDetailsProvider";
import type { CommitStat } from "../src/CommitDetailsProvider";

// `getCommitStats` answers the graph's CHANGES column for a whole window of
// rows with ONE git process. The invariant that matters is that it says exactly
// what the per-commit path (`getCommitFiles(sha, parents[0])`, summed) said —
// for every shape of commit a history can hold — and that it is one spawn.

// ── Pure parsing (deterministic, no git) ─────────────────────────────────────

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("parseCommitStatsZ: entries, a binary, then a commit with no diff, then more", () => {
  const out = parseCommitStatsZ(
    `${A}\x00\n5\t2\tsrc/a.ts\x00-\t-\timg.png\x00` + // two files, one binary
      `${B}\x00` + // an empty commit (or an `ours` merge): sha alone
      `${C}\x00\n1\t0\tnew.ts\x00`,
  );
  assert.deepEqual(out, [
    { sha: A, files: 2, additions: 5, deletions: 2 },
    { sha: B, files: 0, additions: 0, deletions: 0 },
    { sha: C, files: 1, additions: 1, deletions: 0 },
  ]);
});

test("parseCommitStatsZ: a rename as the FIRST entry consumes its old and new path", () => {
  // The `\n` after the header rides on the rename's count field; the two path
  // fields that follow must not be mistaken for entries or shas — the second
  // rename's paths here happen to LOOK like shas, and positional consumption
  // keeps them as paths.
  const out = parseCommitStatsZ(
    `${A}\x00\n3\t1\t\x00src/old.ts\x00src/new.ts\x000\t0\t\x00${B}\x00${C}\x00`,
  );
  assert.deepEqual(out, [{ sha: A, files: 2, additions: 3, deletions: 1 }]);
});

test("parseCommitStatsZ: a sha256 object name is a commit header too", () => {
  const S = "f".repeat(64);
  assert.deepEqual(parseCommitStatsZ(`${S}\x00\n2\t2\tx\x00`), [
    { sha: S, files: 1, additions: 2, deletions: 2 },
  ]);
});

test("parseCommitStatsZ: empty output is no commits", () => {
  assert.deepEqual(parseCommitStatsZ(""), []);
});

// ── Hermetic integration (real git) ──────────────────────────────────────────

let repo: string;
let ctx: GitContext;
let spawns: string[][] = [];
const shas: Record<string, string> = {};

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
  repo = mkdtempSync(join(tmpdir(), "gs-commit-stats-"));
  git(["init", "-q", "-b", "main"]);
  // root: a text file and a binary file
  writeFileSync(join(repo, "a.txt"), "a\nb\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2]));
  git(["add", "."]);
  git(["commit", "-q", "-m", "root"]);
  shas.root = git(["rev-parse", "HEAD"]);
  // a rename WITH an edit, so -M matters and the counts are non-zero
  writeFileSync(join(repo, "b c.txt"), "a\nb\nc\n");
  git(["rm", "-q", "a.txt"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "rename+edit"]);
  shas.rename = git(["rev-parse", "HEAD"]);
  // a feature branch, merged with --no-ff: the merge's first-parent delta is
  // the feature's whole change
  git(["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feat"]);
  shas.feat = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);
  writeFileSync(join(repo, "m.txt"), "m\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "mainside"]);
  shas.mainside = git(["rev-parse", "HEAD"]);
  git(["merge", "-q", "--no-ff", "feat", "-m", "merge"]);
  shas.merge = git(["rev-parse", "HEAD"]);
  // a binary edit: a file, no lines
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  git(["commit", "-q", "-am", "binedit"]);
  shas.binedit = git(["rev-parse", "HEAD"]);
  // a commit that changed nothing at all
  git(["commit", "-q", "--allow-empty", "-m", "empty"]);
  shas.empty = git(["rev-parse", "HEAD"]);
  // a merge whose first-parent delta is empty (`-s ours`)
  git(["checkout", "-q", "-b", "side", shas.root]);
  writeFileSync(join(repo, "y.txt"), "y\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "sidey"]);
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "-s", "ours", "--no-ff", "side", "-m", "merge-ours"]);
  shas.mergeOurs = git(["rev-parse", "HEAD"]);
  ctx = new GitContext({ root: repo, onRun: (e) => void spawns.push(e.args) });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    removeTempRepo(repo);
  }
});

/** The per-commit path's answer, summed exactly as the graph hosts summed it. */
async function slowStat(sha: string): Promise<CommitStat> {
  const parents = git(["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
  const files = await ctx.commitDetails.getCommitFiles(sha, parents[0]);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (f.additions > 0) additions += f.additions;
    if (f.deletions > 0) deletions += f.deletions;
  }
  return { sha, files: files.length, additions, deletions };
}

test("getCommitStats: one process, and every shape of commit agrees with getCommitFiles", async () => {
  const all = Object.values(shas);
  spawns = [];
  const fast = await ctx.commitDetails.getCommitStats(all);
  assert.equal(spawns.length, 1, "a window of rows is ONE git process");
  assert.equal(fast.length, all.length, "every sha is answered");
  const bySha = new Map(fast.map((s) => [s.sha, s]));
  for (const [name, sha] of Object.entries(shas)) {
    assert.deepEqual(bySha.get(sha), await slowStat(sha), `${name} (${sha.slice(0, 7)})`);
  }
  // …and the shapes are the ones the fixture set out to cover, not all zeros
  // agreeing with all zeros.
  assert.deepEqual(bySha.get(shas.root), { sha: shas.root, files: 2, additions: 2, deletions: 0 });
  assert.deepEqual(bySha.get(shas.rename), { sha: shas.rename, files: 1, additions: 1, deletions: 0 });
  assert.deepEqual(bySha.get(shas.merge), { sha: shas.merge, files: 1, additions: 1, deletions: 0 });
  assert.deepEqual(bySha.get(shas.binedit), { sha: shas.binedit, files: 1, additions: 0, deletions: 0 });
  assert.deepEqual(bySha.get(shas.empty), { sha: shas.empty, files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(bySha.get(shas.mergeOurs), { sha: shas.mergeOurs, files: 0, additions: 0, deletions: 0 });
});

test("getCommitStats: a root commit is described even when log.showRoot is off", async () => {
  git(["config", "log.showRoot", "false"]);
  try {
    const [root] = await ctx.commitDetails.getCommitStats([shas.root]);
    assert.deepEqual(root, { sha: shas.root, files: 2, additions: 2, deletions: 0 });
  } finally {
    git(["config", "--unset", "log.showRoot"]);
  }
});

test("getCommitStats: nothing asked, nothing spawned", async () => {
  spawns = [];
  assert.deepEqual(await ctx.commitDetails.getCommitStats([]), []);
  assert.equal(spawns.length, 0);
});

test("getCommitStats: an unknown object is skipped, not fatal, and never answered as zeros", async () => {
  // A graph window can hold a commit a rebase just rewrote away; that row must
  // not blank the column for the others, and must not be reported as "no
  // changes" either — it is simply absent, for the caller to treat as unknown.
  const stats = await ctx.commitDetails.getCommitStats([shas.root, "d".repeat(40)]);
  assert.deepEqual(stats.map((s) => s.sha), [shas.root]);
});
