// Repositories as tabs (issue #32) — main's half: RepoStore's tab model, the
// IPC scope every bridge reads, and the per-repository state the bridges hold.
// The state table is docs/desktop-repo-tabs.md; each test names its row.
//
// The model tests inject `discover` (so a path IS its root) and a fake
// context; the scope and bridge tests use real repositories on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TABS, RepoStore, repoScope } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { droppedTabsNotice, missingFolderError, missingFolderResult, tabsFullNotice } from "../src/main/repoNotice";
import { isExpectedError } from "../src/main/expectedError";
import { spawn } from "node:child_process";
import { tabStatuses, trashRefusal } from "../src/main/localRepos";
import { removeTempRepo } from "./tmpRepo";
import type { GitContext } from "@gitstudio/git-service/index";

/** A store whose "repositories" are any path under /r/ (or `gone` for none). */
function fakeStore(opts: { gone?: string[]; realpath?: (p: string) => string } = {}) {
  const disposed: string[] = [];
  const store = new RepoStore([], {
    discover: async (cwd) => (cwd.startsWith("/r/") && !opts.gone?.includes(cwd) ? cwd.replace(/\/+$/, "") : undefined),
    realpath: opts.realpath ?? ((p) => p.replace(/\/+$/, "")),
    createContext: (root) => ({ root, dispose: () => disposed.push(root) }) as unknown as GitContext,
  });
  const events: Array<{ tabs: string[]; active?: string }> = [];
  store.onChange((s) => events.push({ tabs: s.tabs.map((t) => t.root), active: s.active }));
  return { store, events, disposed };
}

const roots = (s: RepoStore): string[] => s.state().tabs.map((t) => t.root);

// ── The model ────────────────────────────────────────────────────────────────

test("opening adds a tab at the end and brings it to the front", async () => {
  const { store, events } = fakeStore();
  assert.equal((await store.openTab("/r/a")).kind, "opened");
  assert.equal((await store.openTab("/r/b")).kind, "opened");
  assert.deepEqual(roots(store), ["/r/a", "/r/b"]);
  assert.equal(store.state().active, "/r/b");
  assert.deepEqual(events.at(-1), { tabs: ["/r/a", "/r/b"], active: "/r/b" }, "the change is announced");
});

test("row 12: a repository that already has a tab is switched to, not opened twice", async () => {
  const { store } = fakeStore();
  await store.openTab("/r/a");
  await store.openTab("/r/b");
  const again = await store.openTab("/r/a/");
  assert.equal(again.kind, "switched", "a trailing slash is the same repository");
  assert.deepEqual(roots(store), ["/r/a", "/r/b"], "no second tab");
  assert.equal(store.state().active, "/r/a");
});

test("row 12: …and so is the same repository reached through a symlink (real path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-tabs-link-"));
  try {
    const real = join(dir, "real");
    execFileSync("git", ["init", "-q", real]);
    const link = join(dir, "link");
    symlinkSync(real, link);
    const store = new RepoStore([], { discover: async (cwd) => cwd });
    assert.equal((await store.openTab(real)).kind, "opened");
    const viaLink = await store.openTab(link);
    assert.equal(viaLink.kind, "switched", "the symlink is the repository that already has a tab");
    assert.equal(roots(store).length, 1);
    store.dispose();
  } finally {
    removeTempRepo(dir);
  }
});

test("a folder that is not a repository opens nothing", async () => {
  const { store, events } = fakeStore();
  assert.deepEqual(await store.openTab("/elsewhere"), { kind: "notRepo" });
  assert.deepEqual(roots(store), []);
  assert.equal(events.length, 0);
});

test("row 13: an eleventh repository is refused, and nothing is closed to make room", async () => {
  const { store, disposed } = fakeStore();
  for (let i = 0; i < MAX_TABS; i++) await store.openTab(`/r/${i}`);
  const before = roots(store);
  assert.equal(before.length, MAX_TABS);
  assert.equal(store.isFull(), true);
  const out = await store.openTab("/r/one-more");
  assert.deepEqual(out, { kind: "full", max: MAX_TABS });
  assert.deepEqual(roots(store), before, "every tab is still open");
  assert.equal(store.state().active, `/r/${MAX_TABS - 1}`, "the front tab did not move");
  assert.deepEqual(disposed, []);
  // …while switching to one it HAS is still fine at the limit.
  assert.equal((await store.openTab("/r/0")).kind, "switched");
  assert.match(tabsFullNotice(MAX_TABS).message, /up to 10 repositories.*Close a tab/);
});

