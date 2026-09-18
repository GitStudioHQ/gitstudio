import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";

/**
 * What the app says when a merge conflicts.
 *
 * `git merge` writes its whole report to STDOUT and leaves stderr empty:
 *
 *     Auto-merging f.txt
 *     CONFLICT (content): Merge conflict in f.txt
 *     Automatic merge failed; fix conflicts and then commit the result.
 *
 * `BranchOpResult` carried only `stderr`, so all of that was dropped and the
 * app answered "The operation failed." — while the working tree was sitting
 * mid-merge with conflict markers in it. That message describes neither what
 * happened nor what to do, and reads like the merge did not run at all.
 */
function conflictRepo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-merge-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0"); // no background gc racing the cleanup
  git("config", "core.autocrlf", "false"); // and no line-ending rewriting
  writeFileSync(`${root}/f.txt`, "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "other");
  writeFileSync(`${root}/f.txt`, "other\n");
  git("commit", "-qam", "other");
  git("checkout", "-q", "-");
  writeFileSync(`${root}/f.txt`, "main\n");
  git("commit", "-qam", "main");
  return { root, git };
}

test("a conflicted merge reports git's own conflict text, not 'The operation failed'", async () => {
  const { root } = conflictRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const r = await bridge.branchMerge({ name: "other" });

    assert.equal(r.ok, false, "the merge did not succeed");
    const msg = r.message ?? "";
    assert.notEqual(msg, "The operation failed.", "the placeholder must be gone");
    assert.match(msg, /CONFLICT/i, `it names the conflict (got: ${msg})`);
    assert.match(msg, /f\.txt/, "and the file it is in");
  } finally {
    removeTempRepo(root);
  }
});

test("a merge that cannot start still reports git's refusal", async () => {
  const { root, git } = conflictRepo();
  try {
    // Dirty the tree so git refuses outright — a different failure, and one
    // whose text lives on stderr rather than stdout.
    writeFileSync(`${root}/f.txt`, "uncommitted edit\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const r = await bridge.branchMerge({ name: "other" });
    assert.equal(r.ok, false);
    assert.notEqual(r.message ?? "", "The operation failed.", "neither channel is dropped");
    assert.ok((r.message ?? "").length > 10, `git's own words survive (got: ${r.message})`);
  } finally {
    removeTempRepo(root);
  }
});

test("a clean merge still just succeeds", async () => {
  const root = mkdtempSync(`${tmpdir()}/gs-merge-ok-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(`${root}/a.txt`, "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "side");
    writeFileSync(`${root}/b.txt`, "b\n");
    git("add", ".");
    git("commit", "-qm", "side");
    git("checkout", "-q", "-");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const r = await bridge.branchMerge({ name: "side" });
    assert.equal(r.ok, true, `a clean merge succeeds (${r.message ?? ""})`);
  } finally {
    removeTempRepo(root);
  }
});
