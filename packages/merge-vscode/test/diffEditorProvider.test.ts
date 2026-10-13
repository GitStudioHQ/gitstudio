import { settle, stub } from "./support/useVscodeStub";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { DiffEditorProvider } from "../src/diffEditorProvider";
import type { MergeHostCore } from "../src/host";

beforeEach(() => stub.reset());
afterEach(() => { for (const panel of stub.panels) panel.dispose(); });

test("picker opens the exact revisions directly, coalesces both sides and retains focus", async () => {
  const original = vscode.Uri.parse("gitstudio-rev:///w/file.ts?ref=previous");
  const modified = vscode.Uri.parse("gitstudio-rev:///w/file.ts?ref=current");
  const documents = [original, modified].map((uri, i) => ({ uri, getText: () => `revision ${i}`, lineCount: 1 }));
  (vscode.workspace.textDocuments as unknown[]).push(...documents);
  const source = { input: new vscode.TabInputTextDiff(original, modified), label: "Historical comparison" };
  stub.tabGroupsAll.push({ tabs: [source], activeTab: source, viewColumn: 2 } as never);
  const host = {
    context: { extensionUri: vscode.Uri.file("/ext") },
    product: {
      viewTypes: { diffView: "picker-test.diff" },
      openChangesEmbedded: () => { assert.fail("must bypass product routing"); },
    },
    notify: () => { assert.fail("comparison should load"); },
  } as unknown as MergeHostCore;
  const provider = new DiffEditorProvider(host);
  let disposed = 0;
  for (const document of documents) {
    await provider.resolveCustomTextEditor(document as vscode.TextDocument, {
      viewColumn: 2, dispose: () => { disposed++; },
    } as unknown as vscode.WebviewPanel);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settle();
  assert.equal(disposed, 2);
  assert.equal(stub.panels.length, 1);
  const panel = stub.panels[0];
  assert.equal(panel.title, source.label);
  assert.ok(panel.revealed.length > 0);
  panel.receive({ type: "ready" });
  await settle();
  const init = panel.posted.find((message: any) => message.type === "diffInit") as any;
  assert.equal(init.leftText, "revision 0");
  assert.equal(init.rightText, "revision 1");
  assert.equal(init.rightEditable, false);
});
