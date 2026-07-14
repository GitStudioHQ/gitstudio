import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { parseV2 } from "../src/StatusProvider";

// ── Pure parser tests (hand-crafted porcelain v2 -z output) ──────────────────

test("parseV2: branch header (head, upstream, ahead/behind)", () => {
  const s = parseV2(
    "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0",
  );
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.detached, false);
});

test("parseV2: detached head", () => {
  const s = parseV2("# branch.head (detached)\0");
  assert.equal(s.detached, true);
  assert.equal(s.branch, undefined);
});

test("parseV2: ordinary staged + unstaged + untracked", () => {
  // "1 XY sub mH mI mW hH hI path"
  const s = parseV2(
    [
      "1 A. N... 000000 100644 100644 0000 aaaa added.ts", // staged add
      "1 .M N... 100644 100644 100644 bbbb bbbb work.ts", // unstaged modify
      "1 MM N... 100644 100644 100644 cccc dddd both.ts", // staged+unstaged
      "? untracked.ts", // untracked
      "! ignored.ts", // ignored (dropped)
      "",
    ].join("\0"),
  );
  assert.deepEqual(s.staged, [
    { path: "added.ts", status: "A" },
    { path: "both.ts", status: "M" },
  ]);
  assert.deepEqual(s.unstaged, [
    { path: "work.ts", status: "M" },
    { path: "both.ts", status: "M" },
    { path: "untracked.ts", status: "U" },
  ]);
  assert.equal(s.merge.length, 0);
});

test("parseV2: rename record consumes the original path field", () => {
  // "2 XY sub mH mI mW hH hI Xscore path\0origPath"
  const s = parseV2(
    ["2 R. N... 100644 100644 100644 eeee eeee R100 new.ts", "old.ts", ""].join(
      "\0",
    ),
  );
  assert.deepEqual(s.staged, [{ path: "new.ts", status: "R" }]);
  assert.equal(s.unstaged.length, 0);
});

test("parseV2: unmerged (conflict) → merge group with '!'", () => {
  // "u XY sub m1 m2 m3 mW h1 h2 h3 path"
  const s = parseV2(
    ["u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.ts", ""].join(
      "\0",
    ),
  );
  assert.deepEqual(s.merge, [{ path: "conflict.ts", status: "!" }]);
});

test("parseV2: intent-to-add (worktree Y='A') → unstaged 'A'", () => {
  // `git add -N newfile` → "1 .A ... newfile"
  const s = parseV2("1 .A N... 000000 100644 100644 0000 0000 newfile.ts\0");
  assert.deepEqual(s.unstaged, [{ path: "newfile.ts", status: "A" }]);
  assert.equal(s.staged.length, 0);
});

test("parseV2: paths with spaces survive", () => {
  const s = parseV2("1 .M N... 100644 100644 100644 aa aa my file.ts\0");
  assert.deepEqual(s.unstaged, [{ path: "my file.ts", status: "M" }]);
});

// ── Hermetic test against real `git status` ──────────────────────────────────

let repo: string;
let ctx: GitContext;
function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gs-status-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(["add", "base.txt"]);
  git(["commit", "-qm", "base"]);
  // staged add, unstaged modify, untracked
  writeFileSync(join(repo, "staged.txt"), "new\n");
  git(["add", "staged.txt"]);
  writeFileSync(join(repo, "base.txt"), "changed\n");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  ctx = new GitContext({ root: repo, gitPath: "git" });
});

after(() => {
  ctx.dispose();
  rmSync(repo, { recursive: true, force: true });
});

test("StatusProvider.read on a real repo groups correctly", async () => {
  const s = await ctx.status.read();
  assert.equal(s.branch, "main");
  assert.deepEqual(
    s.staged.map((f) => f.path).sort(),
    ["staged.txt"],
  );
  assert.deepEqual(
    s.unstaged.map((f) => f.path).sort(),
    ["base.txt", "untracked.txt"],
  );
  assert.equal(s.merge.length, 0);
  assert.equal(s.staged.find((f) => f.path === "staged.txt")?.status, "A");
  assert.equal(s.unstaged.find((f) => f.path === "base.txt")?.status, "M");
  assert.equal(s.unstaged.find((f) => f.path === "untracked.txt")?.status, "U");
});
