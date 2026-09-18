import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClone } from "../src/main/cloneBridge";
import { removeTempRepo } from "./tmpRepo";

// The clone folder can now be DELETED from the Repositories screen — which is
// what Anton asked for, and which means the next clone has a destination that
// does not exist. `spawn` with a missing cwd fails with a bare ENOENT, so the
// clone creates the folder instead. This test is the reason that stays true.

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) removeTempRepo(d);
});

function sourceRepo(): string {
  const src = mkdtempSync(join(tmpdir(), "gitstudio-clonesrc-"));
  made.push(src);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", src]);
  writeFileSync(join(src, "a.txt"), "one\n");
  execFileSync("git", ["-C", src, "config", "user.email", "dev@example.com"]);
  execFileSync("git", ["-C", src, "config", "user.name", "Dev"]);
  execFileSync("git", ["-C", src, "add", "."]);
  execFileSync("git", ["-C", src, "commit", "-m", "first"]);
  return src;
}

test("cloning into a folder that is not there creates it", async () => {
  const src = sourceRepo();
  const parent = mkdtempSync(join(tmpdir(), "gitstudio-clonedest-"));
  made.push(parent);
  // The case the Repositories screen can now produce: the configured clone
  // folder was deleted, so it is a path with nothing at it.
  const gone = join(parent, "GitStudio", "nested");
  assert.equal(existsSync(gone), false);

  const r = await startClone({ url: src, parentDir: gone, name: "cloned" }, () => {});
  assert.equal(r.ok, true, r.message);
  assert.equal(existsSync(join(gone, "cloned", ".git")), true, "the clone is there");
});

test("a destination that cannot be created is reported as such", async () => {
  const src = sourceRepo();
  const parent = mkdtempSync(join(tmpdir(), "gitstudio-clonedest-"));
  made.push(parent);
  // A FILE where the folder should go: mkdir fails, and the message has to name
  // the path rather than surfacing a raw errno.
  const blocked = join(parent, "not-a-folder");
  writeFileSync(blocked, "");

  const r = await startClone({ url: src, parentDir: blocked, name: "cloned" }, () => {});
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /not-a-folder/);
});
