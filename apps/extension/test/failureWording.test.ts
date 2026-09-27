// What a failure says, from the doors people press — against real git.
//
// "A failure reads 'GitStudio: <Action> failed — <git's reason>'" was true of
// the Changes view and the status bar, and not of the doors this table
// presses: the graph's failures read "Cherry-pick failed: error: …" or "git
// branch failed: fatal: …" (no GitStudio, a colon, git's verb); about twenty
// branch actions showed git's stderr alone ("fatal: a branch named 'main'
// already exists", nobody's name, no action); a rebase refused over a stopped
// merge said "A merge is already in progress — …" with no GitStudio. The
// census in notifyStyle.test.ts holds the sources to the builders; this
// holds what the user is actually shown.
//
// Each cell makes the door fail for a reason of the repository's (a name
// that is taken, a lock another git holds, a remote that is not there, a
// merge commit picked without a parent), presses it with every question
// answered, and reads the one message it showed.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { __said: { kind: string; message: string }[] };
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { runCommitAction } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const branchActions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const { startInteractiveRebase } = require("../src/rebase/rebaseCommands") as typeof import("../src/rebase/rebaseCommands");
const { ErrorReporter } = require("../src/reporting/errorReporter") as typeof import("../src/reporting/errorReporter");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-failwording-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const filed: string[] = [];
(ErrorReporter as unknown as { current: unknown }).current = {
  captureGitError: (label: string) => filed.push(label),
  captureError: (where: string) => filed.push(where),
};
// Every question answered: a name box gets `answer`, a confirm says yes.
let answer = "ok";
registerDialogHost({ show: async () => ({ value: answer }) });

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-failwording-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/** main with two commits, a merged side branch (so HEAD~0 is a merge), a tag, and a branch "feature". */
function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(scratch, "cell-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "s.txt"), "s\n");
  git("add", ".");
  git("commit", "-q", "-m", "side");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-q", "-m", "two");
  git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  git("branch", "feature");
  git("tag", "v1");
  return { dir, git };
}

type Cell = {
  door: string;
  /** Make it fail; return the door, pressed. */
  press: (r: { dir: string; git: (...a: string[]) => string }) => Promise<void>;
  kind: "error" | "warning";
  says: RegExp;
};

const reposOf = (dir: string) => {
  const ctx = new GitContext({ root: dir });
  return { ctx, repos: { getActive: () => ({ ctx, root: dir }), getUndoLedger: () => undefined } as never };
};
const noop = (): void => {};

const CELLS: Cell[] = [
  {
    door: "graph: Cherry-Pick a merge commit",
    press: async ({ dir, git }) => {
      git("checkout", "-q", "-b", "elsewhere", "HEAD~2");
      const { ctx } = reposOf(dir);
      await runCommitAction("cherryPick", ctx, { sha: git("rev-parse", "main").trim(), subject: "merge side" } as never);
    },
    kind: "error",
    says: /^GitStudio: Cherry-pick failed — error: commit [0-9a-f]{40} is a merge but no -m option was given\./,
  },
  {
    door: "graph: Create Branch… with a name that is taken",
    press: async ({ dir, git }) => {
      answer = "feature";
      const { ctx } = reposOf(dir);
      await runCommitAction("branch", ctx, { sha: git("rev-parse", "HEAD~1").trim(), subject: "two" } as never);
    },
    kind: "error",
    says: /^GitStudio: Create branch failed — fatal: a branch named 'feature' already exists\.$/,
  },
  {
    door: "graph: Create Tag… with a name that is taken",
    press: async ({ dir, git }) => {
      answer = "v1";
      const { ctx } = reposOf(dir);
      await runCommitAction("tag", ctx, { sha: git("rev-parse", "HEAD~1").trim(), subject: "two" } as never);
    },
    kind: "error",
    says: /^GitStudio: Create tag failed — fatal: tag 'v1' already exists\.$/,
  },
  {
    door: "branches: Rename to a name that is taken",
    press: async ({ dir }) => {
      answer = "main";
      const { repos } = reposOf(dir);
      await branchActions.renameBranch(repos, { ref: { name: "feature", type: "head" } }, noop);
    },
    kind: "error",
    says: /^GitStudio: Rename branch failed — fatal: a branch named 'main' already exists\.$/,
  },
  {
    door: "branches: Delete Tag while another git holds its lock",
    press: async ({ dir }) => {
      answer = "ok";
      writeFileSync(join(dir, ".git", "refs", "tags", "v1.lock"), "");
      const { repos } = reposOf(dir);
      await branchActions.deleteTag(repos, { ref: { name: "v1", type: "tag" } }, noop);
    },
    kind: "error",
    says: /^GitStudio: Delete tag failed — error: .*v1\.lock/,
  },
  {
    door: "branches: Fetch from a remote that is not there",
    press: async ({ dir, git }) => {
      git("remote", "add", "origin", join(dir, "no-such-remote.git"));
      const { repos } = reposOf(dir);
      await branchActions.fetchAll(repos, noop);
    },
    kind: "error",
    says: /^GitStudio: Fetch failed — .*no-such-remote\.git/,
  },
  {
    door: "rebase: Interactive Rebase while a merge is stopped",
    press: async ({ dir, git }) => {
      git("checkout", "-q", "-b", "left", "HEAD~2");
      writeFileSync(join(dir, "a.txt"), "left\n");
      git("commit", "-q", "-am", "left");
      git("checkout", "-q", "-b", "right", "HEAD~1");
      writeFileSync(join(dir, "a.txt"), "right\n");
      git("commit", "-q", "-am", "right");
      try {
        git("merge", "-q", "left");
      } catch {
        /* stopped on the conflict, as wanted */
      }
      const { repos } = reposOf(dir);
      await startInteractiveRebase(repos, undefined as never);
    },
    kind: "warning",
    says: /^GitStudio: A merge is already in progress — continue or abort it first\.$/,
  },
];

for (const cell of CELLS) {
  test(`what a failure says — ${cell.door}`, async () => {
    const r = repo();
    vscode.__said.length = 0;
    await cell.press(r);
    const shown = vscode.__said.filter((m) => m.kind !== "status");
    assert.equal(shown.length, 1, `one message: ${JSON.stringify(shown)}`);
    assert.equal(shown[0].kind, cell.kind, shown[0].message);
    assert.match(shown[0].message, cell.says);
  });
}
