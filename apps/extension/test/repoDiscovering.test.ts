// RepoManager says whether discovery has settled, so a view with no active
// repository can tell "not found yet" from "there is none".
//
// Until it did, the Changes view said "No repository open" (and, before its
// first state, "Working tree clean") while vscode.git was still scanning a
// folder whose repository sits below it — a rev-parse of the folder finds
// nothing there, and vscode.git's scan is what finds it.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeRepoStub.cjs") : resolve.call(this, request, ...rest);
};

interface Harness {
  setFolders(folders: { name: string; fsPath: string }[]): void;
  gitSettle(): void;
  reset(opts?: { repositories?: unknown[]; state?: "initialized" | "uninitialized" }): void;
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { __test: vs } = require("vscode") as { __test: Harness };
const { RepoManager } = require("../src/git/repoManager") as typeof import("../src/git/repoManager");
/* eslint-enable @typescript-eslint/no-require-imports */

/** A folder that is not a repository (a parent of checkouts, say). */
const plain = realpathSync(mkdtempSync(join(tmpdir(), "gs-repo-discovering-")));
mkdirSync(join(plain, "notes"));
after(() => rmSync(plain, { recursive: true, force: true }));

const live: { dispose(): void }[] = [];
after(() => live.forEach((m) => m.dispose()));

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("while vscode.git is still scanning, no repository is 'not found yet'; once it settles, it is 'none'", async () => {
  vs.reset({ state: "uninitialized" });
  vs.setFolders([{ name: "plain", fsPath: plain }]);
  const m = await RepoManager.create();
  live.push(m);
  await settle();
  assert.equal(m.getActive(), undefined);
  assert.equal(m.isDiscovering(), true, "vscode.git has not finished its first scan");

  let told = 0;
  m.onDidChange(() => told++);
  vs.gitSettle();
  await settle();
  assert.equal(m.isDiscovering(), false);
  assert.ok(told >= 1, "the views are told, so a waiting one can now say there is none");
});

test("with vscode.git already settled, discovery settles as soon as our own look is done", async () => {
  vs.reset({ state: "initialized" });
  vs.setFolders([{ name: "plain", fsPath: plain }]);
  const m = await RepoManager.create();
  live.push(m);
  await settle();
  assert.equal(m.getActive(), undefined);
  assert.equal(m.isDiscovering(), false);
});

test("a vscode.git that never finishes its first scan does not keep 'not found yet' for good", async () => {
  vs.reset({ state: "uninitialized" });
  vs.setFolders([{ name: "plain", fsPath: plain }]);
  const m = await RepoManager.create(undefined, { discoveryLimitMs: 300 });
  live.push(m);
  await settle(100);
  assert.equal(m.isDiscovering(), true, "still within the limit");
  let told = 0;
  m.onDidChange(() => told++);
  await settle(400);
  assert.equal(m.isDiscovering(), false, "past the limit: there is none, as far as anyone can tell");
  assert.ok(told >= 1, "and the views are told");
});
