// "Open on GitHub" (the Commit Graph's commit menu) and blame's "View in
// Browser" pick the remote from the repository's own, against real git.
//
// Both ran `git remote get-url origin`: a repository whose only remote is
// "upstream" was told "origin isn't a recognised GitHub/GitLab remote", and a
// branch tracking a fork opened the commit on origin, where it may not be.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { browseRemote, commitWebUrlIn } from "../src/util/remoteUrl";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-browse-remote-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

function repo(): { ctx: GitContext; git: (...a: string[]) => string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-browse-remote-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const ctx = new GitContext({ root: dir });
  cleanups.push(() => {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ctx, git, sha: git("rev-parse", "HEAD") };
}

/** A branch tracking `remote/main` without a fetch: the config git writes. */
function track(git: (...a: string[]) => string, remote: string): void {
  git("config", "branch.main.remote", remote);
  git("config", "branch.main.merge", "refs/heads/main");
}

test("the only remote is 'upstream': the commit opens there", async () => {
  const { ctx, git, sha } = repo();
  git("remote", "add", "upstream", "git@github.com:acme/tool.git");
  assert.deepEqual(await commitWebUrlIn(ctx, sha), { url: `https://github.com/acme/tool/commit/${sha}` });
});

test("a branch tracking a fork opens on the fork, not on origin", async () => {
  const { ctx, git, sha } = repo();
  git("remote", "add", "origin", "https://github.com/acme/tool.git");
  git("remote", "add", "mine", "https://github.com/me/tool.git");
  track(git, "mine");
  assert.deepEqual(await commitWebUrlIn(ctx, sha), { url: `https://github.com/me/tool/commit/${sha}` });
});

test("origin, with no upstream: origin, as before", async () => {
  const { ctx, git, sha } = repo();
  git("remote", "add", "backup", "/some/local/path.git");
  git("remote", "add", "origin", "https://gitlab.com/acme/tool.git");
  assert.deepEqual(await commitWebUrlIn(ctx, sha), { url: `https://gitlab.com/acme/tool/commit/${sha}` });
});

test("an upstream remote that is a local path: the next remote that can be linked to", async () => {
  const { ctx, git, sha } = repo();
  git("remote", "add", "local", "/srv/git/tool.git");
  git("remote", "add", "origin", "https://github.com/acme/tool.git");
  track(git, "local");
  assert.deepEqual(await commitWebUrlIn(ctx, sha), { url: `https://github.com/acme/tool/commit/${sha}` });
});

test("no remote, or none that can be linked to: it says which, and names no 'origin'", async () => {
  const bare = repo();
  assert.deepEqual(await commitWebUrlIn(bare.ctx, bare.sha), { reason: "this repository has no remote to open the commit on." });
  const local = repo();
  local.git("remote", "add", "upstream", "/srv/git/tool.git");
  const r = await commitWebUrlIn(local.ctx, local.sha);
  assert.ok("reason" in r);
  assert.match(r.reason, /no remote of this repository \(upstream\)/);
});

test("the order, without git", () => {
  const gh = (name: string) => ({ name, fetchUrl: `https://github.com/${name}/r.git` });
  assert.equal(browseRemote([gh("a"), gh("origin"), gh("b")], "b")?.name, "b");
  assert.equal(browseRemote([gh("a"), gh("origin")], undefined)?.name, "origin");
  assert.equal(browseRemote([gh("a"), gh("z")], undefined)?.name, "a", "git's order after those two");
  assert.equal(browseRemote([{ name: "origin", fetchUrl: "/x.git" }], undefined), undefined);
});
