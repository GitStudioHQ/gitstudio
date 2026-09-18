import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { RebaseBridge } from "../src/main/rebaseBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * The plan selects its commits the way git's own sequencer does —
 * `base...HEAD --cherry-pick --right-only` — which DROPS commits whose patch is
 * already on the base. That is correct, and it is why the plan no longer lists
 * a commit that a running rebase would skip and pause on.
 *
 * Dropping them silently is the problem. When it empties the range the view
 * printed "No commits between <base> and <branch>. Pick a different base to
 * reach further back." — a false statement (the commits exist, and a nearer
 * base finds fewer, not more) about the ordinary case of a branch already
 * merged upstream.
 */
function repo(name: string): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-cp-${name}-`);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  return { root, git };
}

async function plan(root: string): Promise<{ commits: unknown[]; message?: string }> {
  const repos = new RepoStore([]);
  await repos.open(root);
  const r = await new RebaseBridge(repos).load({ base: "upstream" });
  assert.equal(r.ok, true, "the plan loads");
  return r as { commits: unknown[]; message?: string };
}

test("a range whose every commit is already upstream says so, instead of claiming it is empty", async () => {
  const { root, git } = repo("all");
  try {
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "upstream");

    // Two commits on the branch…
    writeFileSync(`${root}/a.txt`, "a\n");
    git("add", "-A");
    git("commit", "-qm", "add a");
    writeFileSync(`${root}/b.txt`, "b\n");
    git("add", "-A");
    git("commit", "-qm", "add b");
    const a = git("rev-parse", "HEAD~1").trim();
    const b = git("rev-parse", "HEAD").trim();

    // …both of which land on upstream by a different route, so their SHAs
    // differ and only their patch-ids match. This is what a merge-by-rebase or
    // a maintainer's cherry-pick leaves behind.
    //
    // The unrelated commit first is load-bearing: cherry-picking onto the SAME
    // parent, in the same second, with the same author, tree and message
    // reproduces the input commit byte for byte — git hands back the identical
    // sha and `upstream` merely fast-forwards onto the branch, testing nothing.
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    git("checkout", "-q", "upstream");
    writeFileSync(`${root}/u.txt`, "u\n");
    git("add", "-A");
    git("commit", "-qm", "unrelated upstream work");
    git("cherry-pick", a, b);
    git("checkout", "-q", branch);

    const p = await plan(root);
    assert.equal(p.commits.length, 0, "the plan is empty, as git's own todo would be");
    assert.match(
      p.message ?? "",
      /already on the base/i,
      "and the view is given the reason, so it does not print 'No commits between …'",
    );
    assert.match(p.message ?? "", /^2 commits/, "counted, not hand-waved");
  } finally {
    removeTempRepo(root);
  }
});

test("a partly-upstream range lists the rest and counts what it dropped", async () => {
  const { root, git } = repo("some");
  try {
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "upstream");

    writeFileSync(`${root}/a.txt`, "a\n");
    git("add", "-A");
    git("commit", "-qm", "add a");
    const a = git("rev-parse", "HEAD").trim();
    writeFileSync(`${root}/c.txt`, "c\n");
    git("add", "-A");
    git("commit", "-qm", "add c");

    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    git("checkout", "-q", "upstream");
    writeFileSync(`${root}/u.txt`, "u\n");
    git("add", "-A");
    git("commit", "-qm", "unrelated upstream work");
    git("cherry-pick", a);
    git("checkout", "-q", branch);

    const p = await plan(root);
    assert.equal(p.commits.length, 1, "the one commit not yet upstream is listed");
    assert.match(p.message ?? "", /^One commit in this range isn't listed/, "the other is accounted for");
  } finally {
    removeTempRepo(root);
  }
});

test("a range with nothing dropped carries no note about it", async () => {
  const { root, git } = repo("none");
  try {
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "upstream");
    writeFileSync(`${root}/a.txt`, "a\n");
    git("add", "-A");
    git("commit", "-qm", "add a");

    const p = await plan(root);
    assert.equal(p.commits.length, 1);
    assert.ok(
      !/already on the base/i.test(p.message ?? ""),
      "the note appears only when something was actually dropped",
    );
  } finally {
    removeTempRepo(root);
  }
});
