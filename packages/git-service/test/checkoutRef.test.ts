import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionLikeCheckout, planRefCheckout, refShortName, renameArgs, suggestedRename } from "../src/checkoutRef";
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

test("a remote branch whose short name a LOCAL branch also has checks out the remote one, tracking it", async () => {
  // A local branch literally called "origin/fix" (an easy slip: `git checkout
  // -b origin/fix`) beside refs/remotes/origin/fix. git then shortens the
  // remote one to "remotes/origin/fix", and a bare "origin/fix" on argv is
  // ambiguous: `git checkout -b fix --track origin/fix` stopped with "fatal:
  // ambiguous object name: 'origin/fix'" — from every remote-checkout door in
  // both products.
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "branch", "origin/fix", "main");
    const remoteTip = git(dir, "rev-parse", "refs/remotes/origin/fix").out.trim();
    assert.notEqual(git(dir, "rev-parse", "refs/heads/origin/fix").out.trim(), remoteTip, "two different commits");
    const p = await plan(dir, "refs/remotes/origin/fix");
    assert.ok(p);
    assert.equal(git(dir, ...p.args).code, 0, `the planned argv must actually work: ${p.args.join(" ")}`);
    assert.equal(symbolicHead(dir), "refs/heads/fix", "on a local branch named for the remote one");
    assert.equal(headSha(dir), remoteTip, "at the REMOTE branch's tip, not the local origin/fix");
    assert.equal(
      git(dir, "rev-parse", "--symbolic-full-name", "fix@{upstream}").out.trim(),
      "refs/remotes/origin/fix",
      "tracking the remote-tracking branch, not the local one",
    );
    assert.equal(p.success, "Checked out fix (tracking origin/fix)", "the words stay the short ones");
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

test("a branch whose name starts with a dash is refused, never handed to git as an option", async () => {
  // Porcelain forbids such names, but `git update-ref refs/heads/-f` does
  // not, and a fetch can bring one in under refs/remotes/. Planned by its
  // short name, "Checkout -f" ran `git checkout -f` — which throws away every
  // uncommitted change and says nothing about a branch.
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "update-ref", "refs/heads/-f", "HEAD");
    git(dir, "update-ref", "refs/heads/--all", "HEAD");
    git(dir, "update-ref", "refs/remotes/origin/-f", "HEAD");
    writeFileSync(join(dir, "f.txt"), "uncommitted work\n");
    for (const full of ["refs/heads/-f", "refs/heads/--all", "refs/remotes/origin/-f"]) {
      const p = await plan(dir, full);
      if (p) git(dir, ...p.args); // what the door would have run
      assert.equal(p, undefined, `${full} is refused (${JSON.stringify(p?.args)})`);
    }
    assert.equal(
      execFileSync("cat", [join(dir, "f.txt")], { encoding: "utf8" }),
      "uncommitted work\n",
      "the working tree is untouched",
    );
    assert.equal(symbolicHead(dir), "refs/heads/main", "and HEAD did not move");
    // A tag of that shape detaches by its full name, which cannot be an option.
    git(dir, "update-ref", "refs/tags/-f", "HEAD");
    const t = await plan(dir, "refs/tags/-f");
    assert.deepEqual(t?.args, ["checkout", "--detach", "refs/tags/-f"]);
    // Only a LEADING dash: a branch with one further in is an ordinary name.
    git(dir, "update-ref", "refs/heads/team/-wip", "HEAD");
    assert.deepEqual((await plan(dir, "refs/heads/team/-wip"))?.args, ["checkout", "team/-wip"]);
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("refShortName strips exactly one namespace", () => {
  assert.equal(refShortName("refs/heads/release/1.5"), "release/1.5");
  assert.equal(refShortName("refs/remotes/origin/release/1.5"), "origin/release/1.5");
  assert.equal(refShortName("refs/tags/v1"), "v1");
  assert.equal(refShortName("refs/heads/heads/release"), "heads/release", "a real branch called heads/release keeps its name");
});

test("an option-like branch is refused with the TRUE reason, and a local one can be renamed where it stands", async () => {
  // The refusal used to reach the user as "not in this repository any more —
  // refresh and try again" (Branches view) or as nothing at all (the graph's
  // menus). The branch IS there; the reason is its name.
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "update-ref", "refs/heads/-f", "HEAD");
    git(dir, "update-ref", "refs/remotes/origin/-f", "HEAD");
    const local = optionLikeCheckout("refs/heads/-f");
    assert.equal(local?.name, "-f");
    assert.equal(local?.local, true);
    assert.match(local!.message, /can't safely check out a branch whose name starts with "-"/);
    assert.match(local!.message, /Rename it/);
    const remote = optionLikeCheckout("refs/remotes/origin/-f");
    assert.equal(remote?.name, "-f", "the name git would be handed is the local one it would make");
    assert.equal(remote?.local, false, "a remote's branch is not ours to rename");
    assert.doesNotMatch(remote!.message, /Rename it/);
    // Nothing else is option-like: tags detach by full name, ordinary names pass.
    for (const f of ["refs/tags/-f", "refs/heads/release", "refs/heads/team/-wip", "release", "refs/stash"]) {
      assert.equal(optionLikeCheckout(f), undefined, f);
    }
    // The rename it offers, by FULL name, run for real.
    const args = renameArgs("refs/heads/-f", "fixed-f");
    assert.deepEqual(args, ["branch", "-m", "--", "-f", "fixed-f"]);
    assert.equal(git(dir, ...args!).code, 0);
    assert.equal(git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/fixed-f").code, 0, "renamed");
    assert.equal(git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/-f").code, 1, "and the old name is gone");
    const p = await plan(dir, "refs/heads/fixed-f");
    assert.deepEqual(p?.args, ["checkout", "fixed-f"], "and it checks out like any branch");
    assert.equal(renameArgs("refs/remotes/origin/-f", "x"), undefined, "never a remote-tracking ref");
    assert.equal(renameArgs("refs/heads/-f", ""), undefined);
    assert.equal(suggestedRename("-f"), "f");
    assert.equal(suggestedRename("--all"), "all");
    assert.equal(suggestedRename("-"), "renamed");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});
