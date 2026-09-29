import { settle, stub, type StubPanel } from "./support/useVscodeStub";
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { listChangeBlocks } from "@gitstudio/git-service/blockStaging";
import { DiffCommands, DiffPanel, demoDiffState, headState, twoFileState, type DiffPanelState } from "../src/diffPanel";
import { DEMO_DIFF } from "../src/demoContent";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";
import { git, mergeConflict, newRepo, removeTemp } from "./fixtures";

// The embedded 2-pane diff (diffPanel.ts): what each entry point opens, what
// the page is sent, how an edited right side is written back, how the panel
// stays live, and the staging ticks against REAL git.

type Posted = { type: string; [k: string]: unknown };

const DIFF_VIEW = "cov.diffView";

interface Recorded {
  host: MergeHostCore;
  notes: { kind: string; text: string }[];
  changed: MergeRepo[];
}

function makeHost(locator: RepoLocator, extra: Partial<MergeProduct> = {}): Recorded {
  const notes: { kind: string; text: string }[] = [];
  const changed: MergeRepo[] = [];
  const host: MergeHostCore = {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product: {
      key: "gitstudio",
      displayName: "GitStudio",
      settingsSection: "cov.merge",
      viewTypes: { mergeEditor: "cov.mergeEditor", diffView: DIFF_VIEW, conflicts: "cov.conflicts" },
      locator,
      ...extra,
    } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({ autoOpen: true, autoApplyNonConflicting: false }),
    defers: () => false,
    notify: async (kind: string, text: string) => {
      notes.push({ kind, text });
      return undefined;
    },
    changed: (r: MergeRepo) => {
      changed.push(r);
    },
  };
  return { host, notes, changed };
}

/** A locator with no repositories at all. */
const nowhere: RepoLocator = {
  all: () => [],
  forPath: () => undefined,
  active: () => undefined,
  onDidChange: () => ({ dispose() {} }),
};

/** A locator holding one repository (paths compared resolved, so any separator works). */
function locatorFor(repo: MergeRepo): RepoLocator {
  const root = resolve(repo.root);
  return {
    all: () => [repo],
    forPath: (p) => (resolve(p).startsWith(root) ? repo : undefined),
    active: () => repo,
    onDidChange: () => ({ dispose() {} }),
  };
}

/** An open text document the stub's workspace hands out. */
function openDoc(path: string, text: string) {
  let current = text;
  const doc = {
    uri: vscode.Uri.file(path),
    getText: () => current,
    get lineCount() {
      return current.split("\n").length;
    },
    set(next: string) {
      current = next;
    },
  };
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments.push(doc);
  return doc;
}

const posted = (p: StubPanel): Posted[] => p.posted as Posted[];
const ofType = (p: StubPanel, type: string): Posted[] => posted(p).filter((m) => m.type === type);

/** Wait (on setImmediate, so mocked timers do not matter) until `cond` holds. */
async function until(cond: () => boolean, what: string, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) {
    await settle(1);
  }
  assert.ok(cond(), `timed out waiting for ${what}`);
}

/** Wait on real time, for real git (generous cap). */
async function untilGit(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cond(), `timed out waiting for ${what}`);
}

const temps: string[] = [];

beforeEach(() => stub.reset());
afterEach(() => {
  // Close every panel a test opened, so DiffPanel's reuse map starts empty.
  for (const p of stub.panels) p.dispose();
  mock.timers.reset();
  for (const d of temps.splice(0)) removeTemp(d);
});

// ── State builders ───────────────────────────────────────────────────────────

test("two files: the left is read-only by name, the right is editable, both by URI", () => {
  const left = vscode.Uri.file("/w/src/old.ts");
  const right = vscode.Uri.file("/w/src/new.ts");
  assert.deepEqual(twoFileState(left, right), {
    fileName: right.fsPath,
    leftLabel: "old.ts",
    rightLabel: "new.ts",
    leftSource: "uri",
    leftUri: left.toString(),
    rightUri: right.toString(),
    rightEditable: true,
  });
});

