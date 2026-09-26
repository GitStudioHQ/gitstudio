import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/GitContext";
import { registerMergeExperience } from "../src/register";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";

// The watcher keeps the product's operation context key in step with the open
// repositories, so the operation verbs (Continue / Skip / Abort) can be listed
// in the palette only while there is something for them to act on. With
// nothing in progress each one only answered "nothing is in progress".

beforeEach(() => stub.reset());

const COMMANDS = {
  showConflicts: "t.showConflicts",
  resolveInMergeEditor: "t.resolveInMergeEditor",
  mergeWithJetBrains: "t.mergeWithJetBrains",
  diffWithJetBrains: "t.diffWithJetBrains",
  compare: "t.compare",
  openDiff: "t.openDiff",
  openChanges: "t.openChanges",
  stageWithTicks: "t.stageWithTicks",
  openDemo: "t.openDemo",
  openDemoDiff: "t.openDemoDiff",
  operationContinue: "t.operation.continue",
  operationSkip: "t.operation.skip",
  operationAbort: "t.operation.abort",
  restoreBuiltInMergeEditor: "t.restoreBuiltInMergeEditor",
};

type Detection = { kind: string; unmerged: number };

/** One repository whose operation state the test sets, and a way to say it changed. */
function locator(initial: Detection): { loc: RepoLocator; set(d: Detection): void } {
  let now = initial;
  const listeners: (() => void)[] = [];
  const ctx = {
    operation: { detect: async () => now },
    conflictOps: {
      snapshot: async () => {
        throw new Error("not in this test");
      },
    },
  } as unknown as GitContext;
  const repo: MergeRepo = { root: "/r", ctx };
  return {
    loc: {
      all: () => [repo],
      forPath: () => repo,
      active: () => repo,
      onDidChange: (fn: () => void) => {
        listeners.push(fn);
        return { dispose() {} };
      },
    },
    set: (d) => {
      now = d;
      for (const fn of listeners) fn();
    },
  };
}

function register(loc: RepoLocator, operationContextKey?: string): { dispose(): void } {
  const context = {
    extensionUri: vscode.Uri.file("/ext"),
    globalStorageUri: vscode.Uri.file("/storage"),
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => {}, setKeysForSync: () => {} },
  } as unknown as vscode.ExtensionContext;
  const product: MergeProduct = {
    key: "gitstudio",
    brand: { name: "GitStudio", mark: "gitstudio" },
    displayName: "GitStudio",
    settingsSection: "t",
    viewTypes: { mergeEditor: "t.mergeEditor", diffView: "t.diffView", conflicts: "t.conflicts" },
    commands: COMMANDS,
    ideAvailableContextKey: "t.ideAvailable",
    ...(operationContextKey ? { operationContextKey } : {}),
    statusItemId: "t.conflicts",
    coexistencePromptKey: "t.coexistence.answered",
    locator: loc,
    // Answer every question "no", and keep the automatic behaviour off, so
    // only the watcher's bookkeeping runs.
    ask: async () => false,
    defersTo: () => true,
  };
  return registerMergeExperience(context, product);
}

/** The values the key has been set to, in order. */
const keyValues = (key: string): unknown[] =>
  stub.commands.filter((c) => c[0] === "setContext" && c[1] === key).map((c) => c[2]);

const waitFor = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 60 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 20));
    await settle(5);
  }
};

test("the key is true while a rebase is stopped, and false once it is over", async () => {
  const { loc, set } = locator({ kind: "rebase", unmerged: 0 });
  const exp = register(loc, "t.operationInProgress");
  try {
    await waitFor(() => keyValues("t.operationInProgress").length > 0);
    assert.deepEqual(keyValues("t.operationInProgress"), [true]);
    set({ kind: "none", unmerged: 0 });
    await waitFor(() => keyValues("t.operationInProgress").length > 1);
    assert.deepEqual(keyValues("t.operationInProgress"), [true, false]);
  } finally {
    exp.dispose();
  }
});

test("unmerged files with no operation (a stash apply's conflict) count as something to act on", async () => {
  const { loc } = locator({ kind: "none", unmerged: 2 });
  const exp = register(loc, "t.operationInProgress");
  try {
    await waitFor(() => keyValues("t.operationInProgress").length > 0);
    assert.deepEqual(keyValues("t.operationInProgress"), [true]);
  } finally {
    exp.dispose();
  }
});

test("a clean repository sets the key false, and a rescan that finds the same says nothing again", async () => {
  const { loc, set } = locator({ kind: "none", unmerged: 0 });
  const exp = register(loc, "t.operationInProgress");
  try {
    await waitFor(() => keyValues("t.operationInProgress").length > 0);
    set({ kind: "none", unmerged: 0 });
    await new Promise((r) => setTimeout(r, 300));
    await settle(5);
    assert.deepEqual(keyValues("t.operationInProgress"), [false]);
  } finally {
    exp.dispose();
  }
});

test("a product that names no key gets none set", async () => {
  const { loc } = locator({ kind: "merge", unmerged: 1 });
  const exp = register(loc);
  try {
    await new Promise((r) => setTimeout(r, 200));
    await settle(5);
    const keys = stub.commands.filter((c) => c[0] === "setContext").map((c) => c[1]);
    assert.ok(!keys.some((k) => String(k).includes("operation")), JSON.stringify(keys));
  } finally {
    exp.dispose();
  }
});
