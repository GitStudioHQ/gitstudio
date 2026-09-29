// The gitstudio-rev: content provider and the diff openers built on it
// (revisionContentProvider.ts), against a real repository: what each side of a
// diff reads, which open documents are told to re-read after a staging op, and
// the titles and sides openRevisionDiff hands to vscode.diff.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as Record<string, unknown> & { commands: Record<string, unknown> };

interface FakeUri {
  scheme: string;
  path: string;
  query: string;
  fsPath: string;
}
const Uri = {
  file: (p: string): FakeUri => ({ scheme: "file", path: p, query: "", fsPath: p }),
  from: (o: { scheme: string; path: string; query?: string }): FakeUri => ({ ...o, query: o.query ?? "", fsPath: o.path }),
};
class EventEmitter<T> {
  listeners: ((v: T) => void)[] = [];
  disposed = false;
  event = (l: (v: T) => void) => {
    this.listeners.push(l);
    return { dispose() {} };
  };
  fire(v: T): void {
    for (const l of this.listeners) l(v);
  }
  dispose(): void {
    this.disposed = true;
  }
}
const openDocs: { uri: FakeUri }[] = [];
Object.assign(vscode, { Uri, EventEmitter, workspace: { textDocuments: openDocs } });
const diffs: { left: FakeUri; right: FakeUri; title: string; opts: unknown }[] = [];
vscode.commands.executeCommand = async (id: string, ...a: unknown[]) => {
  assert.equal(id, "vscode.diff");
  diffs.push({ left: a[0] as FakeUri, right: a[1] as FakeUri, title: a[2] as string, opts: a[3] });
};

