import { stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { ExitGuard } from "../src/exitGuard";
import {
  closeMergeEditorTabs,
  closeTextTabs,
  createHostCore,
  dismissSidesTip,
  fileUri,
  readHostSettings,
  sidesTipFor,
} from "../src/host";
import type { MergeProduct, MergeRepo } from "../src/product";

// What every host module shares (host.ts): how the user is told things, the
// settings as read (with the peer's fallback), the tab helpers, and the
// one-time sides tip.

beforeEach(() => stub.reset());

function contextWith(state = new Map<string, unknown>()): vscode.ExtensionContext {
  return {
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => {
        state.set(k, v);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

function product(over: Partial<MergeProduct> = {}): MergeProduct {
  return { displayName: "Merge Studio", settingsSection: "jbMerge", ...over } as unknown as MergeProduct;
}

test("notify: a plain success is a status-bar flash; questions, warnings and errors are toasts", async () => {
  const host = createHostCore(contextWith(), product(), new ExitGuard());
  stub.answer = (_kind, _m, actions) => actions[1];
  assert.equal(await host.notify("info", "all resolved."), undefined);
  assert.equal(await host.notify("info", "a question?", "Yes", "No"), "No");
  await host.notify("warn", "careful.");
  await host.notify("error", "it broke.", "Retry");
  assert.deepEqual(stub.statusMessages, ["$(check) Merge Studio: all resolved."]);
  assert.deepEqual(stub.messages, [
    { kind: "info", message: "Merge Studio: a question?", actions: ["Yes", "No"] },
    { kind: "warn", message: "Merge Studio: careful.", actions: [] },
    { kind: "error", message: "Merge Studio: it broke.", actions: ["Retry"] },
  ]);
});

test("defers: false without a rule, the rule's answer otherwise, and false when the rule throws", () => {
  assert.equal(createHostCore(contextWith(), product(), new ExitGuard()).defers(), false);
  assert.equal(createHostCore(contextWith(), product({ defersTo: () => true }), new ExitGuard()).defers(), true);
  const throwing = product({
    defersTo: () => {
      throw new Error("extensions API gone");
    },
  });
  assert.equal(createHostCore(contextWith(), throwing, new ExitGuard()).defers(), false);
});

test("changed: pokes the git provider and tells the product — a poke that throws does not stop the product hearing it", () => {
  const heard: MergeRepo[] = [];
  const host = createHostCore(contextWith(), product({ onRepositoryChanged: (r) => heard.push(r) }), new ExitGuard());
  let poked = 0;
  const repo = { root: "/r", poke: () => void poked++ } as unknown as MergeRepo;
  host.changed(repo);
  const broken = {
    root: "/s",
    poke: () => {
      throw new Error("vscode.git disposed");
    },
  } as unknown as MergeRepo;
  host.changed(broken);
  assert.equal(poked, 1);
  assert.deepEqual(heard, [repo, broken]);
});

test("settings: normalised from the product's section; garbage reads as the default", () => {
  stub.config["jbMerge.autoOpen"] = false;
  stub.config["jbMerge.autoApplyNonConflicting"] = "yes please";
  assert.deepEqual(readHostSettings("jbMerge"), { autoOpen: false, autoApplyNonConflicting: false });
  const host = createHostCore(contextWith(), product(), new ExitGuard());
  assert.equal(host.settings().autoOpen, false);
});

test("settings: an unset setting falls back to the peer's explicit value — but autoOpen never does", () => {
  stub.config["jbMerge.autoApplyNonConflicting"] = true;
  stub.config["jbMerge.autoOpen"] = false;
  assert.deepEqual(readHostSettings("gitstudio.merge", "jbMerge"), { autoOpen: true, autoApplyNonConflicting: true });
  // Its own value, once set, wins.
  stub.config["gitstudio.merge.autoApplyNonConflicting"] = false;
  assert.equal(readHostSettings("gitstudio.merge", "jbMerge").autoApplyNonConflicting, false);
});

test("closing merge editor tabs closes the product's own, all of them or one file's", async () => {
  const a = { input: { viewType: "ms.merge", uri: vscode.Uri.file("/r/a.txt") } };
  const b = { input: { viewType: "ms.merge", uri: vscode.Uri.file("/r/b.txt") } };
  const other = { input: { viewType: "gs.merge", uri: vscode.Uri.file("/r/a.txt") } };
  const text = { input: { uri: vscode.Uri.file("/r/a.txt") } };
  stub.tabGroupsAll = [{ tabs: [a, other] }, { tabs: [text, b] }];
  await closeMergeEditorTabs("ms.merge", vscode.Uri.file("/r/a.txt"));
  assert.deepEqual(stub.closedTabs, [a]);
  await closeMergeEditorTabs("ms.merge");
  assert.deepEqual(stub.closedTabs, [a, b]);
});

test("closing tabs that are already gone is not an error; with none to close, nothing is asked", async () => {
  let asked = 0;
  stub.onCloseTabs = () => {
    asked++;
    throw new Error("tab already closed");
  };
  await closeMergeEditorTabs("ms.merge");
  assert.equal(asked, 0);
  stub.tabGroupsAll = [
    { tabs: [{ input: { viewType: "ms.merge", uri: vscode.Uri.file("/r/a.txt") } }, { input: { uri: vscode.Uri.file("/r/a.txt") } }] },
  ];
  await assert.doesNotReject(closeMergeEditorTabs("ms.merge"));
  await assert.doesNotReject(closeTextTabs(vscode.Uri.file("/r/a.txt")));
  assert.equal(asked, 2);
});

test("closing a file's text tabs leaves custom editors, notebooks, diffs, dirty tabs and other files alone", async () => {
  const uri = vscode.Uri.file("/r/a.txt");
  const plain = { input: { uri } };
  const dirty = { input: { uri }, isDirty: true };
  const custom = { input: { uri, viewType: "ms.merge" } };
  const notebook = { input: { uri, notebookType: "jupyter" } };
  const diff = { input: { uri, original: uri, modified: uri } };
  const other = { input: { uri: vscode.Uri.file("/r/b.txt") } };
  const empty = { input: undefined };
  stub.tabGroupsAll = [{ tabs: [plain, dirty, custom, notebook, diff, other, empty] }];
  await closeTextTabs(uri);
  assert.deepEqual(stub.closedTabs, [plain]);
  await closeTextTabs(vscode.Uri.file("/r/none.txt"));
  assert.deepEqual(stub.closedTabs, [plain], "nothing to close");
});

test("the sides tip: only for an upgrader, only at a stop whose sides changed, and not once dismissed", async () => {
  const state = new Map<string, unknown>();
  const facts = { version: "1.0", dismissedKey: "ms.sidesTip", why: "https://example.com/why" };
  const host = { context: contextWith(state), product: product({ sidesTip: facts }) };
  const rebase = { kind: "rebase", yours: { name: "" } };

  assert.equal(sidesTipFor({ context: contextWith(), product: product() }, rebase), undefined, "a fresh install");
  assert.equal(sidesTipFor(host, undefined), undefined, "no operation");
  assert.equal(sidesTipFor(host, { kind: "merge", yours: { name: "main" } }), undefined, "a merge's sides never changed");
  assert.deepEqual(sidesTipFor(host, rebase), {
    id: "ms.sidesTip",
    text: "New in Merge Studio 1.0: during a rebase, Yours is your commit, on the left. Before this version the two sides were swapped.",
    why: "https://example.com/why",
  });
  const noWhy = { context: contextWith(state), product: product({ sidesTip: { version: "1.0", dismissedKey: "ms.sidesTip" } }) };
  assert.equal("why" in (sidesTipFor(noWhy, { kind: "stash", yours: { name: "" } }) ?? {}), false);

  await dismissSidesTip(host, "someone-else's-tip");
  assert.equal(state.size, 0, "only this product's tip id is recorded");
  await dismissSidesTip({ context: contextWith(state), product: product() }, "ms.sidesTip");
  assert.equal(state.size, 0, "a product with no tip records nothing");
  await dismissSidesTip(host, "ms.sidesTip");
  assert.equal(state.get("ms.sidesTip"), true);
  assert.equal(sidesTipFor(host, rebase), undefined, "dismissed for good");
});

test("a repo-relative path becomes the file's URI under the repository root", () => {
  const repo = { root: "/w/repo" } as MergeRepo;
  assert.equal(fileUri(repo, "src/deep/a.ts").toString(), vscode.Uri.file("/w/repo/src/deep/a.ts").toString());
});
