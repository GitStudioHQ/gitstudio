// The Worktrees view's rows and commands, through the REAL extension code
// against real git (the Worktrees audit): what each row offers, what each
// command asks, and what the repository looks like after.
//
// The runner cannot load VS Code: a stand-in records every message, command
// and folder picker; the dialog host answers each question from the test's
// script. The menus a row offers are read from package.json's own `when`
// clauses, evaluated against the row's contextValue — the same match VS Code
// makes.

import Module from "node:module";
import { basename, join } from "node:path";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { folderKey } from "@gitstudio/git-service/folderPath";

// ── The stand-in for `vscode` ────────────────────────────────────────────────
const said: { kind: string; message: string; items?: string[] }[] = [];
const executed: { command: string; args: unknown[] }[] = [];
const pickers: { title?: string; openLabel?: string }[] = [];
let pickFolder: string | undefined;
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
  command?: { command: string; arguments?: unknown[] };
  iconPath?: ThemeIcon;
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
    showOpenDialog: async (opts: { title?: string; openLabel?: string }) => {
      pickers.push({ title: opts.title, openLabel: opts.openLabel });
      return pickFolder ? [Uri.file(pickFolder)] : undefined;
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
import type { DialogSpec } from "../src/ui/dialogs";

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
let answer: (spec: DialogSpec) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});
const yes = (spec: DialogSpec): string | undefined => (spec.kind === "confirm" ? "ok" : undefined);

beforeEach(() => {
  asked = [];
  answer = () => undefined;
  said.length = 0;
  executed.length = 0;
  pickers.length = 0;
  pickFolder = undefined;
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
  const repos = {
    getActive: () => entry,
    onDidChange: () => new Disposable(),
  } as never;
  const state = new Map<string, unknown>();
  const store = {
    get: (k: string) => state.get(k),
    update: async (k: string, v: unknown) => void state.set(k, v),
    keys: () => [...state.keys()],
  } as never;
  return { repos, provider: new wt.WorktreesTreeProvider(repos, store) };
}

type Node = InstanceType<typeof wt.WorktreeNode>;
async function rows(provider: InstanceType<typeof wt.WorktreesTreeProvider>): Promise<Node[]> {
  provider.refresh();
  return provider.getChildren();
}
async function row(provider: InstanceType<typeof wt.WorktreesTreeProvider>, label: string): Promise<Node> {
  const hit = (await rows(provider)).find((n) => n.label === label || n.entry.branch === label);
  assert.ok(hit, `a row for ${label}`);
  return hit;
}
const listed = (s: Scene): string[] =>
  s.git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("branch "))
    .map((l) => l.slice("branch refs/heads/".length));
const errors = (): string[] => said.filter((m) => m.kind === "error").map((m) => m.message);
const noop = (): void => {};

// ── The menus: package.json's `when` clauses, evaluated as VS Code does ─────
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: { menus: Record<string, { command: string; when?: string; group?: string }[]> };
};

