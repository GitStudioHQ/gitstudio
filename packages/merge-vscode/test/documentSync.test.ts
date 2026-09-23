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
  notes: { kind: string; text: string; actions: string[] }[];
  saved: string[];
  answer: { value: boolean };
  restored: string[];
}

function rig(working: string): Rig {
  const asked: string[] = [];
  const notes: { kind: string; text: string; actions: string[] }[] = [];
  const saved: string[] = [];
  const restored: string[] = [];
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
        restore: async (path: string) => {
          restored.push(path);
          return { ok: true, changed: true };
        },
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
      commands: { showConflicts: "test.showConflicts" },
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
    // host.notify: an info WITH an action is a notification toast; without
    // one it is a status-bar line (host.ts).
    notify: async (kind: string, text: string, ...actions: string[]) => {
      notes.push({ kind, text, actions });
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
  return { provider: new MergeEditorProvider(host, noIde), document, asked, notes, saved, answer, restored };
}

/** Every message the page was sent, by type. */
const postedTypes = () => stub.panels[0].posted.map((m) => (m as HostMessage).type);

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

test("A1.2: a file already resolved by hand is not written over before Apply; an Apply that keeps it asks nothing, one that changes it asks", async () => {
  const hand = L("a", "B1 by hand", "c", "d", "E2 by hand", "f");
  const r = rig(hand);
  await open(r);
  // The Result starts FROM the resolution (the view seeds it) and says so in
  // place: no toast over the editor.
  assert.ok(!r.notes.some((n) => /already resolved/.test(n.text)), "no toast: the editor says it in place");
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  assert.equal(stub.applied.length, 0, "the resolution in the file stays");
  // "Apply with N unresolved" over the seeded Result writes the file's own
  // resolution back — never base — and there is nothing to replace, so nothing to ask.
  stub.panels[0].receive({ type: "apply", text: hand });
  await settle();
  assert.deepEqual(r.asked, [], "writing the resolution back asks nothing");
  assert.deepEqual(r.saved, [hand], "and saves it as it was");
});

test("A1.2: an Apply that REPLACES a resolution made by hand asks first, and No writes nothing", async () => {
  const hand = L("a", "B1 by hand", "c", "d", "E2 by hand", "f");
  const r = rig(hand);
  await open(r);
  r.answer.value = false;
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-yours", "c", "d", "E2-theirs", "f") });
  await settle();
  assert.deepEqual(r.asked, ["Replace the resolution already in app.txt?"]);
  assert.equal(r.saved.length, 0, "No writes nothing");
  const outcome = stub.panels[0].posted.find((m) => (m as HostMessage).type === "outcome") as Extract<HostMessage, { type: "outcome" }>;
  assert.equal(outcome?.kind, "failed");
  assert.match(outcome.text, /keeps the resolution/);
});

test("A1.1: a conflict with only ONE side in stays marked in the file — the page's `unsettled` text, not the Result, is what the document follows", async () => {
  // Accept Yours on B1, Theirs still to decide: the Result holds Yours' line,
  // which reads exactly like a conflict settled as Yours — and was written
  // to the file that way, markers gone, one click after opening.
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f"), unsettled: BASE });
  await settle();
  const written = stub.applied.length ? lastWrite(r) : r.document.getText();
  assert.equal(markerBlocks(written!), 2, "both conflicts are still marked in the file (" + written + ")");
  // Theirs set aside too: now it is settled, and written as settled.
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  const settled = lastWrite(r);
  assert.equal(markerBlocks(settled!), 1, "the settled one is written as settled, the other still marked");
  assert.match(settled!, /^a\nB1-yours\nc\n/);
});

test("A1.2: a file resolved PARTLY by hand keeps that resolution when the editor writes the rest", async () => {
  // One conflict settled in a text editor before the merge editor opened, one
  // still marked. The Result starts from the conflict, so the first accept
  // mirrored the hand-settled region back as markers: the resolution existed
  // nowhere else, and it was gone.
  const partly = L(
    "a",
    "B1 by hand",
    "c",
    "d",
    "<<<<<<< HEAD", "E2-yours", "||||||| base", "e2", "=======", "E2-theirs", ">>>>>>> feature",
    "f",
  );
  const r = rig(partly);
  await open(r);
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "b1", "c", "d", "E2-theirs", "f") });
  await settle();
  const written = lastWrite(r);
  assert.ok(written !== undefined, "the accept reached the document");
  assert.match(written!, /^B1 by hand$/m, "the hand resolution is still in the file");
  assert.equal(markerBlocks(written!), 0, "and the accepted conflict is settled");
  // Once the Result settles that conflict itself, the Result wins.
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-theirs", "c", "d", "E2-theirs", "f") });
  await settle();
  assert.equal(lastWrite(r), L("a", "B1-theirs", "c", "d", "E2-theirs", "f"));
});

