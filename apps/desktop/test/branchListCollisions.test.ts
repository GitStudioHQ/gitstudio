import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import { branchName, remoteRefParts, tagName, upstreamLabel, upstreamParts } from "../src/renderer/branchRequests";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// The Branches view's list when git's SHORT names are ambiguous (issue #30's
// follow-up, the state table's "branch+tag same name" and "branch with
// slashes" rows). Two collisions, both routine:
//
//   - a TAG named like the default branch ("main"). The default branch's
//     "merged" bar was `%(ahead-behind:main)` — a bare "main" is a revision,
//     and git resolves refs/tags/ before refs/heads/, so every branch was
//     measured against the TAG; and `isDefault` compared git's "heads/main"
//     with "main" and never matched.
//   - a LOCAL branch named "origin/sl" beside refs/remotes/origin/sl. git then
//     shortens the remote one to "remotes/origin/sl", and everything that split
//     an upstream's short name at its first slash named a remote "remotes":
//     "Pull into" and "Delete remote branch" failed.
//
// Real git throughout: the claim is what git resolves.

let upstream: string;
let repo: string;
let ctx: GitContext;
let bridge: GitBridge;
let slTip = "";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
const git = (...args: string[]): string => g(repo, ...args);
const commit = (file: string, msg: string): string => {
  writeFileSync(join(repo, file), msg + "\n");
  git("add", ".");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};

before(() => {
  upstream = mkdtempSync(join(tmpdir(), "gitstudio-blc-up-"));
  g(upstream, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "gitstudio-blc-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", upstream);
  commit("base.txt", "base");
  // A tag "main" on the base commit — BEHIND the branch main from here on.
  git("tag", "main");
  // feature is merged into the BRANCH main (fast-forward) but is ahead of the TAG.
  git("checkout", "-q", "-b", "feature");
  commit("f.txt", "feature work");
  git("checkout", "-q", "main");
  git("merge", "-q", "--ff-only", "feature");
  git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  git("remote", "set-head", "origin", "main");
  // sl on the remote, one commit ahead of a local sl that tracks it; and a
  // LOCAL branch literally called "origin/sl".
  git("checkout", "-q", "-b", "sl-src");
  const slBase = commit("sl.txt", "sl one");
  slTip = commit("sl.txt", "sl two");
  git("push", "-q", "origin", "refs/heads/sl-src:refs/heads/sl");
  git("fetch", "-q", "origin");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "sl-src");
  git("branch", "-q", "sl", slBase);
  git("branch", "-q", "--set-upstream-to=refs/remotes/origin/sl", "sl");
  git("branch", "-q", "origin/sl", "refs/heads/main");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

after(() => {
  ctx?.dispose();
  removeTempRepo(repo);
  removeTempRepo(upstream);
});

test("git really does list these under their disambiguated short names", async () => {
  const list = await bridge.branchesList();
  assert.equal(list.find((b) => b.fullName === "refs/heads/main")?.name, "heads/main");
  assert.equal(list.find((b) => b.fullName === "refs/heads/sl")?.upstream, "remotes/origin/sl");
});

test("the default branch beside a tag of its name is the default, and 'merged' is measured against the BRANCH", async () => {
  const list = await bridge.branchesList();
  const main = list.find((b) => b.fullName === "refs/heads/main");
  const feature = list.find((b) => b.fullName === "refs/heads/feature");
  assert.equal(main?.isDefault, true, "main is the default branch, tag of the same name notwithstanding");
  assert.equal(feature?.aheadDefault, 0, "feature is contained in the branch main (the tag main is behind it)");
  assert.equal(feature?.merged, true);
});

test("an upstream is split by its full name: remote 'origin', never 'remotes'", async () => {
  const list = await bridge.branchesList();
  const sl = list.find((b) => b.fullName === "refs/heads/sl");
  assert.ok(sl);
  assert.equal(sl.upstreamRef, "refs/remotes/origin/sl");
  assert.deepEqual(upstreamParts(sl), { remote: "origin", branch: "sl" }, "what Delete remote branch and the rename offer split");
  assert.equal(upstreamLabel(sl), "origin/sl", "and how the row names it");
});

test("Pull into a branch whose upstream's short name is ambiguous fast-forwards it", async () => {
  const r = await bridge.branchPullFf("refs/heads/sl");
  assert.equal(r.ok, true, `pulled: ${r.message ?? ""}`);
  assert.equal(git("rev-parse", "refs/heads/sl"), slTip, "fast-forwarded to the remote branch's tip");
  assert.equal(git("rev-parse", "refs/heads/origin/sl"), git("rev-parse", "refs/heads/main"), "the local origin/sl is untouched");
});

test("the renderer's names for these refs are the ones under their namespaces", () => {
  assert.equal(branchName({ name: "heads/main", fullName: "refs/heads/main" }), "main");
  assert.equal(tagName({ name: "tags/main", fullName: "refs/tags/main" }), "main");
  assert.deepEqual(remoteRefParts({ name: "remotes/origin/sl", fullName: "refs/remotes/origin/sl" }), { remote: "origin", branch: "sl" });
  assert.deepEqual(remoteRefParts({ name: "origin/feat/x", fullName: "refs/remotes/origin/feat/x" }), { remote: "origin", branch: "feat/x" });
  // A local upstream is not a remote branch to delete or rename on a remote.
  assert.equal(upstreamParts({ upstream: "main", upstreamRef: "refs/heads/main" }), undefined);
  assert.equal(upstreamParts({ upstream: "feature/y", upstreamRef: "refs/heads/feature/y" }), undefined);
  // A payload without the full name keeps the old split.
  assert.deepEqual(upstreamParts({ upstream: "origin/x" }), { remote: "origin", branch: "x" });
});
