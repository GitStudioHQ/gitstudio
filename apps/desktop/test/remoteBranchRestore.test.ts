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

// "Delete remote branch" is the one destructive action here that reaches other
// people, so its undo has to be real: the branch comes back on the REMOTE at
// the same commit, and it refuses rather than overwriting if somebody has
// re-made it in the meantime.
//
// Driven against a real bare remote — a fixture cannot tell you whether `git
// push <sha>:refs/heads/<name>` does what this claims.

let remote: string;
let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const onRemote = (...a: string[]): string =>
  execFileSync("git", a, { cwd: remote, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

beforeEach(() => {
  remote = mkdtempSync(join(tmpdir(), "gitstudio-remote-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", remote]);
  repo = mkdtempSync(join(tmpdir(), "gitstudio-remotebranch-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  git("remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "first");
  git("push", "-u", "origin", "main");
  git("checkout", "-q", "-b", "feature/x");
  writeFileSync(join(repo, "a.txt"), "two\n");
  git("commit", "-qam", "on the feature branch");
  git("push", "-u", "origin", "feature/x");
  git("checkout", "-q", "main");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  removeTempRepo(repo);
  removeTempRepo(remote);
});

test("a deleted remote branch can be pushed back to the same commit", async () => {
  const at = git("rev-parse", "refs/remotes/origin/feature/x").trim();

  const gone = await bridge.branchDeleteRemote({ remote: "origin", name: "feature/x" });
  assert.equal(gone.ok, true, gone.message);
  assert.equal(gone.was, at, "the delete reports where the branch was");
  assert.doesNotMatch(onRemote("branch", "--list"), /feature\/x/, "it is gone from the remote");

  const back = await bridge.branchRestoreRemote({ remote: "origin", name: "feature/x", sha: gone.was! });
  assert.equal(back.ok, true, back.message);
  assert.equal(onRemote("rev-parse", "refs/heads/feature/x").trim(), at, "back at the same commit");
});

test("restoring does not overwrite a branch somebody has re-made", async () => {
  const gone = await bridge.branchDeleteRemote({ remote: "origin", name: "feature/x" });
  // Somebody else pushes a different feature/x while the toast is still up.
  const theirs = git("rev-parse", "HEAD").trim();
  onRemote("update-ref", "refs/heads/feature/x", theirs);

  const back = await bridge.branchRestoreRemote({ remote: "origin", name: "feature/x", sha: gone.was! });
  assert.equal(back.ok, false, "the push is refused rather than forced");
  assert.equal(
    onRemote("rev-parse", "refs/heads/feature/x").trim(),
    theirs,
    "their branch is untouched",
  );
});

test("restoring refuses flag-shaped arguments", async () => {
  assert.equal(
    (await bridge.branchRestoreRemote({ remote: "--upload-pack=x", name: "a", sha: "HEAD" })).ok,
    false,
  );
  assert.equal(
    (await bridge.branchRestoreRemote({ remote: "origin", name: "--all", sha: "HEAD" })).ok,
    false,
  );
});
