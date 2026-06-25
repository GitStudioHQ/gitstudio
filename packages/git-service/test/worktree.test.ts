import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { parseWorktreePorcelain } from "../src/WorktreeProvider";

let repo: string;
let ctx: GitContext;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-worktree-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(repo, "file.txt"), "hello\n");
  git(["add", "file.txt"]);
  git(["commit", "-m", "base"]);

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("list reports the main worktree", async () => {
  const list = await ctx.worktrees.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].path, git(["rev-parse", "--show-toplevel"]).trim());
  assert.equal(list[0].branch, "main");
  assert.ok(list[0].head.length >= 7);
});

test("add creates a linked worktree on a new branch, then list shows both", async () => {
  const wtPath = mkdtempSync(join(tmpdir(), "gitstudio-wt-linked-"));
  rmSync(wtPath, { recursive: true, force: true }); // git wants a non-existent path

  const added = await ctx.worktrees.add(wtPath, "feature", {
    newBranch: true,
  });
  assert.ok(added.ok, added.stderr);
  assert.ok(existsSync(join(wtPath, "file.txt")));

  const list = await ctx.worktrees.list();
  assert.equal(list.length, 2);
  // On macOS, tmpdir paths are symlink-resolved by git (/var -> /private/var),
  // so match on the branch rather than the exact path.
  const linked = list.find((w) => w.branch === "feature");
  assert.ok(linked, "linked worktree should be listed");
  assert.ok(linked!.path.endsWith(wtPath.split("/").pop()!));
});

test("remove deletes the linked worktree", async () => {
  const list = await ctx.worktrees.list();
  const linked = list.find((w) => w.branch === "feature");
  assert.ok(linked);

  const removed = await ctx.worktrees.remove(linked!.path, { force: true });
  assert.ok(removed.ok, removed.stderr);

  const after = await ctx.worktrees.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].branch, "main");

  rmSync(linked!.path, { recursive: true, force: true });
});

test("parseWorktreePorcelain handles bare, detached, locked, and prunable", () => {
  const sample =
    "worktree /repo\n" +
    "HEAD abc123\n" +
    "branch refs/heads/main\n" +
    "\n" +
    "worktree /repo/wt-detached\n" +
    "HEAD def456\n" +
    "detached\n" +
    "locked\n" +
    "\n" +
    "worktree /repo/wt-bare\n" +
    "bare\n" +
    "\n" +
    "worktree /repo/wt-gone\n" +
    "HEAD 000aaa\n" +
    "branch refs/heads/gone\n" +
    "prunable gitdir file points to non-existent location\n";

  const parsed = parseWorktreePorcelain(sample);
  assert.equal(parsed.length, 4);

  assert.deepEqual(parsed[0], {
    path: "/repo",
    head: "abc123",
    branch: "main",
  });
  assert.equal(parsed[1].path, "/repo/wt-detached");
  assert.equal(parsed[1].branch, undefined);
  assert.equal(parsed[1].locked, true);
  assert.equal(parsed[2].bare, true);
  assert.equal(parsed[3].prunable, true);
  assert.equal(parsed[3].branch, "gone");
});
