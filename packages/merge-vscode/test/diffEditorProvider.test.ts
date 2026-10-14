import { settle, stub } from "./support/useVscodeStub";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { DiffEditorProvider } from "../src/diffEditorProvider";
import type { MergeHostCore } from "../src/host";

beforeEach(() => stub.reset());
afterEach(() => { for (const panel of stub.panels) panel.dispose(); });

const VIEW_TYPE = "picker-test.diffEditor";

function host(): MergeHostCore {
  return {
    context: { extensionUri: vscode.Uri.file("/ext") },
    product: {
      viewTypes: { diffView: "picker-test.diff", diffEditor: VIEW_TYPE },
      locator: { forPath: () => undefined },
      openChangesEmbedded: () => { assert.fail("must bypass product routing"); },
    },
    notify: (_kind: string, message: string) => { assert.fail(`comparison should load: ${message}`); },
  } as unknown as MergeHostCore;
}

function documents(...entries: [vscode.Uri, string][]): vscode.TextDocument[] {
  const docs = entries.map(([uri, text]) => ({ uri, getText: () => text, lineCount: 1 }));
  (vscode.workspace.textDocuments as unknown[]).push(...docs);
  return docs as unknown as vscode.TextDocument[];
}

/** The tab VS Code is opening this editor in: a diff's has no input the API can describe. */
function opening(column: number, label: string, input?: unknown): void {
  const tab = { input, label, isActive: true };
  stub.tabGroupsAll.push({ tabs: [tab], activeTab: tab, viewColumn: column } as never);
}

async function resolve(provider: DiffEditorProvider, docs: vscode.TextDocument[], column: number): Promise<number> {
  let disposed = 0;
  for (const document of docs) {
    await provider.resolveCustomTextEditor(document, {
      viewColumn: column, dispose: () => { disposed++; },
    } as unknown as vscode.WebviewPanel);
  }
  await new Promise((r) => setTimeout(r, 10));
  await settle();
  return disposed;
}

async function init(panel: (typeof stub.panels)[number]): Promise<any> {
  panel.receive({ type: "ready" });
  await settle();
  return panel.posted.find((message: any) => message.type === "diffInit");
}

test("Reopen With on a diff opens its two revisions once, the right way round, and takes focus", async () => {
  const original = vscode.Uri.parse("gitstudio-rev:///w/file.ts?ref=previous");
  const modified = vscode.Uri.parse("gitstudio-rev:///w/file.ts?ref=current");
  const [left, right] = documents([original, "revision 0"], [modified, "revision 1"]);
  // The native diff tab, seen before Reopen With replaced it.
  const native = { input: new vscode.TabInputTextDiff(original, modified), label: "Historical comparison" };
  stub.tabGroupsAll.push({ tabs: [native], activeTab: native, viewColumn: 2 } as never);
  const provider = new DiffEditorProvider(host());
  stub.tabGroupsAll = [];
  opening(2, "Historical comparison");
  // VS Code resolves the sides concurrently: the modified one may come first.
  assert.equal(await resolve(provider, [right, left], 2), 2);
  assert.equal(stub.panels.length, 1);
  const panel = stub.panels[0];
  assert.equal(panel.title, "Historical comparison");
  assert.ok(panel.revealed.length > 0);
  const message = await init(panel);
  assert.equal(message.leftText, "revision 0");
  assert.equal(message.rightText, "revision 1");
  assert.equal(message.rightEditable, false);
});

test("a background diff reopened from its tab menu opens ITS sides, not the active diff's", async () => {
  const a = vscode.Uri.file("/w/a.txt");
  const b = vscode.Uri.file("/w/b.txt");
  const head = vscode.Uri.parse("git:///w/a.txt?ref=HEAD");
  const [headDoc, aDoc] = documents([head, "a at HEAD"], [a, "a now"], [b, "b now"]);
  const background = { input: new vscode.TabInputTextDiff(head, a), label: "a.txt (Working Tree)", isActive: false };
  const active = { input: new vscode.TabInputTextDiff(a, b), label: "a.txt ↔ b.txt", isActive: true };
  stub.tabGroupsAll.push({ tabs: [background, active], activeTab: active, viewColumn: 1 } as never);
  const provider = new DiffEditorProvider(host());
  stub.tabGroupsAll = [];
  opening(1, "a.txt (Working Tree)");
  assert.equal(await resolve(provider, [headDoc, aDoc], 1), 2);
  assert.equal(stub.panels.length, 1);
  assert.equal(stub.panels[0].title, "a.txt (Working Tree)");
  const message = await init(stub.panels[0]);
  assert.equal(message.leftText, "a at HEAD");
  assert.equal(message.rightText, "a now");
  assert.equal(message.rightEditable, true);
});

test("Reopen With on a plain file compares it with HEAD, whatever diff that group showed before", async () => {
  const a = vscode.Uri.file("/w/a.txt");
  const b = vscode.Uri.file("/w/b.txt");
  const [aDoc] = documents([a, "a now"], [b, "b now"]);
  const earlier = { input: new vscode.TabInputTextDiff(a, b), label: "a.txt ↔ b.txt" };
  stub.tabGroupsAll.push({ tabs: [earlier], activeTab: earlier, viewColumn: 1 } as never);
  const provider = new DiffEditorProvider(host());
  stub.tabGroupsAll = [];
  opening(1, "a.txt", new vscode.TabInputCustom(a, VIEW_TYPE));
  assert.equal(await resolve(provider, [aDoc], 1), 1);
  assert.equal(stub.panels.length, 1);
  assert.equal(stub.panels[0].title, "Diff: a.txt");
  const message = await init(stub.panels[0]);
  assert.equal(message.leftLabel, "a.txt (HEAD)");
  assert.equal(message.rightText, "a now");
});

test("as the default diff editor (no native tab ever), a revision beside a working file is its original", async () => {
  const a = vscode.Uri.file("/w/a.txt");
  const index = vscode.Uri.parse("git:///w/a.txt?ref=~");
  const [indexDoc, aDoc] = documents([index, "a staged"], [a, "a now"]);
  const provider = new DiffEditorProvider(host());
  opening(1, "a.txt (Working Tree)");
  assert.equal(await resolve(provider, [aDoc, indexDoc], 1), 2);
  assert.equal(stub.panels.length, 1);
  const message = await init(stub.panels[0]);
  assert.equal(message.leftText, "a staged");
  assert.equal(message.rightText, "a now");
});
