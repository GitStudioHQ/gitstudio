// The git-rebase-todo editor (RebaseTodoEditorProvider) end to end: the plan
// git hands it is the one real git writes, the webview's Start is written back
// into the document, and the text it writes is then run by real git — so a
// reorder, a retype and a dropped row are checked by what the branch looks
// like afterwards, not by the text alone. Abort clears the plan to a no-op and
// hands over to the Abort Rebase command; a refused edit says so and saves
// nothing; our own write echoing back does not re-render the list.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RebaseInitMessage } from "@gitstudio/host-bridge/rebaseProtocol";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as Record<string, unknown> & {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
  commands: Record<string, unknown>;
};

// What the provider reaches for, made real enough to observe.
let changeListener: ((e: { document: FakeDoc }) => void) | undefined;
let changeSubDisposed = 0;
let applyEditAnswer = true;
const commandsRun: string[] = [];
class Range {
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}
}
class WorkspaceEdit {
  readonly replaced: { uri: unknown; range: Range; text: string }[] = [];
  replace(uri: unknown, range: Range, text: string): void {
    this.replaced.push({ uri, range, text });
  }
}
vscode.Range = Range;
vscode.WorkspaceEdit = WorkspaceEdit;
vscode.workspace = {
  onDidChangeTextDocument: (l: (e: { document: FakeDoc }) => void) => {
    changeListener = l;
    return { dispose: () => void changeSubDisposed++ };
  },
  applyEdit: async (edit: WorkspaceEdit) => {
    if (!applyEditAnswer) return false;
    for (const r of edit.replaced) {
      const doc = r.uri as unknown as { owner: FakeDoc };
      doc.owner.text = doc.owner.text.slice(0, r.range.start) + r.text + doc.owner.text.slice(r.range.end);
    }
    return true;
  },
};
vscode.commands.executeCommand = async (id: string) => {
  commandsRun.push(id);
  return undefined;
};
vscode.window.registerCustomEditorProvider = (_type: string, p: unknown) => {
  registered = p as Provider;
  return { dispose() {} };
};
let registered: Provider | undefined;
type Provider = { resolveCustomTextEditor: (...a: unknown[]) => void };

const { RebaseTodoEditorProvider } =
  require("../src/rebase/rebaseTodoEditor") as typeof import("../src/rebase/rebaseTodoEditor");
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
/* eslint-enable @typescript-eslint/no-require-imports */

