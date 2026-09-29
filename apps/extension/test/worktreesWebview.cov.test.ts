// The Worktrees view's host — the message handler, the list's reads, the seed
// painted before git answers, and every row action the page can ask for — over
// real git. What the page is SENT is what is asserted: the rows and their
// state, a row's status and details, what is busy, patched and dropped; and
// what VS Code is asked to open. worktreesStateTable.test.ts pins what each
// row says over the whole state table; these are the host's other doors.
//
// The runner cannot load VS Code: a stand-in records every message, command
// and terminal; the dialog host answers each question from the test's script.

import Module from "node:module";
import { basename, join } from "node:path";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ── The stand-in for `vscode` ────────────────────────────────────────────────
const said: { kind: string; message: string }[] = [];
const executed: { command: string; args: unknown[] }[] = [];
const terminals: { name?: string; cwd?: string }[] = [];
let clipboard = "";
let folders: string[] = [];
let windowState: ((s: { focused: boolean }) => void) | undefined;
let windowStateDisposed = 0;

class Disposable {
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.();
  }
}
interface FakeUri {
  scheme: string;
  path: string;
  fsPath: string;
  query: string;
}
const Uri = {
  file: (p: string): FakeUri => ({ scheme: "file", path: p, fsPath: p, query: "" }),
  joinPath: (u: { fsPath: string }, ...parts: string[]) => Uri.file(join(u.fsPath, ...parts)),
  from: (o: { scheme: string; path: string; query?: string }): FakeUri => ({ scheme: o.scheme, path: o.path, fsPath: o.path, query: o.query ?? "" }),
};
const recorded =
  (kind: string) =>
  async (message: string): Promise<undefined> => {
    said.push({ kind, message });
    return undefined;
  };
const vscodeStub = {
  Disposable,
  Uri,
  window: {
    showErrorMessage: recorded("error"),
    showWarningMessage: recorded("warning"),
    showInformationMessage: recorded("info"),
    setStatusBarMessage: (message: string) => {
      said.push({ kind: "status", message });
      return new Disposable();
    },
    onDidChangeWindowState: (l: (s: { focused: boolean }) => void) => {
      windowState = l;
      return new Disposable(() => void windowStateDisposed++);
    },
    createTerminal: (o: { name?: string; cwd?: string }) => {
      terminals.push(o);
      return { show: () => {} };
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
    textDocuments: [],
  },
  env: {
    clipboard: {
      writeText: async (t: string) => {
        clipboard = t;
      },
    },
  },
};
type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB = join(tmpdir(), "__gs_worktrees_webview_cov_vscode_stub__.js");
M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
const origResolve = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : origResolve.call(this, request, parent, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { WorktreesWebviewProvider, revealLabel } = require("../src/views/worktreesWebview") as typeof import("../src/views/worktreesWebview");
const { EMPTY_TREE } = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogResult, DialogSpec } from "../src/ui/dialogs";
import type { WorktreeDetails, WorktreeRow, WorktreeRowStatus } from "@gitstudio/host-bridge/worktreesProtocol";
import { folderKey, sameFolder } from "@gitstudio/git-service/folderPath";

// ── Hermetic git ─────────────────────────────────────────────────────────────
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-wtwcov-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "gs-ext-wtwcov-")));
const contexts: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  for (const d of [scratch, join(cfg, "..")]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
let seq = 0;

let asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => DialogResult | string | undefined = () => undefined;
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : typeof v === "string" ? { value: v } : v;
  },
});