test("A1.3: an edit made outside the merge editor is asked about IN the editor (no dialog), and nothing is written until it is answered — Keep", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  // Another tab types into the same file.
  r.document.set(GIT_FILE.replace("f\n", "f\ntyped elsewhere\n"));
  stub.onDidChangeTextDocument.fire({ document: r.document, contentChanges: [{ text: "typed elsewhere" }] });
  await settle();
  assert.equal(postedTypes().filter((t) => t === "fileChanged").length, 1, "the page is told, inline");
  assert.deepEqual(r.asked, [], "no modal question over the editor");
  // Until it is answered, nothing reaches the document…
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  assert.equal(stub.applied.length, 0, "nothing written while the question is open");
  assert.match(r.document.getText(), /typed elsewhere/);
  // …not even an Apply from an older page that did not hold Apply back.
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-theirs", "c", "d", "E2-yours", "f") });
  await settle();
  assert.equal(r.saved.length, 0, "no Apply over an unanswered question");
  // A second outside edit does not ask twice.
  r.document.set(r.document.getText() + "more\n");
  stub.onDidChangeTextDocument.fire({ document: r.document, contentChanges: [{ text: "more" }] });
  await settle();
  assert.equal(postedTypes().filter((t) => t === "fileChanged").length, 1, "asked once");
  // Keep what's here: the editor stops writing…
  stub.panels[0].receive({ type: "outsideEdit", answer: "keep" });
  await settle();
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-theirs", "c", "d", "e2", "f") });
  await settle();
  assert.equal(stub.applied.length, 0, "kept: the editor leaves the file alone");
  assert.deepEqual(r.asked, []);
  // …until Apply, which the page said replaces it.
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-theirs", "c", "d", "E2-yours", "f") });
  await settle();
  assert.equal(r.saved.length, 1, "Apply writes the Result");
});

test("A1.3: Reload the merge starts over from the file as it is now, and the editor writes again", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  const edited = GIT_FILE.replace("f\n", "f\ntyped elsewhere\n");
  r.document.set(edited);
  stub.onDidChangeTextDocument.fire({ document: r.document, contentChanges: [{ text: "typed elsewhere" }] });
  await settle();
  const inits = () => stub.panels[0].posted.filter((m) => (m as HostMessage).type === "init") as Extract<HostMessage, { type: "init" }>[];
  assert.equal(inits().length, 1);
  stub.panels[0].receive({ type: "outsideEdit", answer: "reload" });
  await settle();
  assert.equal(inits().length, 2, "a fresh init");
  assert.equal(inits()[1].result, edited, "from the file as it is now");
  stub.panels[0].receive({ type: "resultChanged", text: L("a", "B1-yours", "c", "d", "e2", "f") });
  await settle();
  assert.ok(stub.applied.length > 0, "and the editor follows the Result again");
});

test("after an Apply the page offers Undo in place: `applied{undoable}`, and undoApply brings the conflict back", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "apply", text: L("a", "B1-yours", "c", "d", "E2-theirs", "f") });
  await settle();
  const applied = stub.panels[0].posted.find((m) => (m as HostMessage).type === "applied") as Extract<HostMessage, { type: "applied" }>;
  assert.equal(applied?.staged, true);
  assert.equal(applied?.undoable, true, "the page may offer Undo");
  assert.equal(stub.messages.length, 0, "no toast carries it");
  stub.panels[0].receive({ type: "undoApply" });
  await settle();
  assert.deepEqual(r.restored, ["app.txt"], "the conflict is brought back");
  assert.equal(postedTypes().filter((t) => t === "init").length, 2, "and the editor shows it again");
  // Only once.
  stub.panels[0].receive({ type: "undoApply" });
  await settle();
  assert.deepEqual(r.restored, ["app.txt"], "a second Undo has nothing to undo");
  const last = stub.panels[0].posted[stub.panels[0].posted.length - 1] as Extract<HostMessage, { type: "outcome" }>;
  assert.equal(last.type, "outcome");
  assert.equal(last.kind, "failed");
});

test("the strip's conflicts list opens the dashboard", async () => {
  const r = rig(GIT_FILE);
  await open(r);
  stub.panels[0].receive({ type: "showConflicts" });
  await settle();
  assert.deepEqual(stub.commands.map((c) => c[0]), ["test.showConflicts"]);
  assert.equal(stub.panels[0].disposed, false, "the editor stays");
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
    r.notes.filter((n) => n.actions.length > 0 || n.kind !== "info").map((n) => [n.kind, n.text]),
    [],
    "no toast and no Undo button over the editor (the editor says it in place, with Undo beside Apply)",
  );
  assert.equal(stub.messages.length, 0, "no notification toast");
});

test("after an Apply the Result IS the file: a late resultChanged never writes markers back over it", async () => {
  // "Apply with 1 unresolved" saves the Result as shown — the open conflict as
  // its original text, by the user's choice — and stages it. The shell's
  // debounced resultChanged can land after that Apply, and any edit after it
  // posts one: the rule for an UNFINISHED merge put the conflict's markers
  // back into the document, and autosave wrote them over the file just staged.
  const r = rig(GIT_FILE);
  await open(r);
  const applied = L("a", "B1-yours", "c", "d", "e2", "f");
  stub.panels[0].receive({ type: "apply", text: applied });
  await settle();
  assert.equal(r.saved.length, 1, "applied");
  lastWrite(r);
  const before = stub.applied.length;
  stub.panels[0].receive({ type: "resultChanged", text: applied });
  await settle();
  if (stub.applied.length > before) lastWrite(r);
  assert.equal(markerBlocks(r.document.getText()), 0, "no markers over the applied file");
  assert.equal(r.document.getText(), applied);
  // An edit made after the Apply reaches the file as typed.
  const edited = L("a", "B1-yours", "c", "d edited", "e2", "f");
  stub.panels[0].receive({ type: "resultChanged", text: edited });
  await settle();
  lastWrite(r);
  assert.equal(r.document.getText(), edited);
});