test("activating switches the front tab without touching any context", async () => {
  const { store, disposed } = fakeStore();
  await store.openTab("/r/a");
  await store.openTab("/r/b");
  assert.equal(store.activate("/r/a"), true);
  assert.equal(store.state().active, "/r/a");
  assert.equal(store.activate("/r/missing"), false, "a root with no tab is not activated");
  assert.deepEqual(disposed, [], "a switch never disposes a context");
});

test("rows 7–9: closing — a background tab, the front tab (right, else left), the last tab", async () => {
  const { store, disposed } = fakeStore();
  for (const r of ["/r/a", "/r/b", "/r/c", "/r/d"]) await store.openTab(r);
  store.activate("/r/b");
  // 7: a background tab closes; the front tab is untouched.
  store.closeTab("/r/d");
  assert.deepEqual(roots(store), ["/r/a", "/r/b", "/r/c"]);
  assert.equal(store.state().active, "/r/b");
  // 8: the front tab closes; the one to its RIGHT takes over.
  store.closeTab("/r/b");
  assert.equal(store.state().active, "/r/c");
  // 8: the front tab is the LAST in the row; the one to its left takes over.
  store.closeTab("/r/c");
  assert.equal(store.state().active, "/r/a");
  // 9: the last tab.
  store.closeTab("/r/a");
  assert.deepEqual(store.state(), { tabs: [], active: undefined });
  assert.equal(store.current(), undefined);
  assert.deepEqual(disposed, [], "row 10: a closed tab's git is dropped, never killed mid-command");
});

test("moving a tab reorders the row and keeps the front tab", async () => {
  const { store } = fakeStore();
  for (const r of ["/r/a", "/r/b", "/r/c"]) await store.openTab(r);
  assert.equal(store.moveTab("/r/c", 0), true);
  assert.deepEqual(roots(store), ["/r/c", "/r/a", "/r/b"]);
  assert.equal(store.moveTab("/r/c", 0), false, "nowhere to go");
  assert.equal(store.moveTab("/r/a", 99), true, "clamped to the end");
  assert.deepEqual(roots(store), ["/r/c", "/r/b", "/r/a"]);
  assert.equal(store.state().active, "/r/c");
});

test("row 16: the open tabs persist in order with the front one, and come back so", async () => {
  const { store } = fakeStore();
  for (const r of ["/r/a", "/r/b", "/r/c"]) await store.openTab(r);
  store.activate("/r/b");
  const saved = store.serialize();
  assert.deepEqual(saved.open, ["/r/a", "/r/b", "/r/c"]);
  assert.equal(saved.current, "/r/b");

  const { store: next, events } = fakeStore();
  const { dropped } = await next.restore(saved.open, saved.current);
  assert.deepEqual(dropped, []);
  assert.deepEqual(roots(next), ["/r/a", "/r/b", "/r/c"]);
  assert.equal(next.state().active, "/r/b");
  assert.equal(events.length, 1, "one announcement for the whole restore, not one per tab");
});

test("row 16: a tab whose folder is gone is dropped at launch and named once", async () => {
  const { store } = fakeStore({ gone: ["/r/b"] });
  const { dropped } = await store.restore(["/r/a", "/r/b", "/r/c"], "/r/b");
  assert.deepEqual(dropped, ["/r/b"]);
  assert.deepEqual(roots(store), ["/r/a", "/r/c"]);
  assert.equal(store.state().active, "/r/a", "the front tab is gone: the first one takes over");
  assert.match(droppedTabsNotice(dropped).message, /^b was not reopened: \/r\/b is gone/);
  assert.match(droppedTabsNotice(["/x/a", "/x/b", "/x/c", "/x/d"]).message, /^4 tabs were not reopened.*a, b, c and 1 more\.$/);
});

