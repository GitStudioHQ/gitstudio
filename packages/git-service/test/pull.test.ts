import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

/**
 * Regression: a plain Pull must never fail with git's
 *
 *   fatal: Need to specify how to reconcile divergent branches.
 *
 * Since git 2.34, a bare `git pull` errors out on divergent branches when the
 * user has no `pull.rebase` / `pull.ff` config. GitStudio shipped that stderr
 * straight to the user — so clicking Pull looked like the app was demanding you
 * go configure a rebase — and because the pull aborted, no merge was attempted,
 * so conflicts (and the 3-pane merge editor) never appeared either.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A local "remote" + a clone whose branches have genuinely diverged, with the
 *  reconciliation config deliberately UNSET (git's out-of-the-box state). */
function makeDivergentClone(): { dir: string; clone: string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-pull-"));
  const origin = join(dir, "origin");
  const clone = join(dir, "clone");

  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  // A fresh repo has no pull.rebase / pull.ff — which is exactly the
  // out-of-the-box state where git 2.34+ refuses to reconcile divergence.
  const cfg = (repo: string) => {
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
  };
  cfg(origin);
  writeFileSync(join(origin, "a.txt"), "base\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "base");

  execFileSync("git", ["clone", "-q", origin, clone]);
  cfg(clone);

  // origin moves ahead…
  writeFileSync(join(origin, "b.txt"), "theirs\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "theirs");

  // …and the clone commits something else on top of the same base → divergent.
  writeFileSync(join(clone, "c.txt"), "ours\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "ours");
  git(clone, "fetch", "-q");

  return { dir, clone };
}

test("pull() reconciles divergent branches instead of git's 'Need to specify how' fatal", async () => {
  const { dir, clone } = makeDivergentClone();
  try {
    // Prove the trap is real: a bare `git pull` here is a hard error.
    let bareFailed = false;
    try {
      execFileSync("git", ["pull"], { cwd: clone, encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      bareFailed = true;
      assert.match(String((err as { stderr?: Buffer }).stderr ?? ""), /divergent branches/i);
    }
    assert.equal(bareFailed, true, "expected a bare `git pull` to fatal on divergence");

    // GitStudio's pull picks a strategy, so it actually merges.
    const ctx = new GitContext({ root: clone, gitPath: "git" });
    const r = await ctx.sync.pull();
    assert.equal(r.ok, true, `pull failed: ${r.stderr}`);

    // Both sides are now in history — a real merge happened.
    const log = git(clone, "log", "--oneline", "--all");
    assert.match(log, /theirs/);
    assert.match(log, /ours/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull({ rebase: true }) still rebases", async () => {
  const { dir, clone } = makeDivergentClone();
  try {
    const ctx = new GitContext({ root: clone, gitPath: "git" });
    const r = await ctx.sync.pull({ rebase: true });
    assert.equal(r.ok, true, `pull --rebase failed: ${r.stderr}`);
    // A rebase replays "ours" on top of "theirs": linear, no merge commit.
    const merges = git(clone, "log", "--merges", "--oneline").trim();
    assert.equal(merges, "", "expected a linear history after --rebase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
