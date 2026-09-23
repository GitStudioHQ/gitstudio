import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/GitContext";
import { registerMergeExperience } from "../src/register";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";

// registerMergeExperience's watcher at the FIRST conflict, for the two kinds of
// product: the one that owns the automatic behaviour asks the coexistence
// question; the one standing down (D4) never asks it and says, once, that it
// stood down (POLISH A5.8). And the extension's sync list is set once, whole.

beforeEach(() => stub.reset());

const MS_COMMANDS = {
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

/** One repository mid-rebase with one conflicted file. */
function conflictedLocator(): RepoLocator {
  const ctx = {
    operation: { detect: async () => ({ kind: "rebase", unmerged: 1 }) },
    // The dashboard reads a snapshot; failing here keeps it closed (a transient git failure).
    conflictOps: {
      snapshot: async () => {
        throw new Error("not in this test");
      },
    },
  } as unknown as GitContext;
  const repo: MergeRepo = { root: "/r", ctx };
  return {
    all: () => [repo],
    forPath: () => repo,
    active: () => repo,
    onDidChange: () => ({ dispose() {} }),
  };
}

function setUp(defers: boolean): { state: Map<string, unknown>; syncCalls: string[][]; dispose(): void } {
  const state = new Map<string, unknown>();
  const syncCalls: string[][] = [];
  const context = {
    extensionUri: vscode.Uri.file("/ext"),
    globalStorageUri: vscode.Uri.file("/storage"),
    subscriptions: [],
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => {
        if (v === undefined) state.delete(k);
        else state.set(k, v);
      },
      setKeysForSync: (keys: string[]) => syncCalls.push([...keys]),
    },
  } as unknown as vscode.ExtensionContext;
  const product: MergeProduct = {
    key: "merge-studio",
    brand: { name: "Merge Studio", mark: "merge-studio" },
    displayName: "Merge Studio",
    settingsSection: "t",
    viewTypes: { mergeEditor: "t.mergeEditor", diffView: "t.diffView", conflicts: "t.conflicts" },
    commands: MS_COMMANDS,
    ideAvailableContextKey: "t.ideAvailable",
    statusItemId: "t.conflicts",
    coexistencePromptKey: "t.coexistence.answered",
    locator: conflictedLocator(),
    ask: async () => false,
    defersTo: () => defers,
    deferral: { owner: "GitStudio", noticeKey: "t.deferralNoticeShown", handBack: { section: "gitstudio.merge", key: "autoOpen" } },
    syncedStateKeys: ["t.walkthroughShown"],
  };
  // VS Code's own merge UI is on (so there is something to ask about), and no
  // IDE path is set (detection only reads the file system; nothing launches).
  stub.config["git.mergeEditor"] = true;
  const experience = registerMergeExperience(context, product);
  return { state, syncCalls, dispose: () => experience.dispose() };
}

const waitForScan = async (): Promise<void> => {
  // The first scan runs at registration; its question is asked asynchronously.
  for (let i = 0; i < 50 && stub.messages.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    await settle(5);
  }
};

test("standing down (D4): no coexistence question, and the one notice that says so", async () => {
  const { state, dispose } = setUp(true);
  try {
    await waitForScan();
    assert.equal(stub.messages.length, 1, JSON.stringify(stub.messages));
    assert.match(stub.messages[0].message, /^Merge Studio: GitStudio is installed, so GitStudio opens your conflicts/);
    assert.equal(state.get("t.deferralNoticeShown"), true);
    assert.equal(state.get("t.coexistence.answered"), undefined, "the question is the owner's to ask");
  } finally {
    dispose();
  }
});

test("owning the automatic behaviour: the coexistence question, and no deferral notice", async () => {
  const { state, dispose } = setUp(false);
  try {
    await waitForScan();
    assert.equal(stub.messages.length, 1, JSON.stringify(stub.messages));
    assert.match(stub.messages[0].message, /Turn off VS Code's own merge editor/);
    assert.equal(state.get("t.deferralNoticeShown"), undefined);
  } finally {
    dispose();
  }
});

test("the extension's sync list is set once, and holds the product's own keys with the shared ones", async () => {
  const { syncCalls, dispose } = setUp(false);
  try {
    await waitForScan();
    stub.answer = (_k, _m, actions) => (actions.includes("Turn them off") ? "Turn them off" : undefined);
    await settle();
    assert.deepEqual(syncCalls, [
      ["t.walkthroughShown", "t.coexistence.answered", "t.coexistence.answered.previous", "t.deferralNoticeShown"],
    ]);
  } finally {
    dispose();
  }
});
