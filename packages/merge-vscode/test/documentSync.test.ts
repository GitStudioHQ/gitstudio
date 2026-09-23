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

// POLISH A1.1–A1.3 in the merge editor's HOST: what reaches the file's
// document before Apply (every open conflict still marked), a file resolved
// before the editor opened is not written over, and an edit made elsewhere is
// not overwritten without asking.

beforeEach(() => stub.reset());

const L = (...l: string[]) => l.join("\n") + "\n";
const BASE = L("a", "b1", "c", "d", "e2", "f");
const YOURS = L("a", "B1-yours", "c", "d", "E2-yours", "f");
const THEIRS = L("a", "B1-theirs", "c", "d", "E2-theirs", "f");
const GIT_FILE = L(
  "a",
  "<<<<<<< HEAD", "B1-yours", "||||||| base", "b1", "=======", "B1-theirs", ">>>>>>> feature",
  "c",
  "d",
  "<<<<<<< HEAD", "E2-yours", "||||||| base", "e2", "=======", "E2-theirs", ">>>>>>> feature",
  "f",
);

interface Rig {
  provider: MergeEditorProvider;
  document: vscode.TextDocument & { set(text: string): void };
  asked: string[];
  notes: { kind: string; text: string }[];
  saved: string[];
  answer: { value: boolean };
}

function rig(working: string): Rig {
  const asked: string[] = [];
  const notes: { kind: string; text: string }[] = [];
  const saved: string[] = [];
  const answer = { value: false };
  const repo = {
    root: "/r",
    ctx: {
      conflictOps: {
        readSides: async (path: string) => ({
          op: view("merge"),
          path,
          shape: "text",
          hasBase: true,
          source: "git-stages",
          base: BASE,
          yours: YOURS,
          theirs: THEIRS,
        }),
        noteChoice: () => {},
      },
      conflict: { isConflicted: async () => true },
      operation: {
        view: async () => view("merge"),
        detect: async () => ({ kind: "merge", unmerged: 0 }),
      },
      process: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    },
  } as unknown as MergeRepo;
  const locator: RepoLocator = {
    all: () => [repo],
    forPath: () => repo,
    active: () => repo,
    onDidChange: () => new vscode.Disposable(() => {}),
  };
  const host: MergeHostCore = {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product: {
      key: "gitstudio",
      displayName: "GitStudio",
      settingsSection: "test.merge",
      viewTypes: { mergeEditor: "test.mergeEditor", diffView: "test.diff", conflicts: "test.conflicts" },
      locator,
      ask: async (spec: { title: string }) => {
        asked.push(spec.title);
        return answer.value;
      },
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
    notify: async (kind: string, text: string) => {
      notes.push({ kind, text });
      return undefined;
    },
    changed: () => {},
  };
  const noIde = { detect: async () => undefined, cachedName: () => undefined } as unknown as JetBrainsUi;
  let text = working;
  const document = {
    uri: vscode.Uri.file("/r/app.txt"),
    getText: () => text,
    get lineCount() {
      return text.split("\n").length;
    },
    eol: 1,
    isDirty: false,
    save: async () => {
      saved.push(text);
      return true;
    },
    set(next: string) {
      text = next;
    },
  } as unknown as vscode.TextDocument & { set(text: string): void };
  return { provider: new MergeEditorProvider(host, noIde), document, asked, notes, saved, answer };
}

async function open(r: Rig): Promise<void> {
  const panel = vscode.window.createWebviewPanel("test.mergeEditor", "app.txt", vscode.ViewColumn.Active, {});
  await r.provider.resolveCustomTextEditor(r.document, panel, {} as vscode.CancellationToken);
  stub.panels[0].receive({ type: "ready" });
  await settle();
}

/** What the last WorkspaceEdit put in the document (and put it there, as VS Code would). */
function lastWrite(r: Rig): string | undefined {
  const edit = stub.applied[stub.applied.length - 1];
  const text = edit?.edits.find((e) => e.text !== undefined)?.text;
  if (text !== undefined) r.document.set(text);
  return text;
}

const markerBlocks = (text: string) => (text.match(/^<{7} /gm) ?? []).length;

test("A1.1: one accept, and the conflict still open stays MARKED in the document autosave writes", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  const written = lastWrite(r);
  assert.ok(written, "the accept reached the document");
  assert.equal(markerBlocks(written!), 1, "exactly one conflict still marked");
  assert.match(written!, /<<<<<<< Yours \(master\)\nE2-yours\n\|{7} Base\ne2\n=======\nE2-theirs\n>>>>>>> Theirs \(feature\)/);
  assert.match(written!, /^a\nB1-yours\nc\n/, "the settled one is written as settled");
});

