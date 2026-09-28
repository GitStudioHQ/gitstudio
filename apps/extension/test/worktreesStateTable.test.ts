// The Worktrees view's host, over the whole state table, against real git:
//
//   kind (main / linked / bare) × window (this / other, through a symlink too)
//   × folder (present / missing / missing+locked) × head (branch+upstream /
//   no upstream with remotes / no remotes / upstream gone / detached) × sync
//   (up to date / ahead / behind / diverged) × tree (clean / staged,
//   unstaged, untracked, rename, delete / conflicted) × operation (none /
//   merge / rebase / a stale REBASE_HEAD) × lock (none / with a reason /
//   without).
//
// Each cell is asserted by what the row NAMES (its facts and the one state it
// shows, read with the same host-bridge functions the page paints with), what it OFFERS (its
// capabilities), what opening it shows, and what a diff of one of its files
// reads — from THAT worktree. And what it costs: the list is three spawns
// however many worktrees there are; a row's tree is read only when the page
// says it is in view; nothing is read while the view is hidden.

import Module from "node:module";
import { basename, join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ── The stand-in for `vscode` ────────────────────────────────────────────────
const executed: { command: string; args: unknown[] }[] = [];
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
const vscodeStub = {
  Disposable,
  EventEmitter,
  Uri,
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => new Disposable(),
    onDidChangeWindowState: () => new Disposable(),
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
  env: { clipboard: { writeText: async () => {} } },
};
type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };
const STUB = join(tmpdir(), "__gs_worktrees_table_vscode_stub__.js");
M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
const origResolve = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : origResolve.call(this, request, parent, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { WorktreesWebviewProvider } = require("../src/views/worktreesWebview") as typeof import("../src/views/worktreesWebview");
const { RevisionContentProvider } = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  headWords,
  orderWorktreeRows,
  prunableCount,
  unpublishedTitle,
  worktreeCaps,
  worktreeFacts,
  worktreeState,
  type WorktreeDetails,
  type WorktreeRow,
  type WorktreeRowStatus,
} from "@gitstudio/host-bridge/worktreesProtocol";
import { folderKey, sameFolder } from "@gitstudio/git-service/folderPath";