test("row 16: the window's first read of the tabs waits for the launch restore", async () => {
  // main starts the restore, then loads the window; the renderer asks which
  // tabs are open WHILE it loads. Answered before the restore, it heard "none",
  // built the no-repository screen (its persist wiping every tab's remembered
  // view), and then took the restored tabs for NEW ones when they arrived — so a
  // window left on Search came back on Code.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new RepoStore([], {
    discover: async (cwd) => {
      await gate;
      return cwd;
    },
    realpath: (p) => p,
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
  });
  const restoring = store.restore(["/r/a", "/r/b"], "/r/b");
  let answered: { tabs: string[]; active?: string } | undefined;
  const first = store.settledState().then((st) => (answered = { tabs: st.tabs.map((t) => t.root), active: st.active }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(answered, undefined, "not answered while the restore is still finding its repositories");
  release();
  await restoring;
  await first;
  assert.deepEqual(answered, { tabs: ["/r/a", "/r/b"], active: "/r/b" });
});

test("row 16: with no restore under way, the first read answers at once", async () => {
  const { store } = fakeStore();
  await store.openTab("/r/a");
  assert.deepEqual((await store.settledState()).tabs.map((t) => t.root), ["/r/a"]);
  // …and a failed restore does not hold the window forever.
  const broken = new RepoStore([], {
    discover: async () => {
      throw new Error("the disk went away");
    },
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
  });
  await broken.restore(["/r/x"]).catch(() => undefined);
  assert.deepEqual((await broken.settledState()).tabs, []);
});

test("restoring more tabs than the bound keeps the first ten", async () => {
  const { store } = fakeStore();
  const many = Array.from({ length: MAX_TABS + 3 }, (_, i) => `/r/${i}`);
  await store.restore(many, many[0]);
  assert.equal(roots(store).length, MAX_TABS);
});

test("an older open that loses the race touches nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new RepoStore([], {
    discover: async (cwd) => {
      if (cwd === "/r/slow") await gate;
      return cwd;
    },
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
  });
  const slow = store.openTab("/r/slow");
  await store.openTab("/r/fast");
  release();
  assert.equal((await slow).kind, "superseded");
  assert.deepEqual(roots(store), ["/r/fast"], "the loser did not add a tab behind the winner's back");
});

test("closing another tab while an open is still finding its repository does not cancel the open", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new RepoStore([], {
    discover: async (cwd) => {
      if (cwd === "/r/new") await gate; // a slow `git rev-parse` (a network drive, a big repository)
      return cwd;
    },
    realpath: (p) => p,
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
  });
  await store.openTab("/r/a");
  await store.openTab("/r/b");
  const pending = store.openTab("/r/new");
  store.closeTab("/r/a"); // an unrelated tab, closed meanwhile
  release();
  const out = await pending;
  assert.equal(out.kind, "opened", "the open the user asked for still happens");
  assert.deepEqual(roots(store), ["/r/b", "/r/new"]);
  assert.equal(store.state().active, "/r/new");
});

test("…and closing the LAST tab meanwhile does not cancel it either", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new RepoStore([], {
    discover: async (cwd) => {
      if (cwd === "/r/new") await gate;
      return cwd;
    },
    realpath: (p) => p,
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
  });
  await store.openTab("/r/a");
  const pending = store.openTab("/r/new");
  store.closeTab("/r/a");
  release();
  assert.equal((await pending).kind, "opened");
  assert.deepEqual(roots(store), ["/r/new"]);
});

test("closing the repository an open is still finding IS the later word: it stays closed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new RepoStore([], {
    discover: async (cwd) => {
      if (cwd === "/r/a/sub") await gate; // opening a folder INSIDE /r/a, which already has a tab
      return cwd.startsWith("/r/a") ? "/r/a" : cwd;
    },
    realpath: (p) => p,
    createContext: (root) => ({ root, dispose() {} }) as unknown as GitContext,
  });
  await store.openTab("/r/a");
  await store.openTab("/r/b");
  const pending = store.openTab("/r/a/sub");
  store.closeTab("/r/a");
  release();
  const out = await pending;
  assert.equal(out.kind, "superseded");
  assert.equal("info" in out ? out.info : undefined, undefined, "and it does not claim the tab in front as what it opened");
  assert.deepEqual(roots(store), ["/r/b"], "the tab closed while it was being found is not brought back");
});

// ── The scope every bridge reads ─────────────────────────────────────────────

