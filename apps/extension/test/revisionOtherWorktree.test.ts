// A diff side names the folder it reads (`gitstudio-rev:…?root=`). For a
// worktree of this repository that this window has not opened — a Worktrees
// row, or the push review for it — that folder is not one of the window's
// repositories. The reader used to fall back to the ACTIVE repository then:
// harmless for a commit (the objects are shared), wrong for HEAD and the
// index, which are each worktree's own — the other worktree's staged file
// showed as this window's.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

class Disposable {
  dispose(): void {}
}
class EventEmitter<T> {
  event = (_l: (v: T) => void) => new Disposable();
  fire(_v: T): void {}
  dispose(): void {}
}
const vscodeStub = {
  Disposable,
  EventEmitter,
  Uri: {
    from: (o: { scheme: string; path: string; query?: string }) => ({ ...o, query: o.query ?? "", fsPath: o.path }),
    file: (p: string) => ({ scheme: "file", path: p, fsPath: p, query: "" }),
  },
  workspace: { textDocuments: [] },
};
type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB = join(tmpdir(), "__gs_revision_other_worktree_stub__.js");
M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
const orig = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : orig.call(this, request, parent, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports */
const { RevisionContentProvider, toRevisionUri } = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const cfg = join(mkdtempSync(join(tmpdir(), "gs-rev-wt-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-rev-wt-")));
const contexts: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("HEAD and the index of another worktree are read in THAT worktree, not the active repository", async () => {
  const app = join(scratch, "app");
  mkdirSync(app);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  git(scratch, "init", "-q", "-b", "main", app);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) git(app, "config", k, v);
  writeFileSync(join(app, "f.txt"), "base\n");
  git(app, "add", ".");
  git(app, "commit", "-qm", "base");
  const other = join(scratch, "other wt");
  git(app, "worktree", "add", "-q", "-b", "feature", other);
  writeFileSync(join(other, "f.txt"), "feature commit\n");
  git(other, "commit", "-qam", "feature");
  writeFileSync(join(other, "f.txt"), "feature staged\n");
  git(other, "add", "f.txt");
  writeFileSync(join(app, "f.txt"), "window staged\n");
  git(app, "add", "f.txt");

  const ctx = new GitContext({ root: app });
  contexts.push(ctx);
  const entry = { root: app, ctx };
  const reader = new RevisionContentProvider({ getAll: () => [entry], getActive: () => entry } as never);
  const token = { onCancellationRequested: () => new Disposable() } as never;
  const read = (root: string, rev: string) => reader.provideTextDocumentContent(toRevisionUri(root, rev, "f.txt") as never, token);

  assert.equal(await read(other, ""), "feature staged\n", "its index");
  assert.equal(await read(other, "HEAD"), "feature commit\n", "its HEAD");
  // The window's own repository is read as it always was.
  assert.equal(await read(app, ""), "window staged\n");
  assert.equal(await read(app, "HEAD"), "base\n");
  // A root that is not there falls back to the active repository, as before.
  assert.equal(await read(join(scratch, "gone"), "HEAD"), "base\n");
});