test("a file vs HEAD names both sides after the file and reads the left from HEAD", () => {
  const uri = vscode.Uri.file("/w/app.ts");
  const s = headState(uri, { editable: false });
  assert.equal(s.leftLabel, "app.ts (HEAD)");
  assert.equal(s.rightLabel, "app.ts (Working Tree)");
  assert.equal(s.leftSource, "head");
  assert.equal(s.leftUri, uri.toString());
  assert.equal(s.rightUri, uri.toString());
  assert.equal(s.rightEditable, false);
  assert.equal(headState(uri, { editable: true }).rightEditable, true);
});

test("the sample diff is two inline texts, read-only", () => {
  const s = demoDiffState();
  assert.equal(s.leftSource, "text");
  assert.equal(s.leftText, DEMO_DIFF.leftText);
  assert.equal(s.rightText, DEMO_DIFF.rightText);
  assert.equal(s.rightEditable, false);
  assert.equal(s.rightUri, undefined);
});

// ── The sample diff ──────────────────────────────────────────────────────────

test("the sample diff opens a panel that, once ready, is sent both texts, no ticks, and its own state", async () => {
  const { host } = makeHost(nowhere);
  await new DiffCommands(host).openDemoDiff();
  assert.equal(stub.panels.length, 1);
  const panel = stub.panels[0];
  assert.equal(panel.viewType, DIFF_VIEW);
  assert.equal(panel.title, `Diff: ${DEMO_DIFF.fileName}`);
  assert.equal(panel.htmlSets, 1, "the page is loaded once");
  panel.receive({ type: "ready" });
  await until(() => ofType(panel, "persistState").length === 1, "the init messages");
  const [init] = ofType(panel, "diffInit");
  assert.equal(init.leftText, DEMO_DIFF.leftText);
  assert.equal(init.rightText, DEMO_DIFF.rightText);
  assert.equal(init.leftLabel, DEMO_DIFF.leftLabel);
  assert.equal(init.rightEditable, false);
  assert.deepEqual(ofType(panel, "stagingState"), [{ type: "stagingState", indexText: undefined }], "inline text has nothing to stage");
  assert.deepEqual((ofType(panel, "persistState")[0].state as DiffPanelState).leftSource, "text");
  assert.deepEqual(
    posted(panel).map((m) => m.type),
    ["diffInit", "stagingState", "persistState"],
  );
});

test("inline-text diffs have no identity: a second sample opens a second panel", async () => {
  const { host } = makeHost(nowhere);
  const diffs = new DiffCommands(host);
  await diffs.openDemoDiff();
  await diffs.openDemoDiff();
  assert.equal(stub.panels.length, 2);
  assert.equal(stub.panels[0].revealed.length, 0);
});

test("messages the panel does not know are ignored", async () => {
  const { host } = makeHost(nowhere);
  await new DiffCommands(host).openDemoDiff();
  const panel = stub.panels[0];
  panel.receive({ type: "somethingElse" });
  panel.receive(undefined);
  await settle();
  assert.deepEqual(panel.posted, []);
});

// ── Two files ────────────────────────────────────────────────────────────────

test("two selected files diff each other, read from their open documents (unsaved edits included)", async () => {
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "left text\n");
  const right = openDoc("/w/b.txt", "right text\n");
  await new DiffCommands(host).openDiff(undefined, [left.uri, { resourceUri: right.uri }]);
  const panel = stub.panels[0];
  assert.equal(panel.title, "Diff: b.txt");
  panel.receive({ type: "ready" });
  await until(() => ofType(panel, "diffInit").length === 1, "diffInit");
  const [init] = ofType(panel, "diffInit");
  assert.equal(init.leftText, "left text\n");
  assert.equal(init.rightText, "right text\n");
  assert.equal(init.leftLabel, "a.txt");
  assert.equal(init.rightLabel, "b.txt");
  assert.equal(init.rightEditable, true);
});