test("A1.1: opening the editor (a Result that settles nothing) leaves the document untouched", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "resultChanged", text: BASE });
  await settle();
  assert.equal(stub.applied.length, 0, "no edit, so the file is not dirty and autosave has nothing to write");
});

test("A1.2: a file already resolved by hand is not written over by a Result that starts from the conflict", async () => {
  const hand = L("a", "B1 by hand", "c", "d", "E2 by hand", "f");
  const r = rig(hand);
  await open(r);
  assert.ok(r.notes.some((n) => n.kind === "warn" && /already resolved/.test(n.text)), "the user is told once");
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  assert.equal(stub.applied.length, 0, "the resolution in the file stays");
  r.answer.value = false;
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-yours", "c", "d", "E2-theirs", "f") });
  await settle();
  assert.deepEqual(r.asked, ["Replace the resolution already in app.txt?"]);
  assert.equal(r.saved.length, 0, "No writes nothing");
  const outcome = stub.panels[0].posted.find((m) => (m as HostMessage).type === "outcome") as Extract<HostMessage, { type: "outcome" }>;
  assert.equal(outcome?.kind, "failed");
  assert.match(outcome.text, /keeps the resolution/);
});

test("A1.3: an edit made outside the merge editor is not written over without asking — and No keeps it", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  // Another tab types into the same file.
  r.document.set(GIT_FILE.replace("f\n", "f\ntyped elsewhere\n"));
  stub.onDidChangeTextDocument.fire({ document: r.document, contentChanges: [{ text: "typed elsewhere" }] });
  r.answer.value = false;
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  assert.deepEqual(r.asked, ["app.txt changed outside the merge editor"]);
  assert.equal(stub.applied.length, 0, "kept");
  assert.match(r.document.getText(), /typed elsewhere/);
  // Kept means the editor stops writing, without asking on every click...
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-theirs", "c", "d", "e2", "f") });
  await settle();
  assert.equal(r.asked.length, 1);
  assert.equal(stub.applied.length, 0);
  // ...until Apply, which asks again.
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-theirs", "c", "d", "E2-yours", "f") });
  await settle();
  assert.equal(r.asked.length, 2);
  assert.equal(r.saved.length, 0);
});

test("A1.3: the editor's own writes, and VS Code reloading the file git left, are not someone else's edit", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  lastWrite(r);
  stub.onDidChangeTextDocument.fire({ document: r.document, contentChanges: [{ text: "x" }] });
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "E2-yours", "f") });
  await settle();
  assert.deepEqual(r.asked, [], "nothing to ask about");
  assert.equal(stub.applied.length, 2);
});

test("Apply in the merge editor raises no toast over its own Apply / Continue corner", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-yours", "c", "d", "E2-theirs", "f") });
  await settle();
  assert.equal(r.saved.length, 1, "applied");
  assert.deepEqual(
    r.notes.filter((n) => /saved and staged/.test(n.text)).map((n) => n.kind),
    ["info"],
    "said once, as a status-bar line (an info with no action)",
  );
  assert.equal(stub.messages.length, 0, "no notification toast");
});
