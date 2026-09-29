import { settle, stub, type StubPanel } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { OperationOutcome } from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import { MergeEditorProvider, saveConflictedDocuments, saveDocumentAt } from "../src/mergeEditorProvider";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";
import { view } from "./fixtures";

// The merge editor's host (mergeEditorProvider.ts): the page's whole-file and
// operation messages reach git through the session, inside the product's undo
// envelope where there is one; what goes wrong is said, never swallowed.

const MERGE_EDITOR = "cov.mergeEditor";
const CONFLICTED = "<<<<<<< HEAD\nupstream\n=======\nmine\n>>>>>>> 1a2b3c4 (mine)\n";

beforeEach(() => stub.reset());

function fakeRepo(calls: string[], over: { continueOutcome?: OperationOutcome } = {}): MergeRepo {
  const v = view("rebase", { canContinue: true });
  return {
    root: "/r",
    ctx: {
      conflictOps: {
        readSides: async (path: string) => ({
          op: v,
          path,
          shape: "text",
          hasBase: false,
          source: "git-stages",
          yours: "mine\n",
          theirs: "upstream\n",
        }),
        takeRole: async (path: string, role: string) => {
          calls.push(`takeRole:${path}:${role}`);
          return { ok: true, changed: true };
        },
        deleteFile: async (path: string) => {
          calls.push(`deleteFile:${path}`);
          return { ok: true, changed: true };
        },
        noteChoice: (path: string, choice: string) => calls.push(`note:${path}:${choice}`),
        restore: async () => ({ ok: true, changed: true }),
      },
      operation: {
        view: async () => v,
        detect: async () => ({ kind: "rebase", unmerged: 1 }),
        continue: async (o: unknown) => {
          calls.push(`continue:${JSON.stringify(o)}`);
          return over.continueOutcome ?? { ok: true, view: view("none"), remainingConflicts: 0 };
        },
        abort: async () => {
          calls.push("abort");
          return { ok: true, view: view("none"), remainingConflicts: 0 };
        },
      },
      conflict: {
        isConflicted: async () => true,
        listConflicts: async () => ["a.txt"],
      },
      process: {
        run: async (args: string[]) => {
          calls.push(`git ${args.join(" ")}`);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as MergeRepo["ctx"],
  };
}

interface Rec {
  host: MergeHostCore;
  notes: { kind: string; text: string }[];
  undo: string[];
  state: Map<string, unknown>;
}

function hostWith(repo: MergeRepo | undefined, over: Partial<MergeProduct> = {}, failStateWrites = false): Rec {
  const notes: { kind: string; text: string }[] = [];
  const undo: string[] = [];
  const state = new Map<string, unknown>();
  const locator: RepoLocator = {
    all: () => (repo ? [repo] : []),
    forPath: (p) => (repo && p.replace(/\\/g, "/").startsWith("/r/") ? repo : undefined),
    active: () => repo,
    onDidChange: () => new vscode.Disposable(() => {}),
  };
  const host: MergeHostCore = {
    context: {
      extensionUri: vscode.Uri.file("/ext"),
      globalState: {
        get: (k: string) => state.get(k),
        update: async (k: string, v: unknown) => {
          if (failStateWrites) throw new Error("storage is read-only");
          state.set(k, v);
        },
      },
    } as unknown as vscode.ExtensionContext,
    product: {
      key: "gitstudio",
      displayName: "GitStudio",
      settingsSection: "cov.merge",
      viewTypes: { mergeEditor: MERGE_EDITOR, diffView: "cov.diff", conflicts: "cov.conflicts" },
      commands: { showConflicts: "cov.showConflicts" },
      locator,
      runWithUndo: async <T,>(_r: MergeRepo, label: string, fn: () => Promise<T>) => {
        undo.push(label);
        return fn();
      },
      ...over,
    } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({ autoOpen: true, autoApplyNonConflicting: false }),
    defers: () => false,
    notify: async (kind: string, text: string) => {
      notes.push({ kind, text });
      return undefined;
    },
    changed: () => {},
  };
  return { host, notes, undo, state };
}

function documentAt(path: string, saves: boolean | Error = true) {
  let text = CONFLICTED;
  const doc = {
    uri: vscode.Uri.file(path),
    getText: () => text,
    get lineCount() {
      return text.split("\n").length;
    },
    eol: vscode.EndOfLine.LF,
    isDirty: false,
    save: async () => {
      if (saves instanceof Error) throw saves;
      return saves;
    },
    set(next: string) {
      text = next;
    },
  };
  return doc;
}

async function openEditor(rec: Rec, doc: ReturnType<typeof documentAt>): Promise<StubPanel> {
  const provider = new MergeEditorProvider(rec.host);
  const panel = vscode.window.createWebviewPanel(MERGE_EDITOR, "a.txt", vscode.ViewColumn.Active, {});
  await provider.resolveCustomTextEditor(doc as unknown as vscode.TextDocument, panel, {} as vscode.CancellationToken);
  const p = stub.panels[stub.panels.length - 1];
  p.receive({ type: "ready" });
  await settle();
  return p;
}

const sent = (p: StubPanel) => p.posted as HostMessage[];

test("Accept Theirs from the page resolves the file through git, inside the product's undo envelope", async () => {
  const calls: string[] = [];
  const rec = hostWith(fakeRepo(calls));
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  panel.receive({ type: "takeRole", role: "theirs" });
  await settle();
  assert.deepEqual(calls, ["takeRole:a.txt:theirs"]);
  assert.deepEqual(rec.undo, ["Accept Theirs"]);
  const applied = sent(panel).find((m) => m.type === "applied");
  assert.deepEqual(applied, { type: "applied", staged: true, message: undefined });
});

test("Delete the file from the page deletes it through git, also undoable", async () => {
  const calls: string[] = [];
  const rec = hostWith(fakeRepo(calls));
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  panel.receive({ type: "deleteFile" });
  await settle();
  assert.deepEqual(calls, ["deleteFile:a.txt"]);
  assert.deepEqual(rec.undo, ["Delete the conflicted file"]);
});

test("Continue from the page carries the drop confirmation to git and shows the outcome", async () => {
  const calls: string[] = [];
  const rec = hostWith(fakeRepo(calls));
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  panel.receive({ type: "continueOperation", confirmDrop: true });
  await settle();
  assert.deepEqual(calls, ['continue:{"confirmDrop":true}']);
  const outcome = sent(panel).find((m) => m.type === "outcome");
  assert.deepEqual(outcome, { type: "outcome", kind: "done", text: "Rebase complete." });
});

test("an older page's Abort saves the conflicted documents, aborts, and closes the merge editors", async () => {
  const calls: string[] = [];
  const rec = hostWith(fakeRepo(calls));
  const conflictedDoc = { uri: vscode.Uri.file("/r/a.txt"), isDirty: true, save: async () => (calls.push("save:a.txt"), true) };
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [conflictedDoc];
  const tab = { input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/r/a.txt") } };
  stub.tabGroupsAll = [{ tabs: [tab] }];
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  panel.receive({ type: "cancel", mode: "abort" });
  await settle();
  assert.deepEqual(calls, ["save:a.txt", "abort"]);
  assert.deepEqual(stub.closedTabs, [tab]);
});

test("the page's Resolve Conflicts… opens the product's dashboard", async () => {
  const rec = hostWith(fakeRepo([]));
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  panel.receive({ type: "showConflicts" });
  await settle();
  assert.deepEqual(stub.commands, [["cov.showConflicts"]]);
});

test("the sides tip's Got it is remembered for good", async () => {
  const rec = hostWith(fakeRepo([]), { sidesTip: { version: "1.0", dismissedKey: "cov.sidesTip" } });
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  const init = sent(panel).find((m) => m.type === "init") as Extract<HostMessage, { type: "init" }>;
  assert.equal(init.tip?.id, "cov.sidesTip", "the tip is on the page");
  panel.receive({ type: "dismissTip", id: "cov.sidesTip" });
  await settle();
  assert.equal(rec.state.get("cov.sidesTip"), true);
});

test("a failure while handling a page message is reported as an error", async () => {
  const rec = hostWith(fakeRepo([]), { sidesTip: { version: "1.0", dismissedKey: "cov.sidesTip" } }, true);
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  panel.receive({ type: "dismissTip", id: "cov.sidesTip" });
  await settle();
  assert.deepEqual(rec.notes, [{ kind: "error", text: "storage is read-only" }]);
});

test("a message the editor does not know changes nothing", async () => {
  const calls: string[] = [];
  const rec = hostWith(fakeRepo(calls));
  const panel = await openEditor(rec, documentAt("/r/a.txt"));
  const before = panel.posted.length;
  panel.receive({ type: "noSuchMessage" });
  await settle();
  assert.equal(panel.posted.length, before);
  assert.deepEqual(calls, []);
  assert.deepEqual(rec.notes, []);
});

test("an Apply the editor cannot save is not staged, and says so on the page and in a toast", async () => {
  const calls: string[] = [];
  const rec = hostWith(fakeRepo(calls));
  const panel = await openEditor(rec, documentAt("/r/a.txt", false));
  panel.receive({ type: "apply", text: "mine\n" });
  await settle();
  assert.ok(!calls.some((c) => c.startsWith("git add")), "git is never asked to stage an unsaved file");
  assert.deepEqual(rec.notes, [{ kind: "error", text: "couldn't save the resolved file — the editor did not save the file" }]);
  const applied = sent(panel).find((m) => m.type === "applied");
  assert.deepEqual(applied, {
    type: "applied",
    staged: false,
    message: "Couldn't save the resolved file — the editor did not save the file",
  });
  assert.equal(stub.applied.length, 1, "the Result did reach the document");
});

test("saving before a whole-file action ignores a save that fails: git overwrites the file anyway", async () => {
  const order: string[] = [];
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
    {
      uri: vscode.Uri.file("/r/a.txt"),
      isDirty: true,
      save: async () => {
        order.push("save a");
        throw new Error("disk full");
      },
    },
    { uri: vscode.Uri.file("/r/b.txt"), isDirty: true, save: async () => (order.push("save b"), true) },
    { uri: vscode.Uri.file("/r/a.txt"), isDirty: false, save: async () => (order.push("save clean"), true) },
  ];
  await saveDocumentAt(vscode.Uri.file("/r/a.txt"));
  assert.deepEqual(order, ["save a"], "only the dirty document at that path");
});

test("before an Abort, only the dirty conflicted documents are saved, and a failing save does not stop the rest", async () => {
  const order: string[] = [];
  const docs = [
    { uri: vscode.Uri.file("/r/a.txt"), isDirty: true, save: async () => { order.push("a"); throw new Error("read-only"); } },
    { uri: vscode.Uri.file("/r/sub/b.txt"), isDirty: true, save: async () => (order.push("b"), true) },
    { uri: vscode.Uri.file("/r/c.txt"), isDirty: true, save: async () => (order.push("c"), true) },
  ];
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = docs;
  const repo = { root: "/r", ctx: { conflict: { listConflicts: async () => ["a.txt", "sub/b.txt"] } } } as unknown as MergeRepo;
  await saveConflictedDocuments(repo);
  assert.deepEqual(order, ["a", "b"]);

  // git cannot list them: nothing is saved, nothing thrown.
  order.length = 0;
  const broken = {
    root: "/r",
    ctx: {
      conflict: {
        listConflicts: async () => {
          throw new Error("git is busy");
        },
      },
    },
  } as unknown as MergeRepo;
  await saveConflictedDocuments(broken);
  assert.deepEqual(order, []);
});