test("the same two files again reveal the open panel and re-send it, instead of opening another", async () => {
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "R\n");
  const diffs = new DiffCommands(host);
  await diffs.compare(undefined, [left.uri, right.uri]);
  right.set("R2\n");
  await diffs.openDiff(undefined, [left.uri, right.uri]);
  assert.equal(stub.panels.length, 1, "one panel");
  const panel = stub.panels[0];
  assert.equal(panel.revealed.length, 1, "revealed");
  await until(() => ofType(panel, "diffInit").length === 1, "the re-sent init");
  assert.equal(ofType(panel, "diffInit")[0].rightText, "R2\n", "with the file as it is now");
});

test("once closed, the same diff opens a fresh panel", async () => {
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "R\n");
  const diffs = new DiffCommands(host);
  await diffs.openDiff(undefined, [left.uri, right.uri]);
  stub.panels[0].dispose();
  await diffs.openDiff(undefined, [left.uri, right.uri]);
  assert.equal(stub.panels.length, 2);
  assert.equal(stub.panels[0].revealed.length, 0);
  assert.equal(stub.panels[1].disposed, false);
});

test("an edited right side is written back over the whole file; the same text writes nothing", async () => {
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "one\ntwo\n");
  await new DiffCommands(host).openDiff(undefined, [left.uri, right.uri]);
  const panel = stub.panels[0];
  panel.receive({ type: "diffChanged", text: "one\ntwo\n" });
  await settle();
  assert.equal(stub.applied.length, 0, "unchanged text: no edit");
  panel.receive({ type: "diffChanged", text: "one\nTWO\n" });
  await until(() => stub.applied.length === 1, "the write-back");
  const edit = stub.applied[0].edits[0] as { uri: vscode.Uri; text: string; range: vscode.Range };
  assert.equal(edit.uri.toString(), right.uri.toString(), "into the right file");
  assert.equal(edit.text, "one\nTWO\n");
  assert.deepEqual([edit.range.start.line, edit.range.start.character], [0, 0]);
  assert.deepEqual([edit.range.end.line, edit.range.end.character], [3, 0], "to the end of the document");
});

test("a read-only right side is never written", async () => {
  const { host } = makeHost(nowhere);
  await new DiffCommands(host).openDemoDiff();
  stub.panels[0].receive({ type: "diffChanged", text: "edited" });
  await settle();
  assert.equal(stub.applied.length, 0);
});

test("a file that cannot be read says so instead of leaving the page blank", async () => {
  const { host, notes } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  // b.txt is neither open nor readable by the stub's openTextDocument.
  await new DiffCommands(host).openDiff(undefined, [left.uri, vscode.Uri.file("/w/b.txt")]);
  const panel = stub.panels[0];
  panel.receive({ type: "ready" });
  await until(() => notes.length === 1, "the error");
  assert.equal(notes[0].kind, "error");
  assert.match(notes[0].text, /^couldn't load the diff — no document for file:\/\/\/w\/b\.txt/);
  assert.equal(ofType(panel, "diffInit").length, 0);
});

// ── Live refresh (timers mocked: the 250 ms debounce is ticked, never slept) ──

test("an edit to either watched file re-sends the diff once, after the debounce", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "R\n");
  await new DiffCommands(host).openDiff(undefined, [left.uri, right.uri]);
  const panel = stub.panels[0];
  const change = (doc: { uri: vscode.Uri }, n = 1) =>
    stub.onDidChangeTextDocument.fire({ document: doc, contentChanges: Array(n).fill({}) });

  change(left);
  right.set("R changed\n");
  change(right);
  mock.timers.tick(249);
  await settle();
  assert.equal(ofType(panel, "diffInit").length, 0, "not before the debounce");
  mock.timers.tick(1);
  await until(() => ofType(panel, "diffInit").length === 1, "the refresh");
  assert.equal(ofType(panel, "diffInit")[0].rightText, "R changed\n");
  mock.timers.tick(1000);
  await settle();
  assert.equal(ofType(panel, "diffInit").length, 1, "two edits, one refresh");
});

