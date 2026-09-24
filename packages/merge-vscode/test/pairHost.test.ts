import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/GitContext";
import type { ConflictsSnapshot, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { targetUri } from "../src/args";
import { registerMergeExperience } from "../src/register";
import { MERGE_STUDIO_SHARED_MERGE_COMMAND, type MergeProduct, type MergeRepo, type RepoLocator } from "../src/product";

// registerMergeExperience between the two products of the pair, as the e2e
// verification drove them in VS Code (r0923):
// - A5.3: the status item stays once every file is resolved, as "Continue …";
// - A5.8 both ways: handing the automatic behaviour over hides this product's
//   item and closes its dashboard at once, and turning the owner's autoOpen
//   back on is heard without waiting for a repository event;
// - A5.1: an installed Merge Studio 0.3.x is named once, instead of racing;
// - the coexistence question is never asked twice across the pair;
// - A1.3: a routed file keeps one tab;
// - the palette's "Open in merge editor" finds a file shown in a custom editor.

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

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string) => ({
  role,
  stage,
  name,
  paneTitle: name,
  description: name,
});

function rebaseView(over: Partial<OperationView> = {}): OperationView {
  return {
    kind: "rebase",
    backend: "merge",
    title: "Rebasing test onto master · commit 1 of 1: 1a2b3c4 test change",
    direction: { from: "yours", verb: "onto", to: "theirs" },
    step: { n: 1, m: 1, unit: "commit" },
    yours: side("yours", 3, "test"),
    theirs: side("theirs", 2, "master"),
    verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
    canContinue: true,
    canSkip: false,
    episode: "rebase:1",
    ...over,
  };
}

/** One repository whose state the test moves: `unmerged` conflicted files over `view`. */
function fakeRepo(state: { unmerged: number; view: OperationView; conflicted?: Set<string> }): MergeRepo {
  const ctx = {
    operation: {
      detect: async () => ({ kind: state.view.kind, unmerged: state.unmerged }),
      view: async () => state.view,
    },
    conflictOps: {
      snapshot: async (): Promise<ConflictsSnapshot> => {
        const files = Array.from({ length: state.unmerged }, (_, i) => ({
          path: `f${i}.txt`,
          status: "pending" as const,
          shape: "text" as const,
        }));
        return { repoName: "r", op: state.view, files, total: files.length, resolved: 0 };
      },
    },
    conflict: { isConflicted: async (rel: string) => state.conflicted?.has(rel) ?? false },
  } as unknown as GitContext;
  return { root: "/r", ctx };
}

