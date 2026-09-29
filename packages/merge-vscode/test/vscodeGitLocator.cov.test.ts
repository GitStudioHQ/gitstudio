import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { VscodeGitLocator } from "../src/vscodeGitLocator";
import { git, newRepo, removeTemp } from "./fixtures";

// Merge Studio's RepoLocator over vscode.git (vscodeGitLocator.ts): when it
// can exist at all, which repository a path or the active editor belongs to,
// repositories opening and closing, and the debounced change event — against
// REAL repositories (the watch targets come from `git rev-parse --git-path`).

type Listener = () => void;

interface FakeGitRepo {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
  status(): Promise<void>;
  changed: vscode.EventEmitter<void>;
  statusCalls: number;
}

function gitRepoAt(root: string): FakeGitRepo {
  const changed = new vscode.EventEmitter<void>();
  const r: FakeGitRepo = {
    rootUri: vscode.Uri.file(root),
    state: { onDidChange: changed.event },
    status: async () => {
      r.statusCalls++;
    },
    changed,
    statusCalls: 0,
  };
  return r;
}

function installGit(repositories: FakeGitRepo[], opts: { gitPath?: string; enabled?: boolean; active?: boolean } = {}) {
  const open = new vscode.EventEmitter<FakeGitRepo>();
  const close = new vscode.EventEmitter<FakeGitRepo>();
  const exports = {
    enabled: opts.enabled ?? true,
    getAPI: () => ({
      repositories,
      git: { path: opts.gitPath ?? "" },
      onDidOpenRepository: open.event,
      onDidCloseRepository: close.event,
    }),
  };
  let activated = 0;
  stub.extensions["vscode.git"] = {
    isActive: opts.active ?? true,
    exports: opts.active === false ? undefined : exports,
    activate: async () => {
      activated++;
      return exports;
    },
  };
  return { open, close, activated: () => activated };
}

/** Watchers whose listeners the test can fire (the shared stand-in drops them). */
function recordWatchers(): { fire(kind: "create" | "change" | "delete"): void; restore(): void; live(): number } {
  const ws = vscode.workspace as unknown as { createFileSystemWatcher: (p: unknown) => unknown };
  const original = ws.createFileSystemWatcher;
  const made: { listeners: Record<string, Listener[]>; disposed: boolean }[] = [];
  ws.createFileSystemWatcher = () => {
    const w = { listeners: { create: [], change: [], delete: [] } as Record<string, Listener[]>, disposed: false };
    made.push(w);
    const on = (k: string) => (l: Listener) => {
      w.listeners[k].push(l);
      return new vscode.Disposable(() => {});
    };
    return {
      onDidCreate: on("create"),
      onDidChange: on("change"),
      onDidDelete: on("delete"),
      dispose: () => {
        w.disposed = true;
      },
    };
  };
  return {
    fire: (kind) => {
      for (const w of made) if (!w.disposed) for (const l of w.listeners[kind]) l();
    },
    restore: () => {
      ws.createFileSystemWatcher = original;
    },
    live: () => made.filter((w) => !w.disposed).length,
  };
}

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const temps: string[] = [];
let locator: VscodeGitLocator | undefined;

beforeEach(() => stub.reset());
afterEach(() => {
  locator?.dispose();
  locator = undefined;
  for (const d of temps.splice(0)) removeTemp(d);
});

function repo(prefix: string): string {
  const r = newRepo(prefix);
  temps.push(r.dir);
  return r.repo;
}

test("no vscode.git, or vscode.git turned off: there is no locator", async () => {
  assert.equal(await VscodeGitLocator.create(), undefined);
  installGit([], { enabled: false });
  assert.equal(await VscodeGitLocator.create(), undefined);
});

test("a vscode.git that fails to activate means no locator, not a crash", async () => {
  stub.extensions["vscode.git"] = {
    isActive: false,
    activate: async () => {
      throw new Error("git extension failed to start");
    },
  };
  assert.equal(await VscodeGitLocator.create(), undefined);
});

test("a vscode.git not yet active is activated first, and its repositories bound", async () => {
  const root = repo("loc-inactive");
  const git = installGit([gitRepoAt(root)], { active: false });
  locator = await VscodeGitLocator.create();
  assert.ok(locator);
  assert.equal(git.activated(), 1);
  assert.deepEqual(locator.all().map((r) => r.root), [vscode.Uri.file(root).fsPath]);
});

