import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { OperationOutcome, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { ExitGuard } from "../src/exitGuard";
import { createHostCore } from "../src/host";
import { driveVerb, registerMergeExperience, type MergeExperience } from "../src/register";
import type { AskSpec, MergeProduct, MergeRepo, RepoLocator } from "../src/product";
import { view } from "./fixtures";

// registerMergeExperience's commands and watcher, and driveVerb's every
// branch (Continue / Skip / Abort from the palette or a banner): what is
// asked, what git is told to run, and what the user is told.

const COMMANDS = {
  showConflicts: "cov.showConflicts",
  resolveInMergeEditor: "cov.resolveInMergeEditor",
  compare: "cov.compare",
  openDiff: "cov.openDiff",
  openChanges: "cov.openChanges",
  stageWithTicks: "cov.stageWithTicks",
  openDemo: "cov.openDemo",
  openDemoDiff: "cov.openDemoDiff",
  operationContinue: "cov.operation.continue",
  operationSkip: "cov.operation.skip",
  operationAbort: "cov.operation.abort",
  restoreBuiltInMergeEditor: "cov.restoreBuiltInMergeEditor",
};

const MERGE_EDITOR = "cov.mergeEditor";

interface RepoState {
  kind: OperationView["kind"];
  unmerged: number;
  view: OperationView;
  /** What the next verb returns. */
  outcome?: OperationOutcome;
  /** detect() throws. */
  detectFails?: boolean;
  /** view() throws. */
  viewFails?: boolean;
  /** Paths `git ls-files -u` would list. */
  conflicted?: string[];
  /** What running a verb does to the repository. */
  onVerb?: () => void;
}

interface FakeRepo extends MergeRepo {
  calls: string[];
  state: RepoState;
}

function fakeRepo(root: string, state: RepoState): FakeRepo {
  const calls: string[] = [];
  const done = (): OperationOutcome => {
    state.onVerb?.();
    return state.outcome ?? { ok: true, view: view("none"), remainingConflicts: 0 };
  };
  const ctx = {
    operation: {
      detect: async () => {
        calls.push("detect");
        if (state.detectFails) throw new Error("git is busy");
        return { kind: state.kind, unmerged: state.unmerged };
      },
      view: async () => {
        calls.push("view");
        if (state.viewFails) throw new Error("git is busy");
        return state.view;
      },
      continue: async (o: unknown) => {
        calls.push(`continue:${JSON.stringify(o)}`);
        return done();
      },
      skip: async () => {
        calls.push("skip");
        return done();
      },
      abort: async () => {
        calls.push("abort");
        return done();
      },
    },
    conflictOps: {
      snapshot: async () => {
        calls.push("snapshot");
        const files = (state.conflicted ?? []).map((path) => ({ path, status: "pending" as const, shape: "text" as const }));
        return { repoName: root, op: state.view, files, total: files.length, resolved: 0 };
      },
    },
    conflict: {
      listConflicts: async () => state.conflicted ?? [],
      isConflicted: async (rel: string) => (state.conflicted ?? []).includes(rel),
    },
  };
  return { root, ctx: ctx as unknown as MergeRepo["ctx"], calls, state };
}

function locatorOf(repos: MergeRepo[], active?: () => MergeRepo | undefined): RepoLocator & { fire(): void } {
  const listeners = new Set<() => void>();
  return {
    all: () => repos,
    forPath: (p) => repos.find((r) => p.replace(/\\/g, "/").startsWith(`${r.root}/`)),
    active: active ?? (() => repos[0]),
    onDidChange: (l) => {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
    fire: () => {
      for (const l of listeners) l();
    },
  };
}

function contextOf(state = new Map<string, unknown>()): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file("/ext"),
    globalStorageUri: vscode.Uri.file("/storage"),
    subscriptions: [],
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => {
        if (v === undefined) state.delete(k);
        else state.set(k, v);
      },
      setKeysForSync: () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
}

function productOf(over: Partial<MergeProduct> & { locator: RepoLocator }): MergeProduct & { asked: AskSpec[] } {
  const asked: AskSpec[] = [];
  return {
    key: "gitstudio",
    brand: { name: "GitStudio", mark: "gitstudio" },
    displayName: "GitStudio",
    settingsSection: "cov.merge",
    viewTypes: { mergeEditor: MERGE_EDITOR, diffView: "cov.diffView", conflicts: "cov.conflicts" },
    commands: COMMANDS,
    statusItemId: "cov.conflicts",
    coexistencePromptKey: "cov.coexistence.answered",
    ask: async (spec: AskSpec) => {
      asked.push(spec);
      return true;
    },
    asked,
    ...over,
  };
}

let experience: MergeExperience | undefined;
const fsApi = vscode.workspace.fs as unknown as { stat?: (uri: vscode.Uri) => Promise<unknown> };

function register(product: MergeProduct, state?: Map<string, unknown>): MergeExperience {
  experience = registerMergeExperience(contextOf(state), product);
  return experience;
}

/** Wait on real time (generous cap) until `cond` holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await settle(2);
    if (!cond()) await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(cond(), `timed out waiting for ${what}`);
}

const count = (calls: string[], what: string) => calls.filter((c) => c === what).length;
const run = (id: string, ...args: unknown[]) =>
  (stub as unknown as { registered: Map<string, (...a: unknown[]) => unknown> }).registered.get(id)!(...args);

beforeEach(() => {
  stub.reset();
  delete fsApi.stat;
});
afterEach(() => {
  experience?.dispose();
  experience = undefined;
  mock.timers.reset();
  delete fsApi.stat;
});

// ── registerMergeExperience ──────────────────────────────────────────────────

test("every command of the product is registered, and disposing the experience unregisters them", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  const exp = register(productOf({ locator: locatorOf([repo]) }));
  const registered = (stub as unknown as { registered: Map<string, unknown> }).registered;
  assert.deepEqual([...registered.keys()].sort(), Object.values(COMMANDS).sort());
  exp.dispose();
  experience = undefined;
  assert.equal(registered.size, 0);
});

test("Resolve Conflicts… with nothing at work anywhere says so and opens nothing", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  register(productOf({ locator: locatorOf([repo]) }));
  await run(COMMANDS.showConflicts);
  assert.ok(
    stub.statusMessages.includes("$(check) GitStudio: no conflicts and nothing in progress in the open repositories."),
    JSON.stringify(stub.statusMessages),
  );
  assert.equal(stub.panels.filter((p) => p.viewType === "cov.conflicts").length, 0);
});

test("Resolve Conflicts… opens the dashboard for the ACTIVE repository when it is the one at work", async () => {
  const a = fakeRepo("/a", { kind: "merge", unmerged: 1, view: view("merge"), conflicted: ["x.txt"] });
  const b = fakeRepo("/b", { kind: "rebase", unmerged: 1, view: view("rebase"), conflicted: ["y.txt"] });
  register(productOf({ locator: locatorOf([a, b], () => b) }));
  await until(() => a.calls.includes("detect"), "the first scan");
  a.calls.length = 0;
  b.calls.length = 0;
  await run(COMMANDS.showConflicts);
  const panels = stub.panels.filter((p) => p.viewType === "cov.conflicts");
  assert.equal(panels.length, 1);
  assert.ok(b.calls.includes("snapshot"), "b's conflicts are read");
  assert.ok(!a.calls.includes("snapshot"), "not a's");
});

test("…and for the first repository at work when the active one has nothing going on", async () => {
  const idle = fakeRepo("/idle", { kind: "none", unmerged: 0, view: view("none") });
  const busy = fakeRepo("/busy", { kind: "cherry-pick", unmerged: 0, view: view("cherry-pick"), detectFails: false });
  register(productOf({ locator: locatorOf([idle, busy], () => idle) }));
  await until(() => busy.calls.includes("detect"), "the first scan");
  busy.calls.length = 0;
  await run(COMMANDS.showConflicts);
  assert.ok(busy.calls.includes("snapshot"), "an operation with nothing unmerged still has a dashboard");
  assert.ok(!idle.calls.includes("snapshot"));
});

test("a repository whose detection fails counts as having nothing at work", async () => {
  const broken = fakeRepo("/a", { kind: "merge", unmerged: 2, view: view("merge"), detectFails: true });
  register(productOf({ locator: locatorOf([broken]) }));
  await run(COMMANDS.showConflicts);
  assert.ok(stub.statusMessages.some((m) => /no conflicts and nothing in progress/.test(m)));
});

test("opening a conflicted file that is on disk opens the merge editor, and lifts the file's exit guard", async () => {
  const repo = fakeRepo("/a", { kind: "merge", unmerged: 1, view: view("merge"), conflicted: ["f.txt"] });
  fsApi.stat = async () => ({ type: 1 });
  const exp = register(productOf({ locator: locatorOf([repo]) }));
  const uri = vscode.Uri.file("/a/f.txt");
  exp.exitGuard.suppress(uri.toString());
  await exp.openConflict(uri);
  const openWith = stub.commands.filter((c) => c[0] === "vscode.openWith");
  assert.equal(openWith.length, 1);
  assert.equal((openWith[0][1] as vscode.Uri).toString(), uri.toString());
  assert.equal(openWith[0][2], MERGE_EDITOR);
  assert.equal(exp.exitGuard.isSuppressed(uri.toString()), false, "explicitly reopened: routing may send it again");
});

test("a file deleted on both sides has nothing to open: the dashboard for its repository instead", async () => {
  const other = fakeRepo("/other", { kind: "merge", unmerged: 1, view: view("merge"), conflicted: ["o.txt"] });
  const repo = fakeRepo("/a", { kind: "merge", unmerged: 1, view: view("merge"), conflicted: ["gone.txt"] });
  fsApi.stat = async () => {
    throw new Error("ENOENT");
  };
  const exp = register(productOf({ locator: locatorOf([other, repo], () => other) }));
  await until(() => repo.calls.includes("detect"), "the first scan");
  repo.calls.length = 0;
  other.calls.length = 0;
  await exp.openConflict(vscode.Uri.file("/a/gone.txt"));
  assert.equal(stub.commands.filter((c) => c[0] === "vscode.openWith").length, 0);
  assert.ok(repo.calls.includes("snapshot"), "the file's own repository, not the active one");
  assert.equal(stub.panels.filter((p) => p.viewType === "cov.conflicts" && !p.disposed).length, 1);
});

test("Open in Merge Editor needs a file: nothing selected, or an untitled one, is said", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  register(productOf({ locator: locatorOf([repo]) }));
  await run(COMMANDS.resolveInMergeEditor);
  await run(COMMANDS.resolveInMergeEditor, vscode.Uri.parse("untitled://Untitled-1"));
  assert.deepEqual(
    stub.statusMessages.filter((m) => /select a conflicted file/.test(m)),
    [
      "$(check) GitStudio: open or select a conflicted file first.",
      "$(check) GitStudio: open or select a conflicted file first.",
    ],
  );
  assert.equal(stub.commands.filter((c) => c[0] === "vscode.openWith").length, 0);
});

test("Open in Merge Editor on a clicked file opens it with the product's merge editor", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  register(productOf({ locator: locatorOf([repo]) }));
  const uri = vscode.Uri.file("/a/f.txt");
  await run(COMMANDS.resolveInMergeEditor, { resourceUri: uri });
  const openWith = stub.commands.filter((c) => c[0] === "vscode.openWith");
  assert.deepEqual(openWith.map((c) => [(c[1] as vscode.Uri).toString(), c[2]]), [[uri.toString(), MERGE_EDITOR]]);
});

test("the diff commands are wired: the sample diff opens a diff panel, Open Changes with no file asks for one", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  register(productOf({ locator: locatorOf([repo]) }));
  await run(COMMANDS.openDemoDiff);
  const diff = stub.panels.filter((p) => p.viewType === "cov.diffView");
  assert.equal(diff.length, 1);
  assert.equal(diff[0].title, "Diff: authorizeRequest.ts");
  await run(COMMANDS.openChanges);
  await run(COMMANDS.compare);
  await run(COMMANDS.openDiff);
  await run(COMMANDS.stageWithTicks);
  const warned = stub.messages.map((m) => m.message);
  assert.deepEqual(warned, [
    "GitStudio: open a file to compare it against HEAD.",
    "GitStudio: open a file or select two files to compare.",
    "GitStudio: open a file or select two files to compare.",
  ]);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: open a file in a Git repository to stage its changes."));
  diff[0].dispose();
});

test("Put back VS Code's merge editor restores what was saved when it was turned off", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  const state = new Map<string, unknown>([["cov.coexistence.answered.previous", { "git.mergeEditor": true }]]);
  stub.config["git.mergeEditor"] = false;
  stub.config["merge-conflict.codeLens.enabled"] = false;
  register(productOf({ locator: locatorOf([repo]) }), state);
  await run(COMMANDS.restoreBuiltInMergeEditor);
  assert.equal(stub.config["git.mergeEditor"], true, "the saved value comes back");
  assert.equal("merge-conflict.codeLens.enabled" in stub.config, false, "no saved value: back to the default");
  assert.equal(state.has("cov.coexistence.answered.previous"), false);
});

test("the operation commands act on the repository the banner names, and a quiet one says nothing", async () => {
  const a = fakeRepo("/a", { kind: "rebase", unmerged: 0, view: view("rebase", { canContinue: true }) });
  const b = fakeRepo("/b", { kind: "rebase", unmerged: 0, view: view("rebase", { canContinue: true }) });
  register(productOf({ locator: locatorOf([a, b]) }));
  const out = (await run(COMMANDS.operationContinue, { root: "/b", quiet: true })) as OperationOutcome;
  assert.equal(out.ok, true);
  assert.equal(count(b.calls, 'continue:{"confirmDrop":false}'), 1);
  assert.equal(a.calls.filter((c) => c.startsWith("continue")).length, 0);
  assert.equal(stub.statusMessages.filter((m) => /Rebase complete/.test(m)).length, 0, "quiet: the caller reports it");

  // An unknown root falls back to the repository at work (the active one), and reports.
  await run(COMMANDS.operationContinue, { root: "/nowhere" });
  assert.equal(a.calls.filter((c) => c.startsWith("continue")).length, 1);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: Rebase complete."));
});

test("Skip and Abort from the palette ask first, then run git", async () => {
  const skippable = view("rebase", { canSkip: true });
  const repo = fakeRepo("/a", { kind: "rebase", unmerged: 1, view: skippable, conflicted: [] });
  const product = productOf({ locator: locatorOf([repo]) });
  register(product);
  await run(COMMANDS.operationSkip);
  await run(COMMANDS.operationAbort);
  assert.deepEqual(product.asked.map((a) => a.title), ["Skip this commit?", "Abort the rebase?"]);
  assert.ok(product.asked.every((a) => a.danger === true));
  assert.equal(count(repo.calls, "skip"), 1);
  assert.equal(count(repo.calls, "abort"), 1);
});

test("an operation command with nothing in progress anywhere says so and runs nothing", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  const exp = register(productOf({ locator: locatorOf([repo]) }));
  const out = await exp.runOperationVerb("abort");
  assert.equal(out, undefined);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: nothing is in progress."));
  assert.equal(count(repo.calls, "abort"), 0);
});

test("a verb that ran rescans git, so the status item follows what it did", async () => {
  const state: RepoState = { kind: "rebase", unmerged: 0, view: view("rebase", { canContinue: true }) };
  const repo = fakeRepo("/a", state);
  const exp = register(productOf({ locator: locatorOf([repo]) }));
  const item = () => stub.statusItems.find((i) => i.id === "cov.conflicts")!;
  await until(() => item().visible, "the Continue item");
  assert.equal(item().text, "$(debug-continue) Continue Rebase");
  // git finishes the rebase.
  state.onVerb = () => {
    state.kind = "none";
    state.view = view("none");
  };
  const out = await exp.runOperationVerb("continue");
  assert.equal(out?.ok, true);
  assert.equal(count(repo.calls, 'continue:{"confirmDrop":false}'), 1);
  await until(() => !item().visible, "the item to go once nothing is in progress");
});

test("with nothing unmerged, the item stays hidden when git's view says nothing continues, or cannot be read", async () => {
  const state: RepoState = { kind: "rebase", unmerged: 0, view: view("none") };
  const repo = fakeRepo("/a", state);
  const exp = register(productOf({ locator: locatorOf([repo]) }));
  const item = () => stub.statusItems.find((i) => i.id === "cov.conflicts")!;
  await until(() => count(repo.calls, "view") >= 1, "the first scan to read the view");
  await settle();
  assert.equal(item().visible, false, "the view is already over");

  state.viewFails = true;
  exp.refresh();
  await until(() => count(repo.calls, "view") >= 2, "a rescan");
  await settle();
  assert.equal(item().visible, false, "a transient failure shows nothing");

  // …and a readable stop shows its Continue again.
  state.viewFails = false;
  state.view = view("merge", { canContinue: true });
  exp.refresh();
  await until(() => item().visible, "the item");
  assert.equal(item().text, "$(debug-continue) Continue Merge");
});

test("a stash re-apply has no Continue: its item stays hidden without asking git for a view", async () => {
  const repo = fakeRepo("/a", { kind: "stash", unmerged: 0, view: view("stash") });
  register(productOf({ locator: locatorOf([repo]) }));
  await until(() => count(repo.calls, "detect") >= 1, "the first scan");
  await settle();
  assert.equal(count(repo.calls, "view"), 0);
  assert.equal(stub.statusItems.find((i) => i.id === "cov.conflicts")!.visible, false);
});

test("repository events are debounced: two in a row scan once, 120 ms after the last", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  const locator = locatorOf([repo]);
  register(productOf({ locator }));
  await until(() => count(repo.calls, "detect") === 1, "the scan at registration");
  mock.timers.enable({ apis: ["setTimeout"] });
  locator.fire();
  mock.timers.tick(100);
  locator.fire();
  mock.timers.tick(119);
  await settle();
  assert.equal(count(repo.calls, "detect"), 1, "the second event restarted the wait");
  mock.timers.tick(1);
  await settle();
  assert.equal(count(repo.calls, "detect"), 2, "one scan for both");
});

test("a change while a scan is running is not lost: the scan goes round once more", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state: RepoState = { kind: "none", unmerged: 0, view: view("none") };
  const repo = fakeRepo("/a", state);
  const detect = repo.ctx.operation.detect.bind(repo.ctx.operation);
  let gated = true;
  (repo.ctx.operation as { detect: unknown }).detect = async () => {
    if (gated) await gate;
    return detect();
  };
  const locator = locatorOf([repo]);
  register(productOf({ locator }));
  mock.timers.enable({ apis: ["setTimeout"] });
  // The scan at registration is waiting on git; a conflict appears meanwhile.
  state.kind = "merge";
  state.unmerged = 2;
  locator.fire();
  mock.timers.tick(120);
  await settle();
  gated = false;
  release();
  mock.timers.reset();
  const item = () => stub.statusItems.find((i) => i.id === "cov.conflicts")!;
  await until(() => item().visible, "the queued scan");
  assert.equal(item().text, "$(warning) Resolve Conflicts");
  assert.equal(item().tooltip, "2 conflicted files — open the Conflicts view");
  assert.equal(count(repo.calls, "detect"), 2, "the running scan, then once more");
});

test("a scan that fails outright is dropped, and the next change scans again", async () => {
  const state: RepoState = { kind: "merge", unmerged: 1, view: view("merge"), conflicted: ["a.txt"] };
  const repo = fakeRepo("/a", state);
  let fail = true;
  const locator = locatorOf([repo]);
  const all = locator.all;
  locator.all = () => {
    if (fail) throw new Error("the locator is being rebuilt");
    return all();
  };
  const exp = register(productOf({ locator }));
  await settle();
  const item = () => stub.statusItems.find((i) => i.id === "cov.conflicts")!;
  assert.equal(item().visible, false);
  fail = false;
  exp.refresh();
  await until(() => item().visible, "the next scan");
  assert.equal(item().tooltip, "1 conflicted file — open the Conflicts view");
});

test("a change to the peer's settings section (read as fallback) rescans; an unrelated setting does not", async () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  register(productOf({ locator: locatorOf([repo]), settingsFallbackSection: "peer" }));
  await until(() => count(repo.calls, "detect") === 1, "the scan at registration");
  mock.timers.enable({ apis: ["setTimeout"] });
  const affecting = (section: string) => ({ affectsConfiguration: (s: string) => s === section });
  stub.onDidChangeConfiguration.fire(affecting("editor"));
  mock.timers.tick(500);
  await settle();
  assert.equal(count(repo.calls, "detect"), 1);
  stub.onDidChangeConfiguration.fire(affecting("peer"));
  mock.timers.tick(120);
  await settle();
  assert.equal(count(repo.calls, "detect"), 2);
});

test("the peer reads whether the coexistence question was answered here", () => {
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: view("none") });
  const state = new Map<string, unknown>();
  const exp = register(productOf({ locator: locatorOf([repo]) }), state);
  assert.equal(exp.peerApi.coexistenceAnswered(), false);
  state.set("cov.coexistence.answered", true);
  assert.equal(exp.peerApi.coexistenceAnswered(), true);
});

// ── driveVerb ────────────────────────────────────────────────────────────────

function hostWith(repo: FakeRepo, answer = true) {
  const asked: AskSpec[] = [];
  const changed: MergeRepo[] = [];
  const product = productOf({
    locator: locatorOf([repo]),
    ask: async (spec: AskSpec) => {
      asked.push(spec);
      return answer;
    },
    onRepositoryChanged: (r) => {
      changed.push(r);
    },
  });
  const host = createHostCore(contextOf(), product, new ExitGuard());
  return { host, asked, changed };
}

test("Continue that git cannot do yet is refused with git's reason, as a warning, and runs nothing", async () => {
  const blocked = view("rebase", { canContinue: false, continueBlocked: "Resolve 2 files first." });
  const repo = fakeRepo("/a", { kind: "rebase", unmerged: 2, view: blocked });
  const { host, asked } = hostWith(repo);
  assert.equal(await driveVerb(host, repo, blocked, "continue"), undefined);
  assert.deepEqual(stub.messages, [{ kind: "warn", message: "GitStudio: Resolve 2 files first.", actions: [] }]);
  assert.deepEqual(asked, []);
  assert.equal(repo.calls.filter((c) => c.startsWith("continue")).length, 0);
});

test("Continue with nothing in progress is said as information", async () => {
  const none = view("none");
  const repo = fakeRepo("/a", { kind: "none", unmerged: 0, view: none });
  const { host } = hostWith(repo);
  assert.equal(await driveVerb(host, repo, none, "continue"), undefined);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: Nothing is in progress."));
});

test("Continue that would drop an emptied commit asks first, naming it; declined, git is not run", async () => {
  const dropping = view("rebase", {
    canContinue: true,
    willDrop: { sha: "0123456789abcdef", subject: "tidy up", branch: "feature" },
  });
  const repo = fakeRepo("/a", { kind: "rebase", unmerged: 0, view: dropping });
  const { host, asked } = hostWith(repo, false);
  assert.equal(await driveVerb(host, repo, dropping, "continue"), undefined);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Drop the emptied commit?");
  assert.equal(
    asked[0].message,
    "After your resolution, 0123456 “tidy up” has no changes left, so git leaves it out of feature.",
  );
  assert.equal(asked[0].confirmLabel, "Continue Rebase and drop it");
  assert.equal(asked[0].danger, true);
  assert.equal(repo.calls.filter((c) => c.startsWith("continue")).length, 0);
});

test("…and confirmed, git continues WITH the drop confirmed, and the product hears the change", async () => {
  const dropping = view("rebase", {
    canContinue: true,
    willDrop: { sha: "0123456789abcdef", subject: "tidy up", branch: "feature" },
  });
  const repo = fakeRepo("/a", { kind: "rebase", unmerged: 0, view: dropping });
  const { host, changed } = hostWith(repo, true);
  const out = await driveVerb(host, repo, dropping, "continue");
  assert.equal(out?.ok, true);
  assert.deepEqual(repo.calls, ['continue:{"confirmDrop":true}']);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: Rebase complete."));
  assert.deepEqual(changed, [repo]);
});

test("a Continue that stops again warns with a way to the conflicts, and taking it opens them", async () => {
  const cont = view("merge", { canContinue: true });
  const repo = fakeRepo("/a", {
    kind: "merge",
    unmerged: 0,
    view: cont,
    outcome: {
      ok: false,
      stopped: true,
      expected: true,
      view: view("rebase", { step: { n: 2, m: 3, unit: "commit" } }),
      remainingConflicts: 1,
    },
  });
  stub.answer = (_kind, _message, actions) => actions[0];
  const { host } = hostWith(repo);
  const out = await driveVerb(host, repo, cont, "continue");
  assert.equal(out?.stopped, true);
  assert.deepEqual(stub.messages, [
    {
      kind: "warn",
      message: "GitStudio: Stopped at commit 2 of 3 — it has conflicts to resolve.",
      actions: ["Resolve Conflicts…"],
    },
  ]);
  await until(() => stub.commands.some((c) => c[0] === COMMANDS.showConflicts), "the dashboard command");
});

test("a stop the user does not follow up opens nothing", async () => {
  const cont = view("merge", { canContinue: true });
  const repo = fakeRepo("/a", {
    kind: "merge",
    unmerged: 0,
    view: cont,
    outcome: { ok: false, stopped: true, expected: true, view: view("merge"), remainingConflicts: 1 },
  });
  const { host } = hostWith(repo);
  await driveVerb(host, repo, cont, "continue");
  await settle();
  assert.equal(stub.messages[0].message, "GitStudio: Stopped again — there are conflicts to resolve.");
  assert.equal(stub.commands.length, 0);
});

test("a refusal git expected is a warning; an unexpected failure is an error", async () => {
  const cont = view("merge", { canContinue: true });
  const expectedRepo = fakeRepo("/a", {
    kind: "merge",
    unmerged: 0,
    view: cont,
    outcome: { ok: false, expected: true, refused: "blocked", view: view("merge", { continueBlocked: "Stage it first." }), remainingConflicts: 0 },
  });
  await driveVerb(hostWith(expectedRepo).host, expectedRepo, cont, "continue");
  const failingRepo = fakeRepo("/b", {
    kind: "merge",
    unmerged: 0,
    view: cont,
    outcome: { ok: false, view: cont, remainingConflicts: 0, message: "fatal: index.lock exists" },
  });
  await driveVerb(hostWith(failingRepo).host, failingRepo, cont, "continue");
  assert.deepEqual(
    stub.messages.map((m) => [m.kind, m.message]),
    [
      ["warn", "GitStudio: Stage it first."],
      ["error", "GitStudio: fatal: index.lock exists"],
    ],
  );
});

test("Skip where git cannot skip is said, and nothing is asked", async () => {
  const merge = view("merge", { canContinue: true });
  const repo = fakeRepo("/a", { kind: "merge", unmerged: 0, view: merge });
  const { host, asked } = hostWith(repo);
  assert.equal(await driveVerb(host, repo, merge, "skip"), undefined);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: there is nothing git can skip here."));
  assert.deepEqual(asked, []);
  // A view that can skip but names no Skip verb is the same.
  const unnamed = view("merge", { canSkip: true });
  assert.equal(await driveVerb(host, repo, unnamed, "skip"), undefined);
  assert.equal(count(repo.calls, "skip"), 0);
});

test("a declined Skip runs nothing", async () => {
  const skippable = view("rebase", { canSkip: true });
  const repo = fakeRepo("/a", { kind: "rebase", unmerged: 1, view: skippable });
  const { host, asked } = hostWith(repo, false);
  assert.equal(await driveVerb(host, repo, skippable, "skip"), undefined);
  assert.equal(asked[0].title, "Skip this commit?");
  assert.equal(asked[0].danger, true);
  assert.equal(count(repo.calls, "skip"), 0);
});

test("Abort with nothing in progress and nothing unmerged is said, and asks nothing", async () => {
  const none = view("none");
  const clean = fakeRepo("/a", { kind: "none", unmerged: 0, view: none });
  const { host, asked } = hostWith(clean);
  assert.equal(await driveVerb(host, clean, none, "abort"), undefined);
  // A repository whose state cannot be read is treated the same.
  const unreadable = fakeRepo("/b", { kind: "none", unmerged: 3, view: none, detectFails: true });
  assert.equal(await driveVerb(host, unreadable, none, "abort"), undefined);
  assert.equal(stub.statusMessages.filter((m) => m === "$(check) GitStudio: nothing is in progress.").length, 2);
  assert.deepEqual(asked, []);
});

test("Abort of unmerged files with no operation asks the reset question; declined, nothing runs", async () => {
  const none = view("none");
  const repo = fakeRepo("/a", { kind: "none", unmerged: 1, view: none, conflicted: ["a.txt"] });
  const { host, asked } = hostWith(repo, false);
  assert.equal(await driveVerb(host, repo, none, "abort"), undefined);
  assert.equal(asked[0].title, "Reset the conflicted files?");
  assert.equal(count(repo.calls, "abort"), 0);
});

test("a confirmed Abort saves the conflicted files' unsaved edits, aborts, and closes the merge editor tabs", async () => {
  const rebase = view("rebase");
  const repo = fakeRepo("/a", { kind: "rebase", unmerged: 1, view: rebase, conflicted: ["a.txt"] });
  const order: string[] = [];
  const doc = (path: string, isDirty: boolean) => ({
    uri: vscode.Uri.file(path),
    isDirty,
    getText: () => "",
    save: async () => {
      order.push(`save:${path}`);
      return true;
    },
  });
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments.push(
    doc("/a/a.txt", true),
    doc("/a/clean.txt", true), // not conflicted: left alone
    doc("/a/b.txt", false),
  );
  const abort = repo.ctx.operation.abort.bind(repo.ctx.operation);
  (repo.ctx.operation as { abort: unknown }).abort = async () => {
    order.push("abort");
    return abort();
  };
  const mergeTab = { input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/a/a.txt") } };
  const textTab = { input: { uri: vscode.Uri.file("/a/a.txt") } };
  stub.tabGroupsAll = [{ tabs: [mergeTab, textTab] }];
  const { host } = hostWith(repo);
  const out = await driveVerb(host, repo, rebase, "abort");
  assert.equal(out?.ok, true);
  assert.deepEqual(order, ["save:/a/a.txt", "abort"], "unsaved work is saved before git overwrites it");
  assert.deepEqual(stub.closedTabs, [mergeTab], "only the merge editor's tab");
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: Rebase cancelled — the repository is back where it was before."));
});

test("an Abort git refused leaves the merge editor tabs open", async () => {
  const rebase = view("rebase");
  const repo = fakeRepo("/a", {
    kind: "rebase",
    unmerged: 1,
    view: rebase,
    outcome: { ok: false, view: rebase, remainingConflicts: 1, message: "error: could not abort" },
  });
  stub.tabGroupsAll = [{ tabs: [{ input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/a/a.txt") } }] }];
  const { host } = hostWith(repo);
  const out = await driveVerb(host, repo, rebase, "abort");
  assert.equal(out?.ok, false);
  assert.deepEqual(stub.closedTabs, []);
  assert.deepEqual(stub.messages.map((m) => [m.kind, m.message]), [["error", "GitStudio: error: could not abort"]]);
});
