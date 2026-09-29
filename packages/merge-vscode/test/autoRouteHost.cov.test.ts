import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { registerAutoRoute } from "../src/autoRouteHost";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";

// Automatic routing's listeners (autoRouteHost.ts): the active text editor
// and VS Code's own merge tabs, carried out as autoRoute.ts's table says —
// and its guard windows, ticked on a mocked clock.

interface Setup {
  host: MergeHostCore;
  opened: string[];
  asked: string[];
  settings: { autoOpen: boolean; autoApplyNonConflicting: boolean };
  flags: { defers: boolean };
}

function setUp(conflicted: (rel: string) => boolean | Promise<boolean>): Setup {
  const asked: string[] = [];
  const repo: MergeRepo = {
    root: "/r",
    ctx: {
      conflict: {
        isConflicted: async (rel: string) => {
          asked.push(rel);
          return conflicted(rel);
        },
      },
    } as unknown as MergeRepo["ctx"],
  };
  const locator: RepoLocator = {
    all: () => [repo],
    forPath: (p) => (p.replace(/\\/g, "/").startsWith("/r/") ? repo : undefined),
    active: () => repo,
    onDidChange: () => ({ dispose() {} }),
  };
  const settings = { autoOpen: true, autoApplyNonConflicting: false };
  const flags = { defers: false };
  const host: MergeHostCore = {
    context: {} as vscode.ExtensionContext,
    product: { locator, viewTypes: { mergeEditor: "t.merge" } } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => settings,
    defers: () => flags.defers,
    notify: async () => undefined,
    changed: () => {},
  };
  return { host, opened: [], asked, settings, flags };
}

const editorOn = (path: string) => ({ document: { uri: vscode.Uri.file(path) } });
const untitled = () => ({ document: { uri: vscode.Uri.parse("untitled://Untitled-1") } });
const builtInMergeTab = (path: string) => ({
  input: {
    base: vscode.Uri.file(`${path}.base`),
    input1: vscode.Uri.file(`${path}.1`),
    input2: vscode.Uri.file(`${path}.2`),
    result: vscode.Uri.file(path),
  },
});

/** tabGroups.onDidChangeTabs's emitter (on the stand-in, outside its typed surface). */
const tabsChanged = () => (stub as unknown as { onDidChangeTabs: { fire(e?: unknown): void } }).onDidChangeTabs.fire(undefined);

let disposable: vscode.Disposable | undefined;
function start(s: Setup): void {
  disposable = registerAutoRoute(s.host, async (uri) => {
    s.opened.push(uri.fsPath);
  });
}

beforeEach(() => {
  stub.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  disposable?.dispose();
  disposable = undefined;
  mock.timers.reset();
});

test("a conflicted file becoming the active editor opens in the merge editor, and its plain text tab goes", async () => {
  const s = setUp(() => true);
  const textTab = { input: { uri: vscode.Uri.file("/r/a.txt") } };
  const otherTab = { input: { uri: vscode.Uri.file("/r/b.txt") } };
  stub.tabGroupsAll = [{ tabs: [textTab, otherTab] }];
  start(s);
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  await settle();
  assert.deepEqual(s.asked, ["a.txt"]);
  assert.deepEqual(s.opened, ["/r/a.txt"]);
  assert.deepEqual(stub.closedTabs, [textTab], "only that file's text tab");
});

test("the active editor at registration is routed too", async () => {
  const s = setUp(() => true);
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = editorOn("/r/a.txt");
  start(s);
  await settle();
  assert.deepEqual(s.opened, ["/r/a.txt"]);
});

test("a file just routed is not routed again by a focus bounce, until the guard lapses", async () => {
  const s = setUp(() => true);
  start(s);
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  await settle();
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  await settle();
  assert.deepEqual(s.opened, ["/r/a.txt"]);
  assert.equal(s.asked.length, 1, "the guard is checked before git is asked");
  mock.timers.tick(1500);
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  await settle();
  assert.deepEqual(s.opened, ["/r/a.txt", "/r/a.txt"]);
});

test("autoOpen off, standing down (D4) or a non-file document: nothing is routed and git is never asked", async () => {
  const s = setUp(() => true);
  start(s);
  s.settings.autoOpen = false;
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  s.settings.autoOpen = true;
  s.flags.defers = true;
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  s.flags.defers = false;
  stub.onDidChangeActiveTextEditor.fire(untitled());
  stub.onDidChangeActiveTextEditor.fire(undefined);
  await settle();
  assert.deepEqual(s.opened, []);
  assert.deepEqual(s.asked, []);
});