beforeEach(() => {
  asked = [];
  answer = () => undefined;
  said.length = 0;
  executed.length = 0;
  terminals.length = 0;
  clipboard = "";
  windowState = undefined;
  windowStateDisposed = 0;
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const identity = [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]];
const commit = (dir: string, file: string, text: string) => {
  writeFileSync(join(dir, file), text);
  at(dir)("add", "--", file);
  at(dir)("commit", "-qm", `${file}: ${text.trim()}`);
};

/**
 * A clone of a bare origin: the main worktree `app` on main (published), and
 * under wt/: `topic` (published, behind by one), `local` (no upstream),
 * `locked`, `gone` (folder deleted), `unlinked` (its .git removed).
 */
function scene() {
  const base = join(scratch, `s${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of identity) at(seed)("config", k, v);
  commit(seed, "a.txt", "a");
  const origin = join(base, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const app = join(base, "app");
  execFileSync("git", ["clone", "-q", origin, app]);
  const git = at(app);
  for (const [k, v] of identity) git("config", k, v);
  const wt = (n: string) => join(base, "wt", n);
  git("branch", "topic", "origin/main");
  git("push", "-q", "-u", "origin", "topic");
  git("worktree", "add", "-q", wt("topic"), "topic");
  for (const b of ["local", "locked", "gone", "unlinked"]) git("worktree", "add", "-q", "-b", b, wt(b));
  git("worktree", "lock", "--reason", "an agent", wt("locked"));
  rmSync(wt("gone"), { recursive: true, force: true });
  rmSync(join(wt("unlinked"), ".git"), { force: true });
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", origin, other]);
  for (const [k, v] of identity) at(other)("config", k, v);
  at(other)("checkout", "-q", "topic");
  commit(other, "o.txt", "theirs");
  at(other)("push", "-q", "origin", "topic");
  git("fetch", "-q");
  return { base, app, git, wt };
}

type Ctx = InstanceType<typeof GitContext>;
interface Entry {
  ctx: Ctx;
  root: string;
}

/** The view's host over the window at `root`, with a page that records what it is sent. */
function host(root: string | undefined, opts: { store?: Map<string, unknown>; discovering?: boolean } = {}) {
  folders = root ? [root] : [];
  let entry: Entry | undefined;
  if (root) {
    const ctx = new GitContext({ root });
    contexts.push(ctx);
    entry = { ctx, root };
  }
  let changed: () => void = () => {};
  let changeDisposed = 0;
  const repos = {
    getActive: () => entry,
    getAll: () => (entry ? [entry] : []),
    onDidChange: (l: () => void) => {
      changed = l;
      return new Disposable(() => void changeDisposed++);
    },
    isDiscovering: () => opts.discovering === true,
    getUndoLedger: () => undefined,
  };
  const posted: Record<string, unknown>[] = [];
  let visible = true;
  let disposed: (() => void) | undefined;
  const visibility: (() => void)[] = [];
  const view = {
    get visible() {
      return visible;
    },
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u: FakeUri) => u.fsPath,
      onDidReceiveMessage: () => new Disposable(),
      postMessage: async (m: Record<string, unknown>) => {
        posted.push(m);
        return true;
      },
    },
    onDidDispose: (l: () => void) => {
      disposed = l;
      return new Disposable();
    },
    onDidChangeVisibility: (l: () => void) => {
      visibility.push(l);
      return new Disposable();
    },
  };
  const state = opts.store ?? new Map<string, unknown>();
  const store = { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v), keys: () => [...state.keys()] };
  const reviews: unknown[] = [];
  let onChanged = 0;
  const provider = new WorktreesWebviewProvider(repos as never, Uri.file("/ext") as never, store as never, {
    openPushReview: async (t) => void reviews.push(t),
    onChanged: () => void onChanged++,
  });
  provider.resolveWebviewView(view as never);
  type Inside = { refreshing?: unknown; refreshTimer?: unknown; running: number; queue: unknown[] };
  const inside = provider as unknown as Inside;
  const idle = async () => {
    for (let i = 0; i < 2000; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (!inside.refreshing && !inside.refreshTimer && inside.running === 0 && inside.queue.length === 0) return;
    }
    throw new Error("the host never settled");
  };
  const handle = (provider as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage.bind(provider);
  function rows(): WorktreeRow[] {
    let out: WorktreeRow[] = [];
    for (const m of posted) {
      if (m.type === "rows") out = (m.rows as WorktreeRow[]).map((r) => ({ ...r }));
      else if (m.type === "status") {
        const r = out.find((x) => x.path === m.path);
        if (r) r.status = (m.status as WorktreeRowStatus | null) ?? undefined;
      } else if (m.type === "patch") {
        const r = out.find((x) => x.path === m.path);
        if (r) Object.assign(r, m.row);
      } else if (m.type === "drop") out = out.filter((x) => x.path !== m.path);
    }
    return out;
  }
  /** A folder as the host names it: the row's own spelling (git's). */
  const rowPath = (p: string): string => rows().find((r) => sameFolder(r.path, p))?.path ?? p;
  return {
    provider,
    posted,
    reviews,
    ctx: entry?.ctx,
    rows,
    rowPath,
    idle,
    handle,
    send: async (m: Record<string, unknown>) => {
      await handle(m);
      await idle();
    },
    repoChanged: async () => {
      changed();
      await idle();
    },
    switchTo: (other: string) => {
      const ctx = new GitContext({ root: other });
      contexts.push(ctx);
      entry = { ctx, root: other };
      folders = [other];
    },
    close: () => {
      entry = undefined;
    },
    disposeView: () => disposed?.(),
    changeDisposed: () => changeDisposed,
    onChanged: () => onChanged,
    lastRows: () => [...posted].reverse().find((m) => m.type === "rows") as { rows: WorktreeRow[]; state: string } | undefined,
    of: (type: string) => posted.filter((m) => m.type === type),
    since: (n: number) => posted.slice(n),
  };
}

const row = (rows: WorktreeRow[], p: string) => rows.find((r) => sameFolder(r.path, p));

// ── Words, the list's reads, and the page's lifecycle ────────────────────────

test("Reveal is named each platform's way", () => {
  assert.equal(revealLabel("darwin"), "Reveal in Finder");
  assert.equal(revealLabel("win32"), "Reveal in File Explorer");
  assert.equal(revealLabel("linux"), "Open Containing Folder");
});

test("the page's html loads only its own bundle, under a nonce'd CSP", () => {
  const h = host(undefined);
  const html = (h.provider as unknown as { view: { webview: { html: string } } }).view.webview.html;
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
  assert.ok(nonce, html);
  assert.match(html, new RegExp(`<script nonce="${nonce}" src="[^"]*dist[\\\\/]webview[\\\\/]worktrees\\.js"></script>`));
  assert.match(html, /default-src 'none'/);
  h.provider.dispose();
});

