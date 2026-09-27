// The one rule every comparison of two folders goes through (folderPath.ts),
// with Windows' spellings fed literally — a Windows runner is where they
// differ, and none is needed to test them.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { folderKey, nativePath, sameFolder, type PathRules } from "../src/folderPath";

/**
 * A Windows disk as a CI runner has it: os.tmpdir() hands out the 8.3 short
 * name C:\Users\RUNNER~1\…, the disk's own (and git's) spelling is the long
 * one, and only the folders in `present` exist. What realpathSync.native
 * does there: it throws for a path that is not there, and answers the long
 * name, with backslashes, for one that is.
 */
function runnerDisk(present: string[]): PathRules {
  const long = (p: string) => win32.normalize(p).replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, "C:\\Users\\runneradmin");
  const there = new Set(present.map((p) => long(p).toLowerCase()));
  return {
    platform: "win32",
    realpath: (p) => {
      const l = long(p);
      if (!there.has(l.toLowerCase())) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: "ENOENT" });
      }
      return l;
    },
  };
}

const TEMP = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
const disk = runnerDisk([
  "C:\\",
  "C:\\Users",
  "C:\\Users\\runneradmin",
  "C:\\Users\\runneradmin\\AppData",
  "C:\\Users\\runneradmin\\AppData\\Local",
  TEMP,
  `${TEMP}\\gs-x`,
  `${TEMP}\\gs-x\\app`,
  `${TEMP}\\gs-x\\wt`,
  `${TEMP}\\gs-x\\wt\\feat`,
  // wt\gone is not: its folder was deleted, git still lists it.
]);

test("git's spelling and os.tmpdir()'s are one folder on Windows — the 8.3 short name, the slashes, the case", () => {
  const git = "C:/Users/runneradmin/AppData/Local/Temp/gs-x/wt/feat";
  for (const same of [
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\feat",
    "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\gs-x\\wt\\feat",
    "c:\\users\\RUNNERADMIN\\appdata\\local\\temp\\GS-X\\WT\\Feat",
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\feat\\",
    "C:/Users/RUNNER~1/AppData/Local/Temp/gs-x/app/../wt/feat",
  ]) {
    assert.equal(sameFolder(same, git, disk), true, same);
  }
  for (const other of [
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt",
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\feat-2",
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\app",
    "D:\\Users\\runneradmin\\AppData\\Local\\Temp\\gs-x\\wt\\feat",
  ]) {
    assert.equal(sameFolder(other, git, disk), false, other);
  }
});

test("a worktree whose folder is gone is still the folder git lists: its nearest parent that is there settles the spelling", () => {
  // The removal() that answered "notListed" for this on the runner: the
  // folder is gone, so it cannot be resolved itself — its parent can.
  const git = "C:/Users/runneradmin/AppData/Local/Temp/gs-x/wt/gone";
  assert.equal(sameFolder("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\gone", git, disk), true);
  assert.equal(sameFolder("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\gone\\deeper", git, disk), false);
  assert.equal(sameFolder("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\gone-too", git, disk), false);
  // Several levels gone at once.
  assert.equal(
    sameFolder("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-y\\a\\b", "C:/Users/runneradmin/AppData/Local/Temp/gs-y/a/b", disk),
    true,
  );
});

test("the key: forward slashes, no trailing one but the root's, folded case on Windows", () => {
  assert.equal(folderKey("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gs-x\\wt\\feat\\", disk), "c:/users/runneradmin/appdata/local/temp/gs-x/wt/feat");
  assert.equal(folderKey("C:\\", disk), "c:/");
  assert.equal(folderKey("C:/", { platform: "win32", realpath: null }), "c:/");
  // By the text alone (no disk), the short name is a different name — which
  // is why the disk is asked.
  assert.notEqual(
    folderKey("C:\\Users\\RUNNER~1\\x", { platform: "win32", realpath: null }),
    folderKey("C:/Users/runneradmin/x", { platform: "win32", realpath: null }),
  );
  // A drive nothing of which is there is compared as written.
  assert.equal(folderKey("Z:\\nowhere\\x", disk), "z:/nowhere/x");
});

test("off Windows: case is a difference on Linux and not on macOS; a backslash is a character in a Linux name", () => {
  const text = (platform: string): PathRules => ({ platform, realpath: null });
  assert.equal(sameFolder("/work/Repo", "/work/repo", text("linux")), false);
  assert.equal(sameFolder("/work/Repo", "/work/repo", text("darwin")), true);
  assert.equal(sameFolder("/work/repo/", "/work/other/../repo", text("linux")), true);
  assert.equal(sameFolder("/work/a\\b", "/work/a/b", text("linux")), false);
  assert.equal(folderKey("/", text("linux")), "/");
});

test("shown to a person, a path is spelled the system's way: C:\\ on Windows, untouched anywhere else", () => {
  assert.equal(nativePath("C:/Users/runneradmin/AppData/Local/Temp/gs-x/wt/feat", "win32"), "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\gs-x\\wt\\feat");
  assert.equal(nativePath("C:\\already\\native", "win32"), "C:\\already\\native");
  assert.equal(nativePath("/private/var/folders/x/wt/feat", "darwin"), "/private/var/folders/x/wt/feat");
  assert.equal(nativePath("/odd//but/as/git/wrote/it/", "linux"), "/odd//but/as/git/wrote/it/");
  assert.equal(nativePath("", "win32"), "");
});

// ── And on this machine's own disk ───────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "gs-folder-path-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("on this disk: tmpdir's spelling and the resolved one are one folder, gone or there, and through a symlink", () => {
  // os.tmpdir()'s spelling (/var/… on macOS, RUNNER~1 on a Windows runner)
  // against the disk's own, which is git's.
  const real = realpathSync.native(scratch);
  mkdirSync(join(scratch, "here"));
  assert.equal(sameFolder(join(scratch, "here"), join(real, "here")), true);
  assert.equal(sameFolder(join(scratch, "gone", "deeper"), join(real, "gone", "deeper")), true);
  assert.equal(sameFolder(join(scratch, "here"), join(real, "gone")), false);
  let linked = false;
  try {
    symlinkSync(join(scratch, "here"), join(scratch, "link"), "junction");
    linked = true;
  } catch {
    // No symlinks on this machine (a Windows account without the right): the rest still holds.
  }
  if (linked) assert.equal(sameFolder(join(scratch, "link"), join(real, "here")), true);
});
