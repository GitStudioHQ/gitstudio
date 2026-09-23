// What the app says when a folder the user opened does not open.
//
// git answers every failure to discover a repository with the same sentence —
// "not a git repository (or any of the parent directories)" — including a
// repository whose .git the user cannot read (checked against real git: a
// .git at mode 000, and one whose objects folder is 000, both say it). So the
// app said "<path> is not inside a Git repository." about a repository, in an
// error toast. Opening a folder you cannot read is a state you are in, not a
// failure of the app, and "not a repository" sends you looking in the wrong
// place. The notice is decided from the filesystem instead: a `.git` at or
// above the folder, and whether it can be read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { cannotOpenNotice } from "../src/main/repoNotice";

function repo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gs-notice-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  return {
    root,
    cleanup: () => {
      try {
        chmodSync(join(root, ".git"), 0o755);
        chmodSync(join(root, ".git", "objects"), 0o755);
      } catch {
        /* already readable */
      }
      removeTempRepo(root);
    },
  };
}

test("a folder with no repository anywhere above it is 'not inside a Git repository' — and not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-notice-plain-"));
  try {
    const n = cannotOpenNotice(dir, { canRead: () => true, dotGitAbove: () => undefined });
    assert.match(n.message, /is not inside a Git repository\./);
    assert.notEqual(n.kind, "error", "opening the wrong folder is not a failure");
  } finally {
    removeTempRepo(dir);
  }
});

test("a repository whose .git cannot be read says so — permissions, not 'not a repository'", () => {
  // Injected, so it holds on every platform (chmod does not deny a read on Windows).
  const n = cannotOpenNotice("/work/project/src", {
    dotGitAbove: () => "/work/project/.git",
    canRead: (p) => !p.startsWith("/work/project/.git"),
    ownedByOtherUser: () => false,
  });
  assert.doesNotMatch(n.message, /not inside a Git repository/);
  assert.match(n.message, /\/work\/project is a Git repository/);
  assert.match(n.message, /permission/i);
  assert.notEqual(n.kind, "error");
});

test("…one owned by another account says that instead", () => {
  const n = cannotOpenNotice("/work/project", {
    dotGitAbove: () => "/work/project/.git",
    canRead: () => true,
    ownedByOtherUser: () => true,
  });
  assert.match(n.message, /another user/i);
  assert.doesNotMatch(n.message, /git config|safe\.directory/, "not a terminal's advice");
});

test("…and a readable one git still refused is said to be unreadable, not missing", () => {
  const n = cannotOpenNotice("/work/project", {
    dotGitAbove: () => "/work/project/.git",
    canRead: () => true,
    ownedByOtherUser: () => false,
  });
  assert.match(n.message, /is a Git repository/);
  assert.match(n.message, /can't read/);
});

test(
  "against the real filesystem: a .git at mode 000, and one whose objects are 000",
  { skip: process.platform === "win32" || process.getuid?.() === 0 ? "chmod does not deny a read here" : false },
  () => {
    for (const lock of [".git", join(".git", "objects")]) {
      const { root, cleanup } = repo();
      try {
        mkdirSync(join(root, "sub"));
        chmodSync(join(root, lock), 0o000);
        let gitSays = "";
        try {
          execFileSync("git", ["-C", join(root, "sub"), "rev-parse", "--show-toplevel"], { stdio: "pipe" });
        } catch (e) {
          gitSays = String((e as { stderr?: Buffer }).stderr ?? "");
        }
        assert.match(gitSays, /not a git repository/i, `precondition (${lock}): git calls it no repository`);
        const n = cannotOpenNotice(join(root, "sub"));
        assert.match(n.message, /is a Git repository/, lock);
        assert.match(n.message, /permission/i, lock);
        assert.notEqual(n.kind, "error", lock);
      } finally {
        cleanup();
      }
    }
  },
);
