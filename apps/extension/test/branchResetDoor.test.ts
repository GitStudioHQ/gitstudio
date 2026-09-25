// "Reset to 'origin/feature'…" (issue #32) through the REAL extension doors —
// the branch menu's command, the branch menu's "Checkout origin/x", the
// graph's ref chip — and the REAL Undo ledger, against real git.
//
// The engine is pinned cell by cell in packages/git-service/test/
// branchReset.test.ts. This is what the person sees and gets: which question
// is asked (and whether one is), what each answer does to the repository,
// what the envelope records, and that Undo (Ctrl/Cmd+Alt+G Z → undoLast)
// puts the branch back — the checked-out one with its uncommitted work, the
// other one without touching HEAD — rather than offering to REVERT the
// remote's commits, which is what the generic undo path offers once HEAD
// sits on a pushed commit.
//
// The runner cannot load VS Code: vscodeStub.cjs stands in and records every
// message; the dialog host answers each question from the test's script.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const branchActions = require("../src/views/branchActions") as typeof import("../src/views/branchActions");
const { runCommitAction, refActionId } = require("../src/graph/commitActions") as typeof import("../src/graph/commitActions");
const { UndoLedger } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-reset-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-reset-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let seq = 0;

// ── The dialog host: every question is recorded and answered by `answer`. ──
let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function identify(g: (...a: string[]) => string): void {
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    g("config", k, v);
  }
}

interface Cell {
  dir: string;
  git: (...a: string[]) => string;
  ctx: InstanceType<typeof GitContext>;
  repos: never;
  ledger: InstanceType<typeof UndoLedger>;
  entry: { ctx: InstanceType<typeof GitContext>; root: string };
}

/**
 * origin has main and feature; the work clone has both, tracking. The remote
 * then gains two commits on feature (not fetched), and the local feature gets
 * three of its own — diverged, the "messy branch" of the report.
 */
function cell(opts: { diverged?: boolean } = { diverged: true }): Cell {
  const base = join(scratch, `c${++seq}`);
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(base, "seed");
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
  const s = at(seed);
  identify(s);
  writeFileSync(join(seed, "f.txt"), "base\n");
  s("add", ".");
  s("commit", "-qm", "base");
  s("push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/feature");
  const dir = join(base, "work");
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  const git = at(dir);
  identify(git);
  git("branch", "-q", "--track", "feature", "refs/remotes/origin/feature");
  if (opts.diverged) {
    s("checkout", "-q", "-b", "feature", "origin/feature");
    writeFileSync(join(seed, "f.txt"), "remote\n");
    s("commit", "-qam", "remote one");
    s("commit", "-q", "--allow-empty", "-m", "remote two");
    s("push", "-q", "origin", "feature");
    const tip = git("rev-parse", "refs/heads/feature");
    const tree = git("rev-parse", `${tip}^{tree}`);
    let parent = tip;
    for (const m of ["mess one", "mess two", "mess three"]) parent = git("commit-tree", tree, "-p", parent, "-m", m);
    git("update-ref", "refs/heads/feature", parent);
  }
  const ctx = new GitContext({ root: dir });
  const entry = { ctx, root: dir };
  const state = new Map<string, unknown>();
  const context = {
    workspaceState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => void state.set(k, v),
    },
  };
  let ledger: InstanceType<typeof UndoLedger> | undefined;
  const repos = { getActive: () => entry, getUndoLedger: () => ledger } as never;
  ledger = new UndoLedger(repos, context as never);
  return { dir, git, ctx, repos, ledger, entry };
}

function reset(): void {
  asked = [];
  vscode.__said.length = 0;
}
const node = (name: string, type = "head") => ({ ref: { name, type, sha: "" } });
const said = (kind: string): string[] => vscode.__said.filter((m) => m.kind === kind).map((m) => m.message);
const confirmFor = (title: RegExp, value = "ok") => (spec: DialogSpec): string | undefined =>
  title.test(spec.title) ? value : undefined;

