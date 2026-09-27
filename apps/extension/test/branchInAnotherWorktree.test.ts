// A branch another worktree has checked out, through the REAL extension doors
// against real git (the Worktrees audit): git checks a branch out in one
// worktree at a time, and refuses the second checkout ("fatal: 'x' is already
// used by worktree at …") and the delete ("error: cannot delete branch 'x'
// used by worktree at …"). The doors ran git anyway and showed those words —
// Delete after asking "Delete branch x?" first, and the graph's chip through
// the error path that files crash reports. Now each door asks the worktrees
// first and says where the branch is, in words, before anything runs.
//
// The runner cannot load VS Code: vscodeStub.cjs stands in and records every
// message; the dialog host answers each question from the test's script.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
};
// The PR checkout runs inside a progress notification: run its task.
vscode.window.withProgress = (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
  task({ report: () => undefined }, { onCancellationRequested: () => undefined });
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const branchActions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const { runCommitAction, refActionId } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
const { checkoutPullRequest } = require("../src/pr/checkoutPr") as typeof import("../src/pr/checkoutPr");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";
import { configuredRemotes } from "./prGitWorld";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-elsewhere-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

// os.tmpdir()'s own spelling, never resolved — RUNNER~1 on a Windows runner,
// /var/… on macOS — while git says the disk's own; where a branch is is SHOWN
// in that, with the system's separators: realpathSync.native.
const scratch = mkdtempSync(join(tmpdir(), "gs-ext-elsewhere-"));
const contexts: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
let seq = 0;

let asked: DialogSpec[] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    return spec.kind === "confirm" ? { value: "ok" } : undefined;
  },
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * main checked out in app/; `feat` checked out in the linked worktree
 * wt/feat; and origin/feat beside it, so "Checkout origin/feat" means switch
 * to that same local branch.
 */
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
  const holder = join(base, "wt", "feat");
  git("worktree", "add", "-q", "-b", "feat", holder);
  git("remote", "add", "origin", join(base, "nowhere.git"));
  git("update-ref", "refs/remotes/origin/feat", "HEAD");
  const ctx = new GitContext({ root: app });
  contexts.push(ctx);
  const entry = { ctx, root: app };
  const repos = { getActive: () => entry, getUndoLedger: () => undefined } as never;
  asked = [];
  vscode.__said.length = 0;
  return { app, git, holder, ctx, repos, sha: git("rev-parse", "HEAD") };
}

const node = (name: string, type = "head") => ({ ref: { name, type, sha: "" } });
const said = (kind: string): string[] => vscode.__said.filter((m) => m.kind === kind).map((m) => m.message);
const noop = (): void => {};

test("Checkout of a branch another worktree has: says where, runs nothing — from the Branches view", async () => {
  const s = scene();
  await branchActions.checkoutBranch(s.repos, node("feat"), noop);
  assert.deepEqual(said("error"), [], "never git's words");
  const w = said("warning").join("\n");
  assert.match(w, /'feat' is checked out in the worktree at /);
  assert.ok(w.includes(`at ${realpathSync.native(s.holder)},`), w);
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/main");
});

test("…and from Checkout origin/feat, which lands on that same local branch", async () => {
  const s = scene();
  await branchActions.checkoutRemoteBranch(s.repos, node("origin/feat", "remote"), noop);
  assert.deepEqual(said("error"), []);
  assert.match(said("warning").join("\n"), /'feat' is checked out in the worktree at /);
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/main");
});

test("…and from the graph's branch chip, which files no crash report for it", async () => {
  const s = scene();
  const changed = await runCommitAction(refActionId("refs/heads/feat"), s.ctx, { sha: s.sha, subject: "" });
  assert.equal(changed, false);
  assert.deepEqual(said("error"), []);
  assert.match(said("warning").join("\n"), /'feat' is checked out in the worktree at /);
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/main");
});

