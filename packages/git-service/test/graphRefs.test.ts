import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

// What counts as "history" for the commit graph.
//
// It used to be `git log --all`, which means every ref under refs/ — notes and
// the stash included. Note commits are dated when the note was written, carry no
// subject, and can outnumber the real history; this repository had 163 of them
// against 202 real commits. They sorted to the top of the graph as blank rows,
// and because skip-based paging counts positions in that list, a note written
// between two page reads shifted every later page and dropped a real commit into
// the gap. That was reported as "the graph silently omits a commit".

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

const shas = async (): Promise<string[]> => {
  const out: string[] = [];
  for await (const c of ctx.log.streamCommits({ revRange: "--all" })) out.push(c.sha);
  return out;
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-graphrefs-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    git("add", ".");
    git("commit", "-m", `c${i}`);
  }
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

test("THE BUG: a git note does not add a row to the graph", async () => {
  const before = await shas();
  git("notes", "--ref=ai", "add", "-m", "some annotation", "HEAD");
  const after = await shas();

  assert.deepEqual(after, before, "writing a note must not change the history shown");
});

test("many notes do not swamp the history", async () => {
  const before = await shas();
  for (let i = 0; i < 3; i++) {
    git("notes", "--ref=ai", "add", "-m", `note ${i}`, before[i]);
  }
  const after = await shas();
  assert.equal(after.length, before.length, `${after.length} rows for ${before.length} commits`);
});

test("a note written BETWEEN two pages does not shift the second one", async () => {
  // The reported symptom, reproduced directly: page, annotate, page again.
  const page = async (skip: number, n: number): Promise<string[]> => {
    const out: string[] = [];
    for await (const c of ctx.log.streamCommits({ revRange: "--all", skip, maxCount: n })) {
      out.push(c.sha);
    }
    return out;
  };
  const truth = await shas();

  const first = await page(0, 2);
  git("notes", "--ref=ai", "add", "-m", "written mid-scroll", truth[0]);
  const second = await page(2, 2);

  assert.deepEqual([...first, ...second], truth, "every commit paged in exactly once");
});

test("the stash is not history either", async () => {
  const before = await shas();
  writeFileSync(join(repo, "f0.txt"), "dirty\n");
  git("stash", "push", "-m", "wip");
  assert.match(git("stash", "list"), /wip/, "sanity: a stash really exists");

  assert.deepEqual(await shas(), before, "a stash must not appear as a commit");
});

test("a DETACHED head is still shown — the commit you are sitting on", async () => {
  // --branches/--tags/--remotes do not cover a detached HEAD, so dropping it
  // would trade one missing-commit bug for another.
  git("checkout", "--detach", "HEAD~1");
  writeFileSync(join(repo, "extra.txt"), "x\n");
  git("add", ".");
  git("commit", "-m", "work on a detached head");
  const head = git("rev-parse", "HEAD").trim();

  assert.ok((await shas()).includes(head), "the detached commit must be in the graph");
});

test("branches, tags and remotes are all still included", async () => {
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "side.txt"), "s\n");
  git("add", ".");
  git("commit", "-m", "on a side branch");
  const sideTip = git("rev-parse", "HEAD").trim();
  git("tag", "v1", "HEAD~1");
  git("checkout", "-q", "main");

  const all = await shas();
  assert.ok(all.includes(sideTip), "a commit on another branch is history");
  assert.ok(all.includes(git("rev-parse", "v1^{commit}").trim()), "a tagged commit is history");
});