test("with no repository the page is told so — or, while repositories are still being found, that they are", async () => {
  const none = host(undefined);
  await none.send({ type: "ready" });
  assert.deepEqual(none.lastRows()?.rows, []);
  assert.equal(none.lastRows()?.state, "noRepo");
  none.provider.dispose();

  const looking = host(undefined, { discovering: true });
  await looking.send({ type: "refresh" });
  assert.equal(looking.lastRows()?.state, "discovering");
  looking.provider.dispose();
});

test("a list git can't read is said as failed; a read that lists nothing keeps the last good list", async () => {
  const s = scene();
  const h = host(s.app);
  const snapshot = h.ctx!.worktrees.snapshot.bind(h.ctx!.worktrees);
  h.ctx!.worktrees.snapshot = async () => {
    throw new Error("git crashed");
  };
  await h.send({ type: "ready" });
  assert.deepEqual([h.lastRows()?.rows, h.lastRows()?.state], [[], "failed"]);

  // Nothing listed before any good read: failed, too (a repository always lists its main worktree).
  h.ctx!.worktrees.snapshot = async (...a: Parameters<typeof snapshot>) => ({ ...(await snapshot(...a)), worktrees: [] });
  await h.send({ type: "refresh" });
  assert.equal(h.lastRows()?.state, "failed");

  // A good read, then one that lists nothing: the good list stays, as ok.
  h.ctx!.worktrees.snapshot = snapshot;
  await h.send({ type: "refresh" });
  const good = h.lastRows()!;
  assert.equal(good.state, "ok");
  assert.equal(good.rows.length, 6);
  h.ctx!.worktrees.snapshot = async (...a: Parameters<typeof snapshot>) => ({ ...(await snapshot(...a)), worktrees: [] });
  const before = h.posted.length;
  await h.send({ type: "refresh" });
  assert.deepEqual(h.since(before).filter((m) => m.type === "rows"), [], "the same list is not sent again");
  assert.deepEqual(h.lastRows(), good);
  h.provider.dispose();
});

test("back to the window, the list is read again — a lock taken in a terminal shows; losing focus reads nothing", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  assert.equal(row(h.rows(), s.wt("local"))?.locked, false);
  s.git("worktree", "lock", s.wt("local"));
  const n = h.posted.length;
  windowState?.({ focused: false });
  await h.idle();
  assert.equal(h.posted.length, n, "blurred: nothing read");
  windowState?.({ focused: true });
  await h.idle();
  assert.equal(row(h.rows(), s.wt("local"))?.locked, true);
  h.provider.dispose();
});

test("a Refresh asked for while the list is being read reads it again after — the change in between is not lost", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const inside = h.provider as unknown as { refreshing?: unknown };
  void h.handle({ type: "refresh" });
  for (let i = 0; i < 2000 && !inside.refreshing; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(inside.refreshing, "the first read is under way");
  s.git("worktree", "lock", "--reason", "meanwhile", s.wt("local"));
  await h.send({ type: "refresh" });
  assert.equal(row(h.rows(), s.wt("local"))?.lockReason, "meanwhile");
  h.provider.dispose();
});

