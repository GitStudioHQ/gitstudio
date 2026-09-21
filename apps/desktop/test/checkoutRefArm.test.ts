import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The graph's "Checkout <ref>" — the row's commit menu and the chip's own
// menu — reaches this arm with the ref's FULL name now. It used to run
// `git checkout <name>` with the chip's short name, and with a tag and a
// branch both called "release" that name is "heads/release": a revision, not
// a branch, so HEAD detached at the branch tip under a "changed: true".
// Driven against real git, because the claim is about what git does.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;
let branchTip = "";
let tagTip = "";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-checkoutref-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  git("branch", "release");
  branchTip = git("rev-parse", "refs/heads/release");
  writeFileSync(join(repo, "f.txt"), "two\n");
  git("commit", "-q", "-am", "two");
  git("tag", "release");
  tagTip = git("rev-parse", "refs/tags/release");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

after(() => {
  ctx?.dispose();
  removeTempRepo(repo);
});

const symbolicHead = (): string => {
  try {
    return git("symbolic-ref", "-q", "HEAD");
  } catch {
    return "";
  }
};

test("git's short name for the branch is heads/release here", () => {
  assert.equal(git("for-each-ref", "--format=%(refname:short)", "refs/heads/release"), "heads/release");
});

test("a branch checkout by full name lands ON the branch, beside a tag of the same name", async () => {
  git("checkout", "-q", "main");
  const r = await bridge.commitAction({
    action: "checkout-ref",
    sha: branchTip,
    name: "heads/release",
    refKind: "head",
    fullName: "refs/heads/release",
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(symbolicHead(), "refs/heads/release", "attached to the branch");
  assert.equal(git("rev-parse", "HEAD"), branchTip);
});

test("a tag checkout by full name detaches at the TAG, not at the branch", async () => {
  git("checkout", "-q", "main");
  const r = await bridge.commitAction({
    action: "checkout-ref",
    sha: tagTip,
    name: "tags/release",
    refKind: "tag",
    fullName: "refs/tags/release",
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(symbolicHead(), "", "detached — a tag is a fixed point");
  assert.equal(git("rev-parse", "HEAD"), tagTip);
});

test("a full name outside the three namespaces is refused, not guessed at", async () => {
  git("checkout", "-q", "main");
  const r = await bridge.commitAction({
    action: "checkout-ref",
    sha: branchTip,
    name: "release",
    refKind: "head",
    fullName: "release",
  });
  assert.equal(r.ok, false);
  assert.equal(symbolicHead(), "refs/heads/main", "and HEAD did not move");
});
