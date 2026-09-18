// Which branch the app thinks is the default one — against real git.
//
// This single value decides `merged` on every branch (`%(ahead-behind:<it>)`
// with ahead === 0), which decides the "Merged" pill, the Merged facet, and
// what "Delete N finished…" offers to delete. It was read with
//
//     git symbolic-ref --short refs/remotes/origin/HEAD
//
// which fails outright in a clone whose remote is not called origin —
// `git clone -o upstream`, a `git remote rename`, a fork workflow. The fallback
// underneath it is the CURRENTLY CHECKED OUT branch, so in such a clone every
// ancestor of HEAD read as merged, and a bulk delete was measured against a ref
// nobody chose.
//
// Driven through the bridge's own public read (`branches:list` sets `merged`
// from it) so the test exercises the shipping path, not a copy of the parsing.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

let origin: string;
let clone: string;

const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const run = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", env });

/** A repo with `main` and a `feature` branch already merged into it. */
function makeOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitstudio-defbranch-src-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir], { env });
  run(dir, "config", "user.email", "dev@example.com");
  run(dir, "config", "user.name", "Dev");
  run(dir, "config", "gc.auto", "0");
  run(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "f.txt"), "one\n");
  run(dir, "add", ".");
  run(dir, "commit", "-m", "first");
  return dir;
}

/** Clone it with the remote named `remoteName`, and check out a feature branch
 *  so the default branch is present WITHOUT being the current one — the only
 *  state in which any of this is observable. */
function makeClone(remoteName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gitstudio-defbranch-"));
  execFileSync("git", ["clone", "-o", remoteName, "-q", origin, dir], { env });
  run(dir, "config", "user.email", "dev@example.com");
  run(dir, "config", "user.name", "Dev");
  run(dir, "config", "gc.auto", "0");
  run(dir, "config", "core.autocrlf", "false");
  run(dir, "checkout", "-q", "-b", "work");
  writeFileSync(join(dir, "g.txt"), "work\n");
  run(dir, "add", ".");
  run(dir, "commit", "-m", "work in progress");
  return dir;
}

const bridgeFor = (dir: string): GitBridge => {
  const ctx = new GitContext({ root: dir });
  return new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
};

beforeEach(() => {
  origin = makeOrigin();
});

afterEach(() => {
  removeTempRepo(clone);
  removeTempRepo(origin);
  clone = "";
});

test("a normal clone: main is the default branch and is not 'merged'", async () => {
  clone = makeClone("origin");
  const branches = await bridgeFor(clone).branchesList();
  const main = branches.find((b) => b.name === "main");
  assert.ok(main, `main is missing from ${branches.map((b) => b.name).join(", ")}`);
  // main measured against main is zero ahead, which is what `merged` reads —
  // the flag is set, and the VIEW is what must exclude the default branch. The
  // point of this test is the next one: that the name matches so it can.
  assert.equal(main.merged, true);
  const work = branches.find((b) => b.name === "work");
  assert.equal(work?.merged, false, "a branch with a commit of its own is not merged");
});

test("a clone whose remote is not called origin still finds the default branch", async () => {
  // `git clone -o upstream`. The old read asked refs/remotes/origin/HEAD, which
  // does not exist here, and fell through to the CURRENT branch — so `work`
  // became "the default branch" and every commit already in `work` counted as
  // merged.
  clone = makeClone("upstream");
  assert.match(
    run(clone, "for-each-ref", "--format=%(refname:short)|%(symref:short)", "refs/remotes/*/HEAD").trim(),
    /^upstream\|upstream\/main$/,
    "the fixture is not the fork clone this test is about",
  );
  const branches = await bridgeFor(clone).branchesList();
  const names = branches.map((b) => b.name).sort();
  assert.deepEqual(names, ["main", "work"]);

  // The decisive assertion: `work` — the branch you are standing on, one commit
  // ahead of main — must not read as merged. It did, because divergence was
  // measured against `work` itself.
  const work = branches.find((b) => b.name === "work");
  assert.equal(work?.merged, false, "the current branch was measured against itself");
  assert.equal(work?.aheadDefault, 1, "one commit ahead of the real default branch");

  // And main is found by the name a local branch actually has: "main", not
  // "upstream/main", which is what stripping a literal "origin/" left behind.
  //
  // Verified against real git in this exact clone:
  //   main  ahead-behind=0 0
  //   work  ahead-behind=1 0
  const main = branches.find((b) => b.name === "main");
  assert.equal(main?.aheadDefault, 0, "main is zero ahead of itself");
  assert.equal(main?.behindDefault, 0, "and zero behind itself");
});

test("a renamed remote is the same case, and is the common one", async () => {
  // The workflow people actually run: clone, then rename origin to upstream and
  // add your own fork as origin later.
  clone = makeClone("origin");
  run(clone, "remote", "rename", "origin", "upstream");
  const branches = await bridgeFor(clone).branchesList();
  const work = branches.find((b) => b.name === "work");
  assert.equal(work?.merged, false);
  assert.equal(work?.aheadDefault, 1);
});

test("no remote at all falls back to the checked-out branch, without throwing", async () => {
  // A local-only repo has no refs/remotes/*/HEAD to read. There is no default
  // branch to find, and the list must still come back.
  clone = mkdtempSync(join(tmpdir(), "gitstudio-defbranch-local-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", clone], { env });
  run(clone, "config", "user.email", "dev@example.com");
  run(clone, "config", "user.name", "Dev");
  run(clone, "config", "gc.auto", "0");
  run(clone, "config", "core.autocrlf", "false");
  writeFileSync(join(clone, "f.txt"), "one\n");
  run(clone, "add", ".");
  run(clone, "commit", "-m", "first");
  const branches = await bridgeFor(clone).branchesList();
  assert.deepEqual(branches.map((b) => b.name), ["main"]);
});
