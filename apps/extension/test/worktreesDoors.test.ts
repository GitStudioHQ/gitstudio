// The Worktrees view's commands, through the REAL extension code against real
// git: what each asks, what it refuses and why, and what the repository looks
// like after. The view names a worktree by its folder; the palette names none,
// and then the command asks which.
//
// The runner cannot load VS Code: a stand-in records every message, command
// and terminal; the dialog host answers each question from the test's script.

import Module from "node:module";
import { basename, dirname, join } from "node:path";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { folderKey } from "@gitstudio/git-service/folderPath";

// ── The stand-in for `vscode` ────────────────────────────────────────────────
const said: { kind: string; message: string; items?: string[] }[] = [];
const executed: { command: string; args: unknown[] }[] = [];
const terminals: { name?: string; cwd?: string }[] = [];
let clipboard = "";
let folders: string[] = [];

class Disposable {
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.();
  }
}
class EventEmitter<T> {
  private readonly listeners = new Set<(v: T) => void>();
  event = (l: (v: T) => void): Disposable => {
    this.listeners.add(l);
    return new Disposable(() => this.listeners.delete(l));
  };
  fire(v: T): void {
    for (const l of [...this.listeners]) l(v);
  }
  dispose(): void {
    this.listeners.clear();
  }
}
class TreeItem {
  description?: string;
  contextValue?: string;
  tooltip?: MarkdownString;
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}
class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}
class ThemeColor {
  constructor(public id: string) {}
}
class MarkdownString {
  supportThemeIcons = false;
  constructor(public value = "") {}
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}
const Uri = {
  file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
  joinPath: (u: { fsPath: string }, ...parts: string[]) => Uri.file(join(u.fsPath, ...parts)),
};
const recorded =
  (kind: string) =>
  (message: string, ...items: string[]): Promise<undefined> => {
    said.push({ kind, message, items });
    return Promise.resolve(undefined);
  };
const vscodeStub = {
  Disposable,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: {
    showErrorMessage: recorded("error"),
    showWarningMessage: recorded("warning"),
    showInformationMessage: recorded("info"),
    setStatusBarMessage: (message: string) => {
      said.push({ kind: "status", message });
      return new Disposable();
    },
    showOpenDialog: async () => {
      throw new Error("New Worktree asks for the folder in its own dialog, never the OS picker");
    },
    createTerminal: (o: { name?: string; cwd?: string }) => {
      terminals.push(o);
      return { show: () => {} };
    },
  },
  env: {
    clipboard: {
      writeText: async (t: string) => {
        clipboard = t;
      },
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
    get workspaceFolders() {
      return folders.map((f, index) => ({ uri: Uri.file(f), name: basename(f), index }));
    },
  },
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB = join(tmpdir(), "__gs_worktrees_doors_vscode_stub__.js");
M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
const origResolve = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : origResolve.call(this, request, parent, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const wt = require("../src/views/worktreesView") as typeof import("../src/views/worktreesView");
const { RefsTreeProvider } = require("../src/views/branchesView") as typeof import("../src/views/branchesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogResult, DialogSpec } from "../src/ui/dialogs";

// ── Hermetic git ─────────────────────────────────────────────────────────────
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-wt-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

// os.tmpdir()'s own spelling, never resolved — the 8.3 C:\Users\RUNNER~1\… on
// a Windows runner, /var/… on macOS — while git names these folders by
// another (C:/Users/runneradmin/…, /private/var/…). So every door here is
// asked in a spelling that is not git's, on macOS as on Windows: a folder it
// opens is compared as a folder (folderKey), and a path it SHOWS is the
// disk's own spelling with the system's separators (realpathSync.native).
const scratch = mkdtempSync(join(tmpdir(), "gs-ext-wt-"));
const contexts: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
let seq = 0;

// ── The dialog host: every question is recorded and answered by `answer`. ──
let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => DialogResult | string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : typeof v === "string" ? { value: v } : v;
  },
});
const yes = (spec: DialogSpec): string | undefined => (spec.kind === "confirm" ? "ok" : undefined);

beforeEach(() => {
  asked = [];
  answer = () => undefined;
  said.length = 0;
  executed.length = 0;
  terminals.length = 0;
  clipboard = "";
  folders = [];
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Scene {
  base: string;
  app: string;
  git: (...a: string[]) => string;
  path: (name: string) => string;
}

/**
 * A main worktree on `main`, and linked worktrees beside it under wt/:
 * feat-clean; feat-locked (with a reason); feat-dirty (staged, unstaged,
 * untracked); feat-gone (folder deleted); feat-gone-locked (folder deleted,
 * locked — which git never marks prunable); and a detached one.
 */
function scene(): Scene {
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
  const path = (name: string) => join(base, "wt", name);
  for (const b of ["feat-clean", "feat-locked", "feat-dirty", "feat-gone", "feat-gone-locked"]) {
    git("worktree", "add", "-q", "-b", b, path(b));
  }
  git("worktree", "add", "-q", "--detach", path("detached"), "HEAD");
  git("worktree", "lock", "--reason", "on a USB drive", path("feat-locked"));
  git("worktree", "lock", "--reason", "agent 42", path("feat-gone-locked"));
  rmSync(path("feat-gone"), { recursive: true, force: true });
  rmSync(path("feat-gone-locked"), { recursive: true, force: true });
  writeFileSync(join(path("feat-dirty"), "a.txt"), "changed\n");
  writeFileSync(join(path("feat-dirty"), "new.txt"), "n\n");
  writeFileSync(join(path("feat-dirty"), "staged.txt"), "s\n");
  at(path("feat-dirty"))("add", "staged.txt");
  return { base, app, git, path };
}

/** The window: its active repository root (and, by default, its one folder). */
function windowAt(root: string, workspaceFolders: string[] = [root]) {
  folders = workspaceFolders;
  const ctx = new GitContext({ root });
  contexts.push(ctx);
  const entry = { ctx, root };
  return {
    getActive: () => entry,
    getAll: () => [entry],
    onDidChange: () => new Disposable(),
    getUndoLedger: () => undefined,
  } as never;
}

/** What the view is told while an action runs. */
function uiLog() {
  const events: string[] = [];
  return {
    events,
    ui: {
      busy: (p: string, label: string | undefined) => events.push(`busy ${basename(p)} ${label ?? "-"}`),
      patch: (p: string, row: Record<string, unknown>) => events.push(`patch ${basename(p)} ${JSON.stringify(row)}`),
      drop: (p: string) => events.push(`drop ${basename(p)}`),
    },
  };
}

const listed = (s: Scene): string[] =>
  s.git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("branch "))
    .map((l) => l.slice("branch refs/heads/".length));
const errors = (): string[] => said.filter((m) => m.kind === "error").map((m) => m.message);
const noop = (): void => {};
type Pick = DialogSpec & { kind: "pick" };
type Confirm = DialogSpec & { kind: "confirm" };

// ── Remove ───────────────────────────────────────────────────────────────────

test("a locked, clean worktree: ONE question naming the lock's reason, and it is gone after — the branch stays", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = yes;
  const log = uiLog();
  await wt.removeWorktree(repos, s.path("feat-locked"), noop, log.ui);

  assert.equal(asked.length, 1, "asked once — not twice, and then git's refusal");
  const q = asked[0] as Confirm;
  assert.equal(q.kind, "confirm");
  assert.match(q.title, /feat-locked/);
  assert.match(q.message, /on a USB drive/);
  assert.equal(q.confirmLabel, "Unlock and Remove");
  assert.deepEqual(errors(), []);
  assert.equal(existsSync(s.path("feat-locked")), false);
  assert.ok(!listed(s).includes("feat-locked"));
  assert.equal(s.git("branch", "--list", "feat-locked"), "feat-locked", "the branch stays");
  assert.deepEqual(log.events, ["busy feat-locked Removing…", "busy feat-locked -", "drop feat-locked"]);
});

test("a dirty worktree: Stash & Remove first, Discard Changes and Remove second — the question lists what it holds", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = () => undefined; // look, don't answer
  await wt.removeWorktree(repos, s.path("feat-dirty"), noop);
  assert.equal(asked.length, 1);
  const q = asked[0] as Pick;
  assert.equal(q.kind, "pick");
  assert.deepEqual(q.choices.map((c) => [c.id, c.label, !!c.danger]), [
    ["stash", "Stash & Remove", false],
    ["discard", "Discard Changes and Remove", true],
  ]);
  for (const f of ["a.txt", "new.txt", "staged.txt"]) assert.ok(q.message?.includes(f), `names ${f}`);
  assert.match(q.message ?? "", /It has 3 uncommitted changes/);
  assert.match(q.message ?? "", /branch feat-dirty and its commits stay/);
  assert.ok(existsSync(s.path("feat-dirty")), "dismissed: nothing ran");
});