/** A `when` clause over `view` and `viewItem`: == != =~ /re/ && || ! ( ). */
function when(clause: string, keys: Record<string, string>): boolean {
  const tokens = clause.match(/\/(?:\\.|[^/])+\/[a-z]*|&&|\|\||==|!=|=~|!|\(|\)|[^\s()!&|=]+/g) ?? [];
  let i = 0;
  const value = (t: string): string => (t in keys ? keys[t] : t);
  function or(): boolean {
    let v = and();
    while (tokens[i] === "||") {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  }
  function and(): boolean {
    let v = unary();
    while (tokens[i] === "&&") {
      i++;
      const r = unary();
      v = v && r;
    }
    return v;
  }
  function unary(): boolean {
    const t = tokens[i++];
    if (t === "!") return !unary();
    if (t === "(") {
      const v = or();
      i++; // ")"
      return v;
    }
    if (t === "true") return true;
    if (t === "false") return false;
    const op = tokens[i];
    if (op === "==" || op === "!=") {
      i++;
      const eq = value(t) === tokens[i++];
      return op === "==" ? eq : !eq;
    }
    if (op === "=~") {
      i++;
      const lit = tokens[i++];
      const m = /^\/(.*)\/([a-z]*)$/.exec(lit)!;
      return new RegExp(m[1], m[2]).test(value(t));
    }
    return !!keys[t];
  }
  return or();
}

/** The commands a row offers: inline buttons and its right-click menu. */
function offered(node: Node): { inline: string[]; menu: string[] } {
  const keys = { view: "gitstudio.worktrees", viewItem: node.contextValue ?? "" };
  const hits = manifest.contributes.menus["view/item/context"].filter((m) => m.when && when(m.when, keys));
  const short = (c: string) => c.replace(/^gitstudio\.worktree\./, "");
  return {
    inline: hits.filter((m) => m.group?.startsWith("inline")).map((m) => short(m.command)),
    menu: hits.filter((m) => !m.group?.startsWith("inline")).map((m) => short(m.command)),
  };
}

// ── Remove ───────────────────────────────────────────────────────────────────

test("a locked worktree: ONE question naming the lock's reason, and it is gone after", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  answer = yes;
  await wt.removeWorktree(repos, await row(provider, "feat-locked"), noop);

  assert.equal(asked.length, 1, "asked once — not twice, and then git's refusal");
  const q = asked[0] as DialogSpec & { kind: "confirm" };
  assert.match(q.title, /feat-locked/);
  assert.match(q.message, /on a USB drive/);
  assert.equal(q.confirmLabel, "Unlock and Remove");
  assert.deepEqual(errors(), []);
  assert.equal(existsSync(s.path("feat-locked")), false);
  assert.ok(!listed(s).includes("feat-locked"));
  assert.equal(s.git("branch", "--list", "feat-locked"), "feat-locked", "the branch stays");
});

test("a dirty worktree: the question lists what is lost, and says the branch stays", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  answer = yes;
  await wt.removeWorktree(repos, await row(provider, "feat-dirty"), noop);

  assert.equal(asked.length, 1);
  const q = asked[0] as DialogSpec & { kind: "confirm" };
  for (const f of ["a.txt", "new.txt", "staged.txt"]) assert.ok(q.message.includes(f), `names ${f}`);
  assert.match(q.message, /3 uncommitted changes/);
  assert.match(q.message, /branch feat-dirty and its commits stay/);
  assert.equal(q.confirmLabel, "Discard Changes and Remove");
  assert.deepEqual(errors(), []);
  assert.equal(existsSync(s.path("feat-dirty")), false);
});

test("a clean worktree: one plain question, removed, the branch kept", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  answer = yes;
  await wt.removeWorktree(repos, await row(provider, "feat-clean"), noop);
  assert.equal(asked.length, 1);
  assert.equal((asked[0] as DialogSpec & { kind: "confirm" }).confirmLabel, "Remove");
  assert.equal(existsSync(s.path("feat-clean")), false);
  assert.equal(s.git("branch", "--list", "feat-clean"), "feat-clean");
});

test("a change made while the question was open is asked about, never deleted — and the lock goes back", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  const late = join(s.path("feat-locked"), "agent-wrote-this.txt");
  answer = (spec) => {
    if (spec.kind !== "confirm") return undefined;
    if (asked.length === 1) {
      writeFileSync(late, "work in progress\n"); // the agent, mid-question
      return "ok";
    }
    return undefined; // the second question: keep it
  };
  await wt.removeWorktree(repos, await row(provider, "feat-locked"), noop);

  assert.equal(asked.length, 2, "asked again, with what it holds now");
  const again = asked[1] as DialogSpec & { kind: "confirm" };
  assert.match(again.message, /agent-wrote-this\.txt/);
  assert.equal(again.confirmLabel, "Unlock, Discard Changes and Remove");
  assert.equal(readFileSync(late, "utf8"), "work in progress\n", "nothing was deleted");
  assert.match(s.git("worktree", "list", "--porcelain"), /locked on a USB drive/, "locked again, with its reason");
  assert.deepEqual(errors(), []);
});

