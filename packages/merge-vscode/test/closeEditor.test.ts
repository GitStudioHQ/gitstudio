import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { JetBrainsUi } from "../src/jetbrainsUi";
import { MergeEditorProvider } from "../src/mergeEditorProvider";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";
import { git, removeTemp, reporterRebase } from "./fixtures";

// The merge editor's Close (the owner, after using it: "we're missing an exit
// button without canceling the whole rebase"). Close ONLY closes the editor:
// the operation stays paused, the index is untouched, the file keeps its
// markers — and no save prompt on the way out that could write half a merge.

beforeEach(() => stub.reset());

const REVERT_AND_CLOSE = "workbench.action.revertAndCloseActiveEditor";

function host(locator: RepoLocator, exitGuard = new ExitGuard()): MergeHostCore {
  return {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product: {
      key: "gitstudio",
      displayName: "GitStudio",
      settingsSection: "test.merge",
      viewTypes: { mergeEditor: "test.mergeEditor", diffView: "test.diff", conflicts: "test.conflicts" },
      commands: { showConflicts: "test.showConflicts" },
      locator,
      ask: async () => {
        throw new Error("Close must not ask anything");
      },
    } as unknown as MergeProduct,
    exitGuard,
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

const noIde = { detect: async () => undefined, cachedName: () => undefined } as unknown as JetBrainsUi;

/** A document backed by a real file: the stub's edits land in it, and a save would write it. */
function fileDocument(path: string) {
  let text = readFileSync(path, "utf8");
  let dirty = false;
  const saves: string[] = [];
  const doc = {
    uri: vscode.Uri.file(path),
    getText: () => text,
    get lineCount() {
      return text.split("\n").length;
    },
    eol: 1,
    get isDirty() {
      return dirty;
    },
    save: async () => {
      saves.push(text);
      return true;
    },
    /** What VS Code does with the editor's WorkspaceEdit: the text changes, the document is dirty. */
    take(next: string) {
      text = next;
      dirty = true;
    },
  };
  return { doc, saves };
}

/** Everything Close must leave exactly as it was. */
function snapshot(repo: string, file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const opDir = join(repo, ".git", "rebase-merge");
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out[`rebase-merge/${prefix}${name}`] = createHash("sha1").update(readFileSync(p)).digest("hex");
    }
  };
  walk(opDir, "");
  out.index = git(repo, "ls-files", "-s");
  out.unmerged = git(repo, "ls-files", "-u");
  out.head = git(repo, "rev-parse", "HEAD");
  out.status = git(repo, "status", "--porcelain=v2");
  out.file = readFileSync(join(repo, file), "utf8");
  return out;
}

