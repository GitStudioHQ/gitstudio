// Removing a worktree from the desktop's Branches ▸ Worktrees, through the REAL
// bridge against real git — the sibling of the extension's Worktrees view
// (apps/extension/test/worktreesDoors.test.ts), which shares the plumbing.
//
// The renderer used to promise "any uncommitted work goes with it", send a
// plain remove, and toast git's refusal: a dirty worktree was never removed,
// a locked one could not be (git wants --force twice), and the main one was
// offered at all. Now what removing takes is read first (worktree:removal)
// and the remove runs as agreed (worktree:remove).

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-desktop-wt-")));
after(() => removeTempRepo(scratch));
let seq = 0;

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A main worktree and, under wt/: clean, locked (with a reason), dirty, and one whose folder is gone. */
function scene() {
  const base = join(scratch, `s${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  const git = at(app);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  writeFileSync(join(app, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const path = (n: string) => join(base, "wt", n);
  for (const b of ["clean", "locked", "dirty", "gone"]) git("worktree", "add", "-q", "-b", b, path(b));
  git("worktree", "lock", "--reason", "on a USB drive", path("locked"));
  writeFileSync(join(path("dirty"), "new.txt"), "n\n");
  rmSync(path("gone"), { recursive: true, force: true });
  return { app, git, path };
}

async function bridgeOn(dir: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(dir);
  return new GitBridge(repos);
}

test("the list says which worktree is main, which folder is gone, and why one is locked", async () => {
  const s = scene();
  const list = await (await bridgeOn(s.app)).worktreeList();
  const by = (b: string) => list.find((w) => w.branch === b);
  assert.equal(by("main")?.main, true);
  assert.equal(by("clean")?.main, false);
  assert.equal(by("gone")?.missing, true);
  assert.equal(by("clean")?.missing, false);
  assert.equal(by("locked")?.lockReason, "on a USB drive");
});

test("removal is read before anything is asked: refused for main and this window's own, facts for the rest", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  assert.deepEqual(await bridge.worktreeRemoval({ path: s.app }), { kind: "main" });
  assert.deepEqual(await bridge.worktreeRemoval({ path: join(s.app, "..", "nowhere") }), { kind: "notListed" });
  const locked = await bridge.worktreeRemoval({ path: s.path("locked") });
  assert.equal(locked.kind, "present");
  assert.equal(locked.kind === "present" && locked.lockReason, "on a USB drive");
  const dirty = await bridge.worktreeRemoval({ path: s.path("dirty") });
  assert.deepEqual(dirty.kind === "present" && dirty.changes, ["new.txt"]);
  assert.equal((await bridge.worktreeRemoval({ path: s.path("gone") })).kind, "missing");

  // From inside a linked worktree, that one is this window's.
  const inside = await bridgeOn(s.path("clean"));
  assert.deepEqual(await inside.worktreeRemoval({ path: s.path("clean") }), { kind: "current" });
  const refused = await inside.worktreeRemove({ path: s.path("clean") });
  assert.equal(refused.ok, false);
  assert.ok(existsSync(s.path("clean")), "the window's own folder stays");
});

test("removal names a merge stopped in that worktree", async () => {
  const s = scene();
  const clean = s.path("clean");
  const c = at(clean);
  writeFileSync(join(clean, "a.txt"), "clean\n");
  c("commit", "-qam", "clean change");
  writeFileSync(join(s.app, "a.txt"), "main\n");
  s.git("commit", "-qam", "main change");
  assert.throws(() => c("merge", "main"));
  const r = await (await bridgeOn(s.app)).worktreeRemoval({ path: clean });
  assert.equal(r.kind === "present" && r.operation, "merge");
});

test("a locked worktree goes when removing it past the lock was agreed", async () => {
  const s = scene();
  const r = await (await bridgeOn(s.app)).worktreeRemove({ path: s.path("locked"), pastLock: true });
  assert.ok(r.ok, r.message);
  assert.equal(existsSync(s.path("locked")), false);
  assert.equal(s.git("branch", "--list", "locked"), "locked", "the branch stays");
});

test("a dirty worktree goes when its changes were agreed to — and is refused, intact, when they were not", async () => {
  const s = scene();
  const bridge = await bridgeOn(s.app);
  const kept = await bridge.worktreeRemove({ path: s.path("dirty") });
  assert.equal(kept.ok, false);
  assert.ok(existsSync(join(s.path("dirty"), "new.txt")));
  const r = await bridge.worktreeRemove({ path: s.path("dirty"), discardChanges: true });
  assert.ok(r.ok, r.message);
  assert.equal(existsSync(s.path("dirty")), false);
});

test("a worktree whose folder is gone is forgotten", async () => {
  const s = scene();
  const r = await (await bridgeOn(s.app)).worktreeRemove({ path: s.path("gone") });
  assert.ok(r.ok, r.message);
  assert.ok(!s.git("worktree", "list", "--porcelain").includes("refs/heads/gone"));
});

test("opened through a symlink, the window's own worktree is still the current one — and still refused", async () => {
  const s = scene();
  const link = join(s.app, "..", "link-to-clean");
  symlinkSync(s.path("clean"), link);
  const bridge = await bridgeOn(link);
  const list = await bridge.worktreeList();
  assert.deepEqual(
    list.filter((w) => w.current).map((w) => w.branch),
    ["clean"],
    "exactly one current row, the worktree the window has open",
  );
  assert.deepEqual(await bridge.worktreeRemoval({ path: s.path("clean") }), { kind: "current" });
});