test("dirty when asked, a file written while the question is open is asked about too, never deleted — locked or not", async () => {
  for (const locked of [true, false]) {
    const s = scene();
    const { repos, provider } = windowAt(s.app);
    // The owner's common case: an agent's worktree, locked and still at work.
    if (locked) s.git("worktree", "lock", "--reason", "claude agent 7", s.path("feat-dirty"));
    const late = join(s.path("feat-dirty"), "written-while-asking.txt");
    asked = [];
    answer = (spec) => {
      if (spec.kind !== "confirm") return undefined;
      if (asked.length === 1) {
        writeFileSync(late, "agent output\n"); // the agent, mid-question
        return "ok";
      }
      return undefined; // the second question: keep it
    };
    await wt.removeWorktree(repos, await row(provider, "feat-dirty"), noop);

    const first = asked[0] as DialogSpec & { kind: "confirm" };
    assert.match(first.message, /Its 3 uncommitted changes go with it/);
    assert.doesNotMatch(first.message, /written-while-asking/);
    assert.equal(asked.length, 2, `${locked ? "locked" : "unlocked"}: asked again, with what it holds now`);
    const again = asked[1] as DialogSpec & { kind: "confirm" };
    assert.match(again.message, /Its 4 uncommitted changes go with it/);
    assert.match(again.message, /written-while-asking\.txt/);
    assert.equal(readFileSync(late, "utf8"), "agent output\n", "the file the first question never named is still there");
    assert.ok(existsSync(join(s.path("feat-dirty"), "new.txt")), "…and so is everything else");
    if (locked) assert.match(s.git("worktree", "list", "--porcelain"), /locked claude agent 7/, "still locked, with its reason");
    assert.deepEqual(errors(), []);
  }
});

test("a worktree that keeps changing is asked about twice at most, then says nothing was removed", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  let n = 0;
  answer = (spec) => {
    if (spec.kind !== "confirm") return undefined;
    writeFileSync(join(s.path("feat-dirty"), `agent-${++n}.txt`), "more\n");
    return "ok";
  };
  await wt.removeWorktree(repos, await row(provider, "feat-dirty"), noop);
  assert.equal(asked.length, 2, "asked again once, not in a loop");
  assert.ok(existsSync(join(s.path("feat-dirty"), "agent-2.txt")), "nothing deleted");
  assert.deepEqual(errors(), []);
  assert.match(
    said.map((m) => m.message).join("\n"),
    /feat-dirty has uncommitted changes it didn't have when you were asked, so nothing was removed/,
  );
});

test("a worktree stopped in a merge: the question says removing it abandons the merge", async () => {
  const s = scene();
  const merging = s.path("feat-clean");
  const m = at(merging);
  writeFileSync(join(merging, "a.txt"), "feat\n");
  m("commit", "-qam", "feat change");
  writeFileSync(join(s.app, "a.txt"), "main\n");
  s.git("commit", "-qam", "main change");
  assert.throws(() => m("merge", "main"));
  const { repos, provider } = windowAt(s.app);
  answer = () => undefined; // asked, and kept
  await wt.removeWorktree(repos, await row(provider, "feat-clean"), noop);
  const q = asked[0] as DialogSpec & { kind: "confirm" };
  assert.match(q.message, /A merge is in progress in it\. Removing the worktree abandons the merge\./);
  assert.match(q.message, /a\.txt/);
  assert.ok(existsSync(merging));
});

test("the worktree this window has open is never removed — nothing is asked and the folder stays", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.path("feat-clean"));
  answer = yes;
  const node = await row(provider, "feat-clean");
  assert.match(node.description ?? "", /^current/);
  assert.deepEqual(offered(node).inline, [], "no inline Remove (or Open) on it");
  assert.ok(!offered(node).menu.includes("remove"));

  await wt.removeWorktree(repos, node, noop);
  assert.equal(asked.length, 0);
  assert.ok(existsSync(s.path("feat-clean")));
  assert.match(said.map((m) => m.message).join("\n"), /this window has feat-clean open/i);
});

