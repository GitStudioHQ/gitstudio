// RepoManager's edges, against real repositories on disk and a vscode.git
// whose repositories the test opens (vscodeRepoStub.cjs): the git binary the
// user configured is the one eager discovery runs, a folder opened through a
// symlink keeps the path it was opened by, vscode.git reporting a repository
// twice binds it once, and the Undo ledger is handed through.

import Module from "node:module";
import { join } from "node:path";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeRepoStub.cjs") : resolve.call(this, request, ...rest);
};

type FakeRepo = { rootUri: { fsPath: string } };
interface Harness {
  repository(root: string): FakeRepo;
  setFolders(folders: { name: string; fsPath: string }[]): void;
  gitOpen(repo: FakeRepo): void;
  reset(opts?: { repositories?: FakeRepo[]; state?: "initialized" | "uninitialized" }): void;
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { __test: Harness; workspace: Record<string, unknown> };
const vs = vscode.__test;
const { RepoManager } = require("../src/git/repoManager") as typeof import("../src/git/repoManager");
/* eslint-enable @typescript-eslint/no-require-imports */
type Manager = import("../src/git/repoManager").RepoManager;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-repo-manager-cov-")));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  writeFileSync(join(dir, "f.txt"), "x\n");
  return dir;
}
const REPO = gitInit(join(scratch, "repo"));

const live: Manager[] = [];
const originalConfig = vscode.workspace.getConfiguration;
beforeEach(() => {
  while (live.length) live.pop()!.dispose();
  vscode.workspace.getConfiguration = originalConfig;
});
after(() => {
  while (live.length) live.pop()!.dispose();
});

async function until(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A window over `folders` with no repositories known to vscode.git (yet). */
async function window(folders: string[]): Promise<Manager> {
  vs.reset({ state: "initialized" });
  vs.setFolders(folders.map((f) => ({ name: f.split(/[\\/]/).pop()!, fsPath: f })));
  const m = await RepoManager.create();
  live.push(m);
  await until("discovery to settle", () => !m.isDiscovering());
  return m;
}

/** git.path, as the user's settings say it. */
function gitPathSetting(value: unknown): void {
  vscode.workspace.getConfiguration = (section?: string) => ({
    get: (key: string, fallback?: unknown) => (section === "git" && key === "path" ? value : fallback),
  });
}

test("eager discovery runs the git the user configured: a git.path that does not exist finds nothing", async () => {
  gitPathSetting(join(scratch, "no-such-git"));
  const m = await window([REPO]);
  assert.equal(m.getActive(), undefined);
  assert.deepEqual(m.getAll(), []);
});

test("a git.path given as a list uses its first entry", async () => {
  gitPathSetting([join(scratch, "no-such-git"), "git"]);
  const m = await window([REPO]);
  assert.equal(m.getActive(), undefined, "the first entry is the one run");
  gitPathSetting(["git"]);
  const found = await window([REPO]);
  assert.equal(found.getActive()?.root, REPO);
});

test("an empty git.path falls back to git on PATH", async () => {
  gitPathSetting("");
  const m = await window([REPO]);
  assert.equal(m.getActive()?.root, REPO);
});

test("a folder opened through a symlink keeps the path it was opened by", { skip: process.platform === "win32" }, async () => {
  const link = join(scratch, "linked");
  try {
    symlinkSync(REPO, link);
  } catch {
    return; // no symlinks here: nothing to test
  }
  const m = await window([link]);
  assert.equal(m.getActive()?.root, link, "vscode.git reports the opened path, so the eager binding must match it");
});

test("vscode.git reporting the same repository twice binds it once, keeping the first handle", async () => {
  const m = await window([]);
  const first = vs.repository(REPO);
  vs.gitOpen(first);
  await until("the repository", () => m.getAll().length === 1);
  vs.gitOpen(vs.repository(REPO));
  assert.equal(m.getAll().length, 1);
  assert.equal(m.getAll()[0].repo, first as never);
});

test("the Undo ledger set at activation is the one every door gets back", async () => {
  const m = await window([]);
  assert.equal(m.getUndoLedger(), undefined);
  const ledger = { runWithUndo: async <T>(_r: unknown, _l: string, fn: () => Promise<T>) => fn() };
  m.setUndoLedger(ledger);
  assert.equal(m.getUndoLedger(), ledger);
});
