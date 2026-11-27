import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess } from "../src/GitProcess";
import { LogProvider } from "../src/LogProvider";
import { removeTempRepo } from "./tmpRepo";

// The graph's walk over a repository whose HEAD names no commit — an UNBORN
// branch (crash report #97). git refuses a literal HEAD there:
//
//   git log … --branches --tags --remotes HEAD
//   fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.
//
// and the whole graph load failed with it. Three ordinary ways to get there:
//   · a fresh `git init` — nothing at all to walk;
//   · `git switch --orphan x` while the other branches have their history;
//   · `git init` + `git fetch` that never checked anything out — only remotes.
// The last two have plenty to show, and showed an error (the desktop) or
// "No commits yet" (the extension, which read the error as an empty repo).

let repo: string;
let proc: GitProcess;
let log: LogProvider;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function commit(file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git("add", ".");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

const walk = async (refs?: string[], head?: boolean): Promise<string[]> => {
  const out: string[] = [];
  for await (const c of log.streamCommits({ revRange: "--all", refs, head })) out.push(c.sha);
  return out;
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-unborn-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  proc = new GitProcess({ cwd: repo });
  log = new LogProvider(proc);
});

afterEach(() => {
  proc?.dispose();
  removeTempRepo(repo);
});

test("a freshly initialised repository walks nothing — no throw", async () => {
  assert.equal(git("for-each-ref"), "", "sanity: not one ref");
  assert.deepEqual(await walk(), [], "the whole graph: empty, not an error");
  assert.deepEqual(await walk([], true), [], "Current branch on it: HEAD alone, and HEAD is nothing");
});

test("THE REPORT: an orphan HEAD still shows every other branch, tag and remote", async () => {
  const one = commit("a.txt", "one");
  const two = commit("b.txt", "two");
  git("tag", "v1", one);
  git("update-ref", "refs/remotes/origin/main", two);
  // History only a tag reaches: --tags still walks it with HEAD unborn.
  git("checkout", "-q", "--detach", one);
  const tagOnly = commit("t.txt", "tag only");
  git("tag", "-a", "-m", "annotated", "v0-lost", tagOnly);
  git("switch", "-q", "--orphan", "lone");

  const all = await walk();
  assert.deepEqual(new Set(all), new Set([two, one, tagOnly]), "every commit the refs reach, and nothing thrown");
});

test("an init + fetch that never checked out: the remotes are the graph", async () => {
  const one = commit("a.txt", "one");
  const two = commit("b.txt", "two");
  git("update-ref", "refs/remotes/origin/main", two);
  // Leave nothing local: HEAD on a branch that has never had a commit, and
  // main gone — what `git init && git remote add && git fetch` leaves.
  git("switch", "-q", "--orphan", "main-to-be");
  git("branch", "-D", "main");
  assert.equal(git("for-each-ref", "--format=%(refname)"), "refs/remotes/origin/main", "sanity: only the remote");

  assert.deepEqual(await walk(), [two, one]);
});

test("under a filter an unborn HEAD walks nothing, and the ticked refs walk as ever", async () => {
  const one = commit("a.txt", "one");
  const two = commit("b.txt", "two");
  git("switch", "-q", "--orphan", "lone");

  // "Current branch" on an unborn branch resolves to no ref, with HEAD walked.
  assert.deepEqual(await walk([], true), []);
  // A hand-picked branch, HEAD walked beside it (no branch is current, so a
  // host takes HEAD for detached): the branch's history, HEAD adding nothing.
  assert.deepEqual(await walk(["refs/heads/main"], true), [two, one]);
  assert.equal(await log.walkReaches(one, ["refs/heads/main"], { head: true }), true);
  assert.equal(await log.walkReaches(one, [], { head: true }), false, "an unborn HEAD reaches nothing");
});

test("a detached HEAD and an attached one are unchanged: HEAD still walks", async () => {
  commit("a.txt", "one");
  git("checkout", "-q", "-b", "side");
  const side = commit("s.txt", "side");
  git("checkout", "-q", "main");
  git("checkout", "-q", "--detach", "HEAD");
  const detached = commit("d.txt", "detached");
  const all = await walk();
  assert.ok(all.includes(detached), "the commit you are sitting on");
  assert.ok(all.includes(side));
});
