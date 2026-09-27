import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RebaseInitMessage } from "@gitstudio/host-bridge/rebaseProtocol";

/**
 * The editor for a `git-rebase-todo` opens at two different moments, and git
 * runs a different rule in each (#32 review):
 *
 *   · the plan of a rebase about to start — the first line can't be a squash
 *     or fixup ("cannot 'squash' without a previous commit");
 *   · `git rebase --edit-todo` on a paused one — git has applied commits
 *     already, the last of them sits above the first line, and git runs a
 *     leading squash into it.
 *
 * The editor used to be told neither, so it refused a plan git accepts and
 * closed Start rebase over it. The host now says which (`continuing`), making
 * git's own test: `done` beside the todo. Both moments here are made by real
 * git, and the message is the one the REAL provider posts to its webview.
 */

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { window: Record<string, unknown> };
const { RebaseTodoEditorProvider } =
  require("../src/rebase/rebaseTodoEditor") as typeof import("../src/rebase/rebaseTodoEditor");
/* eslint-enable @typescript-eslint/no-require-imports */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-todo-continuing-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository with four commits, c1..c4. */
function repo(name: string): string {
  const dir = join(scratch, name);
  git(scratch, ["init", "-q", "-b", "main", name]);
  git(dir, ["config", "gc.auto", "0"]);
  for (const n of [1, 2, 3, 4]) {
    writeFileSync(join(dir, `f${n}`), `${n}\n`);
    git(dir, ["add", `f${n}`]);
    git(dir, ["commit", "-q", "-m", `c${n}`]);
  }
  return dir;
}

/**
 * A sequence editor: a node script that runs `body` with the todo's path as
 * `todo`. git runs an editor through `sh -c`, which eats a Windows path's
 * backslashes (C:\Users\… became "C:Users…: command not found"), so the
 * command names the script with forward slashes, which every git's shell reads.
 */
function editor(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `const fs = require("fs"); const path = require("path"); const todo = process.argv[2];\n${body}\n`);
  return `node "${path.replace(/\\/g, "/")}"`;
}

/** Open `todoPath` in the real provider and return the init it posts. */
function openInEditor(todoPath: string): RebaseInitMessage {
  let provider: { resolveCustomTextEditor: (...a: unknown[]) => void } | undefined;
  vscode.window.registerCustomEditorProvider = (_type: string, p: typeof provider) => {
    provider = p;
    return { dispose() {} };
  };
  RebaseTodoEditorProvider.register({ extensionUri: {} } as never);
  assert.ok(provider, "the provider registered itself");
  const text = readFileSync(todoPath, "utf8");
  const posted: unknown[] = [];
  let onMessage: ((m: unknown) => void) | undefined;
  const document = {
    uri: { scheme: "file", fsPath: todoPath, toString: () => `file://${todoPath}` },
    getText: () => text,
  };
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-resource:",
    asWebviewUri: (u: unknown) => u,
    postMessage: (m: unknown) => {
      posted.push(m);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (cb: (m: unknown) => void) => {
      onMessage = cb;
      return { dispose() {} };
    },
  };
  provider.resolveCustomTextEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) }, {});
  onMessage?.({ type: "ready" });
  const init = posted.find((m) => (m as { type?: string }).type === "rebaseInit") as RebaseInitMessage | undefined;
  assert.ok(init, "the editor was sent the todo");
  return init;
}

test("a paused rebase's --edit-todo: the editor is told git is past the first line", () => {
  const dir = repo("paused");
  // edit c2 / squash c3 / pick c4: git stops at c2, and the todo it leaves
  // starts with the squash.
  const plan = editor(
    "plan.cjs",
    `const lines = fs.readFileSync(todo, "utf8").split("\\n");
lines[0] = lines[0].replace(/^pick/, "edit");
lines[1] = lines[1].replace(/^pick/, "squash");
fs.writeFileSync(todo, lines.join("\\n"));`,
  );
  git(dir, ["rebase", "-i", "HEAD~3"], { GIT_SEQUENCE_EDITOR: plan });
  const todo = join(dir, ".git", "rebase-merge", "git-rebase-todo");
  assert.ok(existsSync(join(dir, ".git", "rebase-merge", "done")), "git keeps a done list while paused");
  const init = openInEditor(todo);
  assert.deepEqual(init.rows.map((r) => `${r.action} ${r.subject}`), ["squash c3", "pick c4"]);
  assert.equal(init.continuing, true, "the editor must know a commit is already kept above the squash");
  // …and git does run that plan: nothing here is a plan the editor should refuse.
  git(dir, ["rebase", "--edit-todo"], { GIT_EDITOR: "true" });
  git(dir, ["rebase", "--continue"], { GIT_EDITOR: "true" });
  assert.equal(git(dir, ["log", "--format=%s"]).trim().split("\n").join(","), "c4,c2,c1");
});

test("a rebase about to start: the editor is told nothing is done yet", () => {
  const dir = repo("fresh");
  // The moment the editor opens is the moment the sequence editor runs, so
  // that is where the rebase's directory is copied from.
  const snap = join(scratch, "fresh-snapshot");
  const plan = editor("snap.cjs", `fs.cpSync(path.dirname(todo), ${JSON.stringify(snap)}, { recursive: true });`);
  git(dir, ["rebase", "-i", "HEAD~3"], { GIT_SEQUENCE_EDITOR: plan });
  const init = openInEditor(join(snap, "git-rebase-todo"));
  assert.equal(init.rows.length, 3);
  assert.ok(init.rows.every((r) => r.action === "pick"));
  assert.notEqual(init.continuing, true, "a fresh plan's first line has nothing above it to fold into");
});
