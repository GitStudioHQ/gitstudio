import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { UNCOMMITTED_SHA } from "../src/index";

// A hermetic repo: f.txt gets three lines from Alice, then Bob edits line two
// and appends two more, so blame must split attribution across two commits.
let repo: string;
let ctx: GitContext;
let aliceSha: string;
let bobSha: string;

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

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-blame-"));

  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });

  // Alice authors the first three lines.
  git(["config", "user.email", "alice@example.com"]);
  git(["config", "user.name", "Alice"]);
  write("f.txt", "line one\nline two\nline three\n");
  git(["add", "f.txt"]);
  git(["commit", "-m", "initial three lines"], {
    GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
  });
  aliceSha = git(["rev-parse", "HEAD"]).trim();

  // Bob edits line two and appends two lines.
  git(["config", "user.email", "bob@example.com"]);
  git(["config", "user.name", "Bob"]);
  write(
    "f.txt",
    "line one\nLINE TWO EDITED\nline three\nline four added\nline five added\n",
  );
  git(["add", "f.txt"]);
  git(["commit", "-m", "edit line two and append lines"], {
    GIT_AUTHOR_DATE: "2022-06-15T12:30:00Z",
    GIT_COMMITTER_DATE: "2022-06-15T12:30:00Z",
  });
  bobSha = git(["rev-parse", "HEAD"]).trim();

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("blameFile attributes each line to the right commit and author", async () => {
  const result = await ctx.blame.blameFile("f.txt");

  // 5 lines, one entry each, sorted by final line.
  assert.equal(result.lines.length, 5);
  assert.deepEqual(
    result.lines.map((l) => l.finalLine),
    [1, 2, 3, 4, 5],
  );

  const shaByLine = new Map(result.lines.map((l) => [l.finalLine, l.sha]));
  assert.equal(shaByLine.get(1), aliceSha, "line 1 is Alice's");
  assert.equal(shaByLine.get(2), bobSha, "line 2 was edited by Bob");
  assert.equal(shaByLine.get(3), aliceSha, "line 3 is Alice's");
  assert.equal(shaByLine.get(4), bobSha, "line 4 appended by Bob");
  assert.equal(shaByLine.get(5), bobSha, "line 5 appended by Bob");

  // Authors resolve through the commit map, including Bob's metadata-less
  // follow-up group (lines 4-5).
  const alice = result.commits.get(aliceSha)!;
  const bob = result.commits.get(bobSha)!;
  assert.equal(alice.author, "Alice");
  assert.equal(alice.authorMail, "alice@example.com");
  assert.equal(alice.isBoundary, true, "Alice's root commit is a boundary");
  assert.equal(bob.author, "Bob");
  assert.equal(bob.authorMail, "bob@example.com");
  assert.equal(bob.summary, "edit line two and append lines");
});

test("blameFile honours a specific revision", async () => {
  // At Alice's commit the file had only three lines, all hers.
  const result = await ctx.blame.blameFile("f.txt", { rev: aliceSha });
  assert.equal(result.lines.length, 3);
  for (const line of result.lines) {
    assert.equal(line.sha, aliceSha);
  }
});

test("dirty contents surface uncommitted lines as the zero-sha", async () => {
  // A dirty buffer: keep line one, change line two again, add a brand-new line.
  const dirty =
    "line one\nDIRTY UNCOMMITTED EDIT\nline three\nline four added\nline five added\nbrand new dirty line\n";
  const result = await ctx.blame.blameFile("f.txt", { contents: dirty });

  assert.equal(result.lines.length, 6);
  const shaByLine = new Map(result.lines.map((l) => [l.finalLine, l.sha]));

  // Line 1 still traces to Alice; the changed line 2 and the new line 6 are
  // "Not Committed Yet" (the zero-sha sentinel).
  assert.equal(shaByLine.get(1), aliceSha);
  assert.equal(shaByLine.get(2), UNCOMMITTED_SHA, "edited line is uncommitted");
  assert.equal(shaByLine.get(6), UNCOMMITTED_SHA, "new line is uncommitted");

  assert.ok(
    result.commits.has(UNCOMMITTED_SHA),
    "the uncommitted sentinel commit is present",
  );
});