function locatorOf(repo: MergeRepo): RepoLocator & { fire(): void } {
  const listeners = new Set<() => void>();
  return {
    all: () => [repo],
    forPath: (p) => (p.startsWith("/r/") ? repo : undefined),
    active: () => repo,
    onDidChange: (l) => {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
    fire: () => {
      for (const l of listeners) l();
    },
  };
}

function setUp(product: Partial<MergeProduct> & { locator: RepoLocator }) {
  const state = new Map<string, unknown>();
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
      setKeysForSync: () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
  const full: MergeProduct = {
    key: "gitstudio",
    brand: { name: "GitStudio", mark: "gitstudio" },
    displayName: "GitStudio",
    settingsSection: "gs.merge",
    viewTypes: { mergeEditor: "gs.mergeEditor", diffView: "gs.diffView", conflicts: "gs.conflicts" },
    commands: COMMANDS,
    ideAvailableContextKey: "gs.ideAvailable",
    statusItemId: "gs.conflicts",
    coexistencePromptKey: "gs.coexistence.answered",
    ask: async () => false,
    ...product,
  };
  const experience = registerMergeExperience(context, full);
  return { state, experience, dispose: () => experience.dispose() };
}

/** Wait out the watcher's debounce (120 ms) and the async work behind it. */
async function scanned(): Promise<void> {
  await settle(10);
  await new Promise((r) => setTimeout(r, 160));
  await settle(20);
}

const conflictsItem = () => stub.statusItems.find((i) => i.id === "gs.conflicts")!;

test("A5.3: with every file resolved mid-rebase the item reads Continue Rebase, not nothing", async () => {
  const s = { unmerged: 1, view: rebaseView() };
  const locator = locatorOf(fakeRepo(s));
  const { dispose } = setUp({ locator });
  try {
    await scanned();
    assert.equal(conflictsItem().visible, true);
    assert.equal(conflictsItem().text, "$(warning) Resolve Conflicts");
    assert.ok(conflictsItem().backgroundColor, "the warning colour while files conflict");

    s.unmerged = 0; // the last file resolved in the terminal
    locator.fire();
    await scanned();
    assert.equal(conflictsItem().visible, true, "the way back to Continue stays on screen");
    assert.equal(conflictsItem().text, "$(debug-continue) Continue Rebase");
    assert.equal(conflictsItem().backgroundColor, undefined, "the neutral colour");

    s.view = rebaseView({ pause: { reason: "edit", detail: "Paused to edit 1a2b3c4 test change" } });
    locator.fire();
    await scanned();
    assert.equal(conflictsItem().text, "$(debug-pause) Rebase paused");

    s.view = { ...rebaseView(), kind: "none", verbs: { abort: "Cancel" }, episode: "none" };
    locator.fire();
    await scanned();
    assert.equal(conflictsItem().visible, false, "nothing in progress: no item");
  } finally {
    dispose();
  }
});

test("A5.8: handing the automatic behaviour over hides the item and closes this product's dashboard at once", async () => {
  const s = { unmerged: 2, view: rebaseView() };
  const locator = locatorOf(fakeRepo(s));
  let defers = false;
  const { dispose } = setUp({ locator, defersTo: () => defers });
  try {
    await scanned();
    const dash = stub.panels.find((p) => p.viewType === "gs.conflicts");
    assert.ok(dash && !dash.disposed, "the owner auto-shows its dashboard");
    assert.equal(conflictsItem().visible, true);

    // "Let Merge Studio open conflicts": gs.merge.autoOpen goes false.
    defers = true;
    stub.config["gs.merge.autoOpen"] = false;
    stub.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => "gs.merge.autoOpen".startsWith(s) });
    await scanned();
    assert.equal(conflictsItem().visible, false, "one Resolve Conflicts item, not two");
    assert.equal(dash.disposed, true, "and one dashboard");
  } finally {
    dispose();
  }
});

test("A5.8: the deferring product hears the owner's autoOpen change without a repository event", async () => {
  const s = { unmerged: 1, view: rebaseView() };
  const locator = locatorOf(fakeRepo(s));
  let defers = false;
  const { dispose } = setUp({
    locator,
    settingsSection: "ms",
    statusItemId: "gs.conflicts",
    defersTo: () => defers,
    deferral: { owner: "GitStudio", noticeKey: "ms.deferral", handBack: { section: "gs.merge", key: "autoOpen" } },
  });
  try {
    await scanned();
    assert.equal(conflictsItem().visible, true, "owning it while the owner's autoOpen is off");
    defers = true; // the owner's autoOpen back to default
    stub.onDidChangeConfiguration.fire({ affectsConfiguration: (sec: string) => "gs.merge.autoOpen".startsWith(sec) });
    await scanned();
    assert.equal(conflictsItem().visible, false, "hidden at once, not at the next git event");
  } finally {
    dispose();
  }
});

const MS_ID = "t.merge-studio";
const peer = {
  extensionId: MS_ID,
  displayName: "Merge Studio",
  sharedMerge: (pkg: unknown) =>
    ((pkg as { contributes?: { commands?: { command: string }[] } })?.contributes?.commands ?? []).some(
      (c) => c.command === MERGE_STUDIO_SHARED_MERGE_COMMAND,
    ),
  outdatedNoticeKey: "gs.merge.outdatedPeerNotice",
};