test("no refresh for another file, or for an event with no content change", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "R\n");
  const other = openDoc("/w/c.txt", "C\n");
  await new DiffCommands(host).openDiff(undefined, [left.uri, right.uri]);
  const panel = stub.panels[0];
  stub.onDidChangeTextDocument.fire({ document: other, contentChanges: [{}] });
  stub.onDidChangeTextDocument.fire({ document: right, contentChanges: [] });
  mock.timers.tick(1000);
  await settle();
  assert.equal(ofType(panel, "diffInit").length, 0);
});

test("the panel's own write-back is not bounced back to it as a refresh", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "R\n");
  await new DiffCommands(host).openDiff(undefined, [left.uri, right.uri]);
  const panel = stub.panels[0];
  const ws = vscode.workspace as unknown as { applyEdit: (e: unknown) => Promise<boolean> };
  const original = ws.applyEdit;
  // VS Code fires the document change while the edit is being applied.
  ws.applyEdit = async (e) => {
    right.set("R edited\n");
    stub.onDidChangeTextDocument.fire({ document: right, contentChanges: [{}] });
    return original(e);
  };
  try {
    panel.receive({ type: "diffChanged", text: "R edited\n" });
    await until(() => stub.applied.length === 1, "the write-back");
    mock.timers.tick(1000);
    await settle();
    assert.equal(ofType(panel, "diffInit").length, 0, "the page already shows that text");
    // …while an edit made afterwards, elsewhere, still refreshes.
    stub.onDidChangeTextDocument.fire({ document: right, contentChanges: [{}] });
    mock.timers.tick(250);
    await until(() => ofType(panel, "diffInit").length === 1, "the later refresh");
  } finally {
    ws.applyEdit = original;
  }
});

test("closing the panel cancels a pending refresh and stops watching", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { host } = makeHost(nowhere);
  const left = openDoc("/w/a.txt", "L\n");
  const right = openDoc("/w/b.txt", "R\n");
  await new DiffCommands(host).openDiff(undefined, [left.uri, right.uri]);
  const panel = stub.panels[0];
  stub.onDidChangeTextDocument.fire({ document: right, contentChanges: [{}] });
  panel.dispose();
  mock.timers.tick(1000);
  stub.onDidChangeTextDocument.fire({ document: right, contentChanges: [{}] });
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(panel.posted, []);
  panel.receive({ type: "ready" });
  await settle();
  assert.deepEqual(panel.posted, [], "a closed panel sends nothing");
});

// ── Restore after reload ─────────────────────────────────────────────────────

test("after a reload, a panel with saved state is rebuilt from it; one without is closed", async () => {
  const w = vscode.window as unknown as {
    registerWebviewPanelSerializer: (viewType: string, s: unknown) => vscode.Disposable;
  };
  const original = w.registerWebviewPanelSerializer;
  const seen: { viewType: string; s: { deserializeWebviewPanel(p: unknown, st: unknown): Promise<void> } }[] = [];
  w.registerWebviewPanelSerializer = (viewType, s) => {
    seen.push({ viewType, s: s as (typeof seen)[number]["s"] });
    return new vscode.Disposable(() => {});
  };
  try {
    const { host } = makeHost(nowhere);
    DiffPanel.register(host).dispose();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].viewType, DIFF_VIEW);

    const empty = vscode.window.createWebviewPanel(DIFF_VIEW, "x", vscode.ViewColumn.Active, {});
    await seen[0].s.deserializeWebviewPanel(empty, undefined);
    assert.equal(stub.panels[0].disposed, true, "nothing to restore: closed");

    const restored = vscode.window.createWebviewPanel(DIFF_VIEW, "x", vscode.ViewColumn.Active, {});
    await seen[0].s.deserializeWebviewPanel(restored, demoDiffState());
    const panel = stub.panels[1];
    assert.equal(panel.disposed, false);
    assert.equal(panel.title, `Diff: ${DEMO_DIFF.fileName}`);
    assert.equal(panel.htmlSets, 1);
    panel.receive({ type: "ready" });
    await until(() => ofType(panel, "diffInit").length === 1, "the restored diff");
    assert.equal(ofType(panel, "diffInit")[0].rightText, DEMO_DIFF.rightText);
  } finally {
    w.registerWebviewPanelSerializer = original;
  }
});