test("a worktree open as another folder of this window counts as open here too", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app, [s.app, join(s.path("feat-clean"))]);
  answer = yes;
  const node = await row(provider, "feat-clean");
  assert.ok(!offered(node).menu.includes("remove"));
  await wt.removeWorktree(repos, node, noop);
  assert.equal(asked.length, 0);
  assert.ok(existsSync(s.path("feat-clean")));
});

test("opened through a symlink, the window's worktree is still the current one", async () => {
  const s = scene();
  const link = join(s.base, "link-to-app");
  symlinkSync(s.app, link);
  const { provider } = windowAt(link);
  const main = await row(provider, "main");
  assert.match(main.description ?? "", /^current/);
  assert.equal((await rows(provider)).filter((n) => /^current/.test(n.description ?? "")).length, 1);
});

test("the main worktree says so, offers no Remove, and a Remove that reaches it runs no git", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.path("feat-clean"));
  answer = yes;
  const main = await row(provider, "main");
  assert.match(main.description ?? "", /main worktree/);
  assert.ok(!offered(main).inline.includes("remove"));
  assert.ok(!offered(main).menu.includes("remove"));
  assert.ok(!offered(main).menu.includes("lock"), "git cannot lock the main worktree either");
  assert.ok(offered(main).inline.includes("openInNewWindow"));

  await wt.removeWorktree(repos, main, noop);
  assert.equal(asked.length, 0);
  assert.deepEqual(errors(), []);
  assert.match(said.map((m) => m.message).join("\n"), /main worktree/);
  assert.ok(existsSync(s.app));
});

