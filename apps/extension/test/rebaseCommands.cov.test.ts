// The interactive-rebase commands (rebaseCommands.ts) and the VS Code binding
// of the shared rebase driver (rebaseRunner.ts), against real repositories:
//
//  · Start Interactive Rebase refuses without a repository, over an operation
//    already stopped, and — when asked — over uncommitted changes; from the
//    palette it asks for the base, and a root commit is rebased with --root;
//    what it sends to the terminal is run here with a scripted todo editor,
//    and its Undo entry puts the branch back.
//  · Abort Rebase ends a stopped rebase, says so when there is nothing (or
//    something else) to abort, and reports git's refusal.
//  · Continue after an `edit` stop finishes the rebase; a failure reaches the
//    crash reporter unless it was the user's own state.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  workspace: unknown;
};
// The runner reads git.path; every setting answers its default.
vscode.workspace = { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) };
const terminals: { name?: string; cwd?: string; env?: Record<string, string>; text: string[]; shown: boolean }[] = [];
vscode.window.createTerminal = (opts: { name?: string; cwd?: string; env?: Record<string, string> }) => {
  const t = { ...opts, text: [] as string[], shown: false };
  terminals.push(t);
  return {
    show() {
      t.shown = true;
    },
    sendText(text: string) {
      t.text.push(text);
    },
    dispose() {},
  };
};
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { startInteractiveRebase, abortRebase } = require("../src/rebase/rebaseCommands") as typeof import("../src/rebase/rebaseCommands");
const runner = require("../src/rebase/rebaseRunner") as typeof import("../src/rebase/rebaseRunner");
const { nothingToAbortText } = require("../src/rebase/rebaseAbort") as typeof import("../src/rebase/rebaseAbort");
const { ErrorReporter } = require("../src/reporting/errorReporter") as typeof import("../src/reporting/errorReporter");
const { UndoLedger } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});