test("a path belongs to the deepest repository that holds it; the active editor's repository is the active one", async () => {
  const outer = repo("loc-outer");
  // A real nested repository (a spawn in a folder that does not exist trips
  // the process-group bug described at the end of this file).
  const inner = join(outer, "vendor", "lib");
  mkdirSync(inner, { recursive: true });
  git(inner, "init", "-q");
  const outerRepo = gitRepoAt(outer);
  const innerRepo = gitRepoAt(inner);
  installGit([outerRepo, innerRepo]);
  locator = await VscodeGitLocator.create();
  assert.ok(locator);
  const innerRoot = innerRepo.rootUri.fsPath;
  const outerRoot = outerRepo.rootUri.fsPath;
  assert.equal(locator.forPath(`${innerRoot}/src/a.ts`)?.root, innerRoot);
  assert.equal(locator.forPath(`${outerRoot}/README.md`)?.root, outerRoot);
  assert.equal(locator.forPath("/somewhere/else.ts"), undefined);

  assert.equal(locator.active()?.root, outerRoot, "no editor: the first repository");
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
    document: { uri: vscode.Uri.file(`${innerRoot}/x.ts`) },
  };
  assert.equal(locator.active()?.root, innerRoot);
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
    document: { uri: vscode.Uri.file("/elsewhere/y.ts") },
  };
  assert.equal(locator.active()?.root, outerRoot, "an editor outside every repository: the first");
});

test("repositories opened and closed later are bound and dropped; a second open of one is ignored", async () => {
  const a = repo("loc-a");
  const b = repo("loc-b");
  const aRepo = gitRepoAt(a);
  const bRepo = gitRepoAt(b);
  const git = installGit([aRepo]);
  locator = await VscodeGitLocator.create();
  assert.ok(locator);
  git.open.fire(bRepo);
  git.open.fire(gitRepoAt(b));
  assert.deepEqual(
    locator.all().map((r) => r.root),
    [aRepo.rootUri.fsPath, bRepo.rootUri.fsPath],
  );
  git.close.fire(aRepo);
  assert.deepEqual(locator.all().map((r) => r.root), [bRepo.rootUri.fsPath]);
  git.close.fire(aRepo); // already gone: nothing happens
  git.close.fire(gitRepoAt("/never/opened"));
  assert.equal(locator.all().length, 1);
});

test("vscode.git's state changes reach listeners once, debounced", async () => {
  const root = repo("loc-events");
  const r = gitRepoAt(root);
  installGit([r]);
  locator = await VscodeGitLocator.create();
  assert.ok(locator);
  let fired = 0;
  // The binding itself fires; let that one pass first.
  const first = locator.onDidChange(() => fired++);
  await until(() => fired === 1, "the binding's own event");
  r.changed.fire();
  r.changed.fire();
  r.changed.fire();
  await until(() => fired === 2, "one event for three changes");
  first.dispose();
  r.changed.fire();
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(fired, 2, "a disposed listener hears nothing");
});

test("git's own operation files are watched: a change there asks vscode.git to rescan and tells listeners", async () => {
  const w = recordWatchers();
  try {
    const root = repo("loc-watch");
    const r = gitRepoAt(root);
    installGit([r]);
    locator = await VscodeGitLocator.create();
    assert.ok(locator);
    await until(() => w.live() === 2, "the two watchers (operation state, refs)");
    let fired = 0;
    locator.onDidChange(() => fired++);
    await until(() => fired >= 1, "the binding's own event");
    const before = fired;
    w.fire("create");
    assert.equal(r.statusCalls, 2, "each watcher pokes vscode.git");
    await until(() => fired === before + 1, "the watcher's event");
    w.fire("change");
    w.fire("delete");
    assert.equal(r.statusCalls, 6);
    // Closing the repository disposes its watchers.
    locator.dispose();
    locator = undefined;
    assert.equal(w.live(), 0);
  } finally {
    w.restore();
  }
});

test("a repository git cannot describe is still bound, with no watchers", async () => {
  const w = recordWatchers();
  try {
    const root = repo("loc-nogit");
    const r = gitRepoAt(root);
    installGit([r], { gitPath: join(root, "no-such-git-binary") });
    locator = await VscodeGitLocator.create();
    assert.ok(locator);
    assert.equal(locator.all().length, 1);
    // Wait for the (failed) answer: the binding's event still arrives.
    let fired = 0;
    locator.onDidChange(() => fired++);
    await until(() => fired === 1, "the binding's event");
    await settle();
    assert.equal(w.live(), 0);
    // poke still reaches vscode.git.
    await locator.all()[0].poke?.();
    assert.equal(r.statusCalls, 1);
  } finally {
    w.restore();
  }
});

// GitProcess.dispose used to kill a git that could not be spawned (a missing
// binary, a repository folder that no longer exists). It has no pid until node
// emits its "error" on the next tick, and ChildProcess.kill() in that window
// signals pid 0 — the WHOLE process group. So a GitContext disposed in the same
// tick it tried such a spawn (a repository closed, or this locator disposed,
// right after vscode.git opened it) SIGTERMed its own process group: the
// extension host, and everything in it. Found when it killed the test runner.
test("closing a repository whose git cannot be started does not signal the extension host's process group", async () => {
  let signalled = false;
  const onTerm = () => {
    signalled = true;
  };
  process.on("SIGTERM", onTerm);
  try {
    const r = gitRepoAt(join(repo("loc-bug"), "gone"));
    const g = installGit([r]);
    locator = await VscodeGitLocator.create();
    g.close.fire(r); // disposes its GitContext while the failed spawn is pending
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(signalled, false);
  } finally {
    process.off("SIGTERM", onTerm);
  }
});