const rc = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-revision-cov-")));
const ctxs: { dispose(): void }[] = [];
after(() => {
  for (const c of ctxs) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const dir = join(scratch, "repo");
execFileSync("git", ["init", "-q", "-b", "main", dir]);
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) git("config", k, v);
writeFileSync(join(dir, "a.txt"), "one\n");
git("add", "a.txt");
git("commit", "-qm", "add a");
const added = git("rev-parse", "HEAD");
writeFileSync(join(dir, "a.txt"), "two\n");
git("commit", "-qam", "edit a");
const edited = git("rev-parse", "HEAD");
writeFileSync(join(dir, "a.txt"), "staged\n");
git("add", "a.txt");
const ctx = new GitContext({ root: dir });
ctxs.push(ctx);
const entry = { root: dir, ctx };
const repos = { getActive: () => entry, getAll: () => [entry] } as never;
const none = { getActive: () => undefined, getAll: () => [] } as never;
const noCancel = { onCancellationRequested: () => ({ dispose() {} }) } as never;

test("each side of a diff reads the file at its revision: a commit, the index, nothing at all", async () => {
  const reader = new rc.RevisionContentProvider(repos);
  const read = (rev: string, rel = "a.txt") => reader.provideTextDocumentContent(rc.toRevisionUri(dir, rev, rel) as never, noCancel);
  assert.equal(await read(added), "one\n");
  assert.equal(await read(`${edited}~1`), "one\n");
  assert.equal(await read("HEAD"), "two\n");
  assert.equal(await read(""), "staged\n", "the index");
  assert.equal(await read(rc.EMPTY_TREE), "", "no file exists in the empty tree");
  assert.equal(await read(added, "missing.txt"), "", "a path the commit lacks reads as empty, not as an error");
  assert.equal(await read("not-a-revision"), "");
  // A read cancelled before git answered is an empty side, not an error toast.
  const cancelled = { onCancellationRequested: (cb: () => void) => (cb(), { dispose() {} }) } as never;
  assert.equal(await reader.provideTextDocumentContent(rc.toRevisionUri(dir, added, "a.txt") as never, cancelled), "");
  // Nothing open, nothing active: nothing to read with.
  const lost = new rc.RevisionContentProvider(none);
  assert.equal(await lost.provideTextDocumentContent(rc.toRevisionUri(dir, added, "a.txt") as never, noCancel), "");
});

test("after a staging op, only open diffs of the index and HEAD are told to re-read", () => {
  const reader = new rc.RevisionContentProvider(repos);
  const fired: FakeUri[] = [];
  reader.onDidChange((u) => void fired.push(u as unknown as FakeUri));
  const index = rc.toRevisionUri(dir, "", "a.txt") as unknown as FakeUri;
  const head = rc.toRevisionUri(dir, "HEAD", "a.txt") as unknown as FakeUri;
  const commit = rc.toRevisionUri(dir, added, "a.txt") as unknown as FakeUri;
  openDocs.push({ uri: index }, { uri: head }, { uri: commit }, { uri: Uri.file(join(dir, "a.txt")) });
  try {
    reader.notifyChanged();
    assert.deepEqual(fired, [index, head], "a commit never changes; a working file is VS Code's own");
    new rc.RevisionContentProvider(none).notifyChanged();
    assert.equal(fired.length, 2, "no repository: nothing to invalidate");
  } finally {
    openDocs.length = 0;
  }
  reader.dispose();
});

test("openRevisionDiff: a revision against the working file, or against another revision, titled by short names", async () => {
  diffs.length = 0;
  await rc.openRevisionDiff(dir, "src/deep/a.txt", `${edited}~1`);
  await rc.openRevisionDiff(`${dir}/`, "a.txt", "HEAD", added);
  await rc.openRevisionDiff(dir, "a.txt", "main", "v1.0", "Custom title");
  const [first, second, third] = diffs;
  assert.deepEqual(rc.fromRevisionUri(first.left as never), { root: dir, rev: `${edited}~1`, relPath: "src/deep/a.txt", readPath: "src/deep/a.txt" });
  assert.deepEqual(first.right, Uri.file(`${dir}/src/deep/a.txt`));
  assert.equal(first.title, `a.txt (${edited.slice(0, 7)} ↔ Working Tree)`, "the parent suffix dropped, the sha shortened");
  assert.deepEqual(first.opts, { preview: true });
  assert.deepEqual(rc.fromRevisionUri(second.right as never).rev, added);
  assert.equal(second.title, `a.txt (HEAD ↔ ${added.slice(0, 7)})`);
  assert.equal(third.title, "Custom title");
  assert.equal(rc.fromRevisionUri(third.left as never).rev, "main");
});

test("what one change did to a file: an added file has no before, a deleted one no after, a blame line its own names", () => {
  assert.deepEqual(rc.commitChangeSides({ sha: "s", parent: "p", path: "new.txt", status: "A" }), {
    left: { rev: rc.EMPTY_TREE, path: "new.txt" },
    right: { rev: "s", path: "new.txt" },
  });
  assert.deepEqual(rc.commitChangeSides({ sha: "s", parent: "p", path: "gone.txt", status: "D" }), {
    left: { rev: "p", path: "gone.txt" },
    right: { rev: rc.EMPTY_TREE, path: "gone.txt" },
  });
  assert.deepEqual(rc.blameChangeSides({ sha: "s", filename: "", previous: undefined } as never, "today.txt"), {
    left: { rev: rc.EMPTY_TREE, path: "today.txt" },
    right: { rev: "s", path: "today.txt" },
  });
  assert.deepEqual(rc.blameChangeSides({ sha: "s", filename: "then.txt", previous: { sha: "p", filename: "before.txt" } } as never, "today.txt"), {
    left: { rev: "p", path: "before.txt" },
    right: { rev: "s", path: "then.txt" },
  });
  // A working-tree side is the file itself.
  assert.deepEqual(rc.revisionSideUri(dir, "a.txt", { rev: undefined }), Uri.file(`${dir}/a.txt`));
  assert.deepEqual(rc.revisionSideUri(dir, "a.txt", { rev: undefined, path: "old.txt" }), Uri.file(`${dir}/old.txt`));
});