// ── Hermetic git ─────────────────────────────────────────────────────────────
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-wtt-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
// Resolved natively (Windows' long spelling, as git writes it); folders are
// still compared with sameFolder — git spells them C:/Users/…, node C:\Users\….
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "gs-ext-wtt-")));
const contexts: InstanceType<typeof GitContext>[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
let seq = 0;

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
const settle = () => new Promise((r) => setTimeout(r, 25));

/** The view's host, over the window at `root`, with a page that records what it is sent. */
function host(root: string, opts: { workspaceFolders?: string[] } = {}) {
  folders = opts.workspaceFolders ?? [root];
  const spawns: string[][] = [];
  const ctx = new GitContext({ root, onRun: (e) => spawns.push(e.args) });
  contexts.push(ctx);
  const entry = { ctx, root };
  const repos = {
    getActive: () => entry,
    getAll: () => [entry],
    onDidChange: (l: () => void) => {
      changed = l;
      return new Disposable();
    },
    isDiscovering: () => false,
    getUndoLedger: () => undefined,
  };
  let changed: () => void = () => {};
  const posted: Record<string, unknown>[] = [];
  let onMessage: (m: unknown) => unknown = () => {};
  let visible = true;
  const visibility: (() => void)[] = [];
  const view = {
    get visible() {
      return visible;
    },
    webview: {
      options: {},
      html: "",
      cspSource: "",
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (l: (m: unknown) => unknown) => {
        onMessage = l;
        return new Disposable();
      },
      postMessage: async (m: Record<string, unknown>) => {
        posted.push(m);
        return true;
      },
    },
    onDidDispose: () => new Disposable(),
    onDidChangeVisibility: (l: () => void) => {
      visibility.push(l);
      return new Disposable();
    },
  };
  const state = new Map<string, unknown>();
  const store = { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v), keys: () => [] };
  const reviews: unknown[] = [];
  const provider = new WorktreesWebviewProvider(repos as never, Uri.file("/ext") as never, store as never, {
    openPushReview: async (t) => void reviews.push(t),
  });
  provider.resolveWebviewView(view as never);
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      await settle();
      const p = provider as unknown as { refreshing?: unknown; refreshTimer?: unknown; running: number; queue: unknown[] };
      if (!p.refreshing && !p.refreshTimer && p.running === 0 && p.queue.length === 0) return;
    }
    throw new Error("the host never settled");
  };
  // The handler itself, awaited: the webview's listener does not wait for it.
  const handle = (provider as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage.bind(provider);
  void onMessage;
  return {
    provider,
    posted,
    spawns,
    reviews,
    ctx,
    send: async (m: unknown) => {
      await handle(asRowPaths(m));
      await idle();
    },
    idle,
    repoChanged: async () => {
      changed();
      await idle();
    },
    setVisible: async (v: boolean) => {
      visible = v;
      for (const l of visibility) l();
      await idle();
    },
    /** The rows as the page holds them: the last list, with every status and patch since. */
    rows: currentRows,
    details(p: string): WorktreeDetails | undefined {
      const d = [...posted].reverse().find((m) => m.type === "details" && sameFolder(m.path as string, p));
      return d?.details as WorktreeDetails | undefined;
    },
  };

  function currentRows(): WorktreeRow[] {
      let rows: WorktreeRow[] = [];
      for (const m of posted) {
        if (m.type === "rows") rows = (m.rows as WorktreeRow[]).map((r) => ({ ...r }));
        else if (m.type === "status") {
          const r = rows.find((x) => x.path === m.path);
          if (r) r.status = (m.status as WorktreeRowStatus | null) ?? undefined;
        } else if (m.type === "patch") {
          const r = rows.find((x) => x.path === m.path);
          if (r) Object.assign(r, m.row);
        } else if (m.type === "drop") rows = rows.filter((x) => x.path !== m.path);
      }
      return rows;
  }

  /**
   * A path the page sends is always one the host gave it (a row's). A test
   * names a folder its own way — node's C:\Users\… for git's C:/Users/… —
   * so it is sent as the row it names.
   */
  function asRowPaths(m: unknown): unknown {
    const rows = currentRows();
    const pick = (p: unknown) => (typeof p === "string" ? (rows.find((r) => sameFolder(r.path, p))?.path ?? p) : p);
    const msg = m as { path?: unknown; paths?: unknown };
    return {
      ...(m as object),
      ...("path" in msg ? { path: pick(msg.path) } : {}),
      ...(Array.isArray(msg.paths) ? { paths: msg.paths.map(pick) } : {}),
    };
  }
}

