import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { VscodeGitLocator } from "../src/vscodeGitLocator";
import { newRepo, removeTemp } from "./fixtures";

// Merge Studio's RepoLocator over vscode.git, against a stand-in for the
// vscode module and REAL repositories (the watch targets come from
// `git rev-parse --git-path`, which is asynchronous).

beforeEach(() => stub.reset());

/**
 * A git that answers correctly, but only after the repository has been closed
 * and its context disposed: it ignores the SIGTERM dispose() sends (once its
 * trap is set — the tests wait GIT_STARTED_MS for that) and takes a moment.
 * So the answer the locator gets is a GOOD one, and only the locator's own
 * check can keep it from watching a repository that is gone.
 */
function lateButCorrectGit(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "merge-vscode-slowgit-"));
  const path = join(dir, "git");
  writeFileSync(path, ["#!/bin/sh", "trap '' TERM", "sleep 0.6", 'exec git "$@"', ""].join("\n"));
  chmodSync(path, 0o755);
  return { path, dir };
}

const posixOnly = { skip: process.platform === "win32" ? "uses a shell-script stand-in for git" : false };

/** Long enough for the stand-in to be past its `trap`, well inside its sleep. */
const GIT_STARTED_MS = 200;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gitRepoAt(root: string) {
  return {
    rootUri: vscode.Uri.file(root),
    state: { onDidChange: new vscode.EventEmitter<void>().event },
    status: async () => {},
  };
}

function gitExtension(repositories: ReturnType<typeof gitRepoAt>[], gitPath: string) {
  const open = new vscode.EventEmitter<ReturnType<typeof gitRepoAt>>();
  const close = new vscode.EventEmitter<ReturnType<typeof gitRepoAt>>();
  stub.extensions["vscode.git"] = {
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        repositories,
        git: { path: gitPath },
        onDidOpenRepository: open.event,
        onDidCloseRepository: close.event,
      }),
    },
  };
  return { open, close };
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const liveOutside = (root: string) =>
  stub.watchers.filter((w) => !w.disposed && !w.pattern.base.fsPath.startsWith(root)).map((w) => w.pattern.base.fsPath);

test("a repository that closes while git is still saying where to watch is left with no live watchers", posixOnly, async () => {
  // GitStudio's RepoManager checks that the binding is still alive after the
  // await; this twin did not, so a repository closed (or a locator disposed)
  // before `rev-parse --git-path` answered got two watchers nothing disposes.
  const slow = lateButCorrectGit();
  const a = newRepo("loc-closed");
  const b = newRepo("loc-kept");
  const repoA = gitRepoAt(a.repo);
  const { close } = gitExtension([repoA, gitRepoAt(b.repo)], slow.path);
  const locator = await VscodeGitLocator.create();
  assert.ok(locator);
  try {
    await wait(GIT_STARTED_MS);
    close.fire(repoA); // closed before git answered
    const under = (root: string) => stub.watchers.filter((w) => w.pattern.base.fsPath.startsWith(root));
    // The kept repository's watchers prove git has answered for both.
    await until(() => under(b.repo).length === 2);
    await new Promise((r) => setTimeout(r, 200));
    await settle();
    assert.equal(under(b.repo).filter((w) => !w.disposed).length, 2, "the open repository is watched");
    assert.deepEqual(liveOutside(b.repo), [], "nothing left watching the closed repository");
  } finally {
    locator!.dispose();
    removeTemp(a.dir);
    removeTemp(b.dir);
    removeTemp(slow.dir);
  }
});

test("a locator disposed while git is still answering leaves no live watchers", posixOnly, async () => {
  const slow = lateButCorrectGit();
  const a = newRepo("loc-disposed");
  const b = newRepo("loc-probe");
  gitExtension([gitRepoAt(a.repo)], slow.path);
  const disposed = await VscodeGitLocator.create();
  await wait(GIT_STARTED_MS);
  disposed!.dispose(); // disposed before git answered
  // A second locator on another repository: its watchers mark "git answered".
  gitExtension([gitRepoAt(b.repo)], slow.path);
  const probe = await VscodeGitLocator.create();
  try {
    const under = (root: string) => stub.watchers.filter((w) => w.pattern.base.fsPath.startsWith(root));
    await until(() => under(b.repo).length === 2);
    await new Promise((r) => setTimeout(r, 200));
    await settle();
    assert.deepEqual(liveOutside(b.repo), [], "nothing left watching for the disposed locator");
  } finally {
    probe!.dispose();
    removeTemp(a.dir);
    removeTemp(b.dir);
    removeTemp(slow.dir);
  }
});