test("a bare repository's entry offers nothing", async () => {
  const base = join(scratch, `bare${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  const g = at(seed);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) g("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  g("add", ".");
  g("commit", "-qm", "base");
  const bare = join(base, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  at(bare)("worktree", "add", "-q", join(base, "main-wt"), "main");
  const { provider } = windowAt(join(base, "main-wt"));
  const entry = (await rows(provider)).find((n) => n.entry.bare);
  assert.ok(entry);
  assert.deepEqual(offered(entry), { inline: [], menu: [] });
  assert.equal(entry.command, undefined);
});

// ── A worktree whose folder is gone ──────────────────────────────────────────

test("a missing folder: no Open, the row says so, and Forget clears it (past its lock too)", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  answer = (spec) => (spec.kind === "pick" ? "new" : spec.kind === "confirm" ? "ok" : undefined);

  for (const name of ["feat-gone", "feat-gone-locked"]) {
    const node = await row(provider, name);
    assert.match(node.description ?? "", /folder missing/);
    assert.equal(node.command, undefined, "a click opens nothing");
    assert.ok(!offered(node).inline.some((c) => c.startsWith("open")));
    assert.ok(!offered(node).menu.some((c) => c.startsWith("open")));
    assert.ok(!offered(node).menu.includes("remove"));
    assert.ok(offered(node).inline.includes("forget"));

    // Reached anyway (a stale row): it says the folder is gone, opens nothing.
    await wt.openWorktree(node);
    assert.ok(!executed.some((e) => e.command === "vscode.openFolder"), `${name}: no window on a missing folder`);
    assert.match(said.map((m) => m.message).join("\n"), /folder is gone/);
  }

  asked = [];
  await wt.removeWorktree(repos, await row(provider, "feat-gone"), noop);
  assert.equal((asked[0] as DialogSpec & { kind: "confirm" }).confirmLabel, "Forget");
  asked = [];
  await wt.removeWorktree(repos, await row(provider, "feat-gone-locked"), noop);
  const q = asked[0] as DialogSpec & { kind: "confirm" };
  assert.match(q.message, /agent 42/);
  assert.equal(q.confirmLabel, "Unlock and Forget");
  assert.deepEqual(errors(), []);
  assert.ok(!listed(s).includes("feat-gone"));
  assert.ok(!listed(s).includes("feat-gone-locked"));
});

test("a message or a question names a worktree's folder as its row does, never in git's spelling", async () => {
  const s = scene();
  // Home is the scene's folder as git spells it, so every worktree here has a
  // shown spelling that is not git's on every system: ~/wt/… on macOS and
  // Linux, C:\Users\…\wt\… (git's C:/Users/…/wt/…) on Windows.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = realpathSync.native(s.base);
  try {
    const { provider } = windowAt(s.app);
    const shown = (n: Node): string => (n.description ?? "").split(" · ").pop() ?? "";

    const gone = await row(provider, "feat-gone");
    assert.notEqual(shown(gone), gone.entry.path, "precondition: the row's spelling is not git's");
    await wt.openWorktree(gone);
    const warning = said.find((m) => /folder is gone/.test(m.message))?.message ?? "";
    assert.ok(warning.includes(`folder is gone — ${shown(gone)}.`), `the warning names it as its row does: ${warning}`);
    assert.ok(!warning.includes(gone.entry.path), "not in git's spelling");

    const clean = await row(provider, "feat-clean");
    await wt.openWorktree(clean);
    const question = asked.find((q) => q.kind === "pick");
    assert.equal(question?.hint, shown(clean), "the question says where it is as its row does");
    assert.ok(!executed.some((e) => e.command === "vscode.openFolder"), "unanswered, nothing opened");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("Open on the current worktree never offers to reopen it in this window", async () => {
  const s = scene();
  const { provider } = windowAt(s.path("feat-clean"));
  answer = (spec) => {
    if (spec.kind === "pick") assert.ok(!spec.choices.some((c) => c.id === "here"), "no 'Open in This Window'");
    return undefined;
  };
  const node = await row(provider, "feat-clean");
  assert.equal(node.command, undefined, "clicking the window's own worktree opens nothing");
  await wt.openWorktree(node);
});

test("the row's Open in New Window opens at once — no question — and Open in This Window is in its menu", async () => {
  const s = scene();
  const { provider } = windowAt(s.app);
  answer = () => {
    throw new Error("a button that says where it opens asks nothing");
  };
  const node = await row(provider, "feat-clean");
  assert.deepEqual(offered(node).inline, ["openInNewWindow", "remove"]);
  assert.deepEqual(offered(node).menu.slice(0, 2), ["openInNewWindow", "openHere"]);

  await wt.openWorktreeIn(node, "new");
  await wt.openWorktreeIn(node, "here");
  assert.deepEqual(
    executed.map((e) => [e.command, folderKey((e.args[0] as { fsPath: string }).fsPath), (e.args[1] as { forceNewWindow: boolean }).forceNewWindow]),
    [
      ["vscode.openFolder", folderKey(s.path("feat-clean")), true],
      ["vscode.openFolder", folderKey(s.path("feat-clean")), false],
    ],
  );
  assert.equal(asked.length, 0);

  // The window's own worktree: neither is offered, and This Window reached anyway reopens nothing.
  executed.length = 0;
  const here = await row(windowAt(s.path("feat-clean")).provider, "feat-clean");
  assert.ok(!offered(here).inline.some((c) => c.startsWith("open")));
  assert.ok(!offered(here).menu.some((c) => c.startsWith("open")));
  await wt.openWorktreeIn(here, "here");
  assert.deepEqual(executed, []);
});

// ── Lock ─────────────────────────────────────────────────────────────────────

test("Lock asks why, and the reason reaches git and the row's tooltip; dismissed, nothing is locked", async () => {
  const s = scene();
  const { repos, provider } = windowAt(s.app);
  answer = (spec) => (spec.kind === "input" ? "agent 7 is working here" : undefined);
  await wt.lockWorktree(repos, await row(provider, "feat-clean"), true, noop);
  assert.match(s.git("worktree", "list", "--porcelain"), /locked agent 7 is working here/);
  const node = await row(provider, "feat-clean");
  assert.match(node.tooltip?.value ?? "", /agent 7 is working here/);

  // Dismissed: nothing is locked.
  answer = () => undefined;
  const detached = async () => (await rows(provider)).find((n) => !n.entry.branch && !n.entry.bare)!;
  await wt.lockWorktree(repos, await detached(), true, noop);
  assert.ok(!(await detached()).entry.locked);
});

// ── Prune ────────────────────────────────────────────────────────────────────

test("Prune says what it pruned — and that there was nothing, when there was nothing", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  await wt.pruneWorktrees(repos, noop);
  const first = said.map((m) => m.message).join("\n");
  assert.match(first, /feat-gone/);
  assert.ok(!listed(s).includes("feat-gone"));
  said.length = 0;
  s.git("worktree", "unlock", s.path("feat-gone-locked"));
  s.git("worktree", "prune");
  await wt.pruneWorktrees(repos, noop);
  assert.match(said.map((m) => m.message).join("\n"), /nothing to prune/i);
});

// ── New worktree ─────────────────────────────────────────────────────────────

test("New worktree: the folder is named for the whole branch, so feature/login and bugfix/login both fit", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const parent = join(s.base, "wt2");
  mkdirSync(parent);
  pickFolder = parent;
  for (const name of ["feature/login", "bugfix/login"]) {
    answer = (spec) => (spec.kind === "pick" ? "gitstudio:new-branch" : spec.kind === "input" ? name : undefined);
    await wt.addWorktree(repos, noop);
  }
  assert.deepEqual(errors(), []);
  assert.ok(existsSync(join(parent, "feature-login")));
  assert.ok(existsSync(join(parent, "bugfix-login")));
  assert.match(pickers[0].openLabel ?? "", /feature-login/, "the picker says which folder it creates");
});

test("New worktree into a folder that is taken: refused before git, no branch left behind, the retry works", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const parent = join(s.base, "wt3");
  mkdirSync(join(parent, "hotfix-x"), { recursive: true });
  writeFileSync(join(parent, "hotfix-x", "mine.txt"), "x\n");
  pickFolder = parent;
  answer = (spec) => (spec.kind === "pick" ? "gitstudio:new-branch" : spec.kind === "input" ? "hotfix/x" : undefined);
  await wt.addWorktree(repos, noop);
  assert.match(said.map((m) => m.message).join("\n"), /already exists/);
  assert.equal(s.git("branch", "--list", "hotfix/x"), "", "no orphan branch");

  rmSync(join(parent, "hotfix-x"), { recursive: true, force: true });
  said.length = 0;
  await wt.addWorktree(repos, noop);
  assert.deepEqual(errors(), []);
  assert.ok(existsSync(join(parent, "hotfix-x")));
});

test("New worktree into the folder of a worktree git still has, though its folder is gone: refused in words before git, no branch left behind", async () => {
  for (const [name, gone] of [["feat/gone", "feat-gone"], ["feat/gone-locked", "feat-gone-locked"]] as const) {
    const s = scene();
    const { repos } = windowAt(s.app);
    pickFolder = join(s.base, "wt");
    said.length = 0;
    answer = (spec) => (spec.kind === "pick" ? "gitstudio:new-branch" : spec.kind === "input" ? name : undefined);
    await wt.addWorktree(repos, noop);
    assert.deepEqual(errors(), [], `${name}: not git's "missing but already registered worktree; use 'add -f'"`);
    assert.ok(
      said.some(
        (m) =>
          m.kind === "warning" &&
          m.message ===
            `GitStudio: git still has a worktree at ${s.path(gone)} (${gone}), though its folder is gone, so nothing was created. Forget that worktree in Worktrees, or choose another folder.`,
      ),
      `${name}: says whose folder it is (${said.map((m) => m.message).join(" / ")})`,
    );
    assert.equal(s.git("branch", "--list", name), "", "no branch made");
    assert.ok(listed(s).includes(gone), "the registered worktree is untouched");
  }
});

