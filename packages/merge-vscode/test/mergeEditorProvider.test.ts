import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { JetBrainsUi } from "../src/jetbrainsUi";
import { MergeEditorProvider } from "../src/mergeEditorProvider";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";
import { view } from "./fixtures";

// The merge editor's HOST (mergeEditorProvider.ts) against a stand-in for the
// vscode module.

beforeEach(() => stub.reset());

const CONFLICTED = "<<<<<<< HEAD\nupstream\n||||||| base\nbase\n=======\nmine\n>>>>>>> 1a2b3c4 (mine)\n";

function hostWith(locator: RepoLocator): MergeHostCore {
  return {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product: {
      key: "gitstudio",
      displayName: "GitStudio",
      settingsSection: "test.merge",
      viewTypes: { mergeEditor: "test.mergeEditor", diffView: "test.diff", conflicts: "test.conflicts" },
      locator,
    } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({
      autoOpen: true,
      autoApplyNonConflicting: false,
      conflictResolver: "embedded",
      diffTool: "embedded",
      preferredIde: "auto",
      jetbrainsPath: "",
    }),
    defers: () => false,
    notify: async () => undefined,
    changed: () => {},
  };
}

const noIde = {
  detect: async () => undefined,
  cachedName: () => undefined,
  merge: async () => {},
} as unknown as JetBrainsUi;

// Handing a conflict to the JetBrains IDE closes this editor. With unapplied
// progress in it, the dirty document was left with no editor and stopped
// following the file the IDE writes — VS Code later offered to save the
// partial merge over the IDE's result. The IDE starts the merge over from the
// three versions, so the progress cannot travel: the product ASKS first, and a
// yes puts the document back to the bytes git left (through the editor's own
// document and a save — never a revert command) before the hand-off.

function editorWith(ask: (spec: { title: string; message: string }) => Promise<boolean>, dirty: boolean) {
  const merged: string[] = [];
  const asked: string[] = [];
  const saved: string[] = [];
  const host = hostWith({
    all: () => [],
    forPath: () => undefined,
    active: () => undefined,
    onDidChange: () => new vscode.Disposable(() => {}),
  });
  (host.product as unknown as { ask: typeof ask }).ask = async (spec) => {
    asked.push(spec.title);
    return ask(spec);
  };
  const ide = {
    detect: async () => ({ id: "intellij", name: "IntelliJ IDEA", command: "/x/idea" }),
    cachedName: () => "IntelliJ IDEA",
    merge: async (uri: vscode.Uri) => {
      merged.push(uri.fsPath);
    },
  } as unknown as JetBrainsUi;
  const provider = new MergeEditorProvider(host, ide);
  const document = {
    uri: vscode.Uri.file("/r/a.txt"),
    getText: () => CONFLICTED,
    lineCount: 7,
    isDirty: dirty,
    save: async () => {
      saved.push(merged.length ? "after-merge" : "before-merge");
      return true;
    },
  } as unknown as vscode.TextDocument;
  return { provider, document, merged, asked, saved };
}

test("open in JetBrains with unapplied progress asks first — and No keeps the editor as it is", async () => {
  const { provider, document, merged, asked, saved } = editorWith(async () => false, true);
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
  stub.panels[0].receive({ type: "openInJetBrains" });
  await settle();
  assert.equal(asked.length, 1, "asked before anything happened");
  assert.match(asked[0], /IntelliJ IDEA/);
  assert.deepEqual(merged, [], "no hand-off");
  assert.deepEqual(saved, [], "and nothing saved");
  assert.equal(stub.panels[0].disposed, false, "the merge editor and its progress stay");
});

test("…Yes discards the progress (back to git's file, saved), then hands off and closes", async () => {
  const { provider, document, merged, saved } = editorWith(async () => true, true);
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
  stub.panels[0].receive({ type: "openInJetBrains" });
  await settle();
  assert.deepEqual(saved, ["before-merge"], "the document was put back and saved before the IDE got the file");
  assert.equal(stub.commands.some((c) => c[0] === "workbench.action.files.revert"), false, "never a revert command");
  assert.deepEqual(merged, ["/r/a.txt"]);
  assert.equal(stub.panels[0].disposed, true);
});

test("…and with nothing unapplied it just hands off, asking nothing", async () => {
  const { provider, document, merged, asked } = editorWith(async () => false, false);
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
  stub.panels[0].receive({ type: "openInJetBrains" });
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(merged, ["/r/a.txt"]);
});

