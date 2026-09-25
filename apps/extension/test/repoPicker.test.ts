// Switch Repository (issue #32): "In VS Code I sometimes open a parent folder
// with multiple repositories … Currently it shows changes for one repository."
//
// The rule under test (RepoManager's class comment): an explicit pick holds
// until you pick again or that repository closes; with no pick the active
// repository follows the editor, longest root first. The pick is remembered per
// workspace and forgotten when its repository is gone.
//
// The REAL RepoManager runs here, against real repositories on disk and a
// vscode.git whose repositories the test opens and closes (vscodeRepoStub.cjs).
// The header control and the picker's rendering are checked in the webview
// itself by repoPickerWebview.test.ts.

import Module from "node:module";
import { join } from "node:path";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeRepoStub.cjs") : resolve.call(this, request, ...rest);
};

type FakeRepo = { rootUri: { fsPath: string } };
interface Harness {
  contexts: Map<string, unknown>;
  repository(root: string, head?: { name?: string; commit?: string }, changes?: Record<string, string[]>): FakeRepo;
  openEditor(fsPath: string | undefined): void;
  setFolders(folders: { name: string; fsPath: string }[]): void;
  gitOpen(repo: FakeRepo): void;
  gitClose(root: string): void;
  gitSettle(): void;
  reset(opts?: { repositories?: FakeRepo[]; state?: "initialized" | "uninitialized" }): void;
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { __test: vs } = require("vscode") as { __test: Harness };
const { RepoManager, PICKED_REPO_KEY } = require("../src/git/repoManager") as typeof import("../src/git/repoManager");
const picker = require("../src/git/repoPicker") as typeof import("../src/git/repoPicker");
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { BlameController } = require("../src/blame/blameController") as typeof import("../src/blame/blameController");
/* eslint-enable @typescript-eslint/no-require-imports */
type Manager = import("../src/git/repoManager").RepoManager;

// ── Real repositories: two side by side, and one nested inside the first ─────

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-repo-picker-")));
after(() => removeDir(scratch));

// Hermetic git: an empty global config, no system one.
const cfg = join(scratch, "gitconfig");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  return dir;
}
const API = gitInit(join(scratch, "code", "api"));
const WEB = gitInit(join(scratch, "code", "web"));
const VENDOR = gitInit(join(API, "vendor", "lib")); // a repo inside api's folder, like a submodule

/**
 * Delete a repository folder, the way a person would while it is open.
 *
 * RepoManager has just asked git where to watch (`rev-parse --git-path`), and
 * a `git` on PATH may be a wrapper whose background helper writes into .git a
 * moment later (seen here: `.git/ai/…`). rmSync's own retries re-try only the
 * last rmdir, never re-listing, so a file that lands after its listing fails
 * every retry. Re-run the whole removal until the folder is gone.
 */
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 100) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
const inApi = join(API, "server.ts");
const inWeb = join(WEB, "app.ts");
const inVendor = join(VENDOR, "index.ts");
for (const f of [inApi, inWeb, inVendor]) writeFileSync(f, "x\n");

/** workspaceState, as a Map. */
function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

const live: Manager[] = [];
beforeEach(() => {
  while (live.length) live.pop()!.dispose();
});
after(() => {
  while (live.length) live.pop()!.dispose();
});

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A window opening with these repositories known to vscode.git. */
async function open(
  roots: string[],
  store = memento(),
  state: "initialized" | "uninitialized" = "initialized",
): Promise<Manager> {
  vs.reset({ repositories: roots.map((r) => vs.repository(r)), state });
  const m = await RepoManager.create(store);
  live.push(m);
  await until(`${roots.length} repositories`, () => m.getAll().length === roots.length);
  // Discovery settles (and a remembered pick is judged) a moment later.
  await new Promise((r) => setTimeout(r, 20));
  return m;
}

const activeRoot = (m: Manager) => m.getActive()?.root;

// ── The header's premise: is there anything to switch to? ─────────────────

test("one repository: nothing to switch to — the multi-repo context stays off", async () => {
  await open([API]);
  assert.equal(vs.contexts.get("gitstudio.hasRepo"), true);
  assert.equal(vs.contexts.get("gitstudio.multiRepo"), false, "the palette entry is gated on this");
});

