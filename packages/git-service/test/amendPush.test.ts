import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

// Amending a commit that was ALREADY PUSHED, then pushing again.
//
// The reported bug: "amending a commit is broken, I tried changing the commit
// message and it failed to push." The amend was never the problem — rewriting
// HEAD leaves the branch ahead 1 / behind 1, and git then refuses a plain push
// as non-fast-forward. Every push route in the Changes view called
// `sync.push()` with no options, so it could only ever be rejected, while the
// modal told the user to "pull first" — which after an amend either resurrects
// the pre-amend commit (merge) or silently discards the fix (rebase).
//
// The first test here is the one that would have caught it.

let bare: string;
let clone: string;
let ctx: GitContext;

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV });
}
const clik = (args: string[]) => gitIn(clone, args);

function commitIn(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  gitIn(cwd, ["add", name]);
  gitIn(cwd, ["commit", "-m", msg]);
}

/** Subjects on the bare "remote", newest first. */
function remoteLog(): string[] {
  return gitIn(bare, ["log", "--format=%s", "main"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function identify(dir: string): void {
  gitIn(dir, ["config", "user.email", "dev@example.com"]);
  gitIn(dir, ["config", "user.name", "Dev"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
}

before(() => {
  bare = mkdtempSync(join(tmpdir(), "gitstudio-am-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { env: ENV });

  const seed = mkdtempSync(join(tmpdir(), "gitstudio-am-seed-"));
  execFileSync("git", ["clone", bare, seed], { env: ENV });
  identify(seed);
  commitIn(seed, "file.txt", "base\n", "base");
  gitIn(seed, ["push", "origin", "main"]);
  rmSync(seed, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

  clone = mkdtempSync(join(tmpdir(), "gitstudio-am-clone-"));
  execFileSync("git", ["clone", bare, clone], { env: ENV });
  identify(clone);
  ctx = new GitContext({ root: clone });
});

after(() => {
  ctx?.dispose();
  for (const dir of [bare, clone]) {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** A published commit on main, ready to be amended. Remote and local in sync. */
beforeEach(() => {
  clik(["checkout", "-q", "main"]);
  clik(["fetch", "-q", "origin"]);
  clik(["reset", "-q", "--hard", "origin/main"]);
  // Trim the remote back to the single base commit so each test starts level.
  const subjects = remoteLog();
  if (subjects.length > 1) {
    clik(["reset", "-q", "--hard", `HEAD~${subjects.length - 1}`]);
    clik(["push", "-q", "--force", "origin", "main"]);
  }
  commitIn(clone, "work.txt", "one\n", "add feture");
  clik(["push", "-q", "origin", "main"]);
});

test("a plain push after amending a PUSHED commit is refused", async () => {
  // The bug, stated as a test. Before the fix this is what every push button in
  // the Changes view did, with no way to get past it.
  clik(["commit", "-q", "--amend", "-m", "add feature"]);

  const r = await ctx.sync.push();
  assert.equal(r.ok, false, "git must refuse to fast-forward over a rewrite");
  assert.match(
    r.stderr,
    /non-fast-forward|fetch first|behind its remote/i,
    `expected a fast-forward rejection, got: ${r.stderr}`,
  );
  assert.deepEqual(remoteLog()[0], "add feture", "the remote still has the typo");
});

test("force-with-lease pushes the amended commit, replacing the old one", async () => {
  clik(["commit", "-q", "--amend", "-m", "add feature"]);

  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, true, `force push should succeed: ${r.stderr}`);

  const log = remoteLog();
  assert.equal(log[0], "add feature", "remote now carries the corrected message");
  assert.equal(
    log.filter((s) => s === "add feture").length,
    0,
    "and the typo commit is gone, not sitting beside it",
  );
});

test("an UNPUSHED commit still pushes plainly — we do not force needlessly", async () => {
  // Guards the other direction: needsForce must not latch on for an ordinary
  // amend of local work, or every push becomes a force push.
  commitIn(clone, "local.txt", "two\n", "local only");
  clik(["commit", "-q", "--amend", "-m", "local only, amended"]);

  const r = await ctx.sync.push();
  assert.equal(r.ok, true, `a fast-forward push must still work: ${r.stderr}`);
  assert.equal(remoteLog()[0], "local only, amended");
});

test("the lease refuses when someone else pushed — their work survives", async () => {
  // The property that makes offering this button acceptable at all.
  const other = mkdtempSync(join(tmpdir(), "gitstudio-am-other-"));
  try {
    execFileSync("git", ["clone", bare, other], { env: ENV });
    identify(other);
    commitIn(other, "theirs.txt", "theirs\n", "colleague work");
    gitIn(other, ["push", "origin", "main"]);

    // We amend without ever seeing their commit.
    clik(["commit", "-q", "--amend", "-m", "add feature"]);

    const r = await ctx.sync.push({ force: true });
    assert.equal(r.ok, false, "the lease must refuse when the remote moved");
    assert.match(r.stderr, /stale info|rejected/i, `got: ${r.stderr}`);
    assert.ok(
      remoteLog().includes("colleague work"),
      "the colleague's commit must still be on the remote",
    );
  } finally {
    rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("ahead+behind is what tells us a plain push cannot work", async () => {
  // The predicate the UI uses (needsForce). It is purely local — no fetch — so
  // the modal can decide before offering a button that cannot succeed.
  const before = await ctx.sync.aheadBehind();
  assert.equal(before.ahead, 0);
  assert.equal(before.behind, 0);

  clik(["commit", "-q", "--amend", "-m", "add feature"]);

  const after = await ctx.sync.aheadBehind();
  assert.ok(
    after.ahead > 0 && after.behind > 0,
    `an amend of a pushed commit diverges both ways, got ${JSON.stringify(after)}`,
  );
});