test("a call stamped with a tab answers for that tab, whichever tab is in front", async () => {
  const { store } = fakeStore();
  await store.openTab("/r/a");
  await store.openTab("/r/b"); // b in front
  const seen = await repoScope.run({ root: "/r/a" }, async () => {
    await new Promise((r) => setTimeout(r, 5)); // …through the handler's own awaits
    return { ctx: (store.getContext() as unknown as { root: string }).root, current: store.current()?.root };
  });
  assert.deepEqual(seen, { ctx: "/r/a", current: "/r/a" });
  assert.equal(store.current()?.root, "/r/b", "outside a scope: the tab in front");
  assert.equal(store.active()?.root, "/r/b");
});

test("a call for a CLOSED tab gets no repository — never the one in front", async () => {
  const { store } = fakeStore();
  await store.openTab("/r/a");
  await store.openTab("/r/b");
  store.closeTab("/r/a");
  repoScope.run({ root: "/r/a" }, () => {
    assert.equal(store.getContext(), undefined);
    assert.equal(store.current(), undefined);
  });
  repoScope.run({ root: undefined }, () => {
    assert.equal(store.getContext(), undefined, "'no repository asked' is an answer, not a fallback");
  });
});

// ── Real repositories through the bridge ─────────────────────────────────────

function repo(name: string, branch: string, commits: number): string {
  const root = mkdtempSync(join(tmpdir(), `gs-tab-${name}-`));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q", "-b", branch);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(root, "f.txt"), `${name} ${i}\n`);
    git("add", ".");
    git("commit", "-q", "-m", `${name} ${i}`);
  }
  return root;
}

test("two tabs, one bridge: each call reads the repository of the tab that made it", async () => {
  const a = repo("alpha", "main", 1);
  const b = repo("beta", "develop", 1);
  try {
    const store = new RepoStore([]);
    const bridge = new GitBridge(store);
    const A = (await store.open(a))!.root;
    const B = (await store.open(b))!.root; // beta in front
    const inA = await repoScope.run({ root: A }, () => bridge.head());
    const inB = await repoScope.run({ root: B }, () => bridge.head());
    assert.equal(inA.branch, "main", "tab A's call reads A while B is in front");
    assert.equal(inB.branch, "develop");
    store.dispose();
  } finally {
    removeTempRepo(a);
    removeTempRepo(b);
  }
});

test("each tab pages its OWN graph: B loading does not reset A's accumulator", async () => {
  const a = repo("alpha", "main", 5);
  const b = repo("beta", "main", 3);
  try {
    const store = new RepoStore([]);
    const bridge = new GitBridge(store);
    const A = (await store.open(a))!.root;
    const B = (await store.open(b))!.root;
    const a1 = await repoScope.run({ root: A }, () => bridge.graphLoad({ skip: 0, maxCount: 2 }));
    assert.equal(a1.rows.length, 2);
    // Tab B loads its history in between…
    await repoScope.run({ root: B }, () => bridge.graphLoad({ skip: 0, maxCount: 50 }));
    // …and A's page 2 is still page 2 of A.
    const a2 = await repoScope.run({ root: A }, () => bridge.graphLoad({ skip: a1.nextSkip, maxCount: 2 }));
    assert.equal(a2.rows.length, 2, "page 2, not a fresh page 1");
    assert.equal(a2.nextSkip, 4, "the cursor continued from A's own pages");
    const subjects = [...a1.rows, ...a2.rows].map((r) => (r as { subject?: string }).subject);
    assert.deepEqual(subjects, ["alpha 4", "alpha 3", "alpha 2", "alpha 1"]);
    store.dispose();
  } finally {
    removeTempRepo(a);
    removeTempRepo(b);
  }
});

// ── A background tab is as open as the front one ─────────────────────────────

test("a repository open in ANY tab cannot be moved to the trash", () => {
  const cloneDir = "/clones";
  const refusal = trashRefusal("/clones/widgets", { cloneDir, current: "/clones/other", open: ["/clones/other", "/clones/widgets"] });
  assert.match(refusal ?? "", /open in a tab — close its tab first/);
  assert.equal(trashRefusal("/clones/widgets", { cloneDir, current: "/clones/other", open: ["/clones/other"] }), null);
});

// ── Row 14: a folder that goes away under its tab ────────────────────────────

