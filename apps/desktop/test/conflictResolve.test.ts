import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";

/**
 * Resolving a modify/delete conflict — one side edited a file, the other removed
 * it.
 *
 * Such a conflict has only TWO index stages: the base, and whichever side kept
 * the file. `conflictTakeSide` unconditionally ran `git show :2:` / `:3:` and
 * wrote stdout, so choosing the side that DELETED the file asked git for a stage
 * that does not exist — and the user got a raw `fatal: path ... does not exist`
 * for pressing a button the app itself had offered. There was no way to resolve
 * one of git's seven conflict kinds at all.
 *
 * An absent stage is not an error. It is that side's answer: delete the file.
 */
function conflictRepo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-md-`);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0"); // no background gc racing the cleanup
  git("config", "core.autocrlf", "false"); // and no line-ending rewriting
  mkdirSync(`${root}/app`);
  writeFileSync(`${root}/app/keep.py`, "print('base')\n");
  writeFileSync(`${root}/app/drop.py`, "print('base')\n");
  writeFileSync(`${root}/app/both.py`, "print('base')\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  // side branch: delete keep.py, edit drop.py, edit both.py
  git("checkout", "-qb", "side");
  execFileSync("git", ["rm", "-q", "app/keep.py"], { cwd: root });
  writeFileSync(`${root}/app/drop.py`, "print('side')\n");
  writeFileSync(`${root}/app/both.py`, "print('side')\n");
  git("add", "-A");
  git("commit", "-qm", "side");

  // main: edit keep.py, delete drop.py, edit both.py — a UD, a DU and a UU.
  git("checkout", "-q", "master");
  writeFileSync(`${root}/app/keep.py`, "print('main')\n");
  execFileSync("git", ["rm", "-q", "app/drop.py"], { cwd: root });
  writeFileSync(`${root}/app/both.py`, "print('main')\n");
  git("add", "-A");
  git("commit", "-qm", "main");
  try {
    git("merge", "side");
  } catch {
    /* conflicts are the point */
  }
  return { root, git };
}

test("taking the side that DELETED the file deletes it", async () => {
  const { root, git } = conflictRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);

    // keep.py: we modified, they deleted. "Take theirs" means remove it.
    const theirs = await bridge.conflictTakeSide({ path: "app/keep.py", side: "theirs" });
    assert.equal(theirs.ok, true, `take-theirs succeeds (${theirs.message ?? ""})`);
    assert.equal(existsSync(`${root}/app/keep.py`), false, "the file is gone from disk");

    // drop.py: we deleted, they modified. "Take ours" means remove it.
    const ours = await bridge.conflictTakeSide({ path: "app/drop.py", side: "ours" });
    assert.equal(ours.ok, true, `take-ours succeeds (${ours.message ?? ""})`);
    assert.equal(existsSync(`${root}/app/drop.py`), false, "and so is this one");

    const status = git("status", "--porcelain=v1");
    assert.ok(!/^U|^.U/m.test(status.replace(/^.. app\/both\.py$/m, "")), "both are resolved");
  } finally {
    removeTempRepo(root);
  }
});

test("taking the side that KEPT the file keeps it", async () => {
  const { root } = conflictRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);

    const keepOurs = await bridge.conflictTakeSide({ path: "app/keep.py", side: "ours" });
    assert.equal(keepOurs.ok, true, `keeping our version succeeds (${keepOurs.message ?? ""})`);
    assert.ok(existsSync(`${root}/app/keep.py`), "our edited file survives");

    const keepTheirs = await bridge.conflictTakeSide({ path: "app/drop.py", side: "theirs" });
    assert.equal(keepTheirs.ok, true, `keeping their version succeeds (${keepTheirs.message ?? ""})`);
    assert.ok(existsSync(`${root}/app/drop.py`), "their edited file is restored");
  } finally {
    removeTempRepo(root);
  }
});

test("an ordinary content conflict still resolves to the chosen side", async () => {
  const { root, git } = conflictRepo();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const res = await bridge.conflictTakeSide({ path: "app/both.py", side: "theirs" });
    assert.equal(res.ok, true, `take-theirs succeeds (${res.message ?? ""})`);
    assert.match(
      git("show", ":app/both.py"),
      /side/,
      "the staged content is the side that was chosen",
    );
  } finally {
    removeTempRepo(root);
  }
});
