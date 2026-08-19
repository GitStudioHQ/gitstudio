import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { unresolvedConflictsMessage } from "../src/ConflictProvider";
import { removeTempRepo } from "./tmpRepo";

// Crash report #9: "git checkout failed — error: you need to resolve your current
// index first". Nothing was broken. The user was mid-conflict and git declined to
// move HEAD over an unmerged index, exactly as it should. It was shown as a red
// error AND filed as a crash report.
//
// The fix asks whether the index still has unmerged files, and treats that as
// "the repo's state, not our defect".
//
// The case that earns this file is the LAST one. An empty cherry-pick leaves
// CHERRY_PICK_HEAD behind with ZERO unmerged files — and that is the report which
// found the locale bug fixed in 1.5.2. Keying the "don't report" decision on the
// operation markers instead would have silenced the most valuable report we have
// had, so the test pins that it stays reportable.

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch {
    return "";
  }
}
const write = (n: string, c: string): void => writeFileSync(join(repo, n), c);
const markerPresent = (m: string): boolean =>
  git("rev-parse", "--verify", "--quiet", m).trim().length > 0;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-unmerged-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  write("f.txt", "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

/** Leave the repo mid-merge with a real conflict. */
function conflict(): void {
  git("checkout", "-qb", "side");
  write("f.txt", "SIDE\n");
  git("commit", "-aqm", "side");
  git("checkout", "-q", "main");
  write("f.txt", "MAIN\n");
  git("commit", "-aqm", "main");
  git("merge", "side");
}

test("a conflicted merge reports unmerged files", async () => {
  conflict();
  assert.ok((await ctx.conflict.unmergedCount()) > 0);
  assert.equal(markerPresent("MERGE_HEAD"), true);
});

test("the reported case: a checkout refused mid-conflict is explained by the index", async () => {
  conflict();
  // This is exactly what the crash report captured.
  const out = git("checkout", "main");
  assert.equal(out, "", "git refuses");
  assert.ok(
    (await ctx.conflict.unmergedCount()) > 0,
    "so the refusal is the repo's state, not a GitStudio defect",
  );
});

test("a conflicted stash pop counts, though NO operation marker exists", async () => {
  // The case a marker-based check misses entirely: unmerged index, and every
  // marker absent. Verified against real git.
  write("f.txt", "local\n");
  git("stash", "push", "-q");
  write("f.txt", "other\n");
  git("commit", "-aqm", "other");
  git("stash", "pop");

  assert.ok((await ctx.conflict.unmergedCount()) > 0, "the index IS unmerged");
  for (const m of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
    assert.equal(markerPresent(m), false, `${m} must be absent here`);
  }
});

test("REGRESSION GUARD: an empty cherry-pick stays reportable", async () => {
  // The report #5 shape — a marker is present, but nothing is unmerged. If a
  // future change keys "don't report" on markers instead of on the index, this
  // fails, and the locale bug that report found could recur unseen.
  git("checkout", "-qb", "feat");
  write("g.txt", "same\n");
  git("add", ".");
  git("commit", "-qm", "add g");
  const sha = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "main");
  write("g.txt", "same\n");
  git("add", ".");
  git("commit", "-qm", "same change independently");
  git("cherry-pick", sha);

  assert.equal(markerPresent("CHERRY_PICK_HEAD"), true, "the marker IS present");
  assert.equal(
    await ctx.conflict.unmergedCount(),
    0,
    "but nothing is unmerged — so this must NOT be suppressed",
  );
});

test("a clean repo reports nothing unmerged", async () => {
  assert.equal(await ctx.conflict.unmergedCount(), 0);
});

test("the message counts files and names the way out", () => {
  assert.match(unresolvedConflictsMessage(1), /^1 file still has/);
  assert.match(unresolvedConflictsMessage(3), /^3 files still have/);
  for (const n of [1, 3]) {
    assert.match(unresolvedConflictsMessage(n), /Resolve them and commit, or abort/);
  }
});