test("row 14: the row hears that a tab's folder is gone — moved, or no longer a repository — and that it is back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-tab-gone-"));
  const init = (r: string): void =>
    void execFileSync("git", ["-c", "init.defaultBranch=main", "init", r], { stdio: "ignore" });
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const c = join(dir, "c");
    for (const r of [a, b, c]) init(r);
    writeFileSync(join(a, "w.txt"), "work\n");
    // b is moved away; c stays a folder but stops being a repository.
    renameSync(b, join(dir, "b-moved"));
    rmSync(join(c, ".git"), { recursive: true, force: true });
    const st = await tabStatuses([a, b, c]);
    assert.deepEqual(st[b], { gone: true }, "a moved folder is gone");
    assert.deepEqual(st[c], { gone: true }, "a folder that is no longer a repository is gone too");
    assert.equal(st[a]?.gone, undefined, "a repository that is there is not");
    assert.equal(st[a]?.dirty, 1, "…and is counted");
    // Put back: gone is asked afresh every time, never remembered.
    renameSync(join(dir, "b-moved"), b);
    const back = await tabStatuses([b]);
    assert.equal(back[b]?.gone, undefined, "a folder put back is whole again at the next look");
    assert.equal(back[b]?.dirty, 0);
  } finally {
    removeTempRepo(dir);
  }
});

test("row 14: a folder that is gone is never handed to git to count", async () => {
  const asked: string[][] = [];
  const st = await tabStatuses(["/r/here", "/r/gone"], {
    isRepo: async (r) => r === "/r/here",
    statuses: async (roots) => {
      asked.push(roots);
      return Object.fromEntries(roots.map((r) => [r, { branch: "main", dirty: 2, ahead: 0, behind: 0 }]));
    },
  });
  assert.deepEqual(asked, [["/r/here"]]);
  assert.deepEqual(st, { "/r/here": { dirty: 2 }, "/r/gone": { gone: true } });
});

test("row 14: a tab whose folder is gone still switches and closes, by any spelling", async () => {
  // The real realpath: the folder is not on disk at all, so it falls back to
  // a lexical resolve — and must still find the tab.
  const store = new RepoStore([], {
    discover: async (cwd) => cwd.replace(/\/+$/, ""),
    createContext: (root) => ({ root, dispose: () => undefined }) as unknown as GitContext,
  });
  await store.openTab("/nowhere/gs-gone-a");
  await store.openTab("/nowhere/gs-gone-b");
  assert.equal(store.activate("/nowhere/gs-gone-a/"), true, "it comes to the front");
  assert.equal(store.closeTab("/nowhere/gs-gone-a/"), true, "it closes");
  assert.deepEqual(roots(store), ["/nowhere/gs-gone-b"]);
  assert.equal(store.state().active, "/nowhere/gs-gone-b");
});

test("row 14: git in a folder that is gone says the folder is gone — not Node's spawn ENOENT", async () => {
  const missing = join(tmpdir(), `gs-gone-${process.pid}-${Date.now()}`);
  // The error the real app gets: GitProcess spawns git with the tab's folder as
  // its working directory, and Node answers `spawn git ENOENT` — the words it
  // uses when git itself is not installed.
  const err = await new Promise<Error>((resolve) => {
    const child = spawn("git", ["status"], { cwd: missing });
    child.on("error", resolve);
  });
  assert.match(err.message, /^spawn \S*git ENOENT$/, "precondition: Node's own error");
  const said = missingFolderError(err, missing);
  assert.ok(said, "mapped");
  assert.equal(said?.message, `The folder ${missing} is not there any more — it was moved or deleted.`);
  assert.ok(isExpectedError(said), "a state of the user's disk, not a crash to report");

  // With the folder THERE, ENOENT means git is missing: left alone.
  assert.equal(missingFolderError(err, tmpdir()), undefined);
  // Anything else is left alone too.
  assert.equal(missingFolderError(new Error("fatal: not a git repository"), missing), undefined);
  assert.equal(missingFolderError(err, undefined), undefined);

  // …and a handler that RETURNS the failure.
  const r = missingFolderResult({ ok: false, message: err.message }, missing);
  assert.deepEqual(r, { ok: false, message: `The folder ${missing} is not there any more — it was moved or deleted.`, expected: true });
  assert.equal(missingFolderResult({ ok: false, message: err.message }, tmpdir()), undefined);
  assert.equal(missingFolderResult({ ok: true }, missing), undefined);
});