test("Stash & Remove: the folder is gone and every change it had is in the stash, which says where it came from", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "stash" : undefined);
  await wt.removeWorktree(repos, s.path("feat-dirty"), noop);
  assert.deepEqual(errors(), []);
  assert.equal(existsSync(s.path("feat-dirty")), false);
  assert.equal(s.git("branch", "--list", "feat-dirty"), "feat-dirty");
  assert.match(s.git("stash", "list"), /Changes from worktree feat-dirty \(.*wt[\\/]feat-dirty\), stashed before removing it/);
  const inStash = s.git("stash", "show", "--include-untracked", "--name-only", "stash@{0}").split("\n").sort();
  assert.deepEqual(inStash, ["a.txt", "new.txt", "staged.txt"]);
  assert.match(said.map((m) => m.message).join("\n"), /its changes are in the stash/);
});

test("the question, the stash and the report name the worktree by its folder, as the list does — its branch in the body", async () => {
  const s = scene();
  const folder = join(s.base, "wt", "app-login");
  s.git("worktree", "add", "-q", "-b", "feature/login", folder);
  writeFileSync(join(folder, "a.txt"), "login work\n");
  const repos = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "stash" : undefined);
  await wt.removeWorktree(repos, folder, noop);
  const q = asked[0] as Pick;
  assert.equal(q.title, "Remove worktree app-login?");
  assert.match(q.message ?? "", /^Deletes its folder, .*wt[\\/]app-login\./);
  assert.match(q.message ?? "", /The branch feature\/login and its commits stay\./);
  assert.match(s.git("stash", "list"), /^stash@\{0\}: On feature\/login: Changes from worktree app-login \(.*wt[\\/]app-login\), stashed before removing it$/);
  assert.match(said.map((m) => m.message).join("\n"), /^GitStudio: Removed the worktree app-login — its changes are in the stash “Changes from worktree app-login/m);
  assert.deepEqual(errors(), []);
});

test("Discard Changes and Remove: the folder is gone, nothing is stashed", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "discard" : undefined);
  await wt.removeWorktree(repos, s.path("feat-dirty"), noop);
  assert.deepEqual(errors(), []);
  assert.equal(existsSync(s.path("feat-dirty")), false);
  assert.equal(s.git("stash", "list"), "");
});

test("dirty and locked: both ways unlock first, and say so", async () => {
  const s = scene();
  s.git("worktree", "lock", "--reason", "claude agent 7", s.path("feat-dirty"));
  const repos = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "stash" : undefined);
  await wt.removeWorktree(repos, s.path("feat-dirty"), noop);
  const q = asked[0] as Pick;
  assert.deepEqual(q.choices.map((c) => c.label), ["Unlock, Stash & Remove", "Unlock, Discard Changes and Remove"]);
  assert.match(q.message ?? "", /It is locked: “claude agent 7”/);
  assert.equal(existsSync(s.path("feat-dirty")), false);
  assert.deepEqual(errors(), []);
});

test("a clean worktree: one plain question, removed, the branch kept", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = yes;
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  assert.equal(asked.length, 1);
  assert.equal((asked[0] as Confirm).confirmLabel, "Remove");
  assert.equal(existsSync(s.path("feat-clean")), false);
  assert.equal(s.git("branch", "--list", "feat-clean"), "feat-clean");
});

test("a branch merged into the default branch: 'Also delete the branch' is offered, unchecked — and checked, it goes (Undo-able)", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  // feat-clean sits at main's commit: fully merged. Unchecked: the branch stays.
  answer = (spec) => (spec.kind === "confirm" ? { value: "ok", options: [] } : undefined);
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  const q = asked[0] as Confirm;
  assert.deepEqual(q.options, [
    { id: "deleteBranch", label: "Also delete the branch feat-clean", description: "It is fully merged into main, so no commit is lost.", checked: false },
  ]);
  assert.equal(s.git("branch", "--list", "feat-clean"), "feat-clean", "unchecked: kept");

  // Checked: removed and the branch deleted.
  asked = [];
  answer = (spec) => (spec.kind === "confirm" ? { value: "ok", options: ["deleteBranch"] } : undefined);
  await wt.removeWorktree(repos, s.path("feat-locked"), noop);
  assert.equal(existsSync(s.path("feat-locked")), false);
  assert.equal(s.git("branch", "--list", "feat-locked"), "", "checked: deleted");
  assert.match(said.map((m) => m.message).join("\n"), /and deleted the branch feat-locked/);
  assert.deepEqual(errors(), []);
});