// ── Entry points that need a file ────────────────────────────────────────────

test("Open Changes with no file asks for one", async () => {
  const { host, notes } = makeHost(nowhere);
  await new DiffCommands(host).openChanges();
  assert.deepEqual(notes, [{ kind: "warn", text: "open a file to compare it against HEAD." }]);
  assert.equal(stub.panels.length, 0);
});

test("Open Changes goes to the product's own diff when it has one, with the active editor's file", async () => {
  const opened: string[] = [];
  const { host } = makeHost(nowhere, {
    openChangesEmbedded: async (uri: vscode.Uri) => {
      opened.push(uri.toString());
    },
  });
  const doc = openDoc("/w/active.ts", "x");
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = { document: doc };
  await new DiffCommands(host).openChanges();
  assert.deepEqual(opened, [doc.uri.toString()]);
  assert.equal(stub.panels.length, 0);
});

test("a file outside every repository has no HEAD: said by name, nothing opened", async () => {
  const { host, notes } = makeHost(nowhere);
  const diffs = new DiffCommands(host);
  await diffs.openChanges(vscode.Uri.file("/w/loose.txt"));
  await diffs.openDiff(vscode.Uri.file("/w/loose.txt"));
  assert.deepEqual(notes, [
    { kind: "warn", text: "loose.txt is not in an open Git repository, so it has no HEAD version." },
    { kind: "warn", text: "loose.txt is not in an open Git repository, so it has no HEAD version." },
  ]);
  assert.equal(stub.panels.length, 0);
});

test("Open in Embedded Diff and Compare with nothing to compare ask for a file", async () => {
  const { host, notes } = makeHost(nowhere);
  const diffs = new DiffCommands(host);
  await diffs.openDiff();
  await diffs.compare(undefined, []);
  assert.deepEqual(
    notes.map((n) => n.text),
    ["open a file or select two files to compare.", "open a file or select two files to compare."],
  );
});

test("Compare with one file hands it to the product's own single-file compare", async () => {
  const asked: string[] = [];
  const { host } = makeHost(nowhere, {
    compareSingle: async (uri: vscode.Uri) => {
      asked.push(uri.toString());
    },
  });
  const uri = vscode.Uri.file("/w/one.ts");
  await new DiffCommands(host).compare(undefined, [uri]);
  assert.deepEqual(asked, [uri.toString()], "the only selected file");
  assert.equal(stub.panels.length, 0);
});

test("Compare with two files diffs them even when the product has its own single-file compare", async () => {
  let asked = 0;
  const { host } = makeHost(nowhere, {
    compareSingle: async () => {
      asked++;
    },
  });
  openDoc("/w/a.txt", "a");
  openDoc("/w/b.txt", "b");
  await new DiffCommands(host).compare(vscode.Uri.file("/w/a.txt"), [vscode.Uri.file("/w/a.txt"), vscode.Uri.file("/w/b.txt")]);
  assert.equal(asked, 0);
  assert.equal(stub.panels.length, 1);
  assert.equal(stub.panels[0].title, "Diff: b.txt");
});

test("staging with ticks needs a file in a Git repository", async () => {
  const { host, notes } = makeHost(nowhere);
  const diffs = new DiffCommands(host);
  await diffs.stageWithTicks();
  await diffs.stageWithTicks(vscode.Uri.parse("untitled://Untitled-1"));
  await diffs.stageWithTicks(vscode.Uri.file("/w/loose.txt"));
  assert.equal(notes.length, 3);
  for (const n of notes) assert.deepEqual(n, { kind: "info", text: "open a file in a Git repository to stage its changes." });
  assert.equal(stub.panels.length, 0);
});

// ── REAL git: HEAD on the left, ticks ────────────────────────────────────────

