import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { branchActionWords, branchesPayload } from "../src/changes/branchMenuData";

// What the Changes view's branch menu is sent, from what real git lists: a
// branch whose upstream was deleted from the remote (what a merged pull
// request leaves behind) is marked gone, so its row does not name that
// upstream as if it were live — git's "[gone]" used to be dropped here.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-bmd-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

let up: string;
let repo: string;
let ctx: GitContext;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  up = mkdtempSync(join(tmpdir(), "gs-ext-bmd-up-"));
  git(up, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "gs-ext-bmd-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "gc.auto", "0");
  git(repo, "remote", "add", "origin", up);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  for (const b of ["merged-pr", "live"]) {
    git(repo, "branch", b);
    git(repo, "push", "-q", "-u", "origin", `refs/heads/${b}:refs/heads/${b}`);
  }
  // The pull request was merged and its branch deleted on the remote.
  git(repo, "push", "-q", "origin", "--delete", "refs/heads/merged-pr");
  ctx = new GitContext({ root: repo });
});
after(() => {
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(up, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("a branch whose upstream was deleted from the remote is sent as gone; a live one is not", async () => {
  const menu = branchesPayload(await ctx.refs.listRefs(), [], []);
  const row = (name: string) => menu.local.find((b) => b.name === name);
  assert.equal(row("merged-pr")?.upstream, "origin/merged-pr", "it still names what it tracked");
  assert.equal(row("merged-pr")?.gone, true, "and says that is gone");
  assert.equal(row("merged-pr")?.upstreamOnRemote, false, "so there is nothing to reset it to");
  for (const live of ["main", "live"]) {
    assert.ok(!row(live)?.gone, `${live}'s upstream is there: ${JSON.stringify(row(live))}`);
    assert.equal(row(live)?.upstreamOnRemote, true);
  }
});

// The menu groups remote branches by remote, and a remote's name may hold a
// slash: "team/eu/feature" is team/eu's feature, which no split at the first
// slash can tell. So the remotes are sent by name — every one, including one
// whose URL holds a space, which `git remote -v` cannot delimit.
test("the remotes are sent by name: one whose name holds a slash, one whose URL holds a space", async () => {
  const eu = mkdtempSync(join(tmpdir(), "gs ext bmd eu "));
  try {
    git(eu, "init", "-q", "--bare", "-b", "main");
    git(repo, "remote", "add", "team/eu", eu);
    git(repo, "push", "-q", "team/eu", "refs/heads/main:refs/heads/feature");
    git(repo, "fetch", "-q", "team/eu");
    const names = await ctx.remotes.names();
    assert.deepEqual([...names].sort(), ["origin", "team/eu"]);
    assert.ok(!(await ctx.remotes.list()).some((r) => r.name === "team/eu"), "(`remote -v` loses it, as this is about)");
    const menu = branchesPayload(await ctx.refs.listRefs(), [], [], names);
    assert.deepEqual([...(menu.remoteNames ?? [])].sort(), ["origin", "team/eu"]);
    assert.ok(menu.remote.includes("team/eu/feature"), menu.remote.join(" | "));
  } finally {
    git(repo, "remote", "remove", "team/eu");
    rmSync(eu, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a branch action is named as the menu names it: Pull, not 'Update (pull)'", () => {
  assert.equal(branchActionWords("pull"), "Pull");
  assert.equal(branchActionWords("checkoutRef", "-f"), "Checkout '-f'");
});