test("'Also delete the branch' asks git again before deleting: a commit made while the question was open keeps the branch, and says why", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  let agentSha = "";
  answer = (spec) => {
    if (spec.kind !== "confirm") return undefined;
    // An agent in the worktree commits while the question is open: the tree
    // is clean again, so nothing about the remove itself changes.
    const w = at(s.path("feat-clean"));
    writeFileSync(join(s.path("feat-clean"), "agent.txt"), "work\n");
    w("add", "agent.txt");
    w("commit", "-qm", "agent work");
    agentSha = w("rev-parse", "HEAD");
    return { value: "ok", options: ["deleteBranch"] };
  };
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  assert.equal((asked[0] as Confirm).options?.[0]?.description, "It is fully merged into main, so no commit is lost.", "merged when asked");
  assert.equal(existsSync(s.path("feat-clean")), false, "the worktree itself goes, as agreed");
  assert.equal(s.git("rev-parse", "refs/heads/feat-clean"), agentSha, "the branch stays, with the commit made on it");
  assert.match(
    said.map((m) => m.message).join("\n"),
    /Removed the worktree feat-clean; the branch feat-clean was kept — a commit was made on it while you were asked, and main doesn't have it/,
  );
  assert.doesNotMatch(said.map((m) => m.message).join("\n"), /deleted the branch/);
  assert.deepEqual(errors(), []);
});

test("'Also delete the branch' runs through Undo: the branch comes back where it was", async () => {
  const s = scene();
  const { UndoLedger } = require("../src/undo/undoLedger") as typeof import("../src/undo/undoLedger");
  const state = new Map<string, unknown>();
  let ledger: InstanceType<typeof UndoLedger> | undefined;
  const base = windowAt(s.app) as unknown as { getActive(): unknown; getAll(): unknown[]; onDidChange(): unknown };
  const repos = { ...base, getActive: base.getActive, getUndoLedger: () => ledger } as never;
  ledger = new UndoLedger(repos, { workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) } } as never);
  const tip = s.git("rev-parse", "refs/heads/feat-clean");
  answer = (spec) => (spec.kind === "confirm" ? { value: "ok", options: ["deleteBranch"] } : undefined);
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  assert.equal(s.git("branch", "--list", "feat-clean"), "", "deleted");
  assert.ok(said.some((m) => m.kind === "info" && m.message === "GitStudio: Delete branch feat-clean — done."), said.map((m) => m.message).join(" | "));
  asked = [];
  answer = (spec) => (spec.kind === "confirm" && /^Undo "Delete branch feat-clean"\?$/.test(spec.title) ? "ok" : undefined);
  await ledger.undoLast();
  assert.equal(asked.map((q) => q.title).join(" | "), 'Undo "Delete branch feat-clean"?');
  assert.equal(s.git("rev-parse", "refs/heads/feat-clean"), tip, "Undo put the branch back at its commit");
  assert.deepEqual(errors(), []);
});

test("an unmerged branch is never offered for deletion; neither is the default branch", async () => {
  const s = scene();
  at(s.path("feat-clean"))("commit", "-q", "--allow-empty", "-m", "work nobody merged");
  const repos = windowAt(s.app);
  answer = () => undefined;
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  assert.equal((asked[0] as Confirm).options, undefined, "unmerged: no option");

  // The default branch (main), checked out in a linked worktree of a repo
  // whose main worktree is elsewhere: merged into itself, never offered.
  asked = [];
  s.git("checkout", "-q", "--detach");
  s.git("worktree", "add", "-q", s.path("on-main"), "main");
  await wt.removeWorktree(repos, s.path("on-main"), noop);
  assert.equal((asked[0] as Confirm).options, undefined, "the default branch: no option");
});

test("a change made while the question was open is asked about, never deleted — and the lock goes back", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  const late = join(s.path("feat-locked"), "agent-wrote-this.txt");
  answer = (spec) => {
    if (asked.length === 1 && spec.kind === "confirm") {
      writeFileSync(late, "work in progress\n"); // the agent, mid-question
      return "ok";
    }
    return undefined; // the second question: keep it
  };
  await wt.removeWorktree(repos, s.path("feat-locked"), noop);

  assert.equal(asked.length, 2, "asked again, with what it holds now");
  const again = asked[1] as Pick;
  assert.match(again.message ?? "", /agent-wrote-this\.txt/);
  assert.deepEqual(again.choices.map((c) => c.label), ["Unlock, Stash & Remove", "Unlock, Discard Changes and Remove"]);
  assert.equal(readFileSync(late, "utf8"), "work in progress\n", "nothing was deleted");
  assert.match(s.git("worktree", "list", "--porcelain"), /locked on a USB drive/, "locked again, with its reason");
  assert.deepEqual(errors(), []);
});

test("dirty when asked, a file written while the question is open is asked about too — for Stash and for Discard, locked or not", async () => {
  for (const [locked, way] of [[true, "discard"], [false, "discard"], [true, "stash"], [false, "stash"]] as const) {
    const s = scene();
    const repos = windowAt(s.app);
    if (locked) s.git("worktree", "lock", "--reason", "claude agent 7", s.path("feat-dirty"));
    const late = join(s.path("feat-dirty"), "written-while-asking.txt");
    asked = [];
    answer = (spec) => {
      if (spec.kind !== "pick") return undefined;
      if (asked.length === 1) {
        writeFileSync(late, "agent output\n"); // the agent, mid-question
        return way;
      }
      return undefined; // the second question: keep it
    };
    await wt.removeWorktree(repos, s.path("feat-dirty"), noop);
    const first = asked[0] as Pick;
    assert.match(first.message ?? "", /It has 3 uncommitted changes/);
    assert.equal(asked.length, 2, `${locked ? "locked" : "unlocked"}, ${way}: asked again, with what it holds now`);
    assert.match((asked[1] as Pick).message ?? "", /It has 4 uncommitted changes/);
    assert.equal(readFileSync(late, "utf8"), "agent output\n", "the file the first question never named is still there");
    assert.ok(existsSync(join(s.path("feat-dirty"), "new.txt")), "…and so is everything else");
    assert.equal(s.git("stash", "list"), "", "and nothing was stashed");
    if (locked) assert.match(s.git("worktree", "list", "--porcelain"), /locked claude agent 7/, "still locked, with its reason");
    assert.deepEqual(errors(), []);
  }
});

test("a worktree that keeps changing is asked about twice at most, then says nothing was removed", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  let n = 0;
  answer = (spec) => {
    if (spec.kind !== "pick") return undefined;
    writeFileSync(join(s.path("feat-dirty"), `agent-${++n}.txt`), "more\n");
    return "discard";
  };
  await wt.removeWorktree(repos, s.path("feat-dirty"), noop);
  assert.equal(asked.length, 2, "asked again once, not in a loop");
  assert.ok(existsSync(join(s.path("feat-dirty"), "agent-2.txt")), "nothing deleted");
  assert.deepEqual(errors(), []);
  assert.match(
    said.map((m) => m.message).join("\n"),
    /feat-dirty has uncommitted changes it didn't have when you were asked, so nothing was removed/,
  );
});