test("…and one whose folder is there but emptied (git calls that missing too) says Remove, which is what its row offers", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  // Emptied, .git file and all: `worktree add` would take an empty folder,
  // but git still has it registered and refuses.
  rmSync(s.path("feat-clean"), { recursive: true, force: true });
  mkdirSync(s.path("feat-clean"));
  pickFolder = join(s.base, "wt");
  answer = (spec) => (spec.kind === "pick" ? "gitstudio:new-branch" : spec.kind === "input" ? "feat/clean" : undefined);
  await wt.addWorktree(repos, noop);
  assert.deepEqual(errors(), []);
  assert.ok(
    said.some(
      (m) =>
        m.message ===
        `GitStudio: git still has a worktree at ${s.path("feat-clean")} (feat-clean), so nothing was created. Remove that worktree in Worktrees, or choose another folder.`,
    ),
    said.map((m) => m.message).join(" / "),
  );
  assert.equal(s.git("branch", "--list", "feat/clean"), "");
});

test("New worktree with a branch name that is taken asks again instead of failing in git", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const parent = join(s.base, "wt4");
  mkdirSync(parent);
  pickFolder = parent;
  const names = ["feat-clean", "feat-clean-2"];
  answer = (spec) => (spec.kind === "pick" ? "gitstudio:new-branch" : spec.kind === "input" ? names.shift() : undefined);
  await wt.addWorktree(repos, noop);
  const inputs = asked.filter((q) => q.kind === "input");
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].hint ?? "", /feat-clean already exists/);
  assert.deepEqual(errors(), []);
  assert.ok(existsSync(join(parent, "feat-clean-2")));
});