test("two repositories: the multi-repo context is on, and goes off when one closes", async () => {
  await open([API, WEB]);
  assert.equal(vs.contexts.get("gitstudio.multiRepo"), true);
  vs.gitClose(WEB);
  assert.equal(vs.contexts.get("gitstudio.multiRepo"), false);
});

// ── No pick: the editor decides, as before ──────────────────────────────────

test("no pick: the active repository follows the editor between repositories", async () => {
  const m = await open([API, WEB]);
  vs.openEditor(inWeb);
  assert.equal(activeRoot(m), WEB);
  vs.openEditor(inApi);
  assert.equal(activeRoot(m), API);
});

test("nested repositories, no pick: the innermost root owns its files", async () => {
  const m = await open([API, VENDOR, WEB]);
  vs.openEditor(inVendor);
  assert.equal(activeRoot(m), VENDOR, "a file under api/vendor/lib is vendor/lib's, not api's");
  vs.openEditor(inApi);
  assert.equal(activeRoot(m), API);
});

// ── A pick holds ──────────────────────────────────────────────────────────

test("a pick holds while the editor moves to another repository's file", async () => {
  const m = await open([API, WEB]);
  vs.openEditor(inApi);
  let changes = 0;
  m.onDidChange(() => changes++);
  assert.equal(m.setActive(WEB), true);
  assert.equal(activeRoot(m), WEB);
  assert.ok(changes >= 1, "the views are told at once, not after the debounce");
  assert.equal(m.getPicked(), WEB);

  vs.openEditor(inApi);
  assert.equal(activeRoot(m), WEB, "opening api's file did not take the view back");
  vs.openEditor(undefined);
  assert.equal(activeRoot(m), WEB);
  // Picking again is the way out.
  m.setActive(API);
  vs.openEditor(inWeb);
  assert.equal(activeRoot(m), API);
});

test("picking a repository that is not open changes nothing", async () => {
  const m = await open([API, WEB]);
  vs.openEditor(inApi);
  assert.equal(m.setActive(join(scratch, "code", "gone")), false);
  assert.equal(activeRoot(m), API);
  assert.equal(m.getPicked(), undefined);
});

test("Follow the active editor drops the pick", async () => {
  const store = memento();
  const m = await open([API, WEB], store);
  m.setActive(WEB);
  vs.openEditor(inApi);
  assert.equal(activeRoot(m), WEB);
  m.setActive(undefined);
  assert.equal(activeRoot(m), API, "back to the editor's repository at once");
  assert.equal(store.values.has(PICKED_REPO_KEY), false, "and not remembered");
});

test("nested: with the OUTER repository picked, its nested repo's files still belong to the nested repo", async () => {
  const m = await open([API, VENDOR]);
  m.setActive(API);
  vs.openEditor(inVendor);
  assert.equal(activeRoot(m), API, "the pick holds");
  assert.equal(m.findByPath(inVendor)?.root, VENDOR, "per-file features ask findByPath");
  // Blame is the per-file feature that used to prefer the active repository
  // whenever it merely CONTAINED the file.
  const doc = { uri: { scheme: "file", fsPath: inVendor } };
  const resolveFor = BlameController.prototype.resolveFor;
  assert.equal(resolveFor.call({ repos: m } as never, doc as never)?.root, VENDOR);
});

// ── A pick ends with its repository ─────────────────────────────────────────

test("a pick is cleared when its repository closes; the editor decides again", async () => {
  const store = memento();
  const m = await open([API, WEB], store);
  vs.openEditor(inApi);
  m.setActive(WEB);
  assert.equal(store.values.get(PICKED_REPO_KEY), WEB);

  vs.gitClose(WEB);
  assert.equal(activeRoot(m), API);
  assert.equal(m.getPicked(), undefined);
  assert.equal(store.values.has(PICKED_REPO_KEY), false, "forgotten, not waiting to re-take the view");
  // It does not come back when the repository reopens.
  vs.gitOpen(vs.repository(WEB));
  vs.openEditor(inApi);
  assert.equal(activeRoot(m), API);
});

