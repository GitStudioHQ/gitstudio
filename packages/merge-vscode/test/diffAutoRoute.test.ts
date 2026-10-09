import { settle, stub } from "./support/useVscodeStub";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { registerDiffAutoRoute } from "../src/diffAutoRoute";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { MergeProduct } from "../src/product";

const subscriptions: vscode.Disposable[] = [];
const notes: string[] = [];

function host(key: MergeProduct["key"] = "merge-studio"): MergeHostCore {
  const settingsSection = key === "merge-studio" ? "jbMerge" : "gitstudio.merge";
  return {
    context: { extensionUri: vscode.Uri.file("/ext") } as vscode.ExtensionContext,
    product: {
      key,
      settingsSection,
      viewTypes: { diffView: `${key}.diff` },
    } as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({ autoOpen: false, autoApplyNonConflicting: false }),
    defers: () => true,
    notify: async (_kind, text) => { notes.push(text); return undefined; },
    changed: () => {},
  };
}

function doc(uri: vscode.Uri, text: string) {
  const document = { uri, getText: () => text, lineCount: text.split("\n").length };
  (vscode.workspace.textDocuments as unknown as typeof document[]).push(document);
  return document;
}

function tab(original: vscode.Uri, modified: vscode.Uri, opts: { dirty?: boolean; active?: boolean } = {}) {
  const group = {
    isActive: opts.active ?? true,
    viewColumn: vscode.ViewColumn.Two,
    tabs: [] as vscode.Tab[],
    get activeTab(): vscode.Tab | undefined { return group.tabs[0]; },
  };
  const result = {
    input: new vscode.TabInputTextDiff(original, modified),
    label: "file.ts (Index ↔ Working Tree)",
    isActive: opts.active ?? true,
    isDirty: opts.dirty ?? false,
    isPinned: true,
    isPreview: false,
    group,
  };
  (group.tabs as vscode.Tab[]).push(result);
  stub.tabGroupsAll.push(group);
  return result;
}

function ready(): void {
  for (const panel of stub.panels) panel.receive({ type: "ready" });
}

function enable(key = "jbMerge"): void {
  stub.config[`${key}.useAsDefaultDiffViewer`] = true;
}

function register(key?: MergeProduct["key"]): void {
  subscriptions.push(registerDiffAutoRoute(host(key)));
}

beforeEach(() => { stub.reset(); notes.length = 0; });
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  for (const panel of stub.panels) panel.dispose();
});

test("off by default: native text diffs are untouched", async () => {
  tab(vscode.Uri.file("/a"), vscode.Uri.file("/b"));
  register();
  stub.onDidChangeTabs.fire();
  await settle();
  assert.equal(stub.panels.length, 0);
  assert.equal(stub.closedTabs.length, 0);
});

test("redirects exact Git/index URIs, title and group, independently of merge routing", async () => {
  enable();
  const original = vscode.Uri.parse("git:///w/file.ts?ref=~");
  const modified = vscode.Uri.file("/w/file.ts");
  doc(original, "index, not HEAD\n");
  doc(modified, "working tree\n");
  const source = tab(original, modified);
  register();
  await settle();
  assert.deepEqual(stub.closedTabs, [source]);
  assert.equal(stub.panels[0].title, source.label);
  assert.deepEqual(stub.panels[0].showOptions, { viewColumn: 2, preserveFocus: false });
  ready();
  await settle();
  const payload = stub.panels[0].posted.find((m) => (m as { type: string }).type === "diffInit");
  assert.ok(payload);
  assert.equal((payload as { leftText: string }).leftText, "index, not HEAD\n");
  assert.equal((payload as { rightText: string }).rightText, "working tree\n");
  assert.equal((payload as { rightEditable: boolean }).rightEditable, true);
});

