import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { parseV2 } from "../src/StatusProvider";
import { removeTempRepo } from "./tmpRepo";

// The states the Changes view must show that the basic status tests don't
// reach: deletions and type changes on either side, a worktree-only rename
// (a moved file marked with `git add -N`), and git refusing to answer.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function repo(): { dir: string; git: (...a: string[]) => string; ctx: GitContext; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gs-statusprov-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  const ctx = new GitContext({ root: dir });
  return {
    dir,
    git,
    ctx,
    dispose: () => {
      ctx.dispose();
      removeTempRepo(dir);
    },
  };
}

test("a folder git won't read as a repository reads as an empty status, not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-statusprov-norepo-"));
  const ctx = new GitContext({ root: dir });
  try {
    // GIT_DIR pointing nowhere makes git refuse whatever the folder is inside.
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, "no-such-git-dir");
    try {
      const s = await ctx.status.read({ signal: new AbortController().signal });
      assert.deepEqual(s, { ahead: 0, behind: 0, detached: false, merge: [], staged: [], unstaged: [] });
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  } finally {
    ctx.dispose();
    removeTempRepo(dir);
  }
});

test("deleted and moved files show on the side they happened: a staged delete, a worktree delete, a worktree rename", async () => {
  const r = repo();
  try {
    for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(r.dir, f), `${f}\n`);
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("rm", "-q", "a.txt"); // staged delete
    rmSync(join(r.dir, "b.txt")); // worktree delete
    renameSync(join(r.dir, "c.txt"), join(r.dir, "c2.txt"));
    r.git("add", "-N", "c2.txt"); // "2 .R": the file's only record
    const s = await r.ctx.status.read();
    assert.deepEqual(s.staged, [{ path: "a.txt", status: "D" }]);
    assert.deepEqual(
      [...s.unstaged].sort((x, y) => x.path.localeCompare(y.path)),
      [
        { path: "b.txt", status: "D" },
        { path: "c2.txt", status: "R", oldPath: "c.txt" },
      ],
    );
  } finally {
    r.dispose();
  }
});

test("a file turned into a symlink is a type change — unstaged, then staged", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "f.txt"), "f\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    rmSync(join(r.dir, "f.txt"));
    symlinkSync("elsewhere", join(r.dir, "f.txt"));
    assert.deepEqual((await r.ctx.status.read()).unstaged, [{ path: "f.txt", status: "T" }]);
    r.git("add", "f.txt");
    const s = await r.ctx.status.read();
    assert.deepEqual(s.staged, [{ path: "f.txt", status: "T" }]);
    assert.deepEqual(s.unstaged, []);
  } finally {
    r.dispose();
  }
});

test("parseV2: a staged type change and a staged copy, each with its letter; a copy keeps where it came from", () => {
  const s = parseV2(
    [
      "1 T. N... 100644 120000 120000 aaaa bbbb link",
      "2 C. N... 100644 100644 100644 cccc cccc C100 copy.txt",
      "orig.txt",
      "",
    ].join("\0"),
  );
  assert.deepEqual(s.staged, [
    { path: "link", status: "T" },
    { path: "copy.txt", status: "R", oldPath: "orig.txt" },
  ]);
  assert.deepEqual(s.unstaged, []);
});

test("parseV2: a worktree-side copy is shown as a rename, and an unknown code on either side is dropped", () => {
  const s = parseV2(
    ["2 .C N... 100644 100644 100644 cccc cccc C100 b.txt", "a.txt", "1 X? N... 100644 100644 100644 aa aa odd.txt", ""].join("\0"),
  );
  assert.deepEqual(s.unstaged, [{ path: "b.txt", status: "R", oldPath: "a.txt" }]);
  assert.deepEqual(s.staged, []);
});

test("parseV2: truncated records are skipped rather than shown with a wrong path", () => {
  const s = parseV2(
    [
      "1 .M N... 100644", // too few fields: no path
      "2 R. N... 100644 100644 100644 eeee eeee", // rename without its path
      "old-of-the-truncated-rename",
      "u UU N... 100644", // conflict without a path
      "1 .M N... 100644 100644 100644 aa aa ok.txt",
      "",
    ].join("\0"),
  );
  assert.deepEqual(s.unstaged, [{ path: "ok.txt", status: "M" }]);
  assert.deepEqual(s.staged, []);
  assert.deepEqual(s.merge, []);
});

test("parseV2: a rename as the last record with its original path missing has no oldPath", () => {
  const s = parseV2("2 R. N... 100644 100644 100644 eeee eeee R100 new.txt");
  assert.deepEqual(s.staged, [{ path: "new.txt", status: "R" }]);
});

test("parseV2: a bare record with nothing after its kind is skipped", () => {
  const s = parseV2("1\0");
  assert.deepEqual(s.staged, []);
  assert.deepEqual(s.unstaged, []);
});

test("parseV2: an ahead/behind header git didn't format as counts leaves them at zero; unknown headers are ignored", () => {
  const s = parseV2("# branch.oid (initial)\0# branch.head main\0# branch.ab ?\0# stash 3\0");
  assert.equal(s.branch, "main");
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});
