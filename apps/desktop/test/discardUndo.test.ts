import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// Discarding changes is the most destructive everyday action in a Git client,
// and until now the confirm dialog said "this can't be undone" — truthfully.
//
// It can be, for a tracked file: `git stash create` writes a commit for the
// current index and working tree WITHOUT touching either, so a restore point
// costs nothing and is invisible unless it is used. These tests pin the two
// properties the feature stands on, because both are easy to get subtly wrong:
//
//   1. the discarded content actually comes back, and
//   2. NOTHING ELSE moves — in particular what was staged stays staged.
//      `git checkout <sha> -- <path>` restores the file AND stages it, which
//      would turn "undo my discard" into a silent staging change.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const read = (f: string): string => readFileSync(join(repo, f), "utf8");
const write = (f: string, s: string): void => writeFileSync(join(repo, f), s);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-discard-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  write("a.txt", "committed a\n");
  write("b.txt", "committed b\n");
  git("add", ".");
  git("commit", "-m", "first");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => removeTempRepo(repo));

test("a discarded file's changes come back, and the index does not move", async () => {
  write("a.txt", "my unsaved work\n");
  write("b.txt", "staged work\n");
  git("add", "b.txt");

  const snap = await bridge.discardSnapshot();
  assert.ok(snap.sha, "a dirty tree produces a restore point");

  const discarded = await bridge.discard("a.txt");
  assert.equal(discarded.ok, true);
  assert.equal(read("a.txt"), "committed a\n", "the discard actually discarded");

  const back = await bridge.discardUndo({ sha: snap.sha!, paths: ["a.txt"] });
  assert.equal(back.ok, true, back.message);
  assert.equal(read("a.txt"), "my unsaved work\n", "the work is back");

  // b.txt was staged before all of this and must still be staged, with the
  // same content — undo restores one file's working tree, not the repository.
  assert.equal(git("diff", "--cached", "--name-only").trim(), "b.txt");
  assert.equal(read("b.txt"), "staged work\n");
});

test("undo restores only the paths it is given", async () => {
  write("a.txt", "work in a\n");
  write("b.txt", "work in b\n");
  const snap = await bridge.discardSnapshot();
  await bridge.discard("a.txt");
  await bridge.discard("b.txt");

  await bridge.discardUndo({ sha: snap.sha!, paths: ["a.txt"] });
  assert.equal(read("a.txt"), "work in a\n");
  assert.equal(read("b.txt"), "committed b\n", "b was not asked for and was not touched");
});

test("a clean tree yields no restore point, so no undo is offered", async () => {
  const snap = await bridge.discardSnapshot();
  assert.equal(snap.sha, undefined);
});

test("an untracked file is deleted by discard and cannot be restored", async () => {
  // The property the confirm dialog states out loud. `git stash create` has no
  // copy of an untracked file, so the snapshot cannot bring it back — and the
  // UI must not offer an undo for one. This test exists so that stays true.
  write("new.txt", "never committed\n");
  const snap = await bridge.discardSnapshot();
  await bridge.discard("new.txt");
  assert.equal(existsSync(join(repo, "new.txt")), false, "discard deletes an untracked file");
  if (snap.sha) {
    const back = await bridge.discardUndo({ sha: snap.sha, paths: ["new.txt"] });
    assert.equal(back.ok, false, "git cannot restore what it never had");
  }
});

test("undo refuses a flag-shaped sha and an empty path list", async () => {
  const bad = await bridge.discardUndo({ sha: "--upload-pack=touch", paths: ["a.txt"] });
  assert.equal(bad.ok, false);
  const none = await bridge.discardUndo({ sha: "HEAD", paths: [] });
  assert.equal(none.ok, false);
});