// ── Remembered per workspace ─────────────────────────────────────────────

test("a pick survives a reload of the window", async () => {
  const store = memento();
  const first = await open([API, WEB], store);
  first.setActive(WEB);
  first.dispose();

  vs.openEditor(inApi);
  const second = await open([API, WEB], store);
  vs.openEditor(inApi);
  assert.equal(activeRoot(second), WEB, "the reloaded window shows the picked repository");
  assert.equal(second.getPicked(), WEB);
});

test("a window closed while discovery is still running keeps the pick for the next one", async () => {
  const store = memento({ [PICKED_REPO_KEY]: WEB });
  vs.reset({ repositories: [vs.repository(API)] }); // WEB not found yet
  const m = await RepoManager.create(store);
  m.dispose(); // before discovery finished
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.values.get(PICKED_REPO_KEY), WEB);
});

test("a picked repository deleted from disk is forgotten — while the window is open", async () => {
  const doomed = gitInit(join(scratch, "code", "doomed"));
  const store = memento();
  const m = await open([API, doomed], store);
  m.setActive(doomed);
  vs.openEditor(inApi);
  assert.equal(activeRoot(m), doomed);
  // What vscode.git does when a repository's folder vanishes: it closes it.
  await removeDir(doomed);
  vs.gitClose(doomed);
  assert.equal(activeRoot(m), API);
  assert.equal(store.values.has(PICKED_REPO_KEY), false);
});

test("a picked repository deleted from disk is forgotten — across a reload", async () => {
  const doomed = gitInit(join(scratch, "code", "doomed-later"));
  const store = memento();
  const first = await open([API, WEB, doomed], store);
  first.setActive(doomed);
  first.dispose();
  await removeDir(doomed);

  // The next window's scan does not find it.
  const m = await open([API, WEB], store, "uninitialized");
  vs.openEditor(inWeb);
  assert.equal(activeRoot(m), WEB, "the editor decides while the scan runs");
  vs.gitSettle();
  await until("the pick is forgotten", () => !store.values.has(PICKED_REPO_KEY));
  assert.equal(m.getPicked(), undefined);
  // Recreated at the same path and opened later, it does not re-take the view.
  gitInit(doomed);
  vs.gitOpen(vs.repository(doomed));
  assert.equal(activeRoot(m), WEB);
});

test("a remembered pick no scan finds (removed from the workspace) is forgotten once vscode.git settles", async () => {
  const elsewhere = gitInit(join(scratch, "elsewhere"));
  const store = memento({ [PICKED_REPO_KEY]: elsewhere });
  const m = await open([API, WEB], store, "uninitialized");
  assert.equal(store.values.get(PICKED_REPO_KEY), elsewhere, "not judged while vscode.git is still scanning");
  vs.gitSettle();
  await until("the pick is forgotten", () => !store.values.has(PICKED_REPO_KEY));
  vs.openEditor(inWeb);
  assert.equal(activeRoot(m), WEB);
});

test("a remembered pick found late by the scan still wins", async () => {
  const store = memento({ [PICKED_REPO_KEY]: WEB });
  const m = await open([API], store, "uninitialized");
  vs.openEditor(inApi);
  assert.equal(activeRoot(m), API, "follows the editor while the picked repository is not found yet");
  vs.gitOpen(vs.repository(WEB));
  assert.equal(activeRoot(m), WEB, "the scan found it: the pick applies");
  vs.gitSettle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.values.get(PICKED_REPO_KEY), WEB, "kept after settling");
  assert.equal(activeRoot(m), WEB);
});

// ── The picker's rows ───────────────────────────────────────────────────────

