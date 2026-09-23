// Every force push is leased on the tip the user last saw — and never on one
// this branch has not had.
//
// A lease is only as good as its expected value. The bare `--force-with-lease`
// takes the remote-tracking ref, and so does an explicit lease read from it:
// both are whatever the last fetch left there. A BACKGROUND fetch — the
// editor's autofetch, the app's, a terminal's — sets that ref to the same
// commit amended on another machine without anybody looking at it. Amend here,
// press Force push, and the lease is satisfied: the other amendment is deleted
// from the remote. git's answer is `--force-if-includes` (2.30+): refuse unless
// the remote-tracking tip is reachable from the local branch's reflog. But git
// IGNORES it beside an explicit `<ref>:<sha>` — replayed against git 2.49 below
// — so SyncOps.push makes the same check itself, and passes the flag where git
// has it.
//
// Real repositories throughout: this is git's behaviour we depend on.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { gitHasForceIfIncludes, pushUnseenMessage } from "../src/SyncOps";

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

/**
 * A base commit and one pushed commit of mine on top of it, cloned onto a
 * second machine of mine. `ctx` drives the second machine, as the app would.
 */
function twoMachines(): { bare: string; laptop: string; desktop: string; ctx: GitContext } {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-fii-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  trash.push(bare);
  const laptop = cloneAs(bare, "gitstudio-fii-laptop-", "Me");
  writeFileSync(join(laptop, "base.txt"), "base\n");
  git(laptop, ["add", "base.txt"]);
  git(laptop, ["commit", "-q", "-m", "base"], 1699999000);
  writeFileSync(join(laptop, "f.txt"), "v1\n");
  git(laptop, ["add", "f.txt"]);
  git(laptop, ["commit", "-q", "-m", "work in progress"], 1700000000);
  git(laptop, ["push", "-q", "-u", "origin", "main"]);
  const desktop = cloneAs(bare, "gitstudio-fii-desktop-", "Me");
  const ctx = new GitContext({ root: desktop });
  contexts.push(ctx);
  return { bare, laptop, desktop, ctx };
}

const remoteSubject = (bare: string): string => git(bare, ["log", "-1", "--format=%s", "main"]).trim();

/** Record every argv SyncOps hands git, and optionally answer `git version`. */
function spy(ctx: GitContext, version?: string): string[][] {
  const calls: string[][] = [];
  const proc = ctx.process;
  const run = proc.run.bind(proc);
  proc.run = async (args, opts) => {
    calls.push(args);
    if (version !== undefined && args[0] === "version") {
      return { code: 0, stdout: `${version}\n`, stderr: "" };
    }
    return run(args, opts);
  };
  return calls;
}

test("a same-author amend fetched in the background is NOT overwritten by a force push", async () => {
  const { bare, laptop, desktop, ctx } = twoMachines();
  // The laptop amends the pushed commit, and pushes it…
  git(laptop, ["commit", "-q", "--amend", "-m", "fixed on the laptop"], 1700000050);
  git(laptop, ["push", "-q", "--force", "origin", "main"]);
  // …the desktop's editor fetches in the background — nobody looks…
  git(desktop, ["fetch", "-q", "origin"]);
  // …and the desktop amends its own copy, later.
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded on the desktop"], 1700000100);

  // The premise: nothing else can tell this from an amend of your own.
  assert.equal(await ctx.sync.rewroteUpstream(), true, "same author, same author date, committed later");
  const ab = await ctx.sync.aheadBehind();
  assert.deepEqual([ab.ahead, ab.behind], [1, 1]);

  // The door with no lease of its own (the desktop's Commit & Push → Force push).
  const plain = await ctx.sync.push({ force: true });
  assert.equal(plain.ok, false, "refused");
  assert.equal(plain.unseen, true, "…as a tip this branch never had, before anything ran");
  assert.equal(remoteSubject(bare), "fixed on the laptop", "the other amendment is still on the remote");

  // A door that read "the tip it last saw" AFTER the background fetch (Sync,
  // pressed once the editor had already fetched) is refused the same way.
  const seen = await ctx.sync.upstreamTip();
  assert.ok(seen);
  const leased = await ctx.sync.push({ force: true, lease: seen });
  assert.equal(leased.ok, false);
  assert.equal(leased.unseen, true);
  assert.equal(remoteSubject(bare), "fixed on the laptop");

  // The question a door asks before it offers the force says the same.
  assert.equal(await ctx.sync.upstreamUnseen(), true);
  assert.match(pushUnseenMessage(), /never had/);
  assert.match(pushUnseenMessage(), /Pull them in first/);
});