test("a worktree stopped in a merge: the question says removing it abandons the merge, and offers no Stash (git can't stash unmerged files)", async () => {
  const s = scene();
  const merging = s.path("feat-clean");
  const m = at(merging);
  writeFileSync(join(merging, "a.txt"), "feat\n");
  m("commit", "-qam", "feat change");
  writeFileSync(join(s.app, "a.txt"), "main\n");
  s.git("commit", "-qam", "main change");
  assert.throws(() => m("merge", "main"));
  const repos = windowAt(s.app);
  answer = () => undefined; // asked, and kept
  await wt.removeWorktree(repos, merging, noop);
  const q = asked[0] as DialogSpec & { message?: string };
  assert.match(q.message ?? "", /A merge is in progress in it\. Removing the worktree abandons the merge\./);
  assert.match(q.message ?? "", /a\.txt/);
  assert.match(q.message ?? "", /A file is left unmerged in it, which git can't stash\./);
  assert.equal((q as Confirm).confirmLabel, "Discard Changes and Remove", "one way: a confirm, not a pick");
  assert.ok(existsSync(merging));
});

test("the worktree this window has open is never removed — nothing is asked and the folder stays", async () => {
  const s = scene();
  const repos = windowAt(s.path("feat-clean"));
  answer = yes;
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  assert.equal(asked.length, 0);
  assert.ok(existsSync(s.path("feat-clean")));
  assert.match(said.map((m) => m.message).join("\n"), /this window has feat-clean open/i);
});

test("a worktree open as another folder of this window counts as open here too", async () => {
  const s = scene();
  const repos = windowAt(s.app, [s.app, s.path("feat-clean")]);
  answer = yes;
  await wt.removeWorktree(repos, s.path("feat-clean"), noop);
  assert.equal(asked.length, 0);
  assert.ok(existsSync(s.path("feat-clean")));
});

test("the main worktree: a Remove that reaches it asks nothing and runs no git", async () => {
  const s = scene();
  const repos = windowAt(s.path("feat-clean"));
  answer = yes;
  await wt.removeWorktree(repos, s.app, noop);
  assert.equal(asked.length, 0);
  assert.deepEqual(errors(), []);
  assert.match(said.map((m) => m.message).join("\n"), /main worktree/);
  assert.ok(existsSync(s.app));
});

test("from the palette: Remove asks which worktree, offering only the ones it can remove", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" && spec.title === "Remove a worktree" ? s.path("feat-clean") : spec.kind === "confirm" ? "ok" : undefined);
  await wt.removeWorktree(repos, undefined, noop);
  const pick = asked[0] as Pick;
  assert.equal(pick.title, "Remove a worktree");
  const offered = pick.choices.map((c) => c.label).sort();
  assert.ok(!offered.includes("app"), "not the main worktree");
  assert.ok(offered.includes("feat-clean") && offered.includes("feat-gone"));
  assert.equal(existsSync(s.path("feat-clean")), false);
});

test("from the palette: Forget asks which worktree, offering only those whose folder is gone or isn't a worktree any more", async () => {
  const s = scene();
  const { x, unlink } = unlinkedNested(s);
  unlink();
  const repos = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" && spec.title === "Forget a worktree" ? s.path("feat-gone") : spec.kind === "confirm" ? "ok" : undefined);
  assert.equal(typeof wt.forgetWorktree, "function", "Forget is its own door");
  await wt.forgetWorktree(repos, undefined, noop);
  const pick = asked[0] as Pick;
  assert.equal(pick.title, "Forget a worktree");
  assert.deepEqual(pick.choices.map((c) => c.label).sort(), ["feat-gone", "feat-gone-locked", "x"]);
  assert.equal(asked[1].title, "Forget worktree feat-gone?");
  assert.equal((asked[1] as Confirm).confirmLabel, "Forget");
  assert.ok(!listed(s).includes("feat-gone"));
  assert.ok(existsSync(x), "the others are untouched");
  assert.deepEqual(errors(), []);
});

test("Forget handed a worktree whose folder is there asks nothing and removes nothing — Remove is the door that deletes a folder", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = yes;
  await wt.forgetWorktree(repos, s.path("feat-clean"), noop);
  assert.equal(asked.length, 0);
  assert.ok(existsSync(s.path("feat-clean")));
  assert.ok(listed(s).includes("feat-clean"));
  assert.match(said.map((m) => m.message).join("\n"), /^GitStudio: feat-clean's folder is there, so there's nothing to forget\. Remove Worktree… removes it, folder and all\.$/m);
  // With nothing to forget, the palette says so and asks nothing.
  s.git("worktree", "unlock", s.path("feat-gone-locked"));
  s.git("worktree", "prune");
  said.length = 0;
  await wt.forgetWorktree(repos, undefined, noop);
  assert.equal(asked.length, 0);
  assert.match(said.map((m) => m.message).join("\n"), /no worktree this can be done to/);
});

// ── A worktree whose folder is gone ──────────────────────────────────────────

test("a missing folder: Open opens nothing and says so; Forget clears it, past its lock too", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  for (const name of ["feat-gone", "feat-gone-locked"]) {
    await wt.openWorktreeIn(repos, s.path(name), "new");
    assert.ok(!executed.some((e) => e.command === "vscode.openFolder"), `${name}: no window on a missing folder`);
    assert.match(said.map((m) => m.message).join("\n"), /folder is gone/);
  }
  answer = yes;
  asked = [];
  await wt.removeWorktree(repos, s.path("feat-gone"), noop);
  assert.equal((asked[0] as Confirm).confirmLabel, "Forget");
  asked = [];
  await wt.removeWorktree(repos, s.path("feat-gone-locked"), noop);
  const q = asked[0] as Confirm;
  assert.match(q.message, /agent 42/);
  assert.equal(q.confirmLabel, "Unlock and Forget");
  assert.deepEqual(errors(), []);
  assert.ok(!listed(s).includes("feat-gone"));
  assert.ok(!listed(s).includes("feat-gone-locked"));
});