test("new diff tabs redirect once; binary/custom/merge inputs stay native", async () => {
  enable();
  register();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  const source = tab(original, modified);
  const other = { ...source, input: { original, modified } };
  (source.group.tabs as vscode.Tab[]).push(other);
  stub.onDidChangeTabs.fire({ opened: [source, other], changed: [], closed: [] });
  stub.onDidChangeTabs.fire({ opened: [], changed: [source], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
  assert.deepEqual(stub.closedTabs, [source]);
});

test("configuration enable redirects existing diffs; disabling leaves future native tabs", async () => {
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified);
  register();
  enable();
  stub.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  await settle();
  assert.equal(stub.panels.length, 1);
  stub.config["jbMerge.useAsDefaultDiffViewer"] = false;
  stub.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  const source = tab(original, modified);
  stub.onDidChangeTabs.fire({ opened: [source], changed: [], closed: [] });
  await settle();
  assert.equal(stub.closedTabs.length, 1);
  assert.equal(stub.panels[0].disposed, false);
});

test("revision-only comparisons stay read-only and background tabs do not steal focus", async () => {
  enable();
  const original = vscode.Uri.parse("revision:///old");
  const modified = vscode.Uri.parse("git:///new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified, { active: false });
  register();
  await settle();
  assert.deepEqual(stub.panels[0].showOptions, { viewColumn: 2, preserveFocus: true });
  ready();
  await settle();
  const payload = stub.panels[0].posted.find((m) => (m as { type: string }).type === "diffInit");
  assert.equal((payload as { rightEditable: boolean }).rightEditable, false);
  stub.panels[0].receive({ type: "diffChanged", text: "do not write" });
  await settle();
  assert.equal(stub.applied.length, 0);
});

test("unsaved source tabs remain open; editing opens a saveable background text tab", async () => {
  enable();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  const right = doc(modified, "unsaved buffer");
  tab(original, modified, { dirty: true });
  register();
  await settle();
  assert.equal(stub.closedTabs.length, 0);
  stub.panels[0].receive({ type: "diffChanged", text: "edited" });
  await settle();
  assert.equal(stub.shownDocuments[0].document, right);
  assert.deepEqual(stub.shownDocuments[0].options, {
    viewColumn: 2, preserveFocus: true, preview: false,
  });
  assert.equal(stub.applied[0].edits[0].text, "edited");
});

test("unreadable comparisons keep the native tab and report one error without an event loop", async () => {
  enable();
  const source = tab(vscode.Uri.file("/missing"), vscode.Uri.file("/also-missing"));
  register();
  await settle();
  stub.onDidChangeTabs.fire({ opened: [], changed: [source], closed: [] });
  await settle();
  assert.equal(stub.closedTabs.length, 0);
  assert.equal(stub.panels.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /couldn't load the diff/);
});

for (const cancellation of ["close", "disable", "dispose"] as const) {
  test(`${cancellation} during loading does not replace the native diff`, async () => {
    const saved = vscode.workspace.openTextDocument;
    let release: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    vscode.workspace.openTextDocument = async () => {
      await loading;
      return {} as vscode.TextDocument;
    };
    try {
      enable();
      tab(vscode.Uri.file("/old"), vscode.Uri.file("/new"));
      register();
      await settle();
      if (cancellation === "dispose") {
        subscriptions[0].dispose();
      } else if (cancellation === "disable") {
        stub.config["jbMerge.useAsDefaultDiffViewer"] = false;
      } else {
        stub.tabGroupsAll = [];
      }
      release?.();
      await settle();
      assert.equal(stub.panels.length, 0);
      assert.equal(stub.closedTabs.length, 0);
      assert.equal(notes.length, 0);
    } finally {
      vscode.workspace.openTextDocument = saved;
    }
  });
}

test("a failed comparison does not block the next readable diff", async () => {
  enable();
  tab(vscode.Uri.file("/missing"), vscode.Uri.file("/also-missing"));
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  const source = tab(original, modified);
  register();
  await settle();
  assert.equal(notes.length, 1);
  assert.equal(stub.panels.length, 1);
  assert.deepEqual(stub.closedTabs, [source]);
});

test("repeated comparisons reuse the panel in the requested group", async () => {
  enable();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified);
  register();
  await settle();
  const source = tab(original, modified, { active: false });
  stub.onDidChangeTabs.fire({ opened: [source], changed: [], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
  assert.deepEqual(stub.panels[0].revealed, [[2, true]]);
  assert.equal(stub.closedTabs.length, 2);
});

test("a preview tab whose input changes mid-load never redirects the stale comparison", async () => {
  enable();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  const next = vscode.Uri.file("/next");
  doc(original, "before");
  doc(modified, "after");
  doc(next, "next");
  const source = tab(original, modified, { dirty: true });
  register();
  source.input = new vscode.TabInputTextDiff(original, next);
  stub.onDidChangeTabs.fire({ opened: [], changed: [source], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
  ready();
  await settle();
  const payload = stub.panels[0].posted.find((m) => (m as { type: string }).type === "diffInit");
  assert.equal((payload as { rightText: string }).rightText, "next");
});

test("when both opt in only GitStudio redirects, without depending on merge auto-open", async () => {
  enable();
  enable("gitstudio.merge");
  stub.extensions["gitstudio.gitstudio"] = {
    packageJSON: { contributes: { configuration: [
      { properties: { "gitstudio.merge.useAsDefaultDiffViewer": {} } },
    ] } },
  };
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified);
  register("merge-studio");
  register("gitstudio");
  await settle();
  assert.equal(stub.panels.length, 1);
  assert.equal(stub.panels[0].viewType, "gitstudio.diff");
  assert.equal(stub.closedTabs.length, 1);
});

test("an older GitStudio without diff routing does not prevent Merge Studio routing", async () => {
  enable();
  enable("gitstudio.merge");
  stub.extensions["gitstudio.gitstudio"] = { packageJSON: {} };
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified);
  register();
  await settle();
  assert.equal(stub.panels.length, 1);
  assert.equal(stub.panels[0].viewType, "merge-studio.diff");
});