let confirmAnswer: string | undefined;
const confirmsAsked: string[] = [];
registerDialogHost({
  show: async (spec) => {
    confirmsAsked.push(spec.title);
    return confirmAnswer === undefined ? undefined : { value: confirmAnswer };
  },
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-todo-editor-cov-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

let seq = 0;
/** A repository with commits c1..c4 (f<n> = "<n>"). */
function repo(): string {
  const name = `r${++seq}`;
  const dir = join(scratch, name);
  git(scratch, ["init", "-q", "-b", "main", name]);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git(dir, ["config", k, v]);
  }
  for (const n of [1, 2, 3, 4]) {
    writeFileSync(join(dir, `f${n}`), `${n}\n`);
    git(dir, ["add", `f${n}`]);
    git(dir, ["commit", "-q", "-m", `c${n}`]);
  }
  return dir;
}

/** A sequence editor running `body` with `todo` = the todo's path (forward slashes: git's sh eats backslashes). */
function editor(body: string): string {
  const path = join(scratch, `ed${++seq}.cjs`);
  writeFileSync(path, `const fs = require("fs"); const todo = process.argv[2];\n${body}\n`);
  return `node "${path.replace(/\\/g, "/")}"`;
}

/** The todo real git writes for `git rebase -i HEAD~3` (the rebase itself then runs unchanged). */
function realTodo(dir: string): string {
  const snap = join(scratch, `todo${++seq}`);
  git(dir, ["rebase", "-i", "HEAD~3"], { GIT_SEQUENCE_EDITOR: editor(`fs.copyFileSync(todo, ${JSON.stringify(snap)});`) });
  return readFileSync(snap, "utf8");
}

/** Run `git rebase -i HEAD~3` with `plan` as the todo; answer the subjects newest first. */
function runPlan(dir: string, plan: string): string[] {
  const file = join(scratch, `plan${++seq}`);
  writeFileSync(file, plan);
  git(dir, ["rebase", "-i", "HEAD~3"], {
    GIT_SEQUENCE_EDITOR: editor(`fs.copyFileSync(${JSON.stringify(file)}, todo);`),
    GIT_EDITOR: "true",
  });
  return git(dir, ["log", "--format=%s"]).trim().split("\n");
}

interface FakeDoc {
  text: string;
  saved: string[];
  uri: { scheme: string; fsPath: string; toString: () => string; owner: FakeDoc };
  getText: () => string;
  save: () => Promise<boolean>;
  positionAt: (n: number) => number;
}

function open(text: string, fsPath = join(scratch, "no-such-rebase", "git-rebase-todo")) {
  RebaseTodoEditorProvider.register({ extensionUri: {} } as never);
  assert.ok(registered, "the provider registered itself");
  const doc = { text, saved: [] as string[] } as unknown as FakeDoc;
  doc.uri = { scheme: "file", fsPath, toString: () => `file://${fsPath}`, owner: doc };
  doc.getText = () => doc.text;
  doc.save = async () => {
    doc.saved.push(doc.text);
    return true;
  };
  doc.positionAt = (n: number) => n;
  const posted: RebaseInitMessage[] = [];
  let onMessage: ((m: unknown) => void) | undefined;
  let messageSubDisposed = 0;
  let onDispose: (() => void) | undefined;
  const webview = {
    options: {} as Record<string, unknown>,
    html: "",
    cspSource: "vscode-resource:",
    asWebviewUri: (u: unknown) => u,
    postMessage: async (m: RebaseInitMessage) => void posted.push(m),
    onDidReceiveMessage: (cb: (m: unknown) => void) => {
      onMessage = cb;
      return { dispose: () => void messageSubDisposed++ };
    },
  };
  registered.resolveCustomTextEditor(doc, { webview, onDidDispose: (cb: () => void) => void (onDispose = cb) }, {});
  return {
    doc,
    webview,
    posted,
    send: (m: unknown) => onMessage?.(m),
    dispose: () => onDispose?.(),
    messageSubDisposed: () => messageSubDisposed,
  };
}

/** Wait (bounded) for an async handler the provider fired without awaiting. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), `timed out waiting for: ${what}`);
}

test("Start with a reordered, retyped plan writes a todo that real git runs exactly as planned", async () => {
  const dir = repo();
  const todo = realTodo(dir);
  const e = open(todo);
  assert.equal(e.webview.options.enableScripts, true, "the webview runs its script");
  assert.match(e.webview.html, /<html/i, "the rebase page is rendered");
  e.send({ type: "ready" });
  const init = e.posted[0];
  assert.deepEqual(init.rows.map((r) => `${r.action} ${r.subject}`), ["pick c2", "pick c3", "pick c4"]);
  assert.equal(init.rows[0].shortSha.length, 7);
  assert.notEqual(init.continuing, true, "no rebase directory beside this todo");

  const [c2, c3, c4] = init.rows;
  vscode.__said.length = 0;
  // c4 first, then c2; c3 dropped by the user.
  e.send({ type: "start", rows: [{ id: c4.id, action: "pick" }, { id: c2.id, action: "pick" }, { id: c3.id, action: "drop" }] });
  await until(() => e.doc.saved.length === 1, "the plan is saved");
  const written = e.doc.saved[0];
  assert.notEqual(written, todo, "the document now holds the new plan");
  assert.ok(written.includes("# Rebase"), "git's comment block is kept");
  assert.ok(vscode.__said.some((s) => s.kind === "status" && /Rebase plan applied/.test(s.message)));

  // Our own write echoing back is not a new plan to render…
  const before = e.posted.length;
  changeListener?.({ document: e.doc });
  assert.equal(e.posted.length, before, "the echo of our own write re-renders nothing");
  // …but someone else's edit to the same document is.
  e.doc.text = `${written}# edited elsewhere\n`;
  changeListener?.({ document: e.doc });
  assert.equal(e.posted.length, before + 1, "an outside edit re-renders the list");
  // A change to another document is none of this editor's business.
  changeListener?.({ document: { ...e.doc, uri: { ...e.doc.uri, toString: () => "file:///elsewhere" } } });
  assert.equal(e.posted.length, before + 1);

  assert.deepEqual(runPlan(dir, written), ["c2", "c4", "c1"], "git replayed c4 then c2, and c3 is gone");
});

test("Start with the plan unchanged saves the document as it is — nothing rewritten", async () => {
  const dir = repo();
  const todo = realTodo(dir);
  const e = open(todo);
  e.send({ type: "ready" });
  const rows = e.posted[0].rows.map((r) => ({ id: r.id, action: r.action }));
  vscode.__said.length = 0;
  e.send({ type: "start", rows });
  await until(() => e.doc.saved.length === 1, "saved");
  assert.equal(e.doc.saved[0], todo, "byte for byte what git wrote");
  assert.ok(!vscode.__said.some((s) => /Rebase plan applied/.test(s.message)), "nothing was applied, so nothing is announced");
});

test("a row the webview never sent back becomes a drop — a commit is never silently lost", async () => {
  const dir = repo();
  const todo = realTodo(dir);
  const e = open(todo);
  e.send({ type: "ready" });
  const [c2, c3, c4] = e.posted[0].rows;
  // c3 omitted entirely, plus a row id the todo does not have.
  e.send({ type: "start", rows: [{ id: c2.id, action: "reword" }, { id: 999, action: "pick" }, { id: c4.id, action: "pick" }] });
  await until(() => e.doc.saved.length === 1, "saved");
  const lines = e.doc.saved[0].split("\n").filter((l) => /^[a-z]+ [0-9a-f]{7,}/.test(l));
  // Newer git writes "pick <sha> # <subject>"; older git, "pick <sha> <subject>".
  const row = (l: string) => `${l.split(" ")[0]} ${l.split(" ").slice(2).join(" ").replace(/^# /, "")}`;
  assert.deepEqual(lines.map(row), ["reword c2", "pick c4", "drop c3"]);
  assert.deepEqual(runPlan(dir, e.doc.saved[0]), ["c4", "c2", "c1"]);
  assert.equal(c3.subject, "c3");
});

test("a Windows-style todo keeps its CRLF line endings when written back", async () => {
  const dir = repo();
  const todo = realTodo(dir).replace(/\r?\n/g, "\r\n");
  const e = open(todo);
  e.send({ type: "ready" });
  const [c2, c3, c4] = e.posted[0].rows;
  e.send({ type: "start", rows: [c4, c3, c2].map((r) => ({ id: r.id, action: "pick" })) });
  await until(() => e.doc.saved.length === 1, "saved");
  const out = e.doc.saved[0];
  assert.ok(out.endsWith("\r\n"), "the trailing newline is kept");
  assert.equal(out.replace(/\r\n/g, "").includes("\n"), false, "no bare LF was introduced");
  assert.ok(out.indexOf(c4.sha.slice(0, 7)) < out.indexOf(c2.sha.slice(0, 7)), "c4 now comes first");
});

test("when the editor refuses the edit, the user is told and nothing is saved", async () => {
  const dir = repo();
  const todo = realTodo(dir);
  const e = open(todo);
  e.send({ type: "ready" });
  const [c2, c3, c4] = e.posted[0].rows;
  vscode.__said.length = 0;
  applyEditAnswer = false;
  try {
    e.send({ type: "start", rows: [c4, c3, c2].map((r) => ({ id: r.id, action: "pick" })) });
    await until(() => vscode.__said.some((s) => s.kind === "error"), "the error toast");
  } finally {
    applyEditAnswer = true;
  }
  assert.ok(vscode.__said.some((s) => s.kind === "error" && /Could not write the rebase plan/.test(s.message)));
  assert.deepEqual(e.doc.saved, [], "nothing saved: git keeps its own plan");
  assert.equal(e.doc.text, todo, "the document is untouched");
});

test("Abort, declined, leaves the plan alone; confirmed, clears it to a no-op and runs Abort Rebase", async () => {
  const e = open("pick 1111111 one\r\npick 2222222 two\r\n");
  confirmsAsked.length = 0;
  commandsRun.length = 0;
  confirmAnswer = undefined;
  e.send({ type: "abort" });
  await until(() => confirmsAsked.length === 1, "the question");
  // Give the declined handler its turn before asserting nothing happened.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(confirmsAsked[0], "Abort this interactive rebase?");
  assert.deepEqual(e.doc.saved, []);
  assert.deepEqual(commandsRun, []);

  confirmAnswer = "ok";
  try {
    e.send({ type: "abort" });
    await until(() => commandsRun.length === 1, "the abort command");
  } finally {
    confirmAnswer = undefined;
  }
  assert.deepEqual(e.doc.saved, ["noop\r\n"], "a no-op plan, in the document's own line ending");
  assert.deepEqual(commandsRun, ["gitstudio.abortRebase"]);
  // The cleared text echoing back is ours, not a plan to render.
  const before = e.posted.length;
  changeListener?.({ document: e.doc });
  assert.equal(e.posted.length, before);
});

test("closing the editor drops its document and message subscriptions", () => {
  const e = open("pick 1111111 one\n");
  const subs = changeSubDisposed;
  e.dispose();
  assert.equal(changeSubDisposed, subs + 1);
  assert.equal(e.messageSubDisposed(), 1);
});