test("a message names a worktree's folder as its row does — the system's spelling, ~ for home — never git's", async () => {
  const s = scene();
  // Home is the scene's folder as git spells it, so every worktree here has a
  // shown spelling that is not git's on every system: ~/wt/… on macOS and
  // Linux, C:\Users\…\wt\… (git's C:/Users/…/wt/…) on Windows.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = realpathSync.native(s.base);
  try {
    const repos = windowAt(s.app);
    const gitSpelling = s.git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree ") && l.endsWith("feat-gone"))
      .map((l) => l.slice("worktree ".length))[0] ?? "";
    assert.ok(gitSpelling, "precondition: git lists feat-gone");
    await wt.openWorktreeIn(repos, s.path("feat-gone"), "new");
    const warning = said.find((m) => /folder is gone/.test(m.message))?.message ?? "";
    // Windows writes no ~: there it is the path with its own separators.
    const shown = process.platform === "win32" ? gitSpelling.replace(/\//g, "\\") : "~/wt/feat-gone";
    assert.ok(warning.includes(`folder is gone — ${shown}.`), `the warning names it as its row does: ${warning}`);
    assert.ok(!warning.includes(gitSpelling), "not in git's spelling");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── A folder that is not a worktree any more ─────────────────────────────────
//
// Its .git is gone while the folder stays, so git in it reads the repository
// AROUND it: for one nested in the main worktree (…/app/.claude/worktrees/x,
// the agents' layout), the main worktree. A door must never read, stash or
// delete there — what it would touch is the main worktree's.

/**
 * The main worktree with work in progress, and x nested in it — its .git gone
 * when `unlink` runs. `sameNames`: x's own change and the main worktree's are
 * both an edit to a.txt, so a question that listed x's changes would pass the
 * main worktree's for them.
 */
function unlinkedNested(s: Scene, opts: { sameNames?: boolean } = {}) {
  writeFileSync(join(s.app, ".git", "info", "exclude"), ".claude/\n");
  const x = join(s.app, ".claude", "worktrees", "x");
  s.git("worktree", "add", "-q", "-b", "x", x);
  if (opts.sameNames) writeFileSync(join(x, "a.txt"), "x's edit\n");
  else writeFileSync(join(x, "mine.txt"), "x's own file\n");
  writeFileSync(join(s.app, "a.txt"), "a\nmain's edit\n");
  if (!opts.sameNames) writeFileSync(join(s.app, "notes.md"), "main's new file\n");
  const unlink = () => rmSync(join(x, ".git"));
  const mainIntact = () => {
    assert.equal(readFileSync(join(s.app, "a.txt"), "utf8"), "a\nmain's edit\n", "the main worktree's edit is where it was");
    if (!opts.sameNames) assert.ok(existsSync(join(s.app, "notes.md")), "the main worktree's new file is where it was");
    assert.equal(s.git("stash", "list"), "", "nothing was stashed");
  };
  return { x, unlink, mainIntact };
}

test("not a worktree any more, nested in the main one: Remove asks to Forget — never lists the main worktree's changes — and the folder stays", async () => {
  const s = scene();
  const { x, unlink, mainIntact } = unlinkedNested(s);
  unlink();
  const repos = windowAt(s.app);
  const log = uiLog();
  answer = yes;
  await wt.removeWorktree(repos, x, noop, log.ui);
  assert.equal(asked.length, 1);
  const q = asked[0] as Confirm;
  assert.equal(q.kind, "confirm", "one way: a confirm");
  assert.equal(q.title, "Forget worktree x?");
  assert.equal(q.confirmLabel, "Forget");
  assert.match(q.message, /isn't a worktree any more: its \.git file is gone\. Forgetting it removes git's record of the worktree; the folder and everything in it stay\./);
  assert.doesNotMatch(q.message, /a\.txt|notes\.md|Deletes its folder/, "never the main worktree's changes, never a delete");
  assert.deepEqual(errors(), []);
  assert.ok(!listed(s).includes("x"), "forgotten");
  assert.equal(readFileSync(join(x, "mine.txt"), "utf8"), "x's own file\n", "its folder and files stay");
  assert.deepEqual(log.events, ["busy x Forgetting…", "busy x -", "drop x"]);
  assert.match(said.map((m) => m.message).join("\n"), /Forgot the worktree x/);
  mainIntact();
});

test("its .git goes while the Remove question is open: Stash & Remove stashes nothing from the main worktree, and asks again — to Forget", async () => {
  for (const way of ["stash", "discard"] as const) {
    const s = scene();
    const { x, unlink, mainIntact } = unlinkedNested(s, { sameNames: true });
    const repos = windowAt(s.app);
    asked = [];
    answer = (spec) => {
      if (asked.length === 1 && spec.kind === "pick") {
        unlink(); // mid-question
        return way;
      }
      return undefined; // the second question: keep it
    };
    await wt.removeWorktree(repos, x, noop);
    assert.match((asked[0] as Pick).message ?? "", /It has 1 uncommitted change:\n {2}a\.txt/, "asked while it was a worktree, about its own edit");
    assert.equal(asked.length, 2, `${way}: asked again, with what it is now`);
    assert.equal(asked[1].title, "Forget worktree x?");
    assert.ok(listed(s).includes("x"), "the second question was kept: still listed");
    assert.equal(readFileSync(join(x, "a.txt"), "utf8"), "x's edit\n", "its own edit stays in its folder");
    assert.deepEqual(errors(), []);
    mainIntact();
  }
});

test("not a worktree any more: Open, Terminal, Pull and Push… run nothing and say so; Reveal still shows the folder", async () => {
  const s = scene();
  const { x, unlink, mainIntact } = unlinkedNested(s);
  unlink();
  const repos = windowAt(s.app);
  await wt.openWorktreeIn(repos, x, "new");
  await wt.openWorktreeIn(repos, x, "here");
  await wt.openWorktreeTerminal(repos, x);
  await wt.pullWorktree(repos, x, noop);
  assert.equal(await wt.pushTargetFor(repos, x), undefined);
  assert.deepEqual(executed, [], "no window, no pull");
  assert.deepEqual(terminals, []);
  const warnings = said.filter((m) => m.kind === "warning").map((m) => m.message);
  assert.equal(warnings.length, 5);
  for (const w of warnings) assert.match(w, /^GitStudio: x's folder isn't a worktree any more — .*\.claude[\\/]worktrees[\\/]x\. Forget the worktree in Worktrees to clear it from the list\.$/);
  await wt.revealWorktree(repos, x);
  assert.deepEqual(executed.map((e) => e.command), ["revealFileInOS"]);
  mainIntact();
});

test("Prune counts a folder that is not a worktree any more (git would prune it), forgets it, and leaves the folder", async () => {
  const s = scene();
  const { x, unlink, mainIntact } = unlinkedNested(s);
  unlink();
  const repos = windowAt(s.app);
  answer = yes;
  await wt.pruneWorktrees(repos, noop);
  const q = asked[0] as Confirm;
  assert.equal(q.title, "Prune 2 missing worktrees?", "the words the view's link and its title menu use");
  assert.equal(q.confirmLabel, "Prune 2");
  assert.match(q.message, /feat-gone — .* \(folder gone\)/);
  assert.match(q.message, /\n {2}x — .*\.claude[\\/]worktrees[\\/]x \(not a worktree any more\)/);
  assert.match(q.message, /Nothing on disk changes/);
  assert.ok(!listed(s).includes("x") && !listed(s).includes("feat-gone"));
  assert.ok(existsSync(join(x, "mine.txt")));
  assert.match(said.map((m) => m.message).join("\n"), /Pruned 2 worktrees: feat-gone, x/);
  mainIntact();
});

// ── Open, reveal, terminal, copy ─────────────────────────────────────────────

test("Open in New Window / This Window open at once — no question — and never the window's own worktree", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = () => {
    throw new Error("a button that says where it opens asks nothing");
  };
  await wt.openWorktreeIn(repos, s.path("feat-clean"), "new");
  await wt.openWorktreeIn(repos, s.path("feat-clean"), "here");
  assert.deepEqual(
    executed.map((e) => [e.command, folderKey((e.args[0] as { fsPath: string }).fsPath), (e.args[1] as { forceNewWindow: boolean }).forceNewWindow]),
    [
      ["vscode.openFolder", folderKey(s.path("feat-clean")), true],
      ["vscode.openFolder", folderKey(s.path("feat-clean")), false],
    ],
  );
  executed.length = 0;
  const here = windowAt(s.path("feat-clean"));
  await wt.openWorktreeIn(here, s.path("feat-clean"), "here");
  await wt.openWorktreeIn(here, s.path("feat-clean"), "new");
  assert.deepEqual(executed, []);
});

test("Reveal, Open in Terminal and Copy Path act on the worktree's own folder", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  // The folder each acts on is compared as a folder (git's spelling is not
  // the one it was asked in); the path copied is the disk's own spelling.
  await wt.revealWorktree(repos, s.path("feat-dirty"));
  assert.deepEqual(executed.map((e) => [e.command, folderKey((e.args[0] as { fsPath: string }).fsPath)]), [["revealFileInOS", folderKey(s.path("feat-dirty"))]]);
  await wt.openWorktreeTerminal(repos, s.path("feat-dirty"));
  assert.deepEqual(terminals.map((t) => ({ ...t, cwd: folderKey(t.cwd ?? "") })), [{ name: "feat-dirty", cwd: folderKey(s.path("feat-dirty")) }]);
  await wt.copyWorktreePath(repos, s.path("feat-dirty"));
  assert.equal(clipboard, realpathSync.native(s.path("feat-dirty")));
});

// ── Lock ─────────────────────────────────────────────────────────────────────

test("Lock asks why; the row is patched at once and the reason reaches git; dismissed, nothing is locked or patched", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  const log = uiLog();
  answer = (spec) => (spec.kind === "input" ? "agent 7 is working here" : undefined);
  await wt.lockWorktree(repos, s.path("feat-clean"), true, noop, log.ui);
  assert.match(s.git("worktree", "list", "--porcelain"), /locked agent 7 is working here/);
  assert.deepEqual(log.events, ['patch feat-clean {"locked":true,"lockReason":"agent 7 is working here"}']);

  log.events.length = 0;
  answer = () => undefined;
  await wt.lockWorktree(repos, s.path("detached"), true, noop, log.ui);
  assert.doesNotMatch(s.git("worktree", "list", "--porcelain"), /detached\nlocked/);
  assert.deepEqual(log.events, []);
});

test("an Unlock git refuses puts the lock back on the row, with its reason", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  const log = uiLog();
  // Unlocked behind the view's back: git refuses the second unlock.
  const stale = s.path("feat-locked");
  s.git("worktree", "unlock", stale);
  s.git("worktree", "lock", "--reason", "put back", stale);
  const proc = (repos as unknown as { getActive(): { ctx: { worktrees: { unlock: (p: string) => Promise<unknown> } } } }).getActive().ctx.worktrees;
  const real = proc.unlock.bind(proc);
  proc.unlock = async () => ({ ok: false, stderr: "fatal: 'x' is not locked" });
  await wt.lockWorktree(repos, stale, false, noop, log.ui);
  proc.unlock = real;
  assert.deepEqual(log.events, ['patch feat-locked {"locked":true,"lockReason":"put back"}']);
  assert.equal(errors().length, 1);
});