function committedRepo(): { dir: string; repo: string; file: string; uri: vscode.Uri; mr: MergeRepo } {
  const r = newRepo("diffpanel");
  temps.push(r.dir);
  const file = join(r.repo, "a.txt");
  writeFileSync(file, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  git(r.repo, "add", "a.txt");
  git(r.repo, "commit", "-m", "base");
  // Two separate changes, far enough apart to be two blocks.
  writeFileSync(file, "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  const mr: MergeRepo = { root: r.repo, ctx: new GitContext({ root: r.repo }) };
  return { ...r, file, uri: vscode.Uri.file(file), mr };
}

/** The engine's 0-based inclusive range as the page's 1-based end-exclusive span. */
const span = (r: { start: number; end: number }) => ({ start: r.start + 1, end: r.end + 2 });

test("REAL git: Open Changes shows HEAD on the left and the working file, editable, on the right, with the index for ticks", async () => {
  const r = committedRepo();
  const { host } = makeHost(locatorFor(r.mr));
  openDoc(r.file, readFileSync(r.file, "utf8"));
  await new DiffCommands(host).openChanges(r.uri);
  const panel = stub.panels[0];
  assert.equal(panel.title, "Diff: a.txt");
  panel.receive({ type: "ready" });
  await untilGit(() => ofType(panel, "persistState").length === 1, "the init messages");
  const [init] = ofType(panel, "diffInit");
  assert.equal(init.leftText, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n", "HEAD");
  assert.equal(init.rightText, "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n", "the working file");
  assert.equal(init.rightEditable, true);
  assert.equal(ofType(panel, "stagingState")[0].indexText, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n", "nothing staged yet");
});

test("REAL git: ticking one change stages exactly that change, and the page is told what git now holds", async () => {
  const r = committedRepo();
  const { host, changed } = makeHost(locatorFor(r.mr));
  const doc = openDoc(r.file, readFileSync(r.file, "utf8"));
  await new DiffCommands(host).stageWithTicks({ resourceUri: r.uri });
  const panel = stub.panels[0];
  panel.receive({ type: "ready" });
  await untilGit(() => ofType(panel, "persistState").length === 1, "the init messages");
  const init = ofType(panel, "diffInit")[0];
  assert.equal(init.rightEditable, false, "the tick page is read-only");

  const blocks = await listChangeBlocks(r.mr.ctx, "a.txt", doc.getText());
  assert.equal(blocks.length, 2);
  const first = blocks[0];
  panel.receive({
    type: "toggleTick",
    block: { head: span(first.head), working: span(first.working), state: first.state },
    staged: true,
  });
  await untilGit(() => ofType(panel, "stagingState").length === 2, "the new index");
  assert.equal(git(r.repo, "show", ":a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n", "only the first change is staged");
  assert.equal(ofType(panel, "stagingState")[1].indexText, "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  assert.deepEqual(changed, [r.mr], "the product hears the repository changed");

  // And back: unticking it leaves the index as HEAD again.
  panel.receive({
    type: "toggleTick",
    block: { head: span(first.head), working: span(first.working), state: "staged" },
    staged: false,
  });
  await untilGit(() => ofType(panel, "stagingState").length === 3, "the index after unstaging");
  assert.equal(git(r.repo, "show", ":a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
});

test("REAL git: a tick for a change that is no longer there is refused in the status bar, and the index is untouched", async () => {
  const r = committedRepo();
  const { host } = makeHost(locatorFor(r.mr));
  openDoc(r.file, readFileSync(r.file, "utf8"));
  await new DiffCommands(host).stageWithTicks(r.uri);
  const panel = stub.panels[0];
  panel.receive({
    type: "toggleTick",
    block: { head: { start: 3, end: 4 }, working: { start: 3, end: 4 }, state: "unstaged" },
    staged: true,
  });
  await untilGit(() => ofType(panel, "stagingState").length === 1, "the index re-read");
  assert.equal(stub.statusMessages.length, 1);
  assert.match(stub.statusMessages[0], /^\$\(info\) GitStudio: That change is no longer there/);
  assert.equal(git(r.repo, "show", ":a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
});

test("REAL git: a tick whose file cannot be read reports the error and still re-reads the index", async () => {
  const r = committedRepo();
  const { host, notes } = makeHost(locatorFor(r.mr));
  // The file is not open, and the stub cannot open it: openTextDocument throws.
  await new DiffCommands(host).stageWithTicks(r.uri);
  const panel = stub.panels[0];
  panel.receive({
    type: "toggleTick",
    block: { head: { start: 1, end: 2 }, working: { start: 1, end: 2 }, state: "unstaged" },
    staged: true,
  });
  await untilGit(() => ofType(panel, "stagingState").length === 1, "the index re-read");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "error");
  assert.match(notes[0].text, /^couldn't stage that change — no document for /);
  assert.equal(ofType(panel, "stagingState")[0].indexText, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
});

test("REAL git: a conflicted file gets no ticks — they would confidently lie", async () => {
  const r = mergeConflict();
  temps.push(r.dir);
  const file = join(r.repo, "a.txt");
  const mr: MergeRepo = { root: r.repo, ctx: new GitContext({ root: r.repo }) };
  const { host } = makeHost(locatorFor(mr));
  openDoc(file, readFileSync(file, "utf8"));
  await new DiffCommands(host).stageWithTicks(vscode.Uri.file(file));
  const panel = stub.panels[0];
  panel.receive({ type: "ready" });
  await untilGit(() => ofType(panel, "persistState").length === 1, "the init messages");
  assert.equal(ofType(panel, "diffInit")[0].leftText, "one\ntwo\nthree-master\nfour\n", "HEAD is master's side");
  assert.deepEqual(ofType(panel, "stagingState"), [{ type: "stagingState", indexText: undefined }]);
});

// ── Restored states and races, against a stand-in repository ─────────────────

/** A repository whose index and HEAD reads the test controls. */
function fakeRepo(over: { indexContent?: () => Promise<string>; headContent?: () => Promise<string>; conflicted?: boolean } = {}) {
  const repo: MergeRepo = {
    root: "/g",
    ctx: {
      conflict: {
        getHeadVersion: async () => "head\n",
        isConflicted: async () => over.conflicted ?? false,
      },
      staging: {
        indexContent: over.indexContent ?? (async () => "index\n"),
        headContent: over.headContent ?? (async () => "head\n"),
        stageContent: async () => ({ ok: true, stderr: "" }),
        unstageFile: async () => ({ ok: true, stderr: "" }),
      },
    } as unknown as MergeRepo["ctx"],
  };
  return repo;
}

/** Capture the serializer DiffPanel.register hands VS Code. */
function captureSerializer(host: MergeHostCore) {
  const w = vscode.window as unknown as {
    registerWebviewPanelSerializer: (viewType: string, s: unknown) => vscode.Disposable;
  };
  const original = w.registerWebviewPanelSerializer;
  let serializer: { deserializeWebviewPanel(p: unknown, st: unknown): Promise<void> } | undefined;
  w.registerWebviewPanelSerializer = (_viewType, s) => {
    serializer = s as typeof serializer;
    return new vscode.Disposable(() => {});
  };
  try {
    DiffPanel.register(host);
  } finally {
    w.registerWebviewPanelSerializer = original;
  }
  return async (state: unknown): Promise<StubPanel> => {
    const panel = vscode.window.createWebviewPanel(DIFF_VIEW, "x", vscode.ViewColumn.Active, {});
    await serializer!.deserializeWebviewPanel(panel, state);
    return stub.panels[stub.panels.length - 1];
  };
}

test("a restored HEAD diff that lost its file reads HEAD as empty; an unknown left side too", async () => {
  const { host } = makeHost(nowhere);
  const restore = captureSerializer(host);
  const noFile = await restore({ fileName: "x.ts", leftLabel: "L", rightLabel: "R", rightEditable: false, leftSource: "head", rightText: "r" });
  const unknown = await restore({ fileName: "y.ts", leftLabel: "L", rightLabel: "R", rightEditable: false, leftSource: "someday", leftText: "l", rightText: "r" });
  for (const panel of [noFile, unknown]) {
    panel.receive({ type: "ready" });
    await until(() => ofType(panel, "diffInit").length === 1, "the restored diff");
    assert.equal(ofType(panel, "diffInit")[0].leftText, "");
    assert.equal(ofType(panel, "diffInit")[0].rightText, "r");
    assert.equal(ofType(panel, "stagingState")[0].indexText, undefined);
  }
});

test("a restored HEAD diff whose file is no longer in an open repository has an empty HEAD and no ticks", async () => {
  const { host } = makeHost(nowhere);
  const restore = captureSerializer(host);
  const doc = openDoc("/g/a.txt", "work\n");
  const panel = await restore(headState(doc.uri, { editable: false }));
  panel.receive({ type: "ready" });
  await until(() => ofType(panel, "stagingState").length === 1, "the init messages");
  assert.equal(ofType(panel, "diffInit")[0].leftText, "");
  assert.equal(ofType(panel, "stagingState")[0].indexText, undefined);
  // …and a tick there does nothing.
  panel.receive({ type: "toggleTick", block: { head: { start: 1, end: 2 }, working: { start: 1, end: 2 }, state: "unstaged" }, staged: true });
  await settle();
  assert.equal(ofType(panel, "stagingState").length, 1);
});

test("an index git cannot read means no ticks, not a broken page", async () => {
  const repo = fakeRepo({
    indexContent: async () => {
      throw new Error("index.lock");
    },
  });
  const { host } = makeHost(locatorFor(repo));
  openDoc("/g/a.txt", "work\n");
  await new DiffCommands(host).stageWithTicks(vscode.Uri.file("/g/a.txt"));
  const panel = stub.panels[0];
  panel.receive({ type: "ready" });
  await until(() => ofType(panel, "persistState").length === 1, "the init messages");
  assert.equal(ofType(panel, "diffInit")[0].leftText, "head\n");
  assert.equal(ofType(panel, "stagingState")[0].indexText, undefined);
});

test("a tick on a page with no working file (the sample) does nothing", async () => {
  const { host } = makeHost(nowhere);
  await new DiffCommands(host).openDemoDiff();
  const panel = stub.panels[0];
  panel.receive({ type: "toggleTick", block: { head: { start: 1, end: 2 }, working: { start: 1, end: 2 }, state: "unstaged" }, staged: true });
  await settle();
  assert.deepEqual(panel.posted, []);
});

test("a panel closed while its files are being read sends nothing", async () => {
  const { host } = makeHost(nowhere);
  const ws = vscode.workspace as unknown as { openTextDocument: (u: vscode.Uri) => Promise<unknown> };
  const original = ws.openTextDocument;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  ws.openTextDocument = async (u) => {
    asked++;
    await gate;
    return { uri: u, getText: () => "late\n", lineCount: 2 };
  };
  try {
    await new DiffCommands(host).openDiff(undefined, [vscode.Uri.file("/w/a.txt"), vscode.Uri.file("/w/b.txt")]);
    const panel = stub.panels[0];
    panel.receive({ type: "ready" });
    await until(() => asked === 1, "the read to start");
    panel.dispose();
    release();
    await settle();
    assert.deepEqual(panel.posted, []);
  } finally {
    ws.openTextDocument = original;
  }
});

test("a panel closed while a tick is being staged is not sent the new index", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reading = 0;
  const repo = fakeRepo({
    headContent: async () => {
      reading++;
      await gate;
      return "head\n";
    },
  });
  const { host, changed } = makeHost(locatorFor(repo));
  openDoc("/g/a.txt", "work\n");
  await new DiffCommands(host).stageWithTicks(vscode.Uri.file("/g/a.txt"));
  const panel = stub.panels[0];
  panel.receive({ type: "toggleTick", block: { head: { start: 1, end: 2 }, working: { start: 1, end: 2 }, state: "unstaged" }, staged: true });
  await until(() => reading === 1, "git to be asked");
  panel.dispose();
  release();
  await until(() => changed.length === 1, "the repository change to be reported");
  await settle();
  assert.deepEqual(panel.posted, []);
});