test("the menu's Reset on a branch that is not checked out: asks, resets it alone, and Undo puts it back", async () => {
  const c = cell();
  try {
    reset();
    const before = c.git("rev-parse", "refs/heads/feature");
    writeFileSync(join(c.dir, "f.txt"), "my edit on main\n");
    answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
    await branchActions.resetBranchToUpstream(c.repos, node("feature"), () => {});

    assert.equal(asked.length, 1, asked.map((a) => a.title).join(" | "));
    const q = asked[0] as DialogSpec & { kind: "confirm" };
    assert.equal(q.kind, "confirm");
    assert.equal(q.title, "Reset 'feature' to 'origin/feature'?");
    assert.equal(q.danger, true);
    assert.equal(q.confirmLabel, "Reset");
    assert.match(q.message, /3 commits on 'feature' are not on 'origin\/feature'/);
    assert.match(q.message, /mess three\n.*mess two\n.*mess one/, "by subject, newest first");
    assert.match(q.message, /also gets the 2 commits on 'origin\/feature'/, "counted after the fetch");
    assert.doesNotMatch(q.message, /Uncommitted/, "main's edit is not feature's business");

    const remote = c.git("rev-parse", "refs/remotes/origin/feature");
    assert.equal(c.git("rev-parse", "refs/heads/feature"), remote, "feature is origin/feature");
    assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(readFileSync(join(c.dir, "f.txt"), "utf8"), "my edit on main\n");
    assert.ok(said("status").some((m) => /Reset feature to origin\/feature/.test(m)), said("status").join(" | "));
    assert.ok(said("info").some((m) => /Undid\? Reset feature to origin\/feature/.test(m)), "the Undo toast");
    assert.deepEqual(said("error"), []);

    reset();
    answer = confirmFor(/^Undo "Reset feature to origin\/feature"\?$/);
    await c.ledger.undoLast();
    assert.equal(asked.map((a) => a.title).join(" | "), 'Undo "Reset feature to origin/feature"?');
    assert.match((asked[0] as { message: string }).message, new RegExp(`^'feature' goes back to ${before.slice(0, 7)}\\.`));
    assert.equal(c.git("rev-parse", "refs/heads/feature"), before, "Undo put the branch back");
    assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(readFileSync(join(c.dir, "f.txt"), "utf8"), "my edit on main\n", "and never touched this working tree");
    assert.deepEqual(said("error"), []);
  } finally {
    c.ctx.dispose();
  }
});

test("the menu's Reset on the checked-out branch with uncommitted edits: Undo brings back the branch AND the edits", async () => {
  const c = cell();
  try {
    c.git("checkout", "-q", "feature");
    const before = c.git("rev-parse", "HEAD");
    writeFileSync(join(c.dir, "f.txt"), "my uncommitted edit\n");
    reset();
    answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
    await branchActions.resetBranchToUpstream(c.repos, node("feature"), () => {});
    const q = asked[0] as DialogSpec & { kind: "confirm" };
    assert.match(q.message, /Uncommitted changes to 1 file are discarded\./);
    assert.match(q.message, /Undo can put the branch back, with your uncommitted changes\./);
    assert.equal(c.git("rev-parse", "HEAD"), c.git("rev-parse", "refs/remotes/origin/feature"));
    assert.equal(c.git("status", "--porcelain"), "");

    reset();
    answer = confirmFor(/^Undo /);
    await c.ledger.undoLast();
    // Not '"Reset …" has already been pushed' and a Revert of the remote's
    // commits: HEAD is on a pushed commit, but the reset published nothing.
    assert.deepEqual(asked.map((a) => a.title), ['Undo "Reset feature to origin/feature"?']);
    assert.match((asked[0] as { message: string }).message, /The uncommitted changes you had then come back too\./);
    assert.equal(c.git("rev-parse", "HEAD"), before, "the branch is back");
    assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/feature");
    assert.equal(readFileSync(join(c.dir, "f.txt"), "utf8"), "my uncommitted edit\n", "and so is the edit");
    assert.deepEqual(said("error"), []);
  } finally {
    c.ctx.dispose();
  }
});

test("nothing to lose and nothing to gain: said, not asked — and nothing is recorded to undo", async () => {
  const c = cell({ diverged: false });
  try {
    reset();
    answer = () => "ok";
    await branchActions.resetBranchToUpstream(c.repos, node("feature"), () => {});
    assert.deepEqual(asked, [], "no question");
    assert.ok(said("info").some((m) => /'feature' already matches 'origin\/feature'\. Nothing to reset\./.test(m)), said("info").join(" | "));
    reset();
    await c.ledger.undoLast();
    assert.ok(said("info").includes("Nothing to undo."));
  } finally {
    c.ctx.dispose();
  }
});

test("backing out of the question changes nothing and records nothing", async () => {
  const c = cell();
  try {
    const before = c.git("rev-parse", "refs/heads/feature");
    reset();
    answer = () => undefined; // Cancel
    await branchActions.resetBranchToUpstream(c.repos, node("feature"), () => {});
    assert.equal(asked.length, 1);
    assert.equal(c.git("rev-parse", "refs/heads/feature"), before);
    reset();
    await c.ledger.undoLast();
    assert.ok(said("info").includes("Nothing to undo."));
  } finally {
    c.ctx.dispose();
  }
});

