// The Interactive Rebase workspace's HOST side (rebaseWorkspacePanel.ts) against
// real repositories: which commits it offers, when it refuses to open, and what
// each of the page's messages does to git — Start runs the plan (and Undo puts
// it back), a conflict stops with the banner's facts, Continue / Skip / Abort /
// Resolve Conflicts / Cancel each do what they say. The page's own script is
// exercised elsewhere (rebasePanelPage.ts); here the page is a message pipe.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Loader = (m: { exports: unknown }, filename: string) => void;
const M = Module as unknown as {
  _resolveFilename: (request: unknown, ...rest: unknown[]) => string;
  _extensions: Record<string, Loader>;
};
const resolve = M._resolveFilename;
M._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
// The panel imports the shared design tokens as text (esbuild inlines them);
// under the test runner a .css file is read the same way.
M._extensions[".css"] = (m, filename) => {
  m.exports = readFileSync(filename, "utf8");
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
  commands: Record<string, unknown>;
  workspace: unknown;
};
vscode.workspace = { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) };

interface FakePanel {
  title: string;
  html: string;
  posted: Record<string, unknown>[];
  disposed: boolean;
  send: (m: unknown) => Promise<void>;
  closeByUser: () => void;
}
const panels: FakePanel[] = [];
vscode.window.createWebviewPanel = (_type: string, title: string) => {
  let onMessage: ((m: unknown) => Promise<void>) | undefined;
  let onDispose: (() => void) | undefined;
  const p: FakePanel = {
    title,
    html: "",
    posted: [],
    disposed: false,
    send: (m) => onMessage!(m),
    closeByUser: () => onDispose?.(),
  };
  const webview = {
    cspSource: "vscode-resource:",
    asWebviewUri: (u: unknown) => u,
    set html(v: string) {
      p.html = v;
    },
    get html() {
      return p.html;
    },
    postMessage: async (m: Record<string, unknown>) => {
      if (p.disposed) throw new Error("Webview is disposed");
      p.posted.push(m);
      return true;
    },
    onDidReceiveMessage: (cb: (m: unknown) => Promise<void>) => {
      onMessage = cb;
      return { dispose() {} };
    },
  };
  panels.push(p);
  return {
    get webview() {
      if (p.disposed) throw new Error("Webview is disposed");
      return webview;
    },
    onDidDispose: (cb: () => void) => {
      onDispose = cb;
      return { dispose() {} };
    },
    dispose: () => {
      p.disposed = true;
    },
  };
};
const commandsRun: { id: string; args: unknown[] }[] = [];
let commandAnswer: (id: string, ...args: unknown[]) => unknown = () => undefined;
vscode.commands.executeCommand = async (id: string, ...args: unknown[]) => {
  commandsRun.push({ id, args });
  return commandAnswer(id, ...args);
};