test("a merge editor that opens before its repository is found still reads git's sides once it is", async () => {
  // VS Code restores an open merge editor on reload, and resolves it the
  // moment GitStudio activates — before the RepoManager's discovery (a git
  // spawn per folder, or vscode.git's scan) has found any repository. The
  // repository was looked up ONCE, then: the editor stayed "not in a Git
  // repository" for good — the sides came from the markers (no rebase swap,
  // so Yours was upstream again: issue #12) and Apply saved without staging.
  let known: MergeRepo | undefined;
  const calls: string[] = [];
  const repo = {
    root: "/r",
    ctx: {
      conflictOps: {
        readSides: async (path: string) => {
          calls.push(`readSides:${path}`);
          const op = view("rebase");
          return { op, path, shape: "text", hasBase: true, source: "git-stages", base: "base\n", yours: "mine\n", theirs: "upstream\n" };
        },
      },
    },
  } as unknown as MergeRepo;
  const locator: RepoLocator = {
    all: () => (known ? [known] : []),
    forPath: (p) => (known && p.startsWith("/r/") ? known : undefined),
    active: () => known,
    onDidChange: () => new vscode.Disposable(() => {}),
  };
  const provider = new MergeEditorProvider(hostWith(locator), noIde);
  const document = {
    uri: vscode.Uri.file("/r/a.txt"),
    getText: () => CONFLICTED,
    lineCount: 7,
    isDirty: false,
  } as unknown as vscode.TextDocument;
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);

  known = repo; // discovery finishes while the webview loads Monaco
  stub.panels[0].receive({ type: "ready" });
  await settle();

  assert.deepEqual(calls, ["readSides:a.txt"], "the sides come from git, not from the markers");
  const init = stub.panels[0].posted.find((m) => (m as HostMessage).type === "init") as Extract<HostMessage, { type: "init" }>;
  assert.equal(init.ours, "mine\n", "Yours is your commit during a rebase");
  assert.equal(init.op?.kind, "rebase");
});

// Real VS Code: Yours is CRLF throughout, Theirs LF. git's conflicted file
// mixes both, VS Code opens it as LF (most of its lines), and the merge editor
// says "Yours uses CRLF, theirs LF: the result keeps CRLF". The result text
// arrived in CRLF, but a WorkspaceEdit takes the DOCUMENT's line ending — so
// Accept Yours + Apply saved and staged LF, every line of Yours' file changed.
// The document has to take the result's line ending along with its text.
function documentWith(eol: number, text: string) {
  let current = text;
  let currentEol = eol;
  return {
    uri: vscode.Uri.file("/r/w.txt"),
    getText: () => current,
    get eol() {
      return currentEol;
    },
    lineCount: text.split("\n").length,
    isDirty: false,
    // What VS Code does with the edit: the text, in the document's ending.
    apply(edit: { edits: { text?: string; newEol?: number }[] }) {
      for (const e of edit.edits) if (e.newEol !== undefined) currentEol = e.newEol;
      for (const e of edit.edits) if (e.text !== undefined) current = e.text.replace(/\r\n/g, "\n").replace(/\n/g, currentEol === 2 ? "\r\n" : "\n");
    },
  };
}

for (const [label, docEol, resultText] of [
  ["a CRLF result in an LF document", 1, "a\r\nX\r\nc\r\n"],
  ["an LF result in a CRLF document", 2, "a\nX\nc\n"],
] as const) {
  test(`the merge result keeps its own line ending: ${label}`, async () => {
    const provider = new MergeEditorProvider(hostWith({
      all: () => [],
      forPath: () => undefined,
      active: () => undefined,
      onDidChange: () => new vscode.Disposable(() => {}),
    }), noIde);
    const doc = documentWith(docEol, docEol === 2 ? "<<<<<<< HEAD\r\na\r\n" : "<<<<<<< HEAD\na\n");
    const panel = vscode.window.createWebviewPanel("test.mergeEditor", "w.txt", vscode.ViewColumn.Active, {});
    await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel, {} as vscode.CancellationToken);
    stub.panels[0].receive({ type: "resultChanged", text: resultText });
    await settle();
    assert.equal(stub.applied.length, 1, "one edit");
    doc.apply(stub.applied[0]);
    assert.equal(doc.getText(), resultText, "the document holds the result byte for byte, line endings included");

    // Once it has them, the next identical result is not an edit at all.
    stub.panels[0].receive({ type: "resultChanged", text: resultText });
    await settle();
    assert.equal(stub.applied.length, 1, "nothing to change the second time");
  });
}