test("another repository becoming active lists ITS worktrees, and reads its own window's row afresh", async () => {
  const s = scene();
  const other = join(scratch, `other${++seq}`);
  mkdirSync(other);
  execFileSync("git", ["init", "-q", "-b", "trunk", other]);
  for (const [k, v] of identity) at(other)("config", k, v);
  commit(other, "z.txt", "z");
  const h = host(s.app);
  await h.send({ type: "ready" });
  assert.equal(h.rows().length, 6);
  h.switchTo(other);
  await h.repoChanged();
  const rows = h.rows();
  assert.deepEqual(rows.map((r) => [r.name, r.branch, r.current, r.kind]), [[basename(other), "trunk", true, "main"]]);
  assert.equal(rows[0].status?.changed, 0, "its own window's row is read at once");
  assert.ok(!h.rows().some((r) => sameFolder(r.path, s.app)), "nothing of the first repository is left");
  h.provider.dispose();
});

test("a page that comes back (moved, reloaded) is sent the list at once — before git is asked again", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const n = h.posted.length;
  void h.handle({ type: "ready" }); // not awaited: what is sent synchronously
  const first = h.posted[n] as { type: string; rows: WorktreeRow[] } | undefined;
  assert.equal(first?.type, "rows");
  assert.equal(first?.rows.length, 6);
  await h.idle();
  h.provider.dispose();
});

test("a new page is painted from the last list this workspace saw — its folders asked again, so one gone since reads missing", async () => {
  const s = scene();
  const store = new Map<string, unknown>();
  const first = host(s.app, { store });
  await first.send({ type: "ready" });
  first.provider.dispose();
  assert.equal(store.size, 1, "the list is remembered");
  rmSync(s.wt("local"), { recursive: true, force: true });
  rmSync(join(s.wt("topic"), ".git"), { force: true });

  const second = host(s.app, { store });
  void second.handle({ type: "ready" });
  const seeded = second.posted.find((m) => m.type === "rows") as { rows: WorktreeRow[]; state: string } | undefined;
  assert.ok(seeded, "painted at once, from the seed");
  assert.equal(seeded.state, "ok");
  assert.equal(row(seeded.rows, s.wt("local"))?.missing, true, "its folder is gone now");
  assert.equal(row(seeded.rows, s.wt("topic"))?.unlinked, true, "not a worktree any more");
  assert.equal(row(seeded.rows, s.app)?.missing, false);
  assert.ok(seeded.rows.every((r) => r.status === undefined), "no tree read yet");
  await second.idle();
  second.provider.dispose();

  // A seed that is not a list paints nothing.
  const broken = new Map<string, unknown>([[[...store.keys()][0], { worktrees: [] }]]);
  const third = host(s.app, { store: broken });
  void third.handle({ type: "ready" });
  assert.deepEqual(third.posted, []);
  await third.idle();
  third.provider.dispose();
});

test("a row whose tree git can't read sends null status — never a clean one", async () => {
  const s = scene();
  const h = host(s.app);
  h.ctx!.worktrees.status = async () => {
    throw new Error("status failed");
  };
  await h.send({ type: "ready" });
  await h.send({ type: "visible", paths: [h.rowPath(s.wt("local"))] });
  const st = h.of("status").find((m) => sameFolder(m.path as string, s.wt("local")));
  assert.deepEqual(st, { type: "status", path: h.rowPath(s.wt("local")), status: null });
  h.provider.dispose();
});

test("a row closed on the page is not sent its details again when the list is read again", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const topic = h.rowPath(s.wt("topic"));
  await h.send({ type: "expand", path: topic });
  const details = h.of("details").filter((m) => m.path === topic);
  assert.equal(details.length, 1);
  const d = details[0].details as WorktreeDetails;
  assert.equal(d.toPull?.title, "To pull from origin/topic");
  assert.deepEqual(d.toPull?.commits.map((c) => c.subject), ["o.txt: theirs"]);

  await h.send({ type: "collapse", path: topic });
  writeFileSync(join(s.wt("topic"), "new.txt"), "n\n");
  await h.repoChanged();
  assert.equal(h.of("details").filter((m) => m.path === topic).length, 1, "closed: no details sent");
  h.provider.dispose();
});

test("a commit's files that git can't read are sent as null — the page says it could not read them", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  h.ctx!.commitDetails.getCommitFiles = async () => {
    throw new Error("unreadable");
  };
  const sha = s.git("rev-parse", "HEAD");
  const topic = h.rowPath(s.wt("topic"));
  await h.send({ type: "commitFiles", path: topic, sha });
  assert.deepEqual(h.of("commitFiles").at(-1), { type: "commitFiles", path: topic, sha, files: null });
  h.provider.dispose();
});

