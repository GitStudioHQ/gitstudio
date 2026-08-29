import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";

/**
 * Push, from the Branches view, on a branch whose upstream is named differently.
 *
 * `git branch -m` KEEPS the tracking config: the renamed branch still tracks
 * the old remote name. The bridge pushed `git push <remote> <localName>`, using
 * only the remote half of the upstream and throwing the remote-side name away —
 * so Push created a SECOND remote branch under the new name and left the tracked
 * one untouched. Confirmed against real git before the fix:
 *
 *     * [new branch]      feature-local-rename -> feature-local-rename
 *
 * The commits were pushed somewhere nobody was looking, and the ahead count
 * never cleared, because the branch still tracked a ref that had not moved.
 */
function repoWithRemote(): {
  work: string;
  remote: string;
  git: (...a: string[]) => string;
  cleanup: () => void;
} {
  const root = mkdtempSync(`${tmpdir()}/gs-push-`);
  const remote = `${root}/remote.git`;
  const work = `${root}/work`;
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", work]);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: work }).toString();
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(`${work}/a.txt`, "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", remote);
  return { work, remote, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const heads = (remote: string): string[] =>
  execFileSync("git", ["ls-remote", "--heads", remote])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t")[1]);

test("pushing a renamed branch updates the branch it tracks, not a new one", async () => {
  const { work, remote, git, cleanup } = repoWithRemote();
  try {
    git("checkout", "-qb", "feature");
    writeFileSync(`${work}/b.txt`, "b\n");
    git("add", ".");
    git("commit", "-qm", "b");
    git("push", "-q", "-u", "origin", "feature");

    // The rename keeps `branch.feature-local-rename.merge = refs/heads/feature`.
    git("branch", "-m", "feature", "feature-local-rename");
    writeFileSync(`${work}/c.txt`, "c\n");
    git("add", ".");
    git("commit", "-qm", "c");

    // Push it from somewhere else, exactly as the Branches view does — this is
    // a branch you are not standing on.
    git("checkout", "-q", "master");

    const repos = new RepoStore([]);
    await repos.open(work);
    const bridge = new GitBridge(repos);
    const r = await bridge.branchPush("feature-local-rename");
    assert.equal(r.ok, true, `push succeeds (${r.message ?? ""})`);

    assert.deepEqual(
      heads(remote),
      ["refs/heads/feature"],
      "no second remote branch is invented under the local name",
    );
    const pushed = execFileSync("git", ["log", "-1", "--format=%s", "refs/heads/feature"], {
      cwd: remote,
    })
      .toString()
      .trim();
    assert.equal(pushed, "c", "the tracked branch actually received the new commit");
  } finally {
    cleanup();
  }
});

/** The ordinary case must keep working: same name both sides, nothing clever. */
test("pushing an ordinary tracked branch still pushes it", async () => {
  const { work, remote, git, cleanup } = repoWithRemote();
  try {
    git("checkout", "-qb", "topic");
    writeFileSync(`${work}/t.txt`, "t\n");
    git("add", ".");
    git("commit", "-qm", "t1");
    git("push", "-q", "-u", "origin", "topic");
    writeFileSync(`${work}/t2.txt`, "t\n");
    git("add", ".");
    git("commit", "-qm", "t2");
    git("checkout", "-q", "master");

    const repos = new RepoStore([]);
    await repos.open(work);
    const bridge = new GitBridge(repos);
    const r = await bridge.branchPush("topic");
    assert.equal(r.ok, true, `push succeeds (${r.message ?? ""})`);
    assert.equal(
      execFileSync("git", ["log", "-1", "--format=%s", "refs/heads/topic"], { cwd: remote })
        .toString()
        .trim(),
      "t2",
    );
  } finally {
    cleanup();
  }
});

/** An unpublished branch still publishes and starts tracking. */
test("pushing an unpublished branch publishes it and sets upstream", async () => {
  const { work, remote, git, cleanup } = repoWithRemote();
  try {
    git("checkout", "-qb", "brand-new");
    writeFileSync(`${work}/n.txt`, "n\n");
    git("add", ".");
    git("commit", "-qm", "n");
    git("checkout", "-q", "master");

    const repos = new RepoStore([]);
    await repos.open(work);
    const bridge = new GitBridge(repos);
    const r = await bridge.branchPush("brand-new");
    assert.equal(r.ok, true, `publish succeeds (${r.message ?? ""})`);
    assert.ok(heads(remote).includes("refs/heads/brand-new"), "it reached the remote");
    assert.equal(
      git("config", "--get", "branch.brand-new.merge").trim(),
      "refs/heads/brand-new",
      "and it now tracks what it published to",
    );
  } finally {
    cleanup();
  }
});