test("a file the user exited stays out of the merge editor while conflicted", async () => {
  const s = setUp(() => true);
  const key = vscode.Uri.file("/r/a.txt").toString();
  s.host.exitGuard.suppress(key);
  start(s);
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  await settle();
  assert.deepEqual(s.opened, []);
  assert.equal(s.host.exitGuard.isSuppressed(key), true);
});

test("once it is no longer conflicted, the exit guard for it lifts", async () => {
  const s = setUp(() => false);
  const key = vscode.Uri.file("/r/a.txt").toString();
  s.host.exitGuard.suppress(key);
  start(s);
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  await settle();
  assert.deepEqual(s.opened, []);
  assert.equal(s.host.exitGuard.isSuppressed(key), false);
});

test("a file git cannot answer about is treated as not conflicted; one outside every repository too", async () => {
  const s = setUp(() => {
    throw new Error("index.lock");
  });
  const key = vscode.Uri.file("/r/a.txt").toString();
  s.host.exitGuard.suppress(key);
  start(s);
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  stub.onDidChangeActiveTextEditor.fire(editorOn("/elsewhere/x.txt"));
  await settle();
  assert.deepEqual(s.opened, []);
  assert.deepEqual(s.asked, ["a.txt"], "no repository, no question");
  assert.equal(s.host.exitGuard.isSuppressed(key), false);
});

test("VS Code's own merge tab is closed and its result file opened in ours instead", async () => {
  const s = setUp(() => true);
  const merge = builtInMergeTab("/r/a.txt");
  const plain = { input: { uri: vscode.Uri.file("/r/b.txt") } };
  stub.tabGroupsAll = [{ tabs: [plain, merge] }];
  start(s);
  await settle();
  assert.deepEqual(stub.closedTabs, [merge]);
  assert.deepEqual(s.opened, ["/r/a.txt"]);
});

test("a built-in merge tab reopened right after a reroute is kept, until the guard lapses", async () => {
  const s = setUp(() => true);
  start(s);
  stub.tabGroupsAll = [{ tabs: [builtInMergeTab("/r/a.txt")] }];
  tabsChanged();
  await settle();
  assert.equal(s.opened.length, 1);
  const again = builtInMergeTab("/r/a.txt");
  stub.tabGroupsAll = [{ tabs: [again] }];
  tabsChanged();
  await settle();
  assert.equal(s.opened.length, 1, "kept: the user may have chosen it");
  mock.timers.tick(3000);
  tabsChanged();
  await settle();
  assert.equal(s.opened.length, 2);
  assert.deepEqual(stub.closedTabs.length, 2);
});

test("built-in merge tabs are kept with autoOpen off, while standing down, or for a file the user exited ours on", async () => {
  const s = setUp(() => true);
  start(s);
  const tab = builtInMergeTab("/r/a.txt");
  stub.tabGroupsAll = [{ tabs: [tab] }];
  s.settings.autoOpen = false;
  tabsChanged();
  s.settings.autoOpen = true;
  s.flags.defers = true;
  tabsChanged();
  s.flags.defers = false;
  s.host.exitGuard.suppress(vscode.Uri.file("/r/a.txt").toString());
  tabsChanged();
  await settle();
  assert.deepEqual(stub.closedTabs, []);
  assert.deepEqual(s.opened, []);
});

test("a built-in tab that is already gone when closed is still replaced by ours", async () => {
  const s = setUp(() => true);
  stub.onCloseTabs = () => {
    throw new Error("tab already closed");
  };
  stub.tabGroupsAll = [{ tabs: [builtInMergeTab("/r/a.txt")] }];
  start(s);
  await settle();
  assert.deepEqual(s.opened, ["/r/a.txt"]);
});

test("disposed, nothing is routed any more", async () => {
  const s = setUp(() => true);
  start(s);
  disposable!.dispose();
  disposable = undefined;
  stub.onDidChangeActiveTextEditor.fire(editorOn("/r/a.txt"));
  stub.tabGroupsAll = [{ tabs: [builtInMergeTab("/r/a.txt")] }];
  tabsChanged();
  await settle();
  assert.deepEqual(s.opened, []);
});
