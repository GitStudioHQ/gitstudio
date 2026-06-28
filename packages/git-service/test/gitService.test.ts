import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitRecord } from "@gitstudio/host-bridge/git";
import { GitContext } from "../src/GitContext";

// A subject and body packed with characters the %x1f/%x1e framing must survive:
// pipes, double quotes, a literal tab, and (in the body) embedded newlines.
const TRICKY_SUBJECT = 'feat: a|b "q" \ttab';
const TRICKY_BODY = "line one\nline two with | pipe\n\nfinal \"quoted\" line";

let repo: string;
let ctx: GitContext;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
}

function commit(message: string): void {
  // -F - keeps multi-line / tricky messages exact (no shell quoting games).
  execFileSync("git", ["commit", "--allow-empty", "-F", "-"], {
    cwd: repo,
    input: message,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
  git(["add", name]);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-gs-"));

  // -c keeps identity/branch config local to this throwaway repo.
  execFileSync(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "init",
      repo,
    ],
    { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
  );
  git(["config", "user.email", "test@gitstudio.dev"]);
  git(["config", "user.name", "GitStudio Test"]);

  // main: c1 (root) -> c2 (tricky message)
  write("a.txt", "1\n");
  commit("c1: root");
  write("a.txt", "1\n2\n");
  commit(`${TRICKY_SUBJECT}\n\n${TRICKY_BODY}`);

  // feature diverges from main at c2, adds its own commit.
  git(["checkout", "-b", "feature"]);
  write("b.txt", "feature\n");
  commit("c3: feature work");

  // main advances independently.
  git(["checkout", "main"]);
  write("a.txt", "1\n2\n3\n");
  commit("c4: main work");

  // Merge feature into main -> a 2-parent merge commit.
  git(["merge", "--no-ff", "-m", "c5: merge feature", "feature"]);

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function collect(
  gen: AsyncGenerator<CommitRecord>,
): Promise<CommitRecord[]> {
  const out: CommitRecord[] = [];
  for await (const c of gen) {
    out.push(c);
  }
  return out;
}

test("streamCommits yields every commit on the merged history", async () => {
  const commits = await collect(ctx.log.streamCommits());
  // c1, c2, c3, c4, c5(merge) = 5 commits.
  assert.equal(commits.length, 5);

  // Every SHA is a full 40-char hex object name.
  for (const c of commits) {
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    assert.ok(Number.isFinite(c.authorDate));
    assert.ok(Number.isFinite(c.committerDate));
  }
});

test("the merge commit has two parents and all parents link up", async () => {
  const commits = await collect(ctx.log.streamCommits());
  const shas = new Set(commits.map((c) => c.sha));

  const merges = commits.filter((c) => c.parents.length === 2);
  assert.equal(merges.length, 1, "exactly one 2-parent merge commit");

  // Every referenced parent SHA exists in the streamed set (the root has none).
  for (const c of commits) {
    for (const parent of c.parents) {
      assert.ok(shas.has(parent), `parent ${parent} of ${c.sha} is present`);
    }
  }

  const roots = commits.filter((c) => c.parents.length === 0);
  assert.equal(roots.length, 1, "exactly one root commit");
});

test("a tricky subject and multi-line body round-trip exactly", async () => {
  const commits = await collect(ctx.log.streamCommits());
  const tricky = commits.find((c) => c.subject === TRICKY_SUBJECT);
  assert.ok(tricky, "found the commit with the tricky subject");
  assert.equal(tricky.subject, TRICKY_SUBJECT);
  // git stores the body without the trailing newline; compare trimmed-right.
  assert.equal(tricky.body.replace(/\n+$/, ""), TRICKY_BODY);
  assert.ok(tricky.body.includes("\n"), "body preserves embedded newlines");
});

test("parsed identity fields match the configured author", async () => {
  const commits = await collect(ctx.log.streamCommits());
  for (const c of commits) {
    assert.equal(c.author, "GitStudio Test");
    assert.equal(c.authorEmail, "test@gitstudio.dev");
    assert.equal(c.committer, "GitStudio Test");
    assert.equal(c.committerEmail, "test@gitstudio.dev");
  }
});

test("maxCount and skip page through the history", async () => {
  const all = await collect(ctx.log.streamCommits());

  const firstTwo = await collect(ctx.log.streamCommits({ maxCount: 2 }));
  assert.equal(firstTwo.length, 2);
  assert.deepEqual(
    firstTwo.map((c) => c.sha),
    all.slice(0, 2).map((c) => c.sha),
  );

  const skipped = await collect(
    ctx.log.streamCommits({ maxCount: 2, skip: 2 }),
  );
  assert.equal(skipped.length, 2);
  assert.deepEqual(
    skipped.map((c) => c.sha),
    all.slice(2, 4).map((c) => c.sha),
  );
});

test("listRefs reports main and feature heads with exactly one current", async () => {
  const refs = await ctx.refs.listRefs();

  const heads = refs.filter((r) => r.type === "head");
  const headNames = heads.map((r) => r.name).sort();
  assert.deepEqual(headNames, ["feature", "main"]);

  const current = heads.filter((r) => r.isCurrent);
  assert.equal(current.length, 1, "exactly one current head");
  assert.equal(current[0].name, "main");

  for (const h of heads) {
    assert.match(h.sha, /^[0-9a-f]{40}$/);
    assert.match(h.fullName, /^refs\/heads\//);
  }
});

test("getHead reports the current branch and sha", async () => {
  const head = await ctx.refs.getHead();
  assert.equal(head.detached, false);
  assert.equal(head.branch, "main");
  assert.match(head.sha, /^[0-9a-f]{40}$/);
});

test("run rejects with an AbortError when the signal is already aborted", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    () => ctx.process.run(["log"], { signal }),
    (err: Error) => {
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("run rejects with an AbortError when aborted while still running", async () => {
  // `cat-file --batch` reads object names from stdin and blocks, so the child
  // stays alive until we abort it — making this a deterministic in-flight kill.
  const controller = new AbortController();
  const pending = ctx.process.run(["cat-file", "--batch"], {
    signal: controller.signal,
  });
  // Abort on the next tick, after the child has been spawned.
  setImmediate(() => controller.abort());
  await assert.rejects(pending, (err: Error) => {
    assert.equal(err.name, "AbortError");
    return true;
  });
});

test("run resolves with a non-zero code instead of rejecting", async () => {
  const result = await ctx.process.run(["rev-parse", "definitely-not-a-ref"]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0);
});