test("New worktree from a branch another worktree has checked out never offers to check it out again", async () => {
  const s = scene();
  const { repos } = windowAt(s.app);
  const parent = join(s.base, "wt5");
  mkdirSync(parent);
  pickFolder = parent;
  answer = (spec) => {
    if (spec.kind === "pick") return spec.choices.some((c) => c.id === "direct") ? "direct" : undefined;
    if (spec.kind === "input") return "feat-clean-copy";
    return undefined;
  };
  await wt.worktreeFromRef(repos, { name: "feat-clean", type: "head", sha: "" } as never, noop);
  assert.ok(!asked.some((q) => q.kind === "pick" && q.choices.some((c) => c.id === "direct")));
  const input = asked.find((q) => q.kind === "input");
  assert.match(input?.hint ?? "", /checked out in the worktree at/);
  assert.deepEqual(errors(), []);
  assert.ok(existsSync(join(parent, "feat-clean-copy")));
});

test("New worktree from a branch named like an option never offers it directly — git would detach, not check it out", async () => {
  const s = scene();
  s.git("update-ref", "refs/heads/-x", "HEAD");
  const { repos } = windowAt(s.app);
  const parent = join(s.base, "wt6");
  mkdirSync(parent);
  pickFolder = parent;
  answer = (spec) => {
    if (spec.kind === "pick") return spec.choices.some((c) => c.id === "direct") ? "direct" : undefined;
    if (spec.kind === "input") return "x-copy";
    return undefined;
  };
  await wt.worktreeFromRef(repos, { name: "-x", type: "head", sha: "" } as never, noop);
  assert.ok(!asked.some((q) => q.kind === "pick" && q.choices.some((c) => c.id === "direct")), "no direct checkout offered");
  assert.match(asked.find((q) => q.kind === "input")?.hint ?? "", /starts with "-"/);
  assert.deepEqual(errors(), []);
  const made = at(join(parent, "x-copy"));
  assert.equal(made("symbolic-ref", "HEAD"), "refs/heads/x-copy", "on the new branch, not detached");
});

// ── The rows' words and symbols ──────────────────────────────────────────────

test("tooltip paths are code spans with no backslash escapes", async () => {
  const s = scene();
  const odd = join(s.base, "my-app.worktrees", "feat_x (copy)");
  s.git("worktree", "add", "-q", "-b", "feat_x", odd);
  const { provider } = windowAt(s.app);
  const node = await row(provider, "feat_x");
  assert.ok(node.tooltip?.value.includes("`" + realpathSync.native(odd) + "`"), node.tooltip?.value);
});

test("its sibling: the Branches view's tooltip names a branch's upstream in a code span the same way", async () => {
  const s = scene();
  s.git("branch", "feat_x");
  const { repos } = windowAt(s.app);
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

test("a detached row uses the commit symbol its tooltip does", async () => {
  const s = scene();
  const { provider } = windowAt(s.app);
  const node = (await rows(provider)).find((n) => !n.entry.branch && !n.entry.bare);
  assert.ok(node);
  assert.equal(node.iconPath?.id, "git-commit");
});