test("refused, in words, before anything is asked: no upstream; checked out in another worktree", async () => {
  const c = cell();
  try {
    c.git("branch", "-q", "--no-track", "topic", "main");
    reset();
    answer = () => "ok";
    await branchActions.resetBranchToUpstream(c.repos, node("topic"), () => {});
    assert.deepEqual(asked, []);
    assert.ok(said("warning").some((m) => /'topic' doesn't track a remote branch/.test(m)), said("warning").join(" | "));

    const wt = join(scratch, `wt${++seq}`);
    c.git("worktree", "add", "-q", wt, "feature");
    const before = c.git("rev-parse", "refs/heads/feature");
    reset();
    await branchActions.resetBranchToUpstream(c.repos, node("feature"), () => {});
    assert.deepEqual(asked, []);
    assert.ok(
      said("warning").some((m) => m.includes(`'feature' is checked out in another worktree, at ${realpathSync(wt)}.`)),
      said("warning").join(" | "),
    );
    assert.equal(c.git("rev-parse", "refs/heads/feature"), before);
  } finally {
    c.ctx.dispose();
  }
});

test("'Checkout origin/feature' over a messy local feature: offers the reset; each answer does what it says", async () => {
  // Reset, then the checkout — and Undo puts the branch back where it stands.
  {
    const c = cell();
    try {
      c.git("fetch", "-q", "origin");
      const before = c.git("rev-parse", "refs/heads/feature");
      reset();
      answer = (spec) => (spec.kind === "pick" ? "reset" : spec.kind === "confirm" ? "ok" : undefined);
      await branchActions.checkoutRemoteBranch(c.repos, node("origin/feature", "remote"), () => {});
      const pick = asked[0] as DialogSpec & { kind: "pick" };
      assert.equal(pick.kind, "pick");
      assert.equal(pick.title, "Check out 'origin/feature'");
      assert.equal(
        pick.hint,
        "A local 'feature' already exists, with 3 commits that 'origin/feature' doesn't have, and 'origin/feature' has 2 commits it doesn't.",
      );
      assert.deepEqual(pick.choices.map((ch) => ch.label), ["Switch to local 'feature'", "Reset 'feature' to 'origin/feature'…"]);
      assert.deepEqual(pick.choices.map((ch) => !!ch.danger), [false, true]);
      assert.equal(asked[1].title, "Reset 'feature' to 'origin/feature'?");
      assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/feature", "then checked out");
      assert.equal(c.git("rev-parse", "HEAD"), c.git("rev-parse", "refs/remotes/origin/feature"));
      assert.equal(c.git("status", "--porcelain"), "");

      reset();
      answer = confirmFor(/^Undo /);
      await c.ledger.undoLast();
      assert.match((asked[0] as { message: string }).message, /It is checked out, so its files change with it; your uncommitted changes are kept\./);
      assert.equal(c.git("rev-parse", "refs/heads/feature"), before, "the messy commits are back");
      assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/feature");
      assert.deepEqual(said("error"), []);
    } finally {
      c.ctx.dispose();
    }
  }
  // Switch: today's behaviour, the local branch as it is.
  {
    const c = cell();
    try {
      c.git("fetch", "-q", "origin");
      const before = c.git("rev-parse", "refs/heads/feature");
      reset();
      answer = (spec) => (spec.kind === "pick" ? "checkout" : undefined);
      await branchActions.checkoutRemoteBranch(c.repos, node("origin/feature", "remote"), () => {});
      assert.equal(asked.length, 1);
      assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/feature");
      assert.equal(c.git("rev-parse", "HEAD"), before, "nothing reset");
    } finally {
      c.ctx.dispose();
    }
  }
  // Cancel: nothing at all.
  {
    const c = cell();
    try {
      c.git("fetch", "-q", "origin");
      reset();
      answer = () => undefined;
      await branchActions.checkoutRemoteBranch(c.repos, node("origin/feature", "remote"), () => {});
      assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/main");
    } finally {
      c.ctx.dispose();
    }
  }
});

test("'Checkout origin/feature' over a local feature with nothing of its own: no question, as before", async () => {
  const c = cell({ diverged: false });
  try {
    reset();
    answer = () => "ok";
    await branchActions.checkoutRemoteBranch(c.repos, node("origin/feature", "remote"), () => {});
    assert.deepEqual(asked, []);
    assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/feature");
  } finally {
    c.ctx.dispose();
  }
});

test("the graph's 'Checkout origin/feature' chip asks the same question, and resets under the same Undo", async () => {
  const c = cell();
  try {
    c.git("fetch", "-q", "origin");
    const before = c.git("rev-parse", "refs/heads/feature");
    reset();
    answer = (spec) => (spec.kind === "pick" ? "reset" : spec.kind === "confirm" ? "ok" : undefined);
    const undo = <T>(label: string, fn: () => Promise<T>, opts?: { branch?: string }) =>
      c.ledger.runWithUndo(c.entry as never, label, fn, opts);
    const sha = c.git("rev-parse", "refs/remotes/origin/feature");
    const changed = await runCommitAction(refActionId("refs/remotes/origin/feature"), c.ctx, { sha, subject: "" }, undo);
    assert.equal(changed, true);
    assert.deepEqual(asked.map((a) => a.title), ["Check out 'origin/feature'", "Reset 'feature' to 'origin/feature'?"]);
    assert.equal(c.git("symbolic-ref", "HEAD"), "refs/heads/feature");
    assert.equal(c.git("rev-parse", "HEAD"), sha);
    reset();
    answer = confirmFor(/^Undo "Reset feature to origin\/feature"\?$/);
    await c.ledger.undoLast();
    assert.equal(c.git("rev-parse", "refs/heads/feature"), before);
  } finally {
    c.ctx.dispose();
  }
});