// ── Opening a worktree's files ───────────────────────────────────────────────

test("an untracked or conflicted file opens as itself, in THAT worktree's folder", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const topic = h.rowPath(s.wt("topic"));
  await h.send({ type: "openFile", path: topic, file: { path: "docs/new.md", status: "U", area: "untracked" } });
  await h.send({ type: "openFile", path: topic, file: { path: "a.txt", status: "U", area: "conflicted" } });
  assert.deepEqual(
    executed.map((e) => [e.command, folderKey((e.args[0] as FakeUri).fsPath)]),
    [
      ["vscode.open", folderKey(join(s.wt("topic"), "docs", "new.md"))],
      ["vscode.open", folderKey(join(s.wt("topic"), "a.txt"))],
    ],
  );
  h.provider.dispose();
});

test("a committed file opens as what that commit did to it, titled with the commit and the worktree; a bad sha or row opens nothing", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const topic = h.rowPath(s.wt("topic"));
  const sha = s.git("rev-parse", "HEAD");
  await h.send({ type: "openCommitFile", path: topic, sha, file: { path: "src/a.txt", status: "A" } });
  await h.send({ type: "openCommitFile", path: topic, sha: "not-a-sha", file: { path: "a.txt", status: "M" } });
  await h.send({ type: "openCommitFile", path: join(s.base, "nowhere"), sha, file: { path: "a.txt", status: "M" } });
  assert.equal(executed.length, 1, JSON.stringify(executed));
  const [command, left, right, title] = [executed[0].command, ...executed[0].args] as [string, FakeUri, FakeUri, string];
  assert.equal(command, "vscode.diff");
  assert.equal(title, `a.txt (${sha.slice(0, 7)}) — topic`);
  const side = (u: FakeUri) => new URLSearchParams(u.query);
  assert.equal(side(left).get("rev"), EMPTY_TREE, "added by the commit: nothing before it");
  assert.equal(side(right).get("rev"), sha);
  assert.ok(sameFolder(side(right).get("root") ?? "", s.wt("topic")), "read in THAT worktree");
  assert.equal(right.path, "/src/a.txt");
  h.provider.dispose();
});

// ── Row actions ──────────────────────────────────────────────────────────────

test("an action the row does not offer is refused in the row's own words, and nothing runs", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const main = h.rowPath(s.app);
  const local = h.rowPath(s.wt("local"));
  const gone = h.rowPath(s.wt("gone"));
  const cases: [string, string, string][] = [
    [main, "openHere", "This window has it open."],
    [main, "openNew", "This window has it open."],
    [main, "lock", "The main worktree holds the repository itself, so git can't lock it."],
    [main, "remove", "The main worktree holds the repository itself, so git never removes it."],
    [local, "pull", "Its branch has no upstream to pull from."],
    [local, "unlock", "It isn't locked."],
    [gone, "push", "Its folder is missing."],
  ];
  for (const [p, action] of cases) await h.send({ type: "action", path: p, action });
  assert.deepEqual(said, cases.map(([, , why]) => ({ kind: "info", message: `GitStudio: ${why}` })));
  assert.deepEqual(executed, []);
  assert.equal(asked.length, 0);
  // A path that is not a string is ignored outright.
  await h.send({ type: "action", path: 42, action: "remove" });
  assert.equal(said.length, cases.length);
  h.provider.dispose();
});

test("Open, Reveal, Terminal and Copy Path act on the row's own folder", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const local = h.rowPath(s.wt("local"));
  for (const action of ["openHere", "openNew", "reveal", "terminal", "copyPath"]) {
    await h.send({ type: "action", path: local, action });
  }
  assert.deepEqual(
    executed.map((e) => [e.command, folderKey((e.args[0] as FakeUri).fsPath), e.args[1]]),
    [
      ["vscode.openFolder", folderKey(s.wt("local")), { forceNewWindow: false }],
      ["vscode.openFolder", folderKey(s.wt("local")), { forceNewWindow: true }],
      ["revealFileInOS", folderKey(s.wt("local")), undefined],
    ],
  );
  assert.deepEqual(terminals.map((t) => [t.name, folderKey(t.cwd ?? "")]), [["local", folderKey(s.wt("local"))]]);
  assert.equal(folderKey(clipboard), folderKey(s.wt("local")));
  h.provider.dispose();
});