const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { RebaseWorkspacePanel, toRebaseOutcome } =
  require("../src/rebase/rebaseWorkspacePanel") as typeof import("../src/rebase/rebaseWorkspacePanel");
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
const filed: { label: string; message: string }[] = [];
(ErrorReporter as unknown as { current: unknown }).current = {
  captureGitError: (label: string, message: string) => void filed.push({ label, message }),
};

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-rebase-panel-cov-")));
const contexts: { dispose(): void }[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let seq = 0;
function fixture() {
  const dir = join(scratch, `r${++seq}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  const ctx = new GitContext({ root: dir });
  contexts.push(ctx);
  const entry = { root: dir, ctx };
  const state = new Map<string, unknown>();
  const context = { workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) } };
  const repos = { getActive: () => entry, getAll: () => [entry] } as never;
  const ledger = new UndoLedger(repos, context as never);
  const log = () => git("log", "--format=%s").split("\n");
  return { dir, git, commit, ctx, entry, repos, ledger, log };
}
type Fx = ReturnType<typeof fixture>;

const extUri = { fsPath: "/ext" } as never;

/** Open the workspace; the panel it made, and the commits it offered (newest first). */
async function open(f: Fx, sha?: string, undo: unknown = f.ledger) {
  const before = panels.length;
  await RebaseWorkspacePanel.show(f.repos, undo as never, extUri, sha);
  assert.equal(panels.length, before + 1, "a panel opened");
  const p = panels[panels.length - 1];
  const m = /const DATA = (.*);\n/.exec(p.html);
  assert.ok(m, "the page carries its data");
  const data = JSON.parse(m[1]) as {
    base: string;
    branch: string;
    baseCommit: { shortSha: string; subject: string } | null;
    commits: { sha: string; shortSha: string; subject: string; author: string; rel: string }[];
  };
  return { p, data };
}

const rows = (commits: { sha: string; subject: string }[], action: (s: string) => string = () => "pick") =>
  commits.map((c) => ({ sha: c.sha, subject: c.subject, action: action(c.subject) }));

function said(kind: string): string[] {
  return vscode.__said.filter((s) => s.kind === kind).map((s) => s.message);
}

test("the workspace lists the commits after the base, newest first, under the branch and base they belong to", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  f.commit("B <script>", "b.txt"); // < and > cannot be in a Windows file name
  const { p, data } = await open(f, a);
  assert.equal(p.title, "Interactive Rebase");
  assert.deepEqual(data.commits.map((c) => c.subject), ["B <script>", "A"]);
  assert.equal(data.commits[1].sha, a);
  assert.equal(data.commits[1].shortSha, a.slice(0, 7));
  assert.equal(data.commits[1].author, "T");
  assert.equal(data.branch, "main");
  assert.equal(data.base, `${a.slice(0, 7)}^`);
  assert.deepEqual(data.baseCommit, { shortSha: f.git("log", "-1", "--format=%h", "HEAD~2"), subject: "base" });
  assert.ok(!/<script>"/.test(p.html.split("const DATA")[1].split(";\n")[0]), "a subject cannot close the page's script");
  assert.ok(p.html.includes(`<b class="rb-branch">main</b>`));
  await p.send({ type: "cancel" });
  assert.equal(p.disposed, true, "Cancel closes it");
});

test("a root commit is rebased with --root, and a detached HEAD is named as such", async () => {
  const f = fixture();
  const root = f.commit("root");
  f.commit("A");
  f.git("checkout", "-q", "--detach");
  const { p, data } = await open(f, root);
  assert.equal(data.base, "the root commit");
  assert.equal(data.baseCommit, null, "nothing below the root");
  assert.equal(data.branch, "detached HEAD");
  assert.deepEqual(data.commits.map((c) => c.subject), ["A", "root"]);
  p.closeByUser();
  assert.equal(p.disposed, true);
});

test("the workspace refuses to open without a repository, over a stopped operation, or with nothing to rebase", async () => {
  const before = panels.length;
  vscode.__said.length = 0;
  await RebaseWorkspacePanel.show({ getActive: () => undefined, getAll: () => [] } as never, undefined as never, extUri);
  assert.deepEqual(said("info"), ["GitStudio: No repository is open."]);

  const f = fixture();
  f.commit("base", "f.txt", "base\n");
  f.git("checkout", "-qb", "feature");
  const x = f.commit("X", "x.txt", "x\n");
  f.git("checkout", "-q", "main");
  f.git("cherry-pick", "-x", x); // -x: a different commit (same patch), even within one second
  // Palette: the base is asked for. Dismissed → nothing.
  asked = [];
  answer = () => undefined;
  await RebaseWorkspacePanel.show(f.repos, f.ledger, extUri);
  assert.equal(asked[0]?.title, "Interactive Rebase");
  // HEAD itself: nothing after it.
  vscode.__said.length = 0;
  answer = (s) => (s.kind === "input" ? "HEAD" : undefined);
  await RebaseWorkspacePanel.show(f.repos, f.ledger, extUri);
  assert.deepEqual(said("info"), ["GitStudio: No commits to rebase from that point."]);
  // Onto feature: main's only commit is X again, which a rebase would skip.
  vscode.__said.length = 0;
  answer = (s) => (s.kind === "input" ? "feature" : undefined);
  await RebaseWorkspacePanel.show(f.repos, f.ledger, extUri);
  assert.deepEqual(said("info"), [
    "GitStudio: Nothing to rebase — all 1 commit here are either merges or changes already on the base, which a rebase would skip.",
  ]);

  // A merge stopped on a conflict.
  f.git("checkout", "-q", "feature");
  f.commit("F", "f.txt", "feature\n");
  f.git("checkout", "-q", "main");
  f.commit("M", "f.txt", "main\n");
  try {
    f.git("merge", "feature");
  } catch {
    /* stops on the conflict */
  }
  vscode.__said.length = 0;
  await RebaseWorkspacePanel.show(f.repos, f.ledger, extUri, f.git("rev-parse", "HEAD"));
  assert.equal(said("warning").length, 1);
  assert.match(said("warning")[0], /merge/i);
  assert.equal(panels.length, before, "no panel opened in any of these");
  f.git("merge", "--abort");
});

test("over 200 commits it asks first; declined, nothing opens", async () => {
  const f = fixture();
  f.commit("base");
  let parent = f.git("rev-parse", "HEAD");
  const emptyTree = f.git("rev-parse", "HEAD^{tree}");
  for (let i = 0; i < 201; i++) {
    parent = execFileSync("git", ["commit-tree", emptyTree, "-p", parent, "-m", `c${i}`], {
      cwd: f.dir,
      encoding: "utf8",
    }).trim();
  }
  f.git("update-ref", "refs/heads/main", parent);
  const before = panels.length;
  asked = [];
  answer = () => undefined;
  await RebaseWorkspacePanel.show(f.repos, f.ledger, extUri, f.git("rev-parse", "HEAD~200"));
  assert.equal(asked[0]?.title, "Rebase 201 commits?");
  assert.equal(panels.length, before);
});

test("Start runs the plan in git — reordered, one dropped — closes the panel, and Undo puts it back", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  f.commit("B");
  const c = f.commit("C");
  const { p, data } = await open(f, a);
  vscode.__said.length = 0;
  // Newest first: A on top, C below it, B dropped → git replays C then A.
  const [cRow, bRow, aRow] = data.commits;
  await p.send({ type: "apply", rows: [aRow, cRow, { ...bRow, action: "drop" }].map((r) => ({ action: "pick", ...r })) });
  assert.deepEqual(p.posted.map((m) => m.type), ["result"]);
  assert.deepEqual((p.posted[0] as { outcome: unknown }).outcome, { status: "done" });
  assert.deepEqual(f.log(), ["A", "C", "base"]);
  assert.ok(said("status").includes("$(check) Rebase complete"));
  assert.equal(p.disposed, true, "a finished rebase closes the workspace");

  answer = (s) => (s.kind === "confirm" ? "ok" : undefined);
  asked = [];
  await f.ledger.undoLast();
  assert.match(asked.find((q) => q.kind === "confirm")?.title ?? "", /Interactive rebase onto [0-9a-f]{7}\^/);
  assert.equal(f.git("rev-parse", "HEAD"), c, "Undo put main back at C");
});

test("a plan git cannot run is refused before git runs — filed only when the page built it wrong", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  const head = f.commit("B");
  const { p, data } = await open(f, a);
  filed.length = 0;
  await p.send({ type: "apply", rows: rows(data.commits, () => "drop") });
  const refused = p.posted.pop() as { type: string; outcome: { status: string; expected?: boolean; message: string } };
  assert.equal(refused.type, "result");
  assert.equal(refused.outcome.status, "failed");
  assert.equal(refused.outcome.expected, true, "dropping everything is the user's own plan");
  assert.deepEqual(filed, [], "…so it is not a crash");

  await p.send({ type: "apply", rows: rows(data.commits, () => "explode") });
  const bad = p.posted.pop() as { outcome: { status: string; expected?: boolean } };
  assert.equal(bad.outcome.status, "failed");
  assert.notEqual(bad.outcome.expected, true);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].label, "Interactive rebase plan refused");
  assert.equal(f.git("rev-parse", "HEAD"), head, "git never ran");
  assert.equal(p.disposed, false, "the panel stays for another try");
});

test("a conflict stops with the banner's facts; Resolve Conflicts opens the dashboard; Abort ends it and closes", async () => {
  const f = fixture();
  f.commit("base", "f.txt", "base\n");
  const a = f.commit("A", "f.txt", "A\n");
  const b = f.commit("B", "f.txt", "B\n");
  const { p, data } = await open(f, a);
  // Newest first: B below A → git applies B onto base first, which conflicts.
  await p.send({ type: "apply", rows: rows([data.commits[1], data.commits[0]]) });
  const result = p.posted.pop() as { outcome: { status: string; reason?: string }; stop?: { conflicts: number; canSkip: boolean } };
  assert.equal(result.outcome.status, "stopped");
  assert.equal(result.outcome.reason, "conflict");
  assert.equal(result.stop?.conflicts, 1, "the banner can offer the Conflicts dashboard");
  assert.equal(p.disposed, false);

  commandsRun.length = 0;
  await p.send({ type: "resolveConflicts" });
  assert.deepEqual(commandsRun.map((c) => c.id), ["gitstudio.showConflicts"]);

  vscode.__said.length = 0;
  await p.send({ type: "abort" });
  assert.deepEqual(p.posted.pop(), { type: "aborted", ok: true });
  assert.deepEqual(said("status"), ["$(discard) Rebase aborted"]);
  assert.equal(p.disposed, true);
  assert.equal(existsSync(join(f.dir, ".git", "rebase-merge")), false);
  assert.equal(f.git("rev-parse", "HEAD"), b, "main is back where it was");
});

test("an edit stop is stopped, not failed; Continue finishes it and closes the panel", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  f.commit("B");
  const { p, data } = await open(f, a);
  await p.send({ type: "apply", rows: rows(data.commits, (s) => (s === "A" ? "edit" : "pick")) });
  const stop = p.posted.pop() as { outcome: { status: string; reason?: string }; stop?: { conflicts: number } };
  assert.equal(stop.outcome.status, "stopped");
  assert.equal(stop.outcome.reason, "edit");
  assert.equal(stop.stop?.conflicts, 0);
  await p.send({ type: "continue" });
  assert.deepEqual((p.posted.pop() as { outcome: unknown }).outcome, { status: "done" });
  assert.equal(p.disposed, true);
  assert.deepEqual(f.log(), ["B", "A", "base"]);
});

test("Skip goes through the shared operation verb, quietly, and reports what it came to", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  const { p } = await open(f, a);
  commandsRun.length = 0;
  commandAnswer = (id) => (id === "gitstudio.operation.skip" ? { ok: false, message: "nothing to skip", view: {} } : undefined);
  await p.send({ type: "skip" });
  assert.deepEqual(commandsRun, [{ id: "gitstudio.operation.skip", args: [{ root: f.dir, quiet: true }] }]);
  assert.deepEqual((p.posted.pop() as { outcome: unknown }).outcome, { status: "failed", message: "nothing to skip" });
  commandAnswer = () => ({ ok: true });
  await p.send({ type: "skip" });
  assert.equal(p.disposed, true, "a skip that finished the rebase closes the workspace");
  commandAnswer = () => undefined;
});

test("Abort with no rebase stopped aborts nothing, says so, and keeps the panel", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  const { p } = await open(f, a);
  vscode.__said.length = 0;
  await p.send({ type: "abort" });
  assert.deepEqual(p.posted.pop(), { type: "aborted", ok: false });
  assert.deepEqual(said("info"), ["GitStudio: No rebase in progress."]);
  assert.equal(p.disposed, false);
});

test("opening a second workspace closes the first", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  const first = (await open(f, a)).p;
  const second = (await open(f, a)).p;
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, false);
  await second.send({ type: "cancel" });
});

test("a step that throws is shown as failed; one that ends after the panel closed posts nothing", async () => {
  const f = fixture();
  f.commit("base");
  const a = f.commit("A");
  const throwing = { runWithUndo: async () => Promise.reject(new Error("snapshot exploded")) };
  const { p, data } = await open(f, a, throwing);
  await p.send({ type: "apply", rows: rows(data.commits) });
  assert.deepEqual((p.posted.pop() as { outcome: unknown }).outcome, { status: "failed", message: "snapshot exploded" });

  let release!: (v: unknown) => void;
  const slow = { runWithUndo: () => new Promise((r) => (release = r)) };
  const second = await open(f, a, slow);
  const pending = second.p.send({ type: "apply", rows: rows(second.data.commits) });
  second.p.closeByUser();
  release({ status: "done" });
  await pending; // would throw ("Webview is disposed") if it posted
  assert.deepEqual(second.p.posted, []);
});

test("a Skip's outcome, in the panel's terms", () => {
  assert.deepEqual(toRebaseOutcome(undefined), { status: "stopped", reason: "unknown", message: "" });
  assert.deepEqual(toRebaseOutcome({ ok: true } as never), { status: "done" });
  assert.deepEqual(toRebaseOutcome({ ok: false, stopped: true, message: "next", view: { pause: true } } as never), {
    status: "stopped",
    reason: "edit",
    message: "next",
  });
  assert.deepEqual(toRebaseOutcome({ ok: false, stopped: true, view: {} } as never), {
    status: "stopped",
    reason: "conflict",
    message: "",
  });
  assert.deepEqual(toRebaseOutcome({ ok: false, view: { continueBlocked: "resolve first" } } as never), {
    status: "failed",
    message: "resolve first",
  });
  assert.deepEqual(toRebaseOutcome({ ok: false, view: {} } as never), { status: "failed", message: "Git refused to skip." });
});
