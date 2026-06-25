import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

// A hermetic repo with a file edited across several commits, including a rename
// (old.txt -> doc.txt) so --follow gets exercised. We track line 2 separately so
// lineHistory can assert it only returns commits that touched that line.
let repo: string;
let ctx: GitContext;
let c1: string; // create old.txt (3 lines)
let c2: string; // edit line 2 of old.txt
let c3: string; // rename old.txt -> doc.txt
let c4: string; // append a line to doc.txt (does NOT touch line 2)

function git(args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
  });
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

function commit(message: string, date: string): string {
  git(["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(["rev-parse", "HEAD"]).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-history-"));

  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);

  // c1: create old.txt with three lines.
  write("old.txt", "alpha\nbeta\ngamma\n");
  git(["add", "old.txt"]);
  c1 = commit("create old.txt", "2021-01-01T00:00:00Z");

  // c2: edit line two only.
  write("old.txt", "alpha\nBETA EDITED\ngamma\n");
  git(["add", "old.txt"]);
  c2 = commit("edit line two", "2021-02-01T00:00:00Z");

  // c3: rename old.txt -> doc.txt (content unchanged).
  renameSync(join(repo, "old.txt"), join(repo, "doc.txt"));
  git(["add", "-A"]);
  c3 = commit("rename old.txt to doc.txt", "2021-03-01T00:00:00Z");

  // c4: append a fourth line — does not touch line two.
  write("doc.txt", "alpha\nBETA EDITED\ngamma\ndelta appended\n");
  git(["add", "doc.txt"]);
  c4 = commit("append delta", "2021-04-01T00:00:00Z");

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fileHistory returns the file's commits newest-first, following the rename", async () => {
  const entries = await ctx.history.fileHistory("doc.txt", { follow: true });

  // All four commits touched the file (through the rename).
  assert.deepEqual(
    entries.map((e) => e.sha),
    [c4, c3, c2, c1],
    "newest-first across the rename",
  );

  const head = entries[0];
  assert.equal(head.shortSha, c4.slice(0, 7));
  assert.equal(head.author, "Dev");
  assert.equal(head.authorEmail, "dev@example.com");
  assert.equal(head.subject, "append delta");
  assert.equal(head.path, "doc.txt");
  assert.ok(head.authorDate > 0, "authorDate is an epoch seconds number");
});

test("fileHistory respects maxCount", async () => {
  const entries = await ctx.history.fileHistory("doc.txt", { maxCount: 2 });
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.sha),
    [c4, c3],
  );
});

test("lineHistory returns only the commits that touched the given line range", async () => {
  // Line 2 was created in c1 and edited in c2. The rename (c3) and the append
  // (c4) leave line 2 untouched, so they must NOT appear.
  const entries = await ctx.history.lineHistory("doc.txt", 2, 2);
  const shas = entries.map((e) => e.sha);

  assert.ok(shas.includes(c2), "the commit that edited line two is present");
  assert.ok(shas.includes(c1), "the commit that created line two is present");
  assert.ok(!shas.includes(c4), "the append commit did not touch line two");

  // Newest-first ordering and the expected shape.
  assert.equal(entries[0].sha, c2);
  assert.equal(entries[0].shortSha, c2.slice(0, 7));
  assert.equal(entries[0].subject, "edit line two");
  assert.equal(entries[0].author, "Dev");
});

test("fileAtRevision returns the file's content at an older sha", async () => {
  // At c1 line two was the original "beta"; at HEAD it is "BETA EDITED".
  const atC1 = await ctx.history.fileAtRevision(c1, "old.txt");
  assert.equal(atC1, "alpha\nbeta\ngamma\n");

  const atHead = await ctx.history.fileAtRevision("HEAD", "doc.txt");
  assert.equal(atHead, "alpha\nBETA EDITED\ngamma\ndelta appended\n");
  assert.notEqual(atC1, atHead, "older content differs from HEAD");
});

test("fileAtRevision returns empty string when the file did not exist", async () => {
  // doc.txt did not exist at c1 (it was still old.txt).
  const missing = await ctx.history.fileAtRevision(c1, "doc.txt");
  assert.equal(missing, "");
});
