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
