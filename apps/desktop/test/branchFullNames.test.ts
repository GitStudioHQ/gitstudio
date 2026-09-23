import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import { branchName, tagName } from "../src/renderer/branchRequests";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The Branches view's branch actions (issue #30's follow-up), on the desktop's
// main-process side. They took %(refname:short) — "heads/release" beside a
// tag "release" — and handed it to git: `git branch -m/-d heads/release` find
// no such branch, `git merge heads/release` records "Merge branch
// 'heads/release'", and a fetch into "heads/release" MAKES a branch of that
// name. Every op now takes the FULL name and refuses a request without one.
// Real git throughout: the claim is what git does with what it is handed.

let upstream: string;
let repo: string;
let ctx: GitContext;
let bridge: GitBridge;
let base = "";
let releaseTip = "";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
const git = (...args: string[]): string => g(repo, ...args);
const exists = (ref: string, cwd = repo): boolean => {
  try {
    g(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  // main ── base ── m1 (checked out); release ── r1 off base, tracking
  // origin/release; a TAG "release" on base, so the bare name is the tag.
  upstream = mkdtempSync(join(tmpdir(), "gitstudio-bfn-up-"));
  g(upstream, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "gitstudio-bfn-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", upstream);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD");
  git("tag", "release");
  git("checkout", "-q", "-b", "release");
  writeFileSync(join(repo, "r.txt"), "release work\n");
  git("add", ".");
  git("commit", "-q", "-m", "release work");
  releaseTip = git("rev-parse", "HEAD");
  git("push", "-q", "-u", "origin", "refs/heads/release:refs/heads/release");
  git("checkout", "-q", "main");
  writeFileSync(join(repo, "m.txt"), "main work\n");
  git("add", ".");
  git("commit", "-q", "-m", "main work");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  ctx?.dispose();
  removeTempRepo(repo);
  removeTempRepo(upstream);
});

test("the listed branch really is heads/release, and the renderer names it release", async () => {
  const listed = (await bridge.branchesList()).find((b) => b.fullName === "refs/heads/release");
  assert.ok(listed);
  assert.equal(listed.name, "heads/release", "git's short form");
  assert.equal(branchName(listed), "release", "what a person reads and what `git branch` takes");
  assert.equal(tagName({ name: "tags/release", fullName: "refs/tags/release" }), "release");
});

test("merge by full name merges the BRANCH and records \"Merge branch 'release'\"", async () => {
  const r = await bridge.branchMerge({ fullName: "refs/heads/release" });
  assert.equal(r.ok, true, r.message);
  assert.ok(git("log", "-1", "--format=%P").split(" ").includes(releaseTip), "the branch tip is a parent");
  assert.equal(git("log", "-1", "--format=%s"), "Merge branch 'release'");
});

test("rebase by full name lands on the BRANCH, not the tag", async () => {
  const r = await bridge.branchRebase({ fullName: "refs/heads/release" });
  assert.equal(r.ok, true, r.message);
  assert.equal(git("rev-parse", "HEAD~1"), releaseTip);
});

test("rename and set-upstream by full name act on the branch; undo renames it back by the new full name", async () => {
  const up = await bridge.branchSetUpstream({ fullName: "refs/heads/release", upstream: "origin/release" });
  assert.equal(up.ok, true, up.message);
  const mv = await bridge.branchRename({ fullName: "refs/heads/release", to: "release-2" });
  assert.equal(mv.ok, true, mv.message);
  assert.equal(exists("refs/heads/release-2"), true);
  assert.equal(exists("refs/heads/release"), false);
  // What the rename flow's undo sends.
  const back = await bridge.branchRename({ fullName: "refs/heads/release-2", to: "release" });
  assert.equal(back.ok, true, back.message);
  assert.equal(git("rev-parse", "refs/heads/release"), releaseTip);
  assert.equal(git("rev-parse", "refs/tags/release"), base, "the tag never moved");
});

test("delete by full name deletes the branch, and the undo restores it under its OWN name", async () => {
  const del = await bridge.branchDelete({ fullName: "refs/heads/release", force: true });
  assert.equal(del.ok, true, del.message);
  assert.equal(del.was, releaseTip, "the tip it deleted, for the undo");
  assert.equal(del.upstream, "origin/release");
  assert.equal(exists("refs/heads/release"), false);
  // The renderer restores by branchName — never the short "heads/release",
  // which would come back as a branch literally called that.
  const back = await bridge.branchCreate({ name: branchName({ name: "heads/release", fullName: "refs/heads/release" }), startPoint: del.was, upstream: del.upstream });
  assert.equal(back.ok, true, back.message);
  assert.equal(git("rev-parse", "refs/heads/release"), releaseTip);
  assert.equal(exists("refs/heads/heads/release"), false);
});

test("push and pull-without-checkout go by full name — no refs/heads/heads/release anywhere", async () => {
  git("checkout", "-q", "release");
  writeFileSync(join(repo, "r.txt"), "more\n");
  git("commit", "-q", "-am", "more release work");
  const tip = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  const push = await bridge.branchPush("refs/heads/release");
  assert.equal(push.ok, true, push.message);
  assert.equal(g(upstream, "rev-parse", "refs/heads/release"), tip, "the remote's release moved");
  assert.equal(exists("refs/heads/heads/release", upstream), false);
  // Rewind the local branch, then fast-forward it back from its upstream —
  // with the TAG "release" on the remote too: an unqualified
  // `fetch origin release:release` takes the remote's tag and is rejected
  // as a non-fast-forward of the branch.
  git("push", "-q", "origin", "refs/tags/release:refs/tags/release");
  git("update-ref", "refs/heads/release", releaseTip);
  git("fetch", "-q", "origin");
  const pull = await bridge.branchPullFf("refs/heads/release");
  assert.equal(pull.ok, true, pull.message);
  assert.equal(git("rev-parse", "refs/heads/release"), tip, "fast-forwarded");
  assert.equal(exists("refs/heads/heads/release"), false, "and no branch called heads/release was made");
});

test("every branch op REFUSES a short name — the door that forgets the full name fails loudly", async () => {
  const before = git("for-each-ref", "--format=%(refname) %(objectname)");
  const refusals = [
    await bridge.branchMerge({ fullName: "heads/release" }),
    await bridge.branchMerge({ fullName: "release" }),
    await bridge.branchRebase({ fullName: "heads/release" }),
    await bridge.branchRename({ fullName: "heads/release", to: "x" }),
    await bridge.branchSetUpstream({ fullName: "release", upstream: "origin/release" }),
    await bridge.branchDelete({ fullName: "heads/release", force: true }),
    await bridge.branchPush("heads/release"),
    await bridge.branchPullFf("heads/release"),
    // A tag is not a local branch, whatever it is called.
    await bridge.branchDelete({ fullName: "refs/tags/release", force: true }),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.match(r.message ?? "", /Couldn't tell which branch to .* — refresh and try again\./);
  }
  assert.equal(git("for-each-ref", "--format=%(refname) %(objectname)"), before, "nothing moved");
});

test("a branch named like an option: checkout says WHY and hands back the rename; the rename by full name works", async () => {
  git("update-ref", "refs/heads/-f", "HEAD~1");
  writeFileSync(join(repo, "m.txt"), "uncommitted\n");
  const r = await bridge.commitAction({
    action: "checkout-ref",
    sha: git("rev-parse", "HEAD~1"),
    name: "-f",
    refKind: "head",
    fullName: "refs/heads/-f",
  });
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /can't safely check out a branch whose name starts with "-"/);
  assert.doesNotMatch(r.message ?? "", /isn't a valid git reference/, "not the old, untrue refusal");
  assert.deepEqual(r.optionLike, { fullName: "refs/heads/-f", name: "-f", local: true });
  assert.equal(readFileSync(join(repo, "m.txt"), "utf8"), "uncommitted\n", "nothing was discarded");
  // What the toast's "Rename…" sends.
  const mv = await bridge.branchRename({ fullName: "refs/heads/-f", to: "fixed-f" });
  assert.equal(mv.ok, true, mv.message);
  assert.equal(exists("refs/heads/fixed-f"), true);
  assert.equal(exists("refs/heads/-f"), false);
  // A remote-tracking one is explained too, without a rename (not ours).
  git("update-ref", "refs/remotes/origin/-x", "HEAD");
  const rr = await bridge.commitAction({ action: "checkout-ref", sha: base, name: "origin/-x", refKind: "remote", fullName: "refs/remotes/origin/-x" });
  assert.equal(rr.ok, false);
  assert.equal(rr.optionLike?.local, false);
});

test("every renderer door sends branch ops by FULL name (source census)", () => {
  // The renderer's doors live in DOM code that cannot run here; the types
  // make `fullName` required, and this pins that it is the BRANCH's.
  const src = readFileSync(fileURLToPath(new URL("../src/renderer/renderer.ts", import.meta.url)), "utf8");
  const calls = [...src.matchAll(/host\.invoke\("branch:(merge|rebase|rename|setUpstream|delete|push|pullFf)", \{([^}]*)\}/g)];
  assert.ok(calls.length >= 10, `found ${calls.length} branch-op calls`);
  for (const [whole, , payload] of calls) {
    assert.match(payload, /fullName: (b|fresh|cur)\.fullName|fullName(,|\s*$)|fullName: `refs\/heads\/\$\{to\}`/, whole);
    assert.doesNotMatch(payload, /\bname: b\.name|: b\.name/, whole);
  }
  assert.doesNotMatch(src, /host\.invoke\("branch:rename", \{ from:/, "no rename by a short `from`");
});
