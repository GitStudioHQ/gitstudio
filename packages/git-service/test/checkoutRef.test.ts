import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRefCheckout, refShortName } from "../src/checkoutRef";
import { removeTempRepo } from "./tmpRepo";

// "Checkout <ref>" from the graph — the row's commit menu and the chip's own
// menu — carried the chip's SHORT name into git. A branch and a tag both
// called "release" is routine (v1.2, stable, release), and git names the branch
// "heads/release" then; `git checkout heads/release` DETACHES at the branch
// tip. The planner takes the full name instead, and these run what it plans
// against real git, because the whole claim is about what git does with it.

// Hermetic git, for the reason checkoutRemote.test.ts spells out: a global
// config brings LFS filters, hooks, and a trace2 listener that races teardown.
const HERMETIC_CFG = join(mkdtempSync(join(tmpdir(), "gs-cr-cfg-")), "config");
writeFileSync(HERMETIC_CFG, "");

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: HERMETIC_CFG,
  GIT_CONFIG_SYSTEM: HERMETIC_CFG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TRACE2: undefined,
  GIT_TRACE2_EVENT: undefined,
  GIT_TRACE2_PERF: undefined,
};

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number };
    return { code: err.status ?? 1, out: "" };
  }
}

function init(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "T");
}

/**
 * A clone whose branch `release` and tag `release` point at DIFFERENT commits
 * (the tag one ahead), with `origin/fix` fetched and no local `fix`. Which
 * commit HEAD lands on says which ref the checkout resolved.
 */
function collidingRepo(): { dir: string; upstream: string; branchTip: string; tagTip: string } {
  const upstream = mkdtempSync(join(tmpdir(), "gs-cr-up-"));
  init(upstream);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "base");
  git(upstream, "branch", "release");
  git(upstream, "branch", "fix");
  writeFileSync(join(upstream, "f.txt"), "two\n");
  git(upstream, "commit", "-qam", "two");
  git(upstream, "tag", "release");

  const dir = mkdtempSync(join(tmpdir(), "gs-cr-"));
  init(dir);
  git(dir, "remote", "add", "origin", upstream);
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-q", "-B", "main", "origin/main");
  git(dir, "branch", "-q", "release", "origin/release");
  return {
    dir,
    upstream,
    branchTip: git(dir, "rev-parse", "refs/heads/release").out.trim(),
    tagTip: git(dir, "rev-parse", "refs/tags/release").out.trim(),
  };
}

const symbolicHead = (dir: string): string => git(dir, "symbolic-ref", "-q", "HEAD").out.trim();
const headSha = (dir: string): string => git(dir, "rev-parse", "HEAD").out.trim();

async function plan(dir: string, fullName: string) {
  return planRefCheckout({ run: async (args) => git(dir, ...args) }, fullName);
}

test("git names a branch that collides with a tag heads/<name>, and checking THAT out detaches", () => {
  // The bug, pinned as git's own behaviour so the planner cannot be
  // "simplified" back to the short name later.
  const { dir, upstream, branchTip } = collidingRepo();
  try {
    assert.match(
      git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/release").out,
      /^heads\/release$/m,
    );
    assert.equal(git(dir, "checkout", "-q", "heads/release").code, 0);
    assert.equal(symbolicHead(dir), "", "HEAD is detached");
    assert.equal(headSha(dir), branchTip, "…at the branch's tip, which is why it looked right");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a branch plans a checkout by its refs/heads/ name and lands ON the branch", async () => {
  const { dir, upstream, branchTip } = collidingRepo();
  try {
    const p = await plan(dir, "refs/heads/release");
    assert.ok(p);
    assert.deepEqual(p.args, ["checkout", "release"]);
    assert.equal(p.detaches, false);
    assert.equal(p.success, "Switched to release", "the toast names the branch, not heads/release");
    assert.equal(git(dir, ...p.args).code, 0, "the planned argv must actually work");
    assert.equal(symbolicHead(dir), "refs/heads/release", "attached, tag of the same name notwithstanding");
    assert.equal(headSha(dir), branchTip);
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a tag plans a detach by its full name and lands on the TAG, not the branch", async () => {
  const { dir, upstream, tagTip } = collidingRepo();
  try {
    const p = await plan(dir, "refs/tags/release");
    assert.ok(p);
    assert.deepEqual(p.args, ["checkout", "--detach", "refs/tags/release"]);
    assert.equal(p.detaches, true, "so the host asks first");
    assert.equal(git(dir, ...p.args).code, 0);
    assert.equal(symbolicHead(dir), "", "detached — a tag is a fixed point");
    assert.equal(headSha(dir), tagTip);
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a remote branch goes through planRemoteCheckout by its remote-tracking name", async () => {
  const { dir, upstream } = collidingRepo();
  try {
    const p = await plan(dir, "refs/remotes/origin/fix");
    assert.ok(p);
    assert.equal(p.detaches, false);
    assert.equal(git(dir, ...p.args).code, 0);
    assert.equal(symbolicHead(dir), "refs/heads/fix", "on a local branch of that name");
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "fix@{upstream}").out.trim(), "origin/fix", "tracking the remote one");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a name outside the three namespaces is refused rather than guessed at", async () => {
  const proc = { run: async () => ({ code: 1 }) };
  // A short name reaching the planner is the bug this exists to end; giving it
  // a namespace here would only move the guess.
  assert.equal(await planRefCheckout(proc, "release"), undefined);
  assert.equal(await planRefCheckout(proc, "heads/release"), undefined);
  assert.equal(await planRefCheckout(proc, "refs/stash"), undefined);
  assert.equal(await planRefCheckout(proc, "refs/heads/"), undefined);
  assert.equal(await planRefCheckout(proc, ""), undefined);
});

test("refShortName strips exactly one namespace", () => {
  assert.equal(refShortName("refs/heads/release/1.5"), "release/1.5");
  assert.equal(refShortName("refs/remotes/origin/release/1.5"), "origin/release/1.5");
  assert.equal(refShortName("refs/tags/v1"), "v1");
  assert.equal(refShortName("refs/heads/heads/release"), "heads/release", "a real branch called heads/release keeps its name");
});
