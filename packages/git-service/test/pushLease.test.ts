// A force push leased on the remote tip the user last SAW.
//
// The extension's Sync fetches, and only then decides whether the branch was
// rewritten by us (`rewroteUpstream`). Its force push used the bare
// `--force-with-lease`, whose lease is the remote-tracking ref — which the
// fetch has just made equal to the remote. So the lease protected nothing, and
// whatever passed the rewrite test was overwritten. Two ordinary things pass it
// while being somebody else's work (both replayed through the real Sync door):
//
//   · the same person amended the same pushed commit on another machine and
//     pushed it first — same author, same author date, committed earlier;
//   · a colleague amended one of your pushed commits (a typo fixed in review)
//     — amending keeps YOUR author and author date.
//
// Sync offered "This branch was rewritten … Force push — replaces only the
// versions you rewrote", and accepting it deleted the other amendment from the
// remote. The tip read BEFORE the fetch is the lease that refuses both.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";

const trash: string[] = [];
const contexts: GitContext[] = [];

afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  for (const d of trash.splice(0)) removeTempRepo(d);
});

const AUTHORED = "1700000000 +0000";

function git(cwd: string, args: string[], committed?: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      ...(committed === undefined ? {} : { GIT_AUTHOR_DATE: AUTHORED, GIT_COMMITTER_DATE: `${committed} +0000` }),
    },
  });
}

function cloneAs(bare: string, prefix: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["clone", "-q", bare, dir], { stdio: "ignore" });
  git(dir, ["config", "user.name", name]);
  git(dir, ["config", "user.email", `${name.toLowerCase()}@example.com`]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "gc.auto", "0"]);
  trash.push(dir);
  return dir;
}

/** One pushed commit of mine, cloned onto a second machine of mine. */
function pushedTwice(): { bare: string; laptop: string; desktop: string; ctx: GitContext } {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-lease-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  trash.push(bare);
  const laptop = cloneAs(bare, "gitstudio-lease-laptop-", "Me");
  writeFileSync(join(laptop, "f.txt"), "v1\n");
  git(laptop, ["add", "f.txt"]);
  git(laptop, ["commit", "-q", "-m", "work in progress"], 1700000000);
  git(laptop, ["push", "-q", "-u", "origin", "main"]);
  const desktop = cloneAs(bare, "gitstudio-lease-desktop-", "Me");
  const ctx = new GitContext({ root: desktop });
  contexts.push(ctx);
  return { bare, laptop, desktop, ctx };
}

const remoteSubject = (bare: string): string => git(bare, ["log", "-1", "--format=%s", "main"]).trim();

test("a lease on the tip seen before the fetch refuses an amendment pushed from elsewhere", async () => {
  const { bare, laptop, desktop, ctx } = pushedTwice();
  // The same commit amended on the laptop, and pushed…
  git(laptop, ["commit", "-q", "--amend", "-m", "fixed on the laptop"], 1700000050);
  git(laptop, ["push", "-q", "--force", "origin", "main"]);
  // …then amended here, later.
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded on the desktop"], 1700000100);

  const seen = await ctx.sync.upstreamTip();
  assert.ok(seen, "the tip this clone last saw");
  assert.equal((await ctx.sync.fetch()).ok, true);
  assert.equal(await ctx.sync.rewroteUpstream(), true, "the premise: the rewrite test alone cannot tell");
  assert.notEqual(await ctx.sync.upstreamTip(), seen, "the fetch moved the remote-tracking ref");

  const leased = await ctx.sync.push({ force: true, lease: seen });
  assert.equal(leased.ok, false, "refused: the remote is not where it was when last seen");
  assert.equal(remoteSubject(bare), "fixed on the laptop", "the other amendment is still on the remote");

  // The bare lease is the one that deleted it — the behaviour this replaced.
  // A force with no lease of its own is now leased on the remote-tracking ref
  // and refused when that tip was never part of this branch (the fetch above
  // brought it in; forceIfIncludes.test.ts), so it cannot delete it either.
  const noLease = await ctx.sync.push({ force: true });
  assert.equal(noLease.ok, false);
  assert.equal(noLease.unseen, true);
  assert.equal(remoteSubject(bare), "fixed on the laptop");
});

test("a colleague's amendment of MY commit is refused the same way", async () => {
  const { bare, desktop, ctx } = pushedTwice();
  const colleague = cloneAs(bare, "gitstudio-lease-colleague-", "Colleague");
  git(colleague, ["commit", "-q", "--amend", "-m", "work in progress (typo fixed in review)"], 1700000050);
  git(colleague, ["push", "-q", "--force", "origin", "main"]);
  git(desktop, ["commit", "-q", "--amend", "-m", "work, reworded"], 1700000100);

  const seen = await ctx.sync.upstreamTip();
  await ctx.sync.fetch();
  assert.equal(await ctx.sync.rewroteUpstream(), true, "the premise: it keeps my author and author date");
  const r = await ctx.sync.push({ force: true, lease: seen ?? undefined });
  assert.equal(r.ok, false);
  assert.equal(remoteSubject(bare), "work in progress (typo fixed in review)");
});

test("a plain amend still force-pushes with the lease — the remote is where it was seen", async () => {
  const { bare, desktop, ctx } = pushedTwice();
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded"], 1700000100);
  const seen = await ctx.sync.upstreamTip();
  await ctx.sync.fetch();
  assert.equal(await ctx.sync.upstreamTip(), seen, "nothing new on the remote");
  const r = await ctx.sync.push({ force: true, lease: seen ?? undefined });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(remoteSubject(bare), "reworded");
});

test("the lease names the REMOTE branch when the local one was renamed", async () => {
  const { bare, desktop, ctx } = pushedTwice();
  git(desktop, ["branch", "-m", "main", "renamed-here"]);
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded, renamed"], 1700000100);
  const seen = await ctx.sync.upstreamTip();
  assert.ok(seen);
  const r = await ctx.sync.push({ force: true, lease: seen });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(remoteSubject(bare), "reworded, renamed", "the tracked remote branch moved");
  assert.throws(() => git(bare, ["rev-parse", "--verify", "--quiet", "refs/heads/renamed-here"]), "and no second branch");
});

test("a lease that is not a full sha is never put on the command line", async () => {
  const { bare, desktop, ctx } = pushedTwice();
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded"], 1700000100);
  const r = await ctx.sync.push({ force: true, lease: "main:HEAD --no-verify" });
  assert.equal(r.ok, true, "falls back to the remote-tracking tip as the lease, which holds here");
  assert.equal(remoteSubject(bare), "reworded");
});