test("Pull on a row: busy while it runs, its branch moves, and its tree is read again after", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const topic = h.rowPath(s.wt("topic"));
  await h.send({ type: "action", path: topic, action: "pull" });
  assert.deepEqual(
    h.of("busy").map((m) => [m.path, m.busy, m.label]),
    [
      [topic, true, "Pulling…"],
      [topic, false, undefined],
    ],
  );
  assert.equal(at(s.wt("topic"))("rev-parse", "HEAD"), s.git("rev-parse", "origin/topic"));
  assert.deepEqual(said.filter((m) => m.kind === "error"), []);
  assert.equal(row(h.rows(), s.wt("topic"))?.behind, 0, "the list was read again");
  h.provider.dispose();
});

test("Push on a row opens the push review for THAT worktree; on this window's own, the review as it is", async () => {
  const s = scene();
  commit(s.wt("topic"), "mine.txt", "mine");
  const h = host(s.app);
  await h.send({ type: "ready" });
  await h.send({ type: "action", path: h.rowPath(s.wt("topic")), action: "push" });
  assert.equal(h.reviews.length, 1);
  const target = h.reviews[0] as { name: string; release(): void };
  assert.equal(target.name, "topic");
  target.release();
  h.provider.dispose();
});

test("Lock, then Unlock, from a row: the row is patched at once and git agrees", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const local = h.rowPath(s.wt("local"));
  answer = (spec) => (spec.kind === "input" ? "reviewing" : undefined);
  await h.send({ type: "action", path: local, action: "lock" });
  assert.deepEqual(h.of("patch").map((m) => [m.path, m.row]), [[local, { locked: true, lockReason: "reviewing" }]]);
  assert.match(s.git("worktree", "list", "--porcelain"), /locked reviewing/);
  await h.send({ type: "action", path: local, action: "unlock" });
  assert.doesNotMatch(s.git("worktree", "list", "--porcelain"), /locked reviewing/);
  assert.equal(row(h.rows(), s.wt("local"))?.locked, false);
  h.provider.dispose();
});

test("Remove from a row: the row is dropped, the other views are told, and the folder is gone", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const local = h.rowPath(s.wt("local"));
  await h.send({ type: "expand", path: local });
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await h.send({ type: "action", path: local, action: "remove" });
  assert.deepEqual(h.of("drop"), [{ type: "drop", path: local }]);
  assert.equal(h.onChanged(), 1);
  assert.equal(row(h.rows(), s.wt("local")), undefined);
  assert.ok(!s.git("worktree", "list").includes(join("wt", "local")));
  h.provider.dispose();
});

test("Forget from a row whose folder is gone: git forgets it and the row is dropped", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const gone = h.rowPath(s.wt("gone"));
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await h.send({ type: "action", path: gone, action: "forget" });
  assert.deepEqual(h.of("drop"), [{ type: "drop", path: gone }]);
  assert.ok(!s.git("worktree", "list", "--porcelain").includes("/wt/gone"));
  assert.equal(row(h.rows(), s.wt("gone")), undefined);
  h.provider.dispose();
});

test("New Worktree and Prune from the page ask their questions; Prune agreed forgets the missing one", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  await h.send({ type: "add" });
  assert.equal(asked[0]?.title, "New worktree — pick a ref", "dismissed: nothing made");
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await h.send({ type: "prune" });
  assert.match(asked[1]?.title ?? "", /^Prune 2 missing worktrees\?$/);
  const listed = s.git("worktree", "list", "--porcelain");
  assert.ok(!/wt[\\/]gone/.test(listed), listed);
  assert.equal(row(h.rows(), s.wt("gone")), undefined, "the list was read again");
  h.provider.dispose();
});

// ── Going away ───────────────────────────────────────────────────────────────

test("once its page is gone nothing is read or sent", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  h.disposeView();
  const n = h.posted.length;
  s.git("worktree", "lock", s.wt("local"));
  await h.send({ type: "refresh" });
  assert.equal(h.posted.length, n, "no page, no reads, nothing sent");
  h.provider.dispose();
});

test("disposed, it lets go of every listener, and a read it had scheduled never runs", async () => {
  const s = scene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  s.git("worktree", "lock", s.wt("local"));
  const n = h.posted.length;
  h.provider.refresh(); // a read due on the next turn…
  h.provider.dispose(); // …cancelled
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(h.posted.length, n, "the lock taken meanwhile was never read");
  assert.equal(h.changeDisposed(), 1);
  assert.equal(windowStateDisposed, 1);
});