test("git itself does not refuse it: an explicit lease makes --force-if-includes a no-op", async () => {
  // Why the check is the engine's own. The same state, pushed by hand with
  // exactly what a naive "explicit lease AND --force-if-includes" would send.
  const { bare, laptop, desktop } = twoMachines();
  git(laptop, ["commit", "-q", "--amend", "-m", "fixed on the laptop"], 1700000050);
  git(laptop, ["push", "-q", "--force", "origin", "main"]);
  git(desktop, ["fetch", "-q", "origin"]);
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded on the desktop"], 1700000100);
  const tip = git(desktop, ["rev-parse", "origin/main"]).trim();
  git(desktop, ["push", "-q", `--force-with-lease=refs/heads/main:${tip}`, "--force-if-includes", "origin", "HEAD:refs/heads/main"]);
  assert.equal(remoteSubject(bare), "reworded on the desktop", "git overwrote the other amendment");
});

test("an ordinary rewrite of my own pushed commit still force-pushes", async () => {
  const { bare, desktop, ctx } = twoMachines();
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded"], 1700000100);
  assert.equal(await ctx.sync.upstreamUnseen(), false, "the tip it replaces is in this branch's reflog");
  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, true, r.stderr);
  assert.ok(!r.unseen);
  assert.equal(remoteSubject(bare), "reworded");
});

test("…and so does one leased on the tip read before a fetch, as Sync does", async () => {
  const { bare, desktop, ctx } = twoMachines();
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded"], 1700000100);
  const seen = await ctx.sync.upstreamTip();
  assert.equal((await ctx.sync.fetch()).ok, true);
  const r = await ctx.sync.push({ force: true, lease: seen ?? undefined });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(remoteSubject(bare), "reworded");
});

test("a rewrite made after pulling the other amendment in is pushed — it was seen", async () => {
  const { bare, laptop, desktop, ctx } = twoMachines();
  git(laptop, ["commit", "-q", "--amend", "-m", "fixed on the laptop"], 1700000050);
  git(laptop, ["push", "-q", "--force", "origin", "main"]);
  git(desktop, ["fetch", "-q", "origin"]);
  // Taken in — the branch now HAS the laptop's version — then amended again.
  git(desktop, ["reset", "-q", "--hard", "origin/main"]);
  git(desktop, ["commit", "-q", "--amend", "-m", "fixed on the laptop, then here"], 1700000200);
  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(remoteSubject(bare), "fixed on the laptop, then here");
});

test("a push that lands after the last fetch is still refused by the lease itself", async () => {
  // Nothing fetched, so the tip this branch has had IS the remote-tracking
  // ref — the includes check passes, and the explicit lease is what refuses.
  const { bare, laptop, desktop, ctx } = twoMachines();
  git(laptop, ["commit", "-q", "--amend", "-m", "fixed on the laptop"], 1700000050);
  git(laptop, ["push", "-q", "--force", "origin", "main"]);
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded on the desktop"], 1700000100);
  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, false);
  assert.ok(!r.unseen, "not the includes check — git's lease");
  assert.equal(remoteSubject(bare), "fixed on the laptop");
});

test("the lease is explicit, and --force-if-includes rides with it on git 2.30+", async () => {
  const { desktop, ctx } = twoMachines();
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded"], 1700000100);
  const tip = git(desktop, ["rev-parse", "origin/main"]).trim();
  const calls = spy(ctx, "git version 2.49.0");
  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, true, r.stderr);
  const push = calls.find((a) => a[0] === "push");
  assert.ok(push, "a push ran");
  assert.ok(push.includes(`--force-with-lease=refs/heads/main:${tip}`), push.join(" "));
  assert.ok(push.includes("--force-if-includes"), push.join(" "));
  assert.ok(!push.includes("--force"), "never a bare --force");
});

test("an older git gets the explicit lease only", async () => {
  const { desktop, ctx } = twoMachines();
  git(desktop, ["commit", "-q", "--amend", "-m", "reworded"], 1700000100);
  const tip = git(desktop, ["rev-parse", "origin/main"]).trim();
  const calls = spy(ctx, "git version 2.29.2");
  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, true, r.stderr);
  const push = calls.find((a) => a[0] === "push") ?? [];
  assert.ok(push.includes(`--force-with-lease=refs/heads/main:${tip}`), push.join(" "));
  assert.ok(!push.includes("--force-if-includes"), "a flag 2.29 does not know would fail the push outright");
});

test("which gits know --force-if-includes", () => {
  assert.equal(gitHasForceIfIncludes("git version 2.49.0"), true);
  assert.equal(gitHasForceIfIncludes("git version 2.30.0"), true);
  assert.equal(gitHasForceIfIncludes("git version 2.39.3 (Apple Git-146)"), true);
  assert.equal(gitHasForceIfIncludes("git version 2.45.1.windows.1"), true);
  assert.equal(gitHasForceIfIncludes("git version 3.0.0"), true);
  assert.equal(gitHasForceIfIncludes("git version 2.29.2"), false);
  assert.equal(gitHasForceIfIncludes("git version 1.9.5"), false);
  assert.equal(gitHasForceIfIncludes(""), false);
});
