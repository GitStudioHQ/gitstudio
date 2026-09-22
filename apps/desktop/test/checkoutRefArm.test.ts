import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import { refCheckoutRequest } from "../src/renderer/refMenuItems";
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

test("a checkout-ref WITHOUT a full name is refused, and HEAD does not move", async () => {
  // The Branches view, the branch switcher and the ref page sent the short
  // name alone, and this arm ran `git checkout heads/release` for them: a
  // DETACHED HEAD at the branch tip, answered `ok: true`. Every door sends the
  // full name now, and a request without one is refused rather than guessed
  // at — so a door that forgets it fails loudly instead of detaching quietly.
  git("checkout", "-q", "main");
  const r = await bridge.commitAction({
    action: "checkout-ref",
    sha: "heads/release",
    name: "heads/release",
    refKind: "head",
  });
  assert.equal(r.ok, false, "refused");
  assert.match(r.message ?? "", /refresh/i, "and says what to do");
  assert.equal(symbolicHead(), "refs/heads/main", "HEAD did not move — let alone detach");
});

test("the Branches list carries each branch's full name beside the short one", async () => {
  const listed = await bridge.branchesList();
  const release = listed.find((b) => b.fullName === "refs/heads/release");
  assert.ok(release, "listed by its full name");
  assert.equal(release.name, "heads/release", "…while the name it shows is git's short form");
  for (const b of listed) assert.match(b.fullName, /^refs\/heads\//, `${b.name} has a full name`);
});

test("the request every Branches-view door builds, from that listing, lands ON the branch", async () => {
  git("checkout", "-q", "main");
  const release = (await bridge.branchesList()).find((b) => b.name === "heads/release")!;
  const r = await bridge.commitAction(refCheckoutRequest(release.fullName));
  assert.equal(r.ok, true, r.message);
  assert.equal(symbolicHead(), "refs/heads/release", "attached, beside the tag of the same name");
  assert.equal(git("rev-parse", "HEAD"), branchTip);
});

test("the remote doors (a remote row, the switcher's remotes) create the local branch tracking it", async () => {
  git("checkout", "-q", "main");
  // A remote of this very repository: origin/fix exists, a local fix does not.
  git("branch", "fix", "refs/heads/release");
  git("remote", "add", "self", repo);
  git("fetch", "-q", "self");
  git("branch", "-q", "-D", "fix");
  const r = await bridge.commitAction(refCheckoutRequest("refs/remotes/self/fix"));
  assert.equal(r.ok, true, r.message);
  assert.equal(symbolicHead(), "refs/heads/fix");
  assert.equal(git("rev-parse", "--abbrev-ref", "fix@{upstream}"), "self/fix");
  git("checkout", "-q", "main");
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