test("A5.1 skew-b: an installed Merge Studio 0.3.4 is named once, instead of the two racing in silence", async () => {
  stub.config["git.mergeEditor"] = true; // something for the coexistence question to be about
  stub.extensions[MS_ID] = { packageJSON: { version: "0.3.4", contributes: { commands: [{ command: "jbMerge.showConflicts" }] } } };
  const s = { unmerged: 1, view: rebaseView() };
  const locator = locatorOf(fakeRepo(s));
  const { state, dispose } = setUp({ locator, peer });
  try {
    await scanned();
    const said = stub.messages.filter((m) => /Merge Studio 0\.3\.4 is installed too/.test(m.message));
    assert.equal(said.length, 1, JSON.stringify(stub.messages));
    assert.match(said[0].message, /rebase's sides the old way round/);
    assert.deepEqual(said[0].actions, ["Show Merge Studio"]);
    assert.equal(state.get(peer.outdatedNoticeKey), "0.3.4");
    assert.equal(stub.messages.length, 1, "one notice: the coexistence question waits");

    // The next conflict: said once per version, so only the question now.
    s.unmerged = 0;
    locator.fire();
    await scanned();
    s.unmerged = 1;
    locator.fire();
    await scanned();
    assert.equal(stub.messages.filter((m) => /is installed too/.test(m.message)).length, 1);
  } finally {
    dispose();
  }
});

test("nothing asks twice: the peer's answer to the coexistence question is this product's", async () => {
  stub.config["git.mergeEditor"] = true;
  stub.extensions[MS_ID] = {
    packageJSON: { version: "1.0.0", contributes: { commands: [{ command: MERGE_STUDIO_SHARED_MERGE_COMMAND }] } },
    isActive: true,
    exports: { mergePeer: { coexistenceAnswered: () => true } },
  };
  const locator = locatorOf(fakeRepo({ unmerged: 1, view: rebaseView() }));
  const { state, dispose } = setUp({ locator, peer });
  try {
    await scanned();
    assert.equal(stub.messages.length, 0, JSON.stringify(stub.messages));
    assert.equal(state.get("gs.coexistence.answered"), true, "and it is kept as this product's answer");
  } finally {
    dispose();
  }
});

test("…while a peer that was not answered leaves the question to be asked", async () => {
  stub.config["git.mergeEditor"] = true;
  stub.extensions[MS_ID] = {
    packageJSON: { version: "1.0.0", contributes: { commands: [{ command: MERGE_STUDIO_SHARED_MERGE_COMMAND }] } },
    isActive: true,
    exports: { mergePeer: { coexistenceAnswered: () => false } },
  };
  const locator = locatorOf(fakeRepo({ unmerged: 1, view: rebaseView() }));
  const { experience, dispose } = setUp({ locator, peer });
  try {
    await scanned();
    assert.equal(stub.messages.length, 1);
    assert.match(stub.messages[0].message, /Turn off VS Code's own merge editor/);
    assert.equal(experience.peerApi.coexistenceAnswered(), false, "this product was not answered either");
  } finally {
    dispose();
  }
});

test("A1.3: a conflicted file routed to the merge editor keeps one tab", async () => {
  const uri = vscode.Uri.file("/r/f.txt");
  const textTab = { input: { uri }, isDirty: false };
  const dirtyOther = { input: { uri: vscode.Uri.file("/r/g.txt") }, isDirty: false };
  stub.tabGroupsAll = [{ tabs: [textTab, dirtyOther] }];
  const locator = locatorOf(fakeRepo({ unmerged: 1, view: rebaseView(), conflicted: new Set(["f.txt"]) }));
  const { dispose } = setUp({ locator });
  try {
    await scanned();
    stub.closedTabs.length = 0;
    stub.onDidChangeActiveTextEditor.fire({ document: { uri } });
    await scanned();
    assert.ok(
      stub.commands.some((c) => c[0] === "vscode.openWith" && (c[1] as vscode.Uri).toString() === uri.toString()),
      "routed to the merge editor",
    );
    assert.deepEqual(stub.closedTabs, [textTab], "its text tab closed; another file's tab untouched");
  } finally {
    dispose();
  }
});

test("A1.3: a text tab with unsaved edits is never closed by routing", async () => {
  const uri = vscode.Uri.file("/r/f.txt");
  stub.tabGroupsAll = [{ tabs: [{ input: { uri }, isDirty: true }] }];
  const locator = locatorOf(fakeRepo({ unmerged: 1, view: rebaseView(), conflicted: new Set(["f.txt"]) }));
  const { dispose } = setUp({ locator });
  try {
    await scanned();
    stub.closedTabs.length = 0;
    stub.onDidChangeActiveTextEditor.fire({ document: { uri } });
    await scanned();
    assert.deepEqual(stub.closedTabs, []);
  } finally {
    dispose();
  }
});

test("the palette's Open in merge editor finds the file of an active custom editor (the other product's merge tab)", () => {
  const uri = vscode.Uri.file("/r/app/version.py");
  stub.activeTabGroup = { activeTab: { input: { uri, viewType: "gitstudio.mergeEditor" } } };
  assert.equal(targetUri(undefined)?.toString(), uri.toString());
  stub.activeTabGroup = undefined;
  assert.equal(targetUri(undefined), undefined);
});