// Every failure the runner files, as the crash reporter would receive it.
const filed: { label: string; message: string }[] = [];
(ErrorReporter as unknown as { current: unknown }).current = {
  captureGitError: (label: string, message: string) => void filed.push({ label, message }),
};

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-rebase-cmds-cov-")));
const contexts: { dispose(): void }[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let seq = 0;
function fixture(commits = ["A", "B", "C"]) {
  const dir = join(scratch, `r${++seq}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const gitEnv = (env: Record<string, string>, ...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
  const git = (...args: string[]) => gitEnv({}, ...args);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  for (const c of commits) {
    writeFileSync(join(dir, `${c}.txt`), `${c}\n`);
    git("add", "-A");
    git("commit", "-qm", c);
  }
  const ctx = new GitContext({ root: dir });
  contexts.push(ctx);
  const entry = { root: dir, ctx };
  const state = new Map<string, unknown>();
  const context = { workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) } };
  const repos = { getActive: () => entry, getAll: () => [entry] } as never;
  const ledger = new UndoLedger(repos, context as never);
  const log = () => git("log", "--format=%s").split("\n");
  return { dir, git, gitEnv, ctx, entry, repos, ledger, log };
}
type Fx = ReturnType<typeof fixture>;

const noRepos = { getActive: () => undefined, getAll: () => [] } as never;

/** A sequence editor: `edit` runs over the todo's `lines` (forward slashes: git's sh eats backslashes). */
function sequenceEditor(edit: string): string {
  const p = join(scratch, `seq-${++seq}.cjs`);
  writeFileSync(
    p,
    `const fs = require("fs"); const t = process.argv[2]; let lines = fs.readFileSync(t, "utf8").split("\\n");\n` +
      `${edit}\nfs.writeFileSync(t, lines.join("\\n"));\n`,
  );
  return `node "${p.replace(/\\/g, "/")}"`;
}

/** Run what the launch typed into its terminal, with a scripted todo editor. */
function runTerminal(f: Fx, editor: string): void {
  const t = terminals[terminals.length - 1];
  assert.equal(t.text.length, 1, "the launch typed one command");
  const args = t.text[0].replace(/^git\s+/, "").split(/\s+/);
  f.gitEnv({ GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: "true" }, ...args);
}

/** Stop a rebase at an `edit` of the oldest of the last two commits. */
function stopAtEdit(f: Fx): void {
  f.gitEnv({ GIT_SEQUENCE_EDITOR: sequenceEditor(`lines[0] = lines[0].replace(/^pick/, "edit");`) }, "rebase", "-i", "HEAD~2");
  assert.ok(existsSync(join(f.dir, ".git", "rebase-merge")), "precondition: the rebase is stopped");
}

function said(kind: string): string[] {
  return vscode.__said.filter((s) => s.kind === kind).map((s) => s.message);
}

test("without a repository, both commands say so and launch nothing", async () => {
  vscode.__said.length = 0;
  const before = terminals.length;
  await startInteractiveRebase(noRepos, undefined as never);
  await abortRebase(noRepos);
  assert.deepEqual(said("info"), ["GitStudio: No repository is open.", "GitStudio: No repository is open."]);
  assert.equal(terminals.length, before);
});

test("Start over a rebase already stopped: sent to finish it, nothing launched", async () => {
  const f = fixture();
  stopAtEdit(f);
  vscode.__said.length = 0;
  const before = terminals.length;
  await startInteractiveRebase(f.repos, f.ledger, f.git("rev-parse", "HEAD"));
  assert.equal(said("warning").length, 1);
  assert.match(said("warning")[0], /rebase/i);
  assert.equal(terminals.length, before, "no second rebase stacked on the first");
  f.git("rebase", "--abort");
});

test("uncommitted changes: declining the warning launches nothing; accepting launches the rebase", async () => {
  const f = fixture();
  writeFileSync(join(f.dir, "A.txt"), "dirty\n");
  const before = terminals.length;
  asked = [];
  answer = () => undefined;
  await startInteractiveRebase(f.repos, f.ledger, f.git("rev-parse", "HEAD~1"));
  assert.equal(asked[0]?.kind, "confirm");
  assert.equal(asked[0]?.title, "You have uncommitted changes");
  assert.equal(terminals.length, before, "declined: no terminal");

  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await startInteractiveRebase(f.repos, f.ledger, f.git("rev-parse", "HEAD~1"));
  assert.equal(terminals.length, before + 1, "accepted: the rebase is launched");
  assert.equal(terminals[terminals.length - 1].text[0], `git rebase -i ${f.git("rev-parse", "HEAD~1")}^`, "the commit and everything after it");
});

test("from the palette it asks for the base (offering the repo's refs), and its Undo puts the branch back", async () => {
  const f = fixture(["base", "A", "B"]);
  const b = f.git("rev-parse", "HEAD");
  asked = [];
  answer = (spec) => (spec.kind === "input" ? "  HEAD~2  " : undefined);
  await startInteractiveRebase(f.repos, f.ledger);
  const input = asked.find((a) => a.kind === "input");
  assert.equal(input?.title, "Interactive rebase");
  assert.ok(
    input && "candidates" in input && input.candidates?.some((c) => c.name === "main"),
    "the base can be picked from the repo's branches",
  );
  const t = terminals[terminals.length - 1];
  assert.equal(t.text[0], "git rebase -i HEAD~2", "the typed base, trimmed");
  assert.equal(t.cwd, f.dir);
  assert.equal(t.env?.GIT_SEQUENCE_EDITOR, "code --wait", "git opens the todo in this window");
  assert.equal(t.env?.GIT_EDITOR, "code --wait", "and the messages too — never vi in a terminal");
  assert.equal(t.shown, true);

  runTerminal(f, sequenceEditor(`lines[0] = lines[0].replace(/^pick/, "drop");`));
  assert.deepEqual(f.log(), ["B", "base"], "the rebase dropped A");

  asked = [];
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await f.ledger.undoLast();
  assert.match(asked.find((a) => a.kind === "confirm")?.title ?? "", /^Undo "Interactive rebase onto HEAD~2"\?$/);
  assert.equal(f.git("rev-parse", "main"), b, "main is back at B");
});

test("a palette prompt dismissed launches nothing", async () => {
  const f = fixture();
  const before = terminals.length;
  answer = () => undefined;
  await startInteractiveRebase(f.repos, f.ledger);
  assert.equal(terminals.length, before);
});

test("the root commit has no parent, so it is rebased with --root", async () => {
  const f = fixture(["root", "A"]);
  answer = () => undefined;
  const root = f.git("rev-list", "--max-parents=0", "HEAD");
  await startInteractiveRebase(f.repos, f.ledger, root);
  assert.equal(terminals[terminals.length - 1].text[0], "git rebase -i --root");
  runTerminal(f, sequenceEditor(`lines = [lines[1], lines[0], ...lines.slice(2)];`));
  assert.deepEqual(f.log(), ["root", "A"], "the whole history, root included, was replayed in the new order");
});

test("Abort Rebase ends a stopped rebase and puts the branch back", async () => {
  const f = fixture();
  const head = f.git("rev-parse", "HEAD");
  stopAtEdit(f);
  vscode.__said.length = 0;
  await abortRebase(f.repos);
  assert.deepEqual(said("status"), ["$(discard) Rebase aborted"]);
  assert.equal(existsSync(join(f.dir, ".git", "rebase-merge")), false);
  assert.equal(f.git("symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("Abort Rebase with nothing — or a merge — stopped says so and aborts nothing", async () => {
  const f = fixture(["base"]);
  vscode.__said.length = 0;
  await abortRebase(f.repos);
  assert.deepEqual(said("info"), ["GitStudio: No rebase in progress."]);

  f.git("checkout", "-qb", "feature");
  writeFileSync(join(f.dir, "base.txt"), "feature\n");
  f.git("commit", "-qam", "feature");
  f.git("checkout", "-q", "main");
  writeFileSync(join(f.dir, "base.txt"), "main\n");
  f.git("commit", "-qam", "main");
  assert.notEqual(spawnSync("git", ["merge", "feature"], { cwd: f.dir }).status, 0, "the merge stops on a conflict");
  vscode.__said.length = 0;
  await abortRebase(f.repos);
  assert.deepEqual(said("info"), ["GitStudio: No rebase in progress — a merge is. Abort it from the Conflicts dashboard."]);
  assert.ok(existsSync(join(f.dir, ".git", "MERGE_HEAD")), "the merge is untouched");
  assert.equal(nothingToAbortText("stash"), "No rebase in progress.");
});

test("Abort Rebase reports git's refusal — and a patch series by its own name", async () => {
  const fake = (kind: string, outcome: { ok: boolean; message?: string }) => {
    const entry = { root: "/r", ctx: { operation: { view: async () => ({ kind }), abort: async () => outcome } } };
    return { getActive: () => entry, getAll: () => [entry] } as never;
  };
  vscode.__said.length = 0;
  await abortRebase(fake("rebase", { ok: false, message: "could not detach HEAD" }));
  await abortRebase(fake("am", { ok: false }));
  const errors = said("error");
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Abort rebase/);
  assert.match(errors[0], /could not detach HEAD/);
  assert.match(errors[1], /Abort \(git am\)/);
  assert.match(errors[1], /git refused/);
  await abortRebase(fake("am", { ok: true }));
  assert.deepEqual(said("status"), ["$(discard) Patch series abandoned"]);
});

test("Continue after an edit stop finishes the rebase; the runner sees it in progress until then", async () => {
  const f = fixture();
  const before = f.log();
  stopAtEdit(f);
  assert.equal(await runner.isRebaseInProgress(f.dir), true);
  filed.length = 0;
  const outcome = await runner.continueRebase(f.dir);
  assert.deepEqual(outcome, { status: "done" });
  assert.equal(await runner.isRebaseInProgress(f.dir), false);
  assert.deepEqual(f.log(), before, "the same commits, in the same order");
  assert.deepEqual(filed, [], "a finished rebase files nothing");
});

test("a Continue git refuses is filed with the crash reporter; the user's own state is not", async () => {
  const f = fixture();
  filed.length = 0;
  const outcome = await runner.continueRebase(f.dir);
  assert.equal(outcome.status, "failed");
  assert.equal(filed.length, 1);
  assert.equal(filed[0].label, "git rebase --continue failed");
  assert.ok(filed[0].message.length > 0);

  filed.length = 0;
  runner.reportRebaseFailure("x", { status: "failed", message: "You have unstaged changes.", expected: true });
  runner.reportRebaseFailure("x", { status: "stopped", reason: "conflict", message: "CONFLICT" });
  runner.reportRebaseFailure("x", { status: "done" });
  assert.deepEqual(filed, [], "expected failures, stops and successes are never crashes");
  runner.reportRebaseFailure("Interactive rebase plan refused", { status: "failed", message: "" });
  assert.deepEqual(filed, [{ label: "Interactive rebase plan refused", message: "Rebase failed." }]);
});