// ── Prune ────────────────────────────────────────────────────────────────────

test("Prune asks first, with the count and the names; says what it pruned; keeps a locked one and says why", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = yes;
  await wt.pruneWorktrees(repos, noop);
  const q = asked[0] as Confirm;
  assert.equal(q.title, "Prune 1 missing worktree?");
  assert.equal(q.confirmLabel, "Prune 1");
  assert.match(q.message, /feat-gone —/);
  assert.match(q.message, /feat-gone-locked is locked, so prune keeps it/);
  assert.ok(!listed(s).includes("feat-gone"));
  assert.ok(listed(s).includes("feat-gone-locked"));
  assert.match(said.map((m) => m.message).join("\n"), /Pruned 1 worktree whose folder was gone: feat-gone/);
});

test("Prune with nothing to prune asks nothing and says so; dismissed, nothing is pruned", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = () => undefined;
  await wt.pruneWorktrees(repos, noop);
  assert.equal(asked.length, 1);
  assert.ok(listed(s).includes("feat-gone"), "dismissed: kept");
  s.git("worktree", "unlock", s.path("feat-gone-locked"));
  s.git("worktree", "prune");
  asked = [];
  said.length = 0;
  await wt.pruneWorktrees(repos, noop);
  assert.equal(asked.length, 0);
  assert.match(said.map((m) => m.message).join("\n"), /Nothing to prune/);
});

// ── New worktree ─────────────────────────────────────────────────────────────

/** Answer New Worktree's questions: New branch…, the name, then the folder as suggested (or `folder`). */
function newBranchAnswers(name: string, folder?: (suggested: string) => string | undefined) {
  return (spec: DialogSpec): string | undefined => {
    if (spec.kind === "pick") return "gitstudio:new-branch";
    if (spec.kind === "input" && spec.title === "New worktree branch") return name;
    if (spec.kind === "input" && spec.title.startsWith("New worktree for ")) return folder ? folder(spec.value ?? "") : spec.value;
    return undefined;
  };
}

test("New worktree suggests a sibling folder '<project>-<branch>', editable, and creates it there — feature/login and bugfix/login both fit", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  for (const name of ["feature/login", "bugfix/login"]) {
    answer = newBranchAnswers(name);
    await wt.addWorktree(repos, noop);
  }
  assert.deepEqual(errors(), []);
  const folderQs = asked.filter((q) => q.kind === "input" && q.title.startsWith("New worktree for ")) as (DialogSpec & { kind: "input" })[];
  assert.equal(folderQs[0].value, join(realpathSync.native(s.base), "app-feature-login"), "beside the main worktree, in the disk's spelling");
  assert.equal(folderQs[0].confirmLabel, "Create Worktree");
  assert.match(folderQs[0].hint ?? "", /Suggested beside the main worktree, as app-feature-login/);
  assert.ok(existsSync(join(s.base, "app-feature-login")));
  assert.ok(existsSync(join(s.base, "app-bugfix-login")));
  assert.equal(at(join(s.base, "app-feature-login"))("symbolic-ref", "--short", "HEAD"), "feature/login");
});

