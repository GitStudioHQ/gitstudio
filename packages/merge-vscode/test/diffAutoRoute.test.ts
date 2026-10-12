import { settle, stub } from "./support/useVscodeStub";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { registerDiffAutoRoute } from "../src/diffAutoRoute";
import { markOwnDiff, openWithoutRouting, OWN_DIFF_MARK_MS } from "../src/ownDiffs";
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

interface StubGroup {
  isActive: boolean;
  viewColumn: vscode.ViewColumn;
  tabs: vscode.Tab[];
  readonly activeTab: vscode.Tab | undefined;
}

function tab(
  original: vscode.Uri,
  modified: vscode.Uri,
  opts: { dirty?: boolean; active?: boolean; groupActive?: boolean; preview?: boolean; group?: StubGroup } = {},
) {
  const group: StubGroup = opts.group ?? {
    isActive: opts.groupActive ?? opts.active ?? true,
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
    isPreview: opts.preview ?? false,
    group,
  };
  (group.tabs as vscode.Tab[]).push(result);
  if (!stub.tabGroupsAll.includes(group)) stub.tabGroupsAll.push(group);
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

test("redirects exact Git/index URIs, title and group, independently of merge routing; a focused pinned diff hands its focus on", async () => {
  enable();
  const original = vscode.Uri.parse("git:///w/file.ts?ref=~");
  const modified = vscode.Uri.file("/w/file.ts");
  doc(original, "index, not HEAD\n");
  const right = doc(modified, "working tree\n");
  const source = tab(original, modified);
  // The native diff was opened pinned and has focus: VS Code reports its right side as the active editor.
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor = { document: right };
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
  const original = vscode.Uri.parse("gitstudio-rev:///old?rev=HEAD~1");
  const modified = vscode.Uri.parse("git:///new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified, { groupActive: false });
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

test("unsaved diff tabs remain open (they own the save prompt), so editing opens no second tab", async () => {
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
  assert.equal(right.getText(), "unsaved buffer");
  assert.deepEqual(stub.shownDocuments, []);
  assert.equal(stub.applied[0].edits[0].text, "edited");
});

test("unreadable comparisons (binary, too large) keep the native tab silently, without an event loop", async () => {
  enable();
  const source = tab(vscode.Uri.file("/missing"), vscode.Uri.file("/also-missing"));
  register();
  await settle();
  stub.onDidChangeTabs.fire({ opened: [], changed: [source], closed: [] });
  await settle();
  assert.equal(stub.closedTabs.length, 0);
  assert.equal(stub.panels.length, 0);
  assert.deepEqual(notes, []);
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
  assert.deepEqual(notes, []);
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
  const source = tab(original, modified, { groupActive: false });
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

test("a background diff tab is routed only when brought to the front, so a group never reorders", async () => {
  enable();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  const restored = tab(original, modified, { active: false, groupActive: true });
  register();
  await settle();
  assert.equal(stub.panels.length, 0);
  assert.equal(stub.closedTabs.length, 0);
  restored.isActive = true;
  stub.onDidChangeTabs.fire({ opened: [], changed: [restored], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
  assert.deepEqual(stub.closedTabs, [restored]);
});

test("diffs that are not of files or revisions stay native: review threads and AI edits live in VS Code's diff editor", async () => {
  enable();
  register();
  for (const [left, right] of [
    ["gitstudio-pr:///o/r/1/base/file.ts", "gitstudio-pr:///o/r/1/head/file.ts"],
    ["chat-editing-snapshot-text-model:///w/file.ts", "file:///w/file.ts"],
    ["vscode-userdata-sync:///settings.json", "vscode-userdata:///settings.json"],
  ]) {
    const original = vscode.Uri.parse(left);
    const modified = vscode.Uri.parse(right);
    doc(original, "before");
    doc(modified, "after");
    const source = tab(original, modified);
    stub.onDidChangeTabs.fire({ opened: [source], changed: [], closed: [] });
  }
  await settle();
  assert.equal(stub.panels.length, 0);
  assert.equal(stub.closedTabs.length, 0);
});

test("a dirty diff is replaced when another tab shows its document (closing it asks nothing)", async () => {
  enable();
  const original = vscode.Uri.parse("showModifications:///w/b.txt");
  const modified = vscode.Uri.file("/w/b.txt");
  doc(original, "saved");
  doc(modified, "unsaved");
  const source = tab(original, modified, { dirty: true });
  (source.group.tabs as unknown[]).unshift({ input: { uri: modified }, isDirty: true, isActive: false, group: source.group });
  register();
  await settle();
  assert.equal(stub.panels.length, 1);
  assert.deepEqual(stub.closedTabs, [source]);
  assert.deepEqual(stub.closePrompts, []);
});

test("a dirty diff whose document only another DIFF shows is kept: closing it would ask, and Don't Save reverts", async () => {
  enable();
  const index = vscode.Uri.parse("git:///w/x.ts?ref=~");
  const saved = vscode.Uri.parse("showModifications:///w/x.ts");
  const file = vscode.Uri.file("/w/x.ts");
  doc(index, "index");
  doc(saved, "saved");
  doc(file, "unsaved");
  // An earlier dirty diff of the file, kept native (its own close would ask).
  const earlier = tab(index, file, { dirty: true, active: false });
  // Then Compare with Saved on the same file, in front of the same group.
  const later = tab(saved, file, { dirty: true, group: earlier.group });
  register();
  await settle();
  assert.equal(stub.panels.length, 1, "the comparison still opens");
  assert.deepEqual(stub.closedTabs, [], "neither dirty diff is closed");
  assert.deepEqual(stub.closePrompts, [], "no save prompt the user did not ask for");
  assert.ok(later);
});

test("a dirty diff whose identical twin is open in another group closes without a prompt", async () => {
  enable();
  const saved = vscode.Uri.parse("showModifications:///w/y.ts");
  const file = vscode.Uri.file("/w/y.ts");
  doc(saved, "saved");
  doc(file, "unsaved");
  const twin = tab(saved, file, { dirty: true, active: false });
  const source = tab(saved, file, { dirty: true });
  register();
  await settle();
  assert.deepEqual(stub.closedTabs, [source]);
  assert.deepEqual(stub.closePrompts, []);
  assert.ok(twin);
});

test("editing writes first and opens the document's tab once, not on every edit", async () => {
  enable();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  const source = tab(original, modified);
  register();
  await settle();
  stub.panels[0].receive({ type: "diffChanged", text: "after1" });
  await settle();
  assert.equal(stub.applied.length, 1);
  assert.equal(stub.shownDocuments.length, 1);
  assert.deepEqual(stub.shownDocuments[0].options, { viewColumn: 2, preserveFocus: true, preview: false });
  assert.deepEqual(stub.panels[0].revealed, [[2, true]]);
  // VS Code now has the document's tab beside the comparison.
  (source.group.tabs as unknown[]).push({ input: { uri: modified }, isDirty: true, isActive: false, group: source.group });
  stub.panels[0].receive({ type: "diffChanged", text: "after12" });
  await settle();
  stub.panels[0].receive({ type: "diffChanged", text: "after123" });
  await settle();
  assert.equal(stub.applied.length, 3);
  assert.equal(stub.shownDocuments.length, 1);
  assert.equal(stub.panels[0].revealed.length, 1);
});

test("a preview diff replaces the previous untouched preview comparison in its group; an edited one stays", async () => {
  enable();
  register();
  const group: StubGroup = { isActive: true, viewColumn: vscode.ViewColumn.Two, tabs: [], get activeTab() { return group.tabs[0]; } };
  const open = (name: string) => {
    const original = vscode.Uri.parse(`git:///w/${name}?ref=~`);
    const modified = vscode.Uri.file(`/w/${name}`);
    doc(original, `${name} index`);
    doc(modified, `${name} working`);
    const source = tab(original, modified, { preview: true, group });
    stub.onDidChangeTabs.fire({ opened: [source], changed: [], closed: [] });
  };
  open("a.ts");
  await settle();
  open("b.ts");
  await settle();
  assert.equal(stub.panels.length, 2);
  assert.equal(stub.panels[0].disposed, true, "the first preview comparison was replaced");
  stub.panels[1].receive({ type: "diffChanged", text: "b.ts edited" });
  await settle();
  open("c.ts");
  await settle();
  assert.equal(stub.panels[1].disposed, false, "an edited comparison is kept, like a pinned tab");
  assert.equal(stub.panels[2].disposed, false);
});

test("a keystroke not yet sent (the page debounces) keeps a preview comparison from being replaced", async () => {
  enable();
  register();
  const group: StubGroup = { isActive: true, viewColumn: vscode.ViewColumn.Two, tabs: [], get activeTab() { return group.tabs[0]; } };
  const open = (name: string) => {
    const original = vscode.Uri.parse(`git:///w/${name}?ref=~`);
    const modified = vscode.Uri.file(`/w/${name}`);
    doc(original, `${name} index`);
    doc(modified, `${name} working`);
    stub.onDidChangeTabs.fire({ opened: [tab(original, modified, { preview: true, group })], changed: [], closed: [] });
  };
  open("a.ts");
  await settle();
  // The first keystroke: the page says so at once; its text follows 250 ms later.
  stub.panels[0].receive({ type: "diffEdited" });
  open("b.ts");
  await settle();
  assert.equal(stub.panels[0].disposed, false, "the comparison holding unsent text stays open");
  assert.equal(stub.panels.length, 2);
});

test("preview comparisons are replaced per editor group", async () => {
  enable();
  register();
  const groups = [vscode.ViewColumn.Two, vscode.ViewColumn.Three].map((viewColumn) => {
    const group: StubGroup = { isActive: true, viewColumn, tabs: [], get activeTab() { return group.tabs[0]; } };
    return group;
  });
  const open = (name: string, group: StubGroup) => {
    const original = vscode.Uri.parse(`git:///w/${name}?ref=~`);
    const modified = vscode.Uri.file(`/w/${name}`);
    doc(original, `${name} index`);
    doc(modified, `${name} working`);
    stub.onDidChangeTabs.fire({ opened: [tab(original, modified, { preview: true, group })], changed: [], closed: [] });
  };
  open("a.ts", groups[0]);
  await settle();
  open("b.ts", groups[1]);
  await settle();
  open("c.ts", groups[0]);
  await settle();
  assert.deepEqual(stub.panels.map((p) => p.disposed), [true, false, false], "group 2's preview replaced, group 3's kept");
});

test("a comparison opened for keeps is never replaced by a preview, even after a preview click on it", async () => {
  enable();
  register();
  const group: StubGroup = { isActive: true, viewColumn: vscode.ViewColumn.Two, tabs: [], get activeTab() { return group.tabs[0]; } };
  const open = (name: string, preview: boolean) => {
    const original = vscode.Uri.parse(`git:///w/${name}?ref=~`);
    const modified = vscode.Uri.file(`/w/${name}`);
    doc(original, `${name} index`);
    doc(modified, `${name} working`);
    stub.onDidChangeTabs.fire({ opened: [tab(original, modified, { preview, group })], changed: [], closed: [] });
  };
  open("a.ts", false); // a double click
  await settle();
  open("a.ts", true); // later a single click on the same file: the same comparison comes forward
  await settle();
  assert.equal(stub.panels.length, 1);
  open("b.ts", true);
  await settle();
  assert.equal(stub.panels[0].disposed, false);
});

test("a preview diff (a single click in a list) or another focused editor leaves focus where it is", async () => {
  enable();
  register();
  const preview = tab(vscode.Uri.parse("git:///w/p.ts?ref=~"), vscode.Uri.file("/w/p.ts"), { preview: true });
  doc(preview.input.original, "p index");
  doc(preview.input.modified, "p working");
  stub.onDidChangeTabs.fire({ opened: [preview], changed: [], closed: [] });
  await settle();
  assert.deepEqual(stub.panels[0].showOptions, { viewColumn: 2, preserveFocus: true });
  // A pinned diff opened with preserveFocus beside a text editor that keeps focus.
  const other = doc(vscode.Uri.file("/w/other.ts"), "other");
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor = { document: other };
  const pinned = tab(vscode.Uri.file("/w/a.txt"), vscode.Uri.file("/w/b.txt"));
  doc(pinned.input.original, "a");
  doc(pinned.input.modified, "b");
  stub.onDidChangeTabs.fire({ opened: [pinned], changed: [], closed: [] });
  await settle();
  assert.deepEqual(stub.panels[1].showOptions, { viewColumn: 2, preserveFocus: true });
});

test("an untitled LEFT side stays native (both sides are typed into); an untitled right side routes", async () => {
  enable();
  register();
  const both = tab(vscode.Uri.parse("untitled:///Untitled-1"), vscode.Uri.parse("untitled:///Untitled-2"), { dirty: true });
  doc(both.input.original, "");
  doc(both.input.modified, "");
  stub.onDidChangeTabs.fire({ opened: [both], changed: [], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 0);
  const right = tab(vscode.Uri.file("/w/a.txt"), vscode.Uri.parse("untitled:///Untitled-3"));
  doc(right.input.original, "a");
  doc(right.input.modified, "pasted");
  stub.onDidChangeTabs.fire({ opened: [right], changed: [], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
});

test("an edit written while its comparison is being closed still gets a tab", async () => {
  enable();
  const original = vscode.Uri.file("/old");
  const modified = vscode.Uri.file("/new");
  doc(original, "before");
  doc(modified, "after");
  tab(original, modified);
  register();
  await settle();
  const saved = vscode.workspace.applyEdit;
  let release: (() => void) | undefined;
  vscode.workspace.applyEdit = async (edit) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return saved(edit);
  };
  try {
    stub.panels[0].receive({ type: "diffChanged", text: "after1" });
    await settle();
    stub.panels[0].dispose(); // closed mid-apply
    release?.();
    await settle();
    assert.equal(stub.applied.length, 1);
    assert.equal(stub.shownDocuments.length, 1, "the unsaved edit is not left without a tab");
    assert.deepEqual(stub.shownDocuments[0].options, { viewColumn: 2, preserveFocus: true, preview: false });
  } finally {
    vscode.workspace.applyEdit = saved;
  }
});

test("a diff the product opens from its own views keeps VS Code's diff editor, for good", async () => {
  enable("gitstudio.merge");
  register("gitstudio");
  const original = vscode.Uri.parse("git:///w/own.ts?ref=~");
  const modified = vscode.Uri.file("/w/own.ts");
  doc(original, "index");
  doc(modified, "working");
  await openWithoutRouting(original, modified, "own.ts (Working Tree)", { preview: true });
  assert.deepEqual(stub.commands.at(-1), ["vscode.diff", original, modified, "own.ts (Working Tree)", { preview: true }]);
  // VS Code opens the tab the command asked for.
  const own = tab(original, modified, { preview: true });
  stub.onDidChangeTabs.fire({ opened: [own], changed: [own], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 0);
  assert.equal(stub.closedTabs.length, 0);
  // Brought forward again, or the setting turned off and on: still its own.
  stub.onDidChangeTabs.fire({ opened: [], changed: [own], closed: [] });
  stub.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  await settle();
  assert.equal(stub.panels.length, 0);
  assert.equal(stub.closedTabs.length, 0);
});

/** A mark made so that it lapses `ms` from now. */
function markLapsingIn(original: vscode.Uri, modified: vscode.Uri, ms: number): void {
  markOwnDiff(original, modified, Date.now() - OWN_DIFF_MARK_MS + ms);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an own diff opened while routing is off is not taken over when it is turned on, long after", async () => {
  register("gitstudio");
  const original = vscode.Uri.parse("gitstudio-rev:///w/off.ts?rev=HEAD");
  const modified = vscode.Uri.file("/w/off.ts");
  doc(original, "head");
  doc(modified, "working");
  markLapsingIn(original, modified, 40);
  const own = tab(original, modified);
  stub.onDidChangeTabs.fire({ opened: [own], changed: [], closed: [] });
  await settle();
  await sleep(80); // the mark has lapsed; the tab is remembered
  enable("gitstudio.merge");
  stub.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  await settle();
  assert.equal(stub.panels.length, 0);
});

test("a mark lapses: the same two sides opened later (from Source Control) are routed", async () => {
  enable("gitstudio.merge");
  register("gitstudio");
  const original = vscode.Uri.parse("git:///w/late.ts?ref=~");
  const modified = vscode.Uri.file("/w/late.ts");
  doc(original, "index");
  doc(modified, "working");
  markOwnDiff(original, modified, Date.now() - OWN_DIFF_MARK_MS - 1);
  const scm = tab(original, modified, { preview: true });
  stub.onDidChangeTabs.fire({ opened: [scm], changed: [], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
});

test("Merge Studio leaves GitStudio's own diffs alone, asking GitStudio's API; an older GitStudio cannot say", async () => {
  enable();
  const original = vscode.Uri.parse("git:///w/gs.ts?ref=~");
  const modified = vscode.Uri.file("/w/gs.ts");
  doc(original, "index");
  doc(modified, "working");
  const asked: string[][] = [];
  stub.extensions["gitstudio.gitstudio"] = {
    isActive: true,
    packageJSON: { contributes: { configuration: [{ properties: { "gitstudio.merge.useAsDefaultDiffViewer": {} } }] } },
    exports: { mergePeer: { ownsDiff: (o: string, m: string) => { asked.push([o, m]); return true; } } },
  };
  register("merge-studio");
  const own = tab(original, modified);
  stub.onDidChangeTabs.fire({ opened: [own], changed: [], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 0);
  assert.deepEqual(asked[0], [original.toString(), modified.toString()]);
  // An older GitStudio (no ownsDiff): Merge Studio routes as before.
  stub.extensions["gitstudio.gitstudio"] = { isActive: true, packageJSON: {}, exports: { mergePeer: {} } };
  const other = vscode.Uri.file("/w/other.ts");
  doc(other, "other");
  const next = tab(original, other);
  stub.onDidChangeTabs.fire({ opened: [next], changed: [], closed: [] });
  await settle();
  assert.equal(stub.panels.length, 1);
});

test("an own tab stays its own after its mark lapses", async () => {
  enable("gitstudio.merge");
  register("gitstudio");
  const original = vscode.Uri.parse("git:///w/kept.ts?ref=~");
  const modified = vscode.Uri.file("/w/kept.ts");
  doc(original, "index");
  doc(modified, "working");
  markLapsingIn(original, modified, 40);
  const own = tab(original, modified);
  stub.onDidChangeTabs.fire({ opened: [own], changed: [own], closed: [] });
  await settle();
  await sleep(80);
  stub.onDidChangeTabs.fire({ opened: [], changed: [own], closed: [] });
  stub.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  await settle();
  assert.equal(stub.panels.length, 0);
});