/** The whole table in one repository: a clone of a bare origin, and a worktree per cell. */
function bigScene() {
  const base = join(scratch, `big${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of identity) at(seed)("config", k, v);
  writeFileSync(join(seed, "a.txt"), "a\n");
  writeFileSync(join(seed, "b.txt"), "b\n");
  at(seed)("add", ".");
  at(seed)("commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", "--bare", seed, join(base, "origin.git")]);
  const app = join(base, "app");
  execFileSync("git", ["clone", "-q", join(base, "origin.git"), app]);
  const git = at(app);
  for (const [k, v] of identity) git("config", k, v);
  const wt = (n: string) => join(base, "wt", n);
  for (const b of ["even", "ahead", "behind", "diverged", "gone"]) {
    git("branch", b, "origin/main");
    git("push", "-q", "-u", "origin", b);
    git("worktree", "add", "-q", wt(b), b);
  }
  for (const b of ["local", "fresh", "dirty", "merging", "rebasing", "stale", "locked", "lockedbare", "missing", "missinglocked"]) {
    git("worktree", "add", "-q", "-b", b, wt(b));
  }
  git("worktree", "add", "-q", "--detach", wt("detached"), "HEAD");
  commit(wt("ahead"), "x.txt", "1");
  commit(wt("ahead"), "x.txt", "2");
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", join(base, "origin.git"), other]);
  for (const [k, v] of identity) at(other)("config", k, v);
  for (const b of ["behind", "diverged"]) {
    at(other)("checkout", "-q", b);
    commit(other, "o.txt", b);
    at(other)("push", "-q", "origin", b);
  }
  commit(wt("diverged"), "d.txt", "mine");
  at(other)("push", "-q", "origin", "--delete", "gone");
  git("fetch", "-q", "--prune", "origin");
  for (let i = 1; i <= 3; i++) commit(wt("local"), "l.txt", String(i));
  // dirty: staged, unstaged, untracked, a rename and a delete.
  const d = wt("dirty");
  writeFileSync(join(d, "staged.txt"), "s\n");
  at(d)("add", "staged.txt");
  writeFileSync(join(d, "a.txt"), "changed in dirty\n");
  at(d)("mv", "b.txt", "b moved.txt");
  writeFileSync(join(d, "new.txt"), "n\n");
  // merging: a conflicted merge of main.
  commit(app, "a.txt", "main moved");
  git("push", "-q", "origin", "main");
  commit(wt("merging"), "a.txt", "merging side");
  assert.throws(() => at(wt("merging"))("merge", "main"));
  commit(wt("rebasing"), "a.txt", "rebasing side");
  assert.throws(() => at(wt("rebasing"))("rebase", "main"));
  const staleDir = at(wt("stale"))("rev-parse", "--absolute-git-dir");
  writeFileSync(join(staleDir, "REBASE_HEAD"), at(wt("stale"))("rev-parse", "HEAD") + "\n");
  git("worktree", "lock", "--reason", "claude agent a2c9 (pid 73264)", wt("locked"));
  git("worktree", "lock", wt("lockedbare"));
  git("worktree", "lock", "--reason", "on a USB drive", wt("missinglocked"));
  rmSync(wt("missing"), { recursive: true, force: true });
  rmSync(wt("missinglocked"), { recursive: true, force: true });
  return { base, app, git, wt };
}

const words = (r: WorktreeRow | undefined) => (r ? worktreeFacts(r).map((b) => b.text) : ["(no row)"]);
/** The one state the row shows beside its name ("" for none). */
const state = (r: WorktreeRow | undefined) => (r ? (worktreeState(r)?.text ?? "") : "(no row)");
const find = (rows: WorktreeRow[], p: string) => rows.find((r) => sameFolder(r.path, p));

test("every cell of the table: what each row names and offers, from real git", async () => {
  const s = bigScene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  const all = h.rows().map((r) => r.path);
  await h.send({ type: "visible", paths: all });
  const rows = h.rows();
  const row = (n: string) => find(rows, n === "app" ? s.app : s.wt(n))!;

  // Kind × window.
  const main = row("app");
  assert.equal(main.kind, "main");
  assert.equal(main.relPath, "app");
  assert.deepEqual(words(main), ["This window", "Main worktree"]);
  assert.equal(worktreeCaps(main).remove.ok, false);
  assert.equal(worktreeCaps(main).openNew.ok, false);
  assert.ok(sameFolder(orderWorktreeRows(rows)[0].path, s.app), "this window's first");
  assert.equal(row("even").relPath, "wt/even");
  assert.match(row("even").shownPath, /wt[\\/]even$/, "shown in the system's spelling");

  // Sync against an upstream.
  assert.deepEqual(words(row("even")), []);
  assert.deepEqual(worktreeCaps(row("even")).push, { ok: false, why: "Nothing to push — it is up to date with origin/even." });
  assert.deepEqual(words(row("ahead")), ["2 to push"]);
  assert.equal(worktreeCaps(row("ahead")).push.ok, true);
  assert.deepEqual(words(row("behind")), ["1 to pull"]);
  assert.equal(worktreeCaps(row("behind")).pull.ok, true);
  assert.deepEqual(words(row("diverged")), ["1 to push, 1 to pull"]);
  assert.deepEqual(words(row("gone")), ["Upstream gone"]);
  assert.equal(worktreeCaps(row("gone")).pull.ok, false);

  // No upstream, with remotes: what no remote has — the push review's count.
  assert.deepEqual(words(row("local")), ["3 unpublished"]);
  assert.equal(Number(at(s.wt("local"))("rev-list", "--count", "HEAD", "--not", "--remotes")), 3);
  assert.deepEqual(words(row("fresh")), ["No upstream"]);
  assert.equal(worktreeCaps(row("fresh")).push.ok, true, "Push publishes it");

  // Tree.
  assert.deepEqual(words(row("dirty")), ["4 changed", "No upstream"]);
  assert.equal(row("dirty").status?.staged, 2);
  assert.equal(row("dirty").status?.unstaged, 1);
  assert.equal(row("dirty").status?.untracked, 1);

  // Operation.
  assert.deepEqual(words(row("merging")), ["Merge in progress · 1 conflict", "1 changed", "1 unpublished"]);
  assert.deepEqual(worktreeCaps(row("merging")).pull, { ok: false, why: "A merge is in progress in it — continue or abort it first." });
  assert.equal(worktreeCaps(row("merging")).push.ok, false);
  assert.equal(row("rebasing").branch, undefined, "git lists a rebase detached");
  assert.equal(headWords(row("rebasing")), "rebasing (rebasing)");
  assert.equal(words(row("rebasing"))[0], "Rebase stopped · 1 conflict");
  assert.deepEqual(worktreeCaps(row("rebasing")).pull, { ok: false, why: "A rebase is stopped in it — continue or abort it first." }, "the rebase, not \"no branch\"");
  assert.deepEqual(words(row("stale")), ["No upstream"], "a stale REBASE_HEAD alone is nothing");

  // Lock.
  assert.deepEqual(words(row("locked")), ["Locked: claude agent a2c9 (pid 73264)", "No upstream"]);
  assert.deepEqual([worktreeCaps(row("locked")).lock.ok, worktreeCaps(row("locked")).unlock.ok], [false, true]);
  assert.deepEqual(words(row("lockedbare")), ["Locked", "No upstream"]);

  // Folder.
  assert.deepEqual(words(row("missing")), ["Folder missing"]);
  assert.equal(row("missing").status, undefined, "a missing folder's tree is never read");
  assert.deepEqual(
    Object.entries(worktreeCaps(row("missing"))).filter(([, v]) => v === true || (typeof v === "object" && v.ok)).map(([k]) => k),
    ["forget"],
  );
  assert.deepEqual(words(row("missinglocked")), ["Locked: on a USB drive", "Folder missing"]);
  assert.equal(worktreeCaps(row("missinglocked")).unlock.ok, true);

  // Detached.
  assert.equal(headWords(row("detached")), `detached at ${row("detached").head.slice(0, 7)}`);
  assert.deepEqual(words(row("detached")), []);
  assert.match((worktreeCaps(row("detached")).pull as { why: string }).why, /nothing to pull into/);
  assert.match((worktreeCaps(row("detached")).push as { why: string }).why, /nothing to push/);

  // The one state each row shows, from the same real git: the most pressing.
  assert.deepEqual(
    Object.fromEntries(
      ["app", "even", "ahead", "behind", "diverged", "gone", "local", "fresh", "dirty", "merging", "rebasing", "stale", "locked", "lockedbare", "missing", "missinglocked", "detached"].map((n) => [n, state(row(n))]),
    ),
    {
      app: "",
      even: "",
      ahead: "2 to push",
      behind: "1 to pull",
      diverged: "diverged",
      gone: "upstream gone",
      local: "3 unpublished",
      fresh: "",
      dirty: "4 changed",
      merging: "merge in progress",
      rebasing: "rebase stopped",
      stale: "",
      locked: "locked",
      lockedbare: "locked",
      missing: "folder missing",
      missinglocked: "folder missing",
      detached: "",
    },
  );

  // Order: this window, then the rest by name, the missing last.
  const names = orderWorktreeRows(rows).map((r) => r.name);
  assert.deepEqual(names.slice(-2), ["missing", "missinglocked"]);
  assert.deepEqual(names.slice(0, 3), ["app", "ahead", "behind"]);
});

test("a folder that isn't a worktree any more — nested in the main one, beside it, locked — is never read: it says so and offers Forget", async () => {
  const base = join(scratch, `unl${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  for (const [k, v] of identity) at(app)("config", k, v);
  commit(app, "a.txt", "a");
  writeFileSync(join(app, ".git", "info", "exclude"), ".claude/\n");
  const nested = join(app, ".claude", "worktrees", "x");
  const side = join(base, "side");
  const held = join(base, "held");
  at(app)("worktree", "add", "-q", "-b", "x", nested);
  at(app)("worktree", "add", "-q", "-b", "side", side);
  at(app)("worktree", "add", "-q", "-b", "held", held);
  at(app)("worktree", "lock", "--reason", "agent 9", held);
  for (const d of [nested, side, held]) rmSync(join(d, ".git"));
  writeFileSync(join(app, "a.txt"), "main's edit\n");
  const h = host(app);
  await h.send({ type: "ready" });
  await h.send({ type: "visible", paths: h.rows().map((r) => r.path) });
  const rows = h.rows();
  for (const p of [nested, side, held]) {
    const r = find(rows, p)!;
    assert.deepEqual([r.unlinked, r.missing, r.status], [true, false, undefined], basename(p));
    const c = worktreeCaps(r);
    assert.deepEqual([c.expand, c.forget, c.reveal, c.pull.ok, c.openNew.ok], [false, true, true, false, false], basename(p));
  }
  assert.deepEqual(words(find(rows, nested)), ["Not a worktree"]);
  assert.equal(state(find(rows, nested)), "not a worktree");
  assert.equal(state(find(rows, held)), "not a worktree", "said over its lock");
  assert.equal(find(rows, nested)!.unlinkedWhy, "gitdir file points to non-existent location");
  assert.deepEqual(words(find(rows, held)), ["Locked: agent 9", "Not a worktree"]);
  assert.equal(find(rows, app)!.status?.changed, 1, "the main worktree's change is the main worktree's alone");
  assert.deepEqual(
    h.spawns.filter((a) => a[0] === "-C" && [nested, side, held].includes(a[1])),
    [],
    "nothing is read in them — git there would read the main worktree",
  );
  assert.equal(prunableCount(rows), 2, "git prunes the two unlocked ones");
  assert.deepEqual(orderWorktreeRows(rows).map((r) => r.name).slice(-3).sort(), ["held", "side", "x"], "with the missing, last");
  await h.send({ type: "expand", path: nested });
  assert.equal(h.details(nested), undefined, "it opens to nothing");
});

test("an open row: its uncommitted files (each side named), its commits not pushed, and what it has to pull", async () => {
  const s = bigScene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  await h.send({ type: "expand", path: s.wt("dirty") });
  const dirty = h.details(s.wt("dirty"))!;
  assert.deepEqual(
    dirty.files.map((f) => [f.area, f.status, f.path, f.oldPath ?? ""]),
    [
      ["staged", "R", "b moved.txt", "b.txt"],
      ["staged", "A", "staged.txt", ""],
      ["unstaged", "M", "a.txt", ""],
      ["untracked", "U", "new.txt", ""],
    ],
  );
  assert.equal(dirty.filesTotal, 4);
  assert.equal(dirty.unpushed?.title, "Not on any remote");
  assert.equal(dirty.unpushed?.commits.length, 0);

  await h.send({ type: "expand", path: s.wt("ahead") });
  const ahead = h.details(s.wt("ahead"))!;
  assert.equal(ahead.unpushed?.title, "Not pushed to origin/ahead");
  assert.deepEqual(ahead.unpushed?.commits.map((c) => c.subject), ["x.txt: 2", "x.txt: 1"]);
  assert.equal(ahead.toPull, undefined);

  await h.send({ type: "expand", path: s.wt("behind") });
  const behind = h.details(s.wt("behind"))!;
  assert.deepEqual(behind.unpushed?.commits, []);
  assert.equal(behind.toPull?.title, "To pull from origin/behind");
  assert.deepEqual(behind.toPull?.commits.map((c) => c.subject), ["o.txt: behind"]);

  await h.send({ type: "expand", path: s.wt("local") });
  const local = h.details(s.wt("local"))!;
  assert.equal(local.unpushed?.commits.length, 3);

  // A commit opens to its files — what THAT commit changed.
  const sha = ahead.unpushed!.commits[0].sha;
  // The host answers in the row's own spelling of its folder (git's).
  const aheadPath = find(h.rows(), s.wt("ahead"))!.path;
  await h.send({ type: "commitFiles", path: s.wt("ahead"), sha });
  const files = [...h.posted].reverse().find((m) => m.type === "commitFiles");
  assert.deepEqual(files, {
    type: "commitFiles",
    path: aheadPath,
    sha,
    files: [{ path: "x.txt", status: "M", additions: 1, deletions: 1, oldPath: undefined }],
  });

  // A commit git can't read: null, said as such — never "No file changes".
  const gone = "0123456789abcdef0123456789abcdef01234567";
  await h.send({ type: "commitFiles", path: s.wt("ahead"), sha: gone });
  assert.deepEqual([...h.posted].reverse().find((m) => m.type === "commitFiles"), { type: "commitFiles", path: aheadPath, sha: gone, files: null });

  // A tree git can't read (a damaged index): its uncommitted changes are
  // unread — never "No uncommitted changes".
  writeFileSync(join(at(s.wt("even"))("rev-parse", "--absolute-git-dir"), "index"), "not an index");
  await h.send({ type: "expand", path: s.wt("even") });
  const unread = h.details(s.wt("even"))!;
  assert.equal(unread.filesUnread, true);
  assert.deepEqual(unread.files, []);

  // A missing or bare row opens to nothing.
  await h.send({ type: "expand", path: s.wt("missing") });
  assert.equal(h.details(s.wt("missing")), undefined);
});

test("no remote at all: 'N not on main'; Pull and Push say the repository has no remote", async () => {
  const base = join(scratch, `nr${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  for (const [k, v] of identity) at(app)("config", k, v);
  commit(app, "a.txt", "a");
  at(app)("worktree", "add", "-q", "-b", "topic", join(base, "app-topic"));
  commit(join(base, "app-topic"), "t.txt", "1");
  commit(join(base, "app-topic"), "t.txt", "2");
  const h = host(app);
  await h.send({ type: "ready" });
  await h.send({ type: "visible", paths: [app, join(base, "app-topic")] });
  const topic = find(h.rows(), join(base, "app-topic"))!;
  assert.equal(topic.relPath, "app-topic");
  assert.deepEqual(words(topic), ["2 not on main"]);
  assert.equal(state(topic), "2 not on main");
  assert.deepEqual(worktreeCaps(topic).push, { ok: false, why: "The repository has no remote to push to." });
  assert.deepEqual(worktreeCaps(topic).pull, { ok: false, why: "The repository has no remote to pull from." });
  assert.equal(unpublishedTitle(topic), "Not on main");
  const main = find(h.rows(), app)!;
  assert.equal(main.onDefaultBranch, true);
  assert.equal(unpublishedTitle(main), undefined, "the default branch has nothing 'not on' itself");
  await h.send({ type: "expand", path: join(base, "app-topic") });
  assert.deepEqual(h.details(join(base, "app-topic"))?.unpushed?.commits.map((c) => c.subject), ["t.txt: 2", "t.txt: 1"]);
});

test("a bare repository's entry: a row with no facts and no state, that does not open", async () => {
  const base = join(scratch, `bare${++seq}`);
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  for (const [k, v] of identity) at(seed)("config", k, v);
  commit(seed, "a.txt", "a");
  const bare = join(base, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  at(bare)("worktree", "add", "-q", join(base, "main-wt"), "main");
  const h = host(join(base, "main-wt"));
  await h.send({ type: "ready" });
  const rows = h.rows();
  const b = find(rows, bare)!;
  assert.equal(b.kind, "bare");
  assert.deepEqual(words(b), []);
  assert.equal(state(b), "");
  assert.equal(worktreeCaps(b).expand, false);
  assert.ok(sameFolder(orderWorktreeRows(rows)[0].path, bare), "shown first, as the repository it is");
  // A bare clone keeps its remote but no remote-tracking refs: by the push
  // review's rule, main's commit is on no remote this repository knows of.
  assert.deepEqual(words(find(rows, join(base, "main-wt"))), ["This window", "1 unpublished"]);
});

test("the window's worktree is the one it has open — a linked one, or one opened through a symlink — and exactly one", async () => {
  const s = bigScene();
  const h = host(s.wt("even"));
  await h.send({ type: "ready" });
  const current = h.rows().filter((r) => r.current).map((r) => r.name);
  assert.deepEqual(current, ["even"]);
  assert.deepEqual(words(find(h.rows(), s.app)), ["Main worktree"]);

  const link = join(s.base, "link-to-app");
  symlinkSync(s.app, link);
  const viaLink = host(link);
  await viaLink.send({ type: "ready" });
  assert.deepEqual(viaLink.rows().filter((r) => r.current).map((r) => folderKey(r.path)), [folderKey(s.app)]);
});

test("a diff of another worktree's file reads THAT worktree's index and HEAD — never this window's — through a path with spaces and unicode", async () => {
  const base = join(scratch, `diff${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  for (const [k, v] of identity) at(app)("config", k, v);
  commit(app, "f.txt", "base");
  const other = join(base, "wt", "fé ature x");
  at(app)("worktree", "add", "-q", "-b", "feature", other);
  // This window's index says one thing, the other worktree's another.
  writeFileSync(join(app, "f.txt"), "window staged\n");
  at(app)("add", "f.txt");
  writeFileSync(join(other, "f.txt"), "other staged\n");
  at(other)("add", "f.txt");
  writeFileSync(join(other, "f.txt"), "other working\n");
  const h = host(app);
  await h.send({ type: "ready" });
  await h.send({ type: "expand", path: other });
  const files = h.details(other)!.files;
  const staged = files.find((f) => f.area === "staged")!;
  const unstaged = files.find((f) => f.area === "unstaged")!;
  executed.length = 0;
  await h.send({ type: "openFile", path: other, file: staged });
  await h.send({ type: "openFile", path: other, file: unstaged });
  const diffs = executed.filter((e) => e.command === "vscode.diff");
  assert.equal(diffs.length, 2);
  const [stagedL, stagedR, stagedTitle] = diffs[0].args as [FakeUri, FakeUri, string];
  const [unstagedL, unstagedR] = diffs[1].args as [FakeUri, FakeUri];
  assert.match(stagedTitle, /f\.txt \(HEAD ↔ Index\) — fé ature x/);
  assert.equal(unstagedR.scheme, "file");
  assert.ok(sameFolder(unstagedR.fsPath, join(other, "f.txt")), "the working file is the worktree's own");

  const reader = new RevisionContentProvider({ getAll: () => [{ root: app, ctx: h.ctx }], getActive: () => ({ root: app, ctx: h.ctx }) } as never);
  const token = { onCancellationRequested: () => new Disposable() } as never;
  const read = (u: FakeUri) => reader.provideTextDocumentContent(u as never, token);
  assert.equal(await read(stagedL), "base", "HEAD of that worktree");
  assert.equal(await read(stagedR), "other staged\n", "the index of that worktree — not 'window staged'");
  assert.equal(await read(unstagedL), "other staged\n");
});

test("what it costs: the list is three spawns for thirty worktrees; a row's tree is read only when in view; nothing while hidden", async () => {
  const base = join(scratch, `many${++seq}`);
  const app = join(base, "app");
  mkdirSync(app, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  for (const [k, v] of identity) at(app)("config", k, v);
  commit(app, "a.txt", "a");
  for (let i = 0; i < 30; i++) at(app)("worktree", "add", "-q", "-b", `agent-${i}`, join(base, "wt", `agent-${i}`));
  const h = host(app);
  await h.send({ type: "ready" });
  // The window's own worktree is read at once; nothing else.
  const tier0 = h.spawns.filter((a) => !a.includes("-C"));
  const others = h.spawns.filter((a) => a.includes("-C") && !a.some((x) => sameFolder(x, app)));
  assert.equal(tier0.filter((a) => a[0] === "worktree" || a[0] === "for-each-ref" || a[0] === "remote").length, 3, tier0.map((a) => a.join(" ")).join("\n"));
  assert.deepEqual(others, [], "no row's tree before the page says it is in view");

  h.spawns.length = 0;
  const two = [join(base, "wt", "agent-3"), join(base, "wt", "agent-7")];
  await h.send({ type: "visible", paths: two });
  const read = new Set(h.spawns.filter((a) => a[0] === "-C").map((a) => a[1]));
  assert.deepEqual([...read].map((p) => folderKey(p)).sort(), two.map((p) => folderKey(p)).sort(), "exactly the rows in view");

  // In view again soon after: fresh, so not read again.
  h.spawns.length = 0;
  await h.send({ type: "visible", paths: two });
  assert.deepEqual(h.spawns, []);

  // Hidden: a repository change reads nothing.
  await h.setVisible(false);
  h.spawns.length = 0;
  await h.repoChanged();
  assert.deepEqual(h.spawns, [], "no reads while the view is hidden");
  // Shown again: the list, and the rows in view (their reads went stale).
  await h.setVisible(true);
  assert.ok(h.spawns.some((a) => a[0] === "worktree"));
});

test("nothing is sent that did not change: a second identical read posts no list and no status", async () => {
  const s = bigScene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  await h.send({ type: "visible", paths: h.rows().map((r) => r.path) });
  await h.send({ type: "expand", path: s.wt("ahead") });
  const before = h.posted.length;
  await h.repoChanged();
  const after2 = h.posted.slice(before).map((m) => m.type);
  assert.deepEqual(after2, [], `nothing changed, nothing sent: ${JSON.stringify(after2)}`);
  // A real change: only that row's status is sent.
  writeFileSync(join(s.wt("even"), "new.txt"), "n\n");
  const mark = h.posted.length;
  await h.repoChanged();
  const sent = h.posted.slice(mark);
  assert.deepEqual(sent.map((m) => [m.type, folderKey(m.path as string)]), [["status", folderKey(s.wt("even"))]]);
});

test("Push… for another worktree opens the push review with that worktree; for the window's own, the review as it is", async () => {
  const s = bigScene();
  const h = host(s.app);
  await h.send({ type: "ready" });
  await h.send({ type: "visible", paths: h.rows().map((r) => r.path) });
  await h.send({ type: "action", path: s.wt("ahead"), action: "push" });
  const t = h.reviews[0] as { name: string; entry: { root: string } };
  assert.equal(t.name, "ahead");
  assert.ok(sameFolder(t.entry.root, s.wt("ahead")), `${t.entry.root} is ${s.wt("ahead")}`);
  // A row that can't push says why and opens nothing.
  await h.send({ type: "action", path: s.wt("detached"), action: "push" });
  assert.equal(h.reviews.length, 1);
});