test("…the folder can be edited: a relative one lands beside the main worktree, ~ is home", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = newBranchAnswers("topic", () => "elsewhere/topic-here");
  await wt.addWorktree(repos, noop);
  assert.ok(existsSync(join(s.base, "elsewhere", "topic-here")));
});

test("…a suggestion that is taken moves on to the next free name", async () => {
  const s = scene();
  mkdirSync(join(s.base, "app-hotfix-x"));
  writeFileSync(join(s.base, "app-hotfix-x", "mine.txt"), "x\n");
  const repos = windowAt(s.app);
  answer = newBranchAnswers("hotfix/x");
  await wt.addWorktree(repos, noop);
  assert.ok(existsSync(join(s.base, "app-hotfix-x-2")));
  assert.equal(readFileSync(join(s.base, "app-hotfix-x", "mine.txt"), "utf8"), "x\n");
});

test("New worktree into a folder that is taken: asked again with why before git runs; no branch left behind", async () => {
  const s = scene();
  const taken = join(s.base, "taken");
  mkdirSync(taken);
  writeFileSync(join(taken, "mine.txt"), "x\n");
  const repos = windowAt(s.app);
  let tries = 0;
  answer = newBranchAnswers("hotfix/y", () => (++tries === 1 ? taken : undefined));
  await wt.addWorktree(repos, noop);
  const folderQs = asked.filter((q) => q.kind === "input" && q.title.startsWith("New worktree for ")) as (DialogSpec & { kind: "input" })[];
  assert.equal(folderQs.length, 2, "asked again");
  assert.match(folderQs[1].hint ?? "", /taken already exists and isn't empty — choose another folder/);
  assert.equal(s.git("branch", "--list", "hotfix/y"), "", "no orphan branch");
  assert.deepEqual(errors(), []);
});

test("New worktree into the folder of a worktree git still has, though its folder is gone: asked again in words, no branch made", async () => {
  for (const gone of ["feat-gone", "feat-gone-locked"]) {
    const s = scene();
    const repos = windowAt(s.app);
    asked = [];
    let tries = 0;
    answer = newBranchAnswers(`x/${gone}`, () => (++tries === 1 ? s.path(gone) : undefined));
    await wt.addWorktree(repos, noop);
    assert.deepEqual(errors(), [], `${gone}: not git's "missing but already registered worktree; use 'add -f'"`);
    const folderQs = asked.filter((q) => q.kind === "input" && q.title.startsWith("New worktree for ")) as (DialogSpec & { kind: "input" })[];
    assert.match(folderQs[1].hint ?? "", new RegExp(`git still has a worktree at .*wt[\\\\/]${gone} \\(${gone}\\), though its folder is gone — forget that worktree in Worktrees`));
    assert.equal(s.git("branch", "--list", `x/${gone}`), "", "no branch made");
    assert.ok(listed(s).includes(gone), "the registered worktree is untouched");
  }
});

test("New worktree with a branch name that is taken asks again instead of failing in git", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  const names = ["feat-clean", "feat-clean-2"];
  answer = (spec) =>
    spec.kind === "pick"
      ? "gitstudio:new-branch"
      : spec.kind === "input" && spec.title === "New worktree branch"
        ? names.shift()
        : spec.kind === "input"
          ? spec.value
          : undefined;
  await wt.addWorktree(repos, noop);
  const inputs = asked.filter((q) => q.kind === "input" && q.title === "New worktree branch");
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].hint ?? "", /feat-clean already exists/);
  assert.deepEqual(errors(), []);
  assert.ok(existsSync(join(s.base, "app-feat-clean-2")));
});

test("New worktree from a branch another worktree has checked out never offers to check it out again", async () => {
  const s = scene();
  const repos = windowAt(s.app);
  answer = (spec) => {
    if (spec.kind === "pick") return spec.choices.some((c) => c.id === "direct") ? "direct" : undefined;
    if (spec.kind === "input" && spec.title === "New worktree branch") return "feat-clean-copy";
    if (spec.kind === "input") return spec.value;
    return undefined;
  };
  await wt.worktreeFromRef(repos, { name: "feat-clean", type: "head", sha: "" } as never, noop);
  assert.ok(!asked.some((q) => q.kind === "pick" && q.choices.some((c) => c.id === "direct")));
  const input = asked.find((q) => q.kind === "input");
  assert.match(input?.hint ?? "", /checked out in the worktree at/);
  assert.deepEqual(errors(), []);
  assert.ok(existsSync(join(s.base, "app-feat-clean-copy")));
});

test("New worktree from a branch named like an option never offers it directly — git would detach, not check it out", async () => {
  const s = scene();
  s.git("update-ref", "refs/heads/-x", "HEAD");
  const repos = windowAt(s.app);
  answer = (spec) => {
    if (spec.kind === "pick") return spec.choices.some((c) => c.id === "direct") ? "direct" : undefined;
    if (spec.kind === "input" && spec.title === "New worktree branch") return "x-copy";
    if (spec.kind === "input") return spec.value;
    return undefined;
  };
  await wt.worktreeFromRef(repos, { name: "-x", type: "head", sha: "" } as never, noop);
  assert.ok(!asked.some((q) => q.kind === "pick" && q.choices.some((c) => c.id === "direct")), "no direct checkout offered");
  assert.match(asked.find((q) => q.kind === "input")?.hint ?? "", /starts with "-"/);
  assert.deepEqual(errors(), []);
  const made = at(join(s.base, "app-x-copy"));
  assert.equal(made("symbolic-ref", "HEAD"), "refs/heads/x-copy", "on the new branch, not detached");
});