test("REAL git: Close leaves the operation directory, the index and the file exactly as they were — no save, no git", async () => {
  const r = reporterRebase();
  const ctx = new GitContext({ root: r.repo });
  const repo: MergeRepo = { root: r.repo, ctx };
  const locator: RepoLocator = {
    all: () => [repo],
    forPath: () => repo,
    active: () => repo,
    onDidChange: () => new vscode.Disposable(() => {}),
  };
  const guard = new ExitGuard();
  const provider = new MergeEditorProvider(host(locator, guard), noIde);
  const { doc, saves } = fileDocument(join(r.repo, "a.txt"));
  try {
    const before = snapshot(r.repo, "a.txt");
    assert.match(before.unmerged, /a\.txt/, "the rebase is stopped on a.txt");
    const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
    await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel, {} as vscode.CancellationToken);
    stub.panels[0].receive({ type: "ready" });
    // Real git answers in its own time: wait for the sides to arrive.
    for (let i = 0; i < 200 && !stub.panels[0].posted.some((m) => (m as { type: string }).type === "init"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle();
    // Work in the editor: Yours taken. The editor mirrors it into the
    // document (still marked: Theirs is to decide), which is now dirty.
    stub.panels[0].receive({ type: "resultChanged", text: "one\ntwo\nthree-test\nfour\n", unsettled: "one\ntwo\nthree\nfour\n" });
    stub.panels[0].receive({ type: "resultChanged", text: "one\ntwo\nthree-test\nfour\n" });
    await settle();
    const edit = stub.applied[stub.applied.length - 1];
    const mirrored = edit?.edits.find((e: { text?: string }) => e.text !== undefined)?.text;
    assert.ok(mirrored, "the Result reached the document");
    doc.take(mirrored!);
    assert.equal(doc.isDirty, true, "unapplied work makes the document dirty");

    stub.panels[0].receive({ type: "cancel", mode: "exit" });
    await settle();

    assert.deepEqual(stub.commands.map((c) => c[0]), [REVERT_AND_CLOSE], "the tab closes REVERTED — never saved, never a save prompt");
    assert.deepEqual(saves, [], "nothing saved");
    assert.equal(stub.panels[0].disposed, true, "the merge editor is closed");
    assert.equal(guard.isSuppressed(doc.uri.toString()), true, "and automatic routing does not send the file straight back");
    assert.deepEqual(snapshot(r.repo, "a.txt"), before, "the rebase, the index and the file are exactly as they were");
  } finally {
    ctx.dispose();
    removeTemp(r.dir);
  }
});

function fakeRepoLocator(): RepoLocator {
  return {
    all: () => [],
    forPath: () => undefined,
    active: () => undefined,
    onDidChange: () => new vscode.Disposable(() => {}),
  };
}

test("Close with nothing unsaved just closes the tab — nothing to revert", async () => {
  const provider = new MergeEditorProvider(host(fakeRepoLocator()), noIde);
  const doc = {
    uri: vscode.Uri.file("/r/a.txt"),
    getText: () => "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n",
    lineCount: 6,
    isDirty: false,
    save: async () => {
      throw new Error("never saved");
    },
  };
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel, {} as vscode.CancellationToken);
  stub.panels[0].receive({ type: "cancel", mode: "exit" });
  await settle();
  assert.deepEqual(stub.commands, [], "no revert, no openWith");
  assert.equal(stub.panels[0].disposed, true);
});

test("Close never reverts ANOTHER editor: when this one cannot be made the active one, the document gets the file's own bytes back instead", async () => {
  // "Revert and Close" acts on whatever editor is active. Should the merge
  // editor not be (and not become so), reverting would throw away another
  // file's unsaved work.
  const provider = new MergeEditorProvider(host(fakeRepoLocator()), noIde);
  const onDisk = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n";
  let text = onDisk;
  const doc = {
    uri: vscode.Uri.file("/r/a.txt"),
    getText: () => text,
    get lineCount() {
      return text.split("\n").length;
    },
    isDirty: true,
    save: async () => {
      throw new Error("never saved");
    },
  };
  const fs = vscode.workspace.fs as unknown as { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
  const readFile = fs.readFile;
  fs.readFile = async () => new TextEncoder().encode(onDisk);
  try {
    const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
    (stub.panels[0] as unknown as { active: boolean }).active = false;
    await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel, {} as vscode.CancellationToken);
    text = "one\ntwo\n"; // the editor's own mirrored work, unsaved
    stub.panels[0].receive({ type: "cancel", mode: "exit" });
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    assert.equal(stub.panels[0].revealed.length, 1, "it tried to bring itself forward first");
    assert.deepEqual(stub.commands, [], "no revert: the active editor is someone else's");
    const put = stub.applied[stub.applied.length - 1]?.edits.find((e: { text?: string }) => e.text !== undefined)?.text;
    assert.equal(put, onDisk, "the document holds the file as it is on disk");
    assert.equal(stub.panels[0].disposed, true);
  } finally {
    fs.readFile = readFile;
  }
});

test("Close after an edit made OUTSIDE the editor leaves that edit to its owner: only the tab closes", async () => {
  const provider = new MergeEditorProvider(host(fakeRepoLocator()), noIde);
  let text = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n";
  const doc = {
    uri: vscode.Uri.file("/r/a.txt"),
    getText: () => text,
    get lineCount() {
      return text.split("\n").length;
    },
    isDirty: true,
    save: async () => {
      throw new Error("never saved");
    },
  };
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel, {} as vscode.CancellationToken);
  text += "typed in another tab\n";
  stub.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ text: "typed" }] });
  stub.panels[0].receive({ type: "cancel", mode: "exit" });
  await settle();
  assert.deepEqual(stub.commands, [], "a revert would throw the other tab's typing away");
  assert.equal(stub.panels[0].disposed, true);
});