test("Delete of a branch another worktree has: says so BEFORE asking, and the branch stays", async () => {
  const s = scene();
  await branchActions.deleteBranch(s.repos, node("feat"), noop);
  assert.equal(asked.length, 0, "no 'Delete branch feat?' for a delete git refuses");
  assert.deepEqual(said("error"), []);
  const w = said("warning").join("\n");
  assert.match(w, /'feat' is checked out in the worktree at .*, so it can't be deleted/);
  assert.equal(s.git("branch", "--list", "feat"), "+ feat");
});

test("its worktree's folder gone: git still holds the branch, so it says to forget that worktree — and offers nothing to open", async () => {
  const s = scene();
  rmSync(s.holder, { recursive: true, force: true });
  await branchActions.deleteBranch(s.repos, node("feat"), noop);
  await branchActions.checkoutBranch(s.repos, node("feat"), noop);
  assert.equal(asked.length, 0);
  assert.deepEqual(said("error"), []);
  const w = said("warning");
  assert.equal(w.length, 2);
  assert.match(w[0], /whose folder is gone — git still keeps the branch for it\. Forget that worktree in Worktrees, then delete it\./);
  assert.match(w[1], /Forget that worktree in Worktrees, then check it out\./);
  assert.equal(s.git("branch", "--list", "feat"), "+ feat");
});

test("a branch no worktree has is checked out and deleted as before", async () => {
  const s = scene();
  s.git("branch", "free");
  await branchActions.checkoutBranch(s.repos, node("free"), noop);
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/free");
  s.git("checkout", "-q", "main");
  await branchActions.deleteBranch(s.repos, node("free"), noop);
  assert.equal(s.git("branch", "--list", "free"), "");
  assert.deepEqual(said("error"), []);
  assert.deepEqual(said("warning"), []);
});

test("Checkout of a pull request whose branch another worktree has: says where, fetches nothing", async () => {
  const s = scene();
  // acme/app (a bare repository, reached by its github.com URL) carries the
  // PR's branch `topic`; a linked worktree has `topic` checked out, tracking it.
  const remote = join(s.app, "..", "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  s.git("config", `url.${remote}.insteadOf`, "https://github.com/acme/app.git");
  s.git("remote", "set-url", "origin", "https://github.com/acme/app.git");
  configuredRemotes(s.ctx, s.app);
  s.git("push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/topic");
  s.git("fetch", "-q", "origin");
  const prTree = join(s.app, "..", "wt", "topic");
  s.git("worktree", "add", "-q", "--track", "-b", "topic", prTree, "origin/topic");
  const before = s.git("rev-parse", "refs/heads/topic");
  const tracked = s.git("rev-parse", "refs/remotes/origin/topic");
  // The contributor pushes again: a fetch would move origin/topic.
  s.git("commit", "-q", "--allow-empty", "-m", "more");
  // (to the repository by its path: a push by the remote's name would move origin/topic itself)
  s.git("push", "-q", remote, "HEAD:refs/heads/topic");
  s.git("reset", "-q", "--hard", "HEAD~1");
  rmSync(join(s.git("rev-parse", "--absolute-git-dir"), "FETCH_HEAD"), { force: true }); // the setup's own fetch
  const repoContext = { owner: "acme", repo: "app", remoteName: "origin", entry: { ctx: s.ctx, root: s.app } };
  const pr = {
    number: 7,
    head: { ref: "topic", sha: before, repoFullName: "acme/app" },
    base: { ref: "main", repoFullName: "acme/app" },
  };
  await checkoutPullRequest(repoContext as never, pr as never);
  assert.deepEqual(said("error"), [], "never git's 'already used by worktree'");
  const w = said("warning").join("\n");
  assert.match(w, /'topic' is checked out in the worktree at /);
  // Where, in the disk's own spelling (git's), with the system's separators.
  assert.ok(w.includes(`at ${realpathSync.native(prTree)}`), w);
  assert.equal(s.git("rev-parse", "refs/heads/topic"), before);
  assert.equal(s.git("symbolic-ref", "HEAD"), "refs/heads/main");
  // Said BEFORE the fetch: nothing went to the network for a checkout that
  // cannot happen here.
  assert.equal(s.git("rev-parse", "refs/remotes/origin/topic"), tracked, "nothing was fetched");
  assert.equal(existsSync(join(s.git("rev-parse", "--absolute-git-dir"), "FETCH_HEAD")), false, "nothing was fetched");
});