test("the bare-repository layout (project/.bare, its worktrees beside it): New Worktree suggests project/<branch>, never a hidden .bare-<branch>", async () => {
  assert.equal(wt.suggestWorktreeFolder("/x/project/.bare", "feature/login", () => true, true), join("/x/project", "feature-login"));
  assert.equal(wt.suggestWorktreeFolder("/x/project/.git", "fix", () => true, true), join("/x/project", "fix"), "a bare .git inside the project too");
  assert.equal(wt.suggestWorktreeFolder("/x/project/.bare", "a", (p) => !/[\\/]a$/.test(p), true), join("/x/project", "a-2"));
  assert.equal(wt.suggestWorktreeFolder("/x/repo.git", "a", () => true, true), join("/x", "repo-a"), "a bare repo.git beside its worktrees is as before");

  // Through the door, on a real layout.
  const base = join(scratch, `barelayout${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) at(seed)("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  at(seed)("add", ".");
  at(seed)("commit", "-qm", "base");
  const project = join(base, "project");
  execFileSync("git", ["clone", "-q", "--bare", seed, join(project, ".bare")]);
  writeFileSync(join(project, ".git"), "gitdir: ./.bare\n");
  at(project)("worktree", "add", "-q", join(project, "main"), "main");
  const repos = windowAt(join(project, "main"));
  answer = newBranchAnswers("feature/login");
  await wt.addWorktree(repos, noop);
  const folderQ = asked.find((q) => q.kind === "input" && q.title.startsWith("New worktree for ")) as DialogSpec & { kind: "input" };
  // Suggested from git's own spelling of the project: the disk's.
  assert.equal(folderQ.value, join(realpathSync.native(project), "feature-login"));
  assert.match(folderQ.hint ?? "", /Suggested in the project's folder, as feature-login/);
  assert.deepEqual(errors(), []);
  assert.equal(at(join(project, "feature-login"))("symbolic-ref", "--short", "HEAD"), "feature/login");
});

test("the suggestion for a bare repository's worktrees names the project without .git", () => {
  assert.equal(wt.projectName("/code/repo.git"), "repo");
  assert.equal(wt.suggestWorktreeFolder("/code/repo.git", "feature/a", () => true), join("/code", "repo-feature-a"));
  assert.equal(wt.suggestWorktreeFolder("/code/app", "a", (p) => !p.endsWith("app-a")), join("/code", "app-a-2"));
  assert.equal(dirname(wt.suggestWorktreeFolder("/code/app", "x")), join("/code"));
});

// ── Pull and Push, in the worktree's own folder ──────────────────────────────

/** A repository cloned from a bare origin, with a published branch in a linked worktree. */
function publishedScene() {
  const base = join(scratch, `p${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  const sg = at(seed);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) sg("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  sg("add", ".");
  sg("commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", "--bare", seed, join(base, "origin.git")]);
  const app = join(base, "app");
  execFileSync("git", ["clone", "-q", join(base, "origin.git"), app]);
  const git = at(app);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git("config", k, v);
  git("branch", "topic", "origin/main");
  git("push", "-q", "-u", "origin", "topic");
  const topic = join(base, "app-topic");
  git("worktree", "add", "-q", topic, "topic");
  // Someone else pushes to topic.
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", join(base, "origin.git"), other]);
  const og = at(other);
  for (const [k, v] of [["user.email", "o@example.com"], ["user.name", "O"], ["commit.gpgsign", "false"]]) og("config", k, v);
  og("checkout", "-q", "topic");
  writeFileSync(join(other, "b.txt"), "b\n");
  og("add", ".");
  og("commit", "-qm", "their work");
  og("push", "-q", "origin", "topic");
  git("fetch", "-q");
  return { base, app, git, topic };
}

test("Pull runs in the worktree's own folder: its branch moves, this window's does not", async () => {
  const p = publishedScene();
  const repos = windowAt(p.app);
  const before = p.git("rev-parse", "main");
  const log = uiLog();
  await wt.pullWorktree(repos, p.topic, noop, log.ui);
  assert.deepEqual(errors(), []);
  assert.equal(at(p.topic)("rev-parse", "HEAD"), p.git("rev-parse", "origin/topic"), "the worktree fast-forwarded");
  assert.ok(existsSync(join(p.topic, "b.txt")));
  assert.equal(p.git("rev-parse", "main"), before, "this window's branch did not move");
  assert.deepEqual(log.events, ["busy app-topic Pulling…", "busy app-topic -"]);
  assert.match(said.map((m) => m.message).join("\n"), /Pulled the worktree app-topic/);
});

test("Pull over a merge stopped in the worktree says so, naming the worktree, and runs nothing", async () => {
  const p = publishedScene();
  const t = at(p.topic);
  writeFileSync(join(p.topic, "a.txt"), "mine\n");
  t("commit", "-qam", "mine");
  t("branch", "side", "HEAD~1");
  t("checkout", "-q", "side");
  writeFileSync(join(p.topic, "a.txt"), "side\n");
  t("commit", "-qam", "side");
  t("checkout", "-q", "topic");
  assert.throws(() => t("merge", "side"));
  const repos = windowAt(p.app);
  const head = t("rev-parse", "HEAD");
  await wt.pullWorktree(repos, p.topic, noop);
  const w = said.find((m) => m.kind === "warning");
  assert.ok(w, said.map((m) => m.message).join(" / "));
  assert.match(w.message, /^GitStudio: Pull in the worktree app-topic didn't run:/);
  assert.deepEqual(w.items, ["Open in New Window"]);
  assert.equal(t("rev-parse", "HEAD"), head);
});

test("Pull on this window's own worktree goes through the status bar's Pull — the same flow", async () => {
  const p = publishedScene();
  const repos = windowAt(p.topic);
  await wt.pullWorktree(repos, p.topic, noop);
  assert.deepEqual(executed.map((e) => e.command), ["gitstudio.sync.pull"]);
});

test("Push… for another worktree names it and hands the review a context in THAT folder; for this window's, the active one", async () => {
  const p = publishedScene();
  const repos = windowAt(p.app);
  const t = await wt.pushTargetFor(repos, p.topic);
  assert.ok(t && t !== "active");
  assert.equal(t.name, "app-topic");
  assert.equal(folderKey(t.entry.root), folderKey(p.topic));
  assert.equal((await t.entry.ctx.refs.getHead()).fullName, "refs/heads/topic", "its HEAD, not this window's");
  t.release();
  assert.equal(await wt.pushTargetFor(windowAt(p.topic), p.topic), "active");
});

// ── The Branches view's tooltip (the code-span sibling) ─────────────────────

test("the Branches view's tooltip names a branch's upstream in a code span, no backslash escapes", async () => {
  const s = scene();
  s.git("branch", "feat_x");
  const repos = windowAt(s.app);
  s.git("remote", "add", "origin", join(s.base, "nowhere.git"));
  s.git("update-ref", "refs/remotes/origin/feat_x-1.2", "HEAD");
  s.git("config", "branch.feat_x.remote", "origin");
  s.git("config", "branch.feat_x.merge", "refs/heads/feat_x-1.2");
  const tree = new RefsTreeProvider(repos);
  const [local] = await tree.getChildren();
  const branch = (await tree.getChildren(local)).find((n) => n.label === "feat_x") as unknown as TreeItem;
  assert.ok(branch?.tooltip?.value.includes("`origin/feat_x-1.2`"), branch?.tooltip?.value);
});

test("a code span shows its text exactly, backticks included", () => {
  const { codeSpan } = require("../src/ui/markdownCode") as typeof import("../src/ui/markdownCode"); // eslint-disable-line @typescript-eslint/no-require-imports
  assert.equal(codeSpan("my-app.worktrees/feat_x (copy)"), "`my-app.worktrees/feat_x (copy)`");
  assert.equal(codeSpan("a`b"), "``a`b``");
  assert.equal(codeSpan("`tick"), "`` `tick ``");
  assert.equal(codeSpan(" padded "), "`  padded  `");
});
