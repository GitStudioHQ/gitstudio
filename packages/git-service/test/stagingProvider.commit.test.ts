import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitProcess, type GitRunResult, type GitRunWithInputOptions } from "../src/GitProcess";
import { StagingProvider, commitBlockerMessage } from "../src/StagingProvider";
import { makeRepo, type Repo } from "./opRepo";

// commit()'s options as the commit box sends them, and the counts the box
// shows — each read back from the commit git actually wrote.

function repo(name: string): Repo {
  const r = makeRepo(name);
  r.write("a.txt", "a\n");
  r.commitAll("base");
  return r;
}

const shellHooks = process.platform === "win32" ? "the hook is a POSIX shell script" : false;

test("commit with an author override records that author, and the configured committer", async () => {
  const r = repo("commit-author");
  try {
    r.write("a.txt", "b\n");
    r.git("add", "a.txt");
    const res = await r.ctx().staging.commit("by someone else", { author: "Jane Roe <jane@example.com>" });
    assert.equal(res.ok, true, res.stderr);
    assert.equal(r.git("log", "-1", "--format=%an <%ae>|%cn|%s").trim(), "Jane Roe <jane@example.com>|Dev|by someone else");
  } finally {
    r.cleanup();
  }
});

test("amend with an empty message keeps the previous message and folds in the staged change", async () => {
  const r = repo("commit-amend-reuse");
  try {
    r.write("b.txt", "b\n");
    r.git("add", "b.txt");
    r.git("commit", "-q", "-m", "keep this subject\n\nand this body");
    r.write("c.txt", "c\n");
    r.git("add", "c.txt");
    const res = await r.ctx().staging.commit("  \n", { amend: true });
    assert.equal(res.ok, true, res.stderr);
    assert.equal(r.git("log", "-1", "--format=%B").trim(), "keep this subject\n\nand this body");
    assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "2", "amended, not a new commit");
    assert.deepEqual(r.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["b.txt", "c.txt"]);
  } finally {
    r.cleanup();
  }
});

test("a pre-commit hook that refuses stops the commit — and noVerify skips it", { skip: shellHooks }, async () => {
  const r = repo("commit-noverify");
  try {
    const hook = join(r.root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    r.write("a.txt", "changed\n");
    r.git("add", "a.txt");
    const staging = r.ctx().staging;

    const refused = await staging.commit("blocked");
    assert.equal(refused.ok, false);
    assert.match(refused.stderr, /hook says no/, "the hook's own words reach the caller");
    assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "1");

    const skipped = await staging.commit("past the hook", { noVerify: true });
    assert.equal(skipped.ok, true, skipped.stderr);
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "past the hook");
  } finally {
    r.cleanup();
  }
});

test("a multi-line message with shell-hostile characters is committed byte for byte", async () => {
  const r = repo("commit-message");
  try {
    r.write("a.txt", "z\n");
    r.git("add", "a.txt");
    const msg = "fix: `rm -rf $HOME` && \"quotes\" 'single'\n\nbody; line | two\n-- not an option";
    const res = await r.ctx().staging.commit(msg, { signoff: true, amend: false, noVerify: false });
    assert.equal(res.ok, true, res.stderr);
    const body = r.git("log", "-1", "--format=%B").trim();
    assert.ok(body.startsWith(msg), body);
    assert.match(body, /Signed-off-by: Dev <dev@example\.com>$/);
  } finally {
    r.cleanup();
  }
});

/** A real git, except `diff --name-only` (the unstaged listing) fails. */
class NoUnstagedListing extends GitProcess {
  override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
    if (args[0] === "diff" && !args.includes("--cached")) return { code: 128, stdout: "junk\0more\0", stderr: "fatal" };
    return super.run(args, opts);
  }
}

test("a failed listing counts as zero, never as changes: untracked-only is still told apart", async () => {
  const r = repo("blocker-failed-listing");
  try {
    r.write("a.txt", "edited but unreadable\n");
    r.write("new.txt", "n\n");
    const staging = new StagingProvider(new NoUnstagedListing({ cwd: r.root }));
    assert.equal(await staging.whyNothingToCommit(), "untrackedOnly", "the failed listing's stdout was not counted");
  } finally {
    r.cleanup();
  }
});

test("stagedCount is 0 when git cannot answer, and whyNothingToCommit is undefined once something is staged", async () => {
  const r = repo("staged-count");
  try {
    const failing = new StagingProvider(
      new (class extends GitProcess {
        override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
          if (args.includes("--cached")) return { code: 128, stdout: "x\0y\0", stderr: "fatal" };
          return super.run(args, opts);
        }
      })({ cwd: r.root }),
    );
    r.write("a.txt", "staged\n");
    r.git("add", "a.txt");
    assert.equal(await failing.stagedCount(), 0);
    const real = r.ctx().staging;
    assert.equal(await real.stagedCount(), 1);
    assert.equal(await real.whyNothingToCommit(), undefined, "something WAS staged: not a nothing-to-commit case");
  } finally {
    r.cleanup();
  }
});

test("each blocker has its own sentence", () => {
  const all = (["unstagedChanges", "untrackedOnly", "cleanTree"] as const).map(commitBlockerMessage);
  assert.equal(new Set(all).size, 3);
  assert.match(commitBlockerMessage("cleanTree"), /clean/);
  assert.match(commitBlockerMessage("untrackedOnly"), /track/);
});