test("paths read from the workspace folder; outside every folder, from home", () => {
  const folders = [{ name: "code", fsPath: join(scratch, "code") }];
  assert.equal(picker.repoDisplayPath(API, folders, "/nowhere"), "code/api");
  assert.equal(picker.repoDisplayPath(VENDOR, folders, "/nowhere"), "code/api/vendor/lib");
  assert.equal(picker.repoDisplayPath(join(scratch, "code"), folders, "/nowhere"), "code");
  assert.equal(picker.repoDisplayPath(join(scratch, "elsewhere"), folders, scratch), "~/elsewhere");
  assert.equal(picker.repoDisplayPath("/opt/x", folders, scratch), "/opt/x");
  // Multi-root: the innermost folder names it.
  const multi = [...folders, { name: "API (root)", fsPath: API }];
  assert.equal(picker.repoDisplayPath(VENDOR, multi, "/nowhere"), "API (root)/vendor/lib");
});

test("rows: name, path and branch, changed files, the current one checked, in path order", () => {
  const rows = [
    { root: WEB, name: "web", path: "code/web", glance: { branch: "main", changed: 0 } },
    { root: API, name: "api", path: "code/api", glance: { branch: "feature/login", changed: 3 } },
    { root: VENDOR, name: "lib", path: "code/api/vendor/lib", glance: { detachedAt: "1a2b3c4", changed: 1 } },
  ];
  const choices = picker.repoChoices(rows, API, false);
  assert.deepEqual(
    choices.map((c) => [c.label, c.description, c.detail, c.icon]),
    [
      ["api", "code/api · on feature/login", "3 changed files", "check"],
      ["lib", "code/api/vendor/lib · detached at 1a2b3c4", "1 changed file", "repo"],
      ["web", "code/web · on main", undefined, "repo"],
    ],
  );
  assert.equal(choices[0].id, API);
  assert.ok(!choices.some((c) => c.id === picker.FOLLOW_EDITOR_ID), "no way back to offer when nothing is picked");
  const pickedChoices = picker.repoChoices(rows, API, true);
  assert.equal(pickedChoices[pickedChoices.length - 1].id, picker.FOLLOW_EDITOR_ID);
});

test("a row counts each changed file once, from vscode.git's state — no git run", () => {
  const repo = vs.repository(API, { name: "main" }, {
    staged: [inApi],
    unstaged: [inApi, join(API, "b.ts")],
    untracked: [join(API, "new.ts")],
  });
  const g = picker.glance({ root: API, repo, ctx: undefined } as never);
  assert.deepEqual(g, { branch: "main", detachedAt: undefined, changed: 3 });
  assert.deepEqual(picker.glance({ root: API, ctx: undefined } as never), {}, "not attached yet: name and path only");
});

// ── The command, end to end through GitStudio's own pick dialog ────────────

test("Switch Repository… asks in the pick dialog and makes the answer active", async () => {
  const m = await open([API, WEB]);
  vs.setFolders([{ name: "code", fsPath: join(scratch, "code") }]);
  vs.openEditor(inApi);
  const asked: import("../src/ui/dialogs").DialogSpec[] = [];
  let answer: string | undefined = WEB;
  const host = registerDialogHost({
    show: async (spec) => {
      asked.push(spec);
      return answer === undefined ? undefined : { value: answer };
    },
  });
  try {
    await picker.switchRepository(m);
    assert.equal(asked.length, 1);
    const spec = asked[0];
    assert.equal(spec.kind, "pick");
    assert.equal(spec.title, "Switch Repository");
    assert.match(spec.hint ?? "", /follow the file you are editing/);
    const choices = spec.kind === "pick" ? spec.choices : [];
    assert.deepEqual(choices.map((c) => [c.label, c.icon]), [["api", "check"], ["web", "repo"]]);
    assert.equal(activeRoot(m), WEB);

    // Dismissed: nothing changes. With a pick in effect, the hint says so and
    // the way back is offered.
    answer = undefined;
    await picker.switchRepository(m);
    assert.equal(activeRoot(m), WEB);
    const second = asked[1];
    assert.match(second.hint ?? "", /stay on web until you pick again/);
    const ids = second.kind === "pick" ? second.choices.map((c) => c.id) : [];
    assert.equal(ids[ids.length - 1], picker.FOLLOW_EDITOR_ID);

    answer = picker.FOLLOW_EDITOR_ID;
    await picker.switchRepository(m);
    assert.equal(m.getPicked(), undefined);
    assert.equal(activeRoot(m), API);
  } finally {
    host.dispose();
  }
});
