import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";

// The question Merge and Rebase ask from a branch's actions (and the Branches
// view), through the real branchActions doors with `vscode` and ui/dialogs
// swapped for stand-ins, against a real repository. On a detached HEAD the
// branch menu offers "Merge 'origin/main' into HEAD (a1b2c3d)" — and the
// question then asked about "the current branch", which does not exist, and
// warned that the next push would need a force, with no branch to push. It
// names HEAD as the item did, says the result is on no branch, and leaves the
// push out; on a branch it asks what it always asked.

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-mrd-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

const asked: { title: string; message: string }[] = [];
const vscodeStub = {
  // branchActions reaches the Worktrees view (its rows are TreeItems) at load.
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ThemeColor: class {},
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire(): void {}
    dispose(): void {}
  },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
  },
  commands: { executeCommand: async () => undefined },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
};
const dialogsStub = {
  // Declined: only the question is under test, and nothing runs after a No.
  promptConfirm: async (spec: { title: string; message: string }) => {
    asked.push({ title: spec.title, message: spec.message });
    return false;
  },
  promptPick: async () => undefined,
  promptInput: async () => undefined,
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB_VSCODE = join(tmpdir(), "__gs_mrd_vscode_stub__.js");
const STUB_DIALOGS = join(tmpdir(), "__gs_mrd_dialogs_stub__.js");
const origResolve = M._resolveFilename;

/* eslint-disable @typescript-eslint/no-explicit-any */
let mergeBranchIntoCurrent: any;
let rebaseCurrentOnto: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let repo: string;
let ctx: GitContext;
let head = "";
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  M._cache[STUB_VSCODE] = { id: STUB_VSCODE, filename: STUB_VSCODE, loaded: true, exports: vscodeStub };
  M._cache[STUB_DIALOGS] = { id: STUB_DIALOGS, filename: STUB_DIALOGS, loaded: true, exports: dialogsStub };
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    if (request === "vscode") return STUB_VSCODE;
    const r = origResolve.call(this, request, parent, ...rest);
    return /[\\/]src[\\/]ui[\\/]dialogs\.ts$/.test(r) ? STUB_DIALOGS : r;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ mergeBranchIntoCurrent, rebaseCurrentOnto } = require("../src/views/branchActions"));

  repo = mkdtempSync(join(tmpdir(), "gs-ext-mrd-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  git("config", "gc.auto", "0");
  writeFileSync(join(repo, "f.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "feature");
  writeFileSync(join(repo, "g.txt"), "two\n");
  git("add", ".");
  git("commit", "-qm", "two");
  ctx = new GitContext({ root: repo });
});

after(() => {
  M._resolveFilename = origResolve;
  delete M._cache[STUB_VSCODE];
  delete M._cache[STUB_DIALOGS];
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const repos = () => ({ getActive: () => ({ root: repo, ctx }) });
const feature = { ref: { name: "feature", type: "head", fullName: "refs/heads/feature" } };

async function ask(run: typeof mergeBranchIntoCurrent): Promise<{ title: string; message: string }> {
  asked.length = 0;
  await run(repos(), feature, () => {});
  assert.equal(asked.length, 1, "one question");
  return asked[0];
}

test("on a detached HEAD, Merge and Rebase ask about HEAD at its commit, with no push to force", async () => {
  git("checkout", "-q", "--detach", "main");
  head = git("rev-parse", "--short=7", "HEAD");

  const merge = await ask(mergeBranchIntoCurrent);
  assert.equal(merge.title, `Merge feature into HEAD (${head})?`);
  assert.doesNotMatch(merge.title + merge.message, /current branch/);
  assert.match(merge.message, /no branch/, `it says the result is on no branch: ${merge.message}`);

  const rebase = await ask(rebaseCurrentOnto);
  assert.equal(rebase.title, `Rebase HEAD (${head}) onto feature?`);
  assert.doesNotMatch(rebase.title + rebase.message, /current branch|push|force/i, rebase.message);
  assert.match(rebase.message, /no branch/, `it says the result is on no branch: ${rebase.message}`);
});

test("on a branch, they ask what they always asked", async () => {
  git("checkout", "-q", "main");
  const merge = await ask(mergeBranchIntoCurrent);
  assert.equal(merge.title, "Merge feature into the current branch?");
  const rebase = await ask(rebaseCurrentOnto);
  assert.equal(rebase.title, "Rebase the current branch onto feature?");
  assert.match(rebase.message, /the next push needs a force/);
});
