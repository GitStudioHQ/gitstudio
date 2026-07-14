import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { chunkPaths } from "../src/StagingProvider";

// Discard routing: tracked changes are restored via `git checkout --`, untracked
// files are removed via `git clean -f`. The regression these guard against: a
// single `git checkout -- <tracked> <untracked>` aborts atomically (git rejects
// the untracked pathspec), silently discarding NOTHING — so the Changes view's
// "Discard All"/"Discard folder"/per-file discard must partition the two.

let repo: string;
let ctx: GitContext;
function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}
function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gs-discard-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  write("tracked.txt", "committed\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-qm", "base"]);
  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("chunkPaths: a normal changeset stays a single batch", () => {
  const files = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
  const chunks = chunkPaths(files);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks.flat(), files);
});

test("chunkPaths: thousands of long paths split into bounded batches (nothing lost)", () => {
  const files = Array.from(
    { length: 4000 },
    (_, i) => `deeply/nested/directory/structure/module-${i}/component.tsx`,
  );
  const chunks = chunkPaths(files);
  assert.ok(chunks.length > 1, "should split");
  // Every batch's joined length stays under the ~32K command-line ceiling.
  for (const c of chunks) {
    const joined = c.join(" ").length;
    assert.ok(joined <= 24000, `batch too long: ${joined}`);
  }
  // No path dropped or reordered.
  assert.deepEqual(chunks.flat(), files);
});

test("cleanFiles removes an untracked file", async () => {
  write("untracked.txt", "junk\n");
  assert.equal(existsSync(join(repo, "untracked.txt")), true);
  const r = await ctx.staging.cleanFiles(["untracked.txt"]);
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(repo, "untracked.txt")), false);
});

test("discardFiles restores a modified tracked file", async () => {
  write("tracked.txt", "DIRTY\n");
  const r = await ctx.staging.discardFiles(["tracked.txt"]);
  assert.equal(r.ok, true);
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(status.trim(), ""); // clean again
});

test("REGRESSION: one checkout over a mixed tracked+untracked set aborts and discards nothing", async () => {
  write("tracked.txt", "DIRTY\n");
  write("untracked.txt", "junk\n");
  // The buggy path: a single checkout batch with an untracked pathspec.
  const bad = await ctx.staging.discardFiles(["tracked.txt", "untracked.txt"]);
  assert.equal(bad.ok, false); // git aborts the whole batch
  // ...and proves nothing was discarded: tracked.txt is still dirty.
  const still = execFileSync("git", ["status", "--porcelain", "tracked.txt"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(still, /M tracked\.txt/);

  // The FIX: partition — checkout the tracked path, clean the untracked one.
  const t = await ctx.staging.discardFiles(["tracked.txt"]);
  const u = await ctx.staging.cleanFiles(["untracked.txt"]);
  assert.equal(t.ok, true);
  assert.equal(u.ok, true);
  const clean = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(clean.trim(), ""); // both handled: fully clean
  assert.equal(existsSync(join(repo, "untracked.txt")), false);
});
