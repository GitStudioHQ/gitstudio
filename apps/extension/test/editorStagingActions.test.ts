// Stage and unstage from the code itself: the hover on a changed line and the
// opt-in CodeLens (#87, reopened), driven for real — StagedGutter and
// EditorStagingActions under the vscode stand-in, against real repositories.
//
// VS Code gives an extension's gutter mark no click and no hover (verified in
// VS Code 1.142: resting on the mark or the line number shows nothing), so the
// click lives in a hover on the changed TEXT. What is pinned here:
//   · the hover offers what the change can do, and only that;
//   · its links stage exactly what the line-number menu's toggle stages — a
//     partly staged change, an untracked file — because they run the same
//     engine (StagedGutter.setAtLine);
//   · "Stage selected lines" appears only while a selection touches the change,
//     and stages by the existing selection rule;
//   · the CodeLens is off unless asked for.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { scratchRepo, vscode } from "./changesHost";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { StagedGutter } = require("../src/changes/stagedGutter") as typeof import("../src/changes/stagedGutter");
const { EditorStagingActions, runSetChange, runSetSelectedLines } =
  require("../src/changes/editorStagingActions") as typeof import("../src/changes/editorStagingActions");
const actions = require("../src/changes/stagingActions") as typeof import("../src/changes/stagingActions");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

type Pos = { line: number; character: number };
const vs = vscode as unknown as Record<string, unknown> & { window: Record<string, unknown>; workspace: Record<string, unknown> };

// Just enough of the real classes: the stand-in answers anything, and keeps nothing.
class Range {
  start: Pos;
  end: Pos;
  constructor(sl: number, sc: number, el: number, ec: number) {
    this.start = { line: sl, character: sc };
    this.end = { line: el, character: ec };
  }
}
class MarkdownString {
  value = "";
  isTrusted: unknown;
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
}
class Hover {
  constructor(
    readonly contents: MarkdownString,
    readonly range: Range,
  ) {}
}
class CodeLens {
  constructor(
    readonly range: Range,
    readonly command: { title: string; command: string; arguments: unknown[] },
  ) {}
}
class EventEmitter {
  private listeners: (() => void)[] = [];
  event = (l: () => void) => {
    this.listeners.push(l);
    return { dispose() {} };
  };
  fire() {
    this.listeners.forEach((l) => l());
  }
  dispose() {}
}
Object.assign(vs, { Range, MarkdownString, Hover, CodeLens, EventEmitter });
const STATES = ["staged", "unstaged", "partial"] as const;
let made = 0;
vs.window.createTextEditorDecorationType = () => ({ state: STATES[made++ % 3], dispose() {} });

// Settings, as a test sets them.
const settings = new Map<string, unknown>();
vs.workspace.getConfiguration = () => ({
  get: (key: string, fallback: unknown) => (settings.has(key) ? settings.get(key) : fallback),
});
// Which document a link opens: the one the test made.
const documents = new Map<string, unknown>();
vs.workspace.openTextDocument = async (uri: { toString(): string }) => documents.get(uri.toString());
vs.Uri = { parse: (s: string) => ({ toString: () => s, scheme: "file" }), joinPath: () => ({}) };

const repos: { done: () => void }[] = [];
after(() => repos.forEach((r) => r.done()));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ok: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await sleep(25);
  }
}

/**
 * A repository whose `name` is `committed` in HEAD, `staged` in the index
 * (undefined: not added at all — an untracked file when committed is
 * undefined too) and `working` on disk; an editor on it, active.
 */
function setup(
  label: string,
  { committed, staged, working, name = "f.txt" }: { committed?: string; staged?: string; working: string; name?: string },
) {
  const r = scratchRepo(label);
  repos.push(r);
  writeFileSync(join(r.dir, "seed.txt"), "seed\n");
  r.git("add", "seed.txt");
  const file = join(r.dir, name);
  if (committed !== undefined) {
    writeFileSync(file, committed);
    r.git("add", name);
  }
  r.git("commit", "-qm", "base");
  if (staged !== undefined) {
    writeFileSync(file, staged);
    r.git("add", name);
  }
  writeFileSync(file, working);

  const key = `file://${file}`;
  const uri = { scheme: "file", fsPath: file, toString: () => key };
  const text = () => readFileSync(file, "utf8");
  const lines = () => text().split("\n");
  const document = {
    uri,
    getText: text,
    version: 1,
    get lineCount() {
      return lines().length;
    },
    lineAt: (i: number) => ({ text: lines()[i] ?? "" }),
  };
  documents.set(key, document);
  const caret = { line: 0, character: 0 };
  const editor = {
    document,
    selections: [{ start: caret, end: caret, active: caret, anchor: caret, isEmpty: true }],
    setDecorations() {},
  };
  vs.window.visibleTextEditors = [editor];
  vs.window.activeTextEditor = editor;

  const entry = { root: r.dir, ctx: new GitContext({ root: r.dir }) };
  const manager = { getAll: () => [entry], onDidChange: () => ({ dispose() {} }) };
  const gutter = new StagedGutter({ extensionUri: {} } as never, manager as never);
  const ui = new EditorStagingActions(gutter);
  return {
    r,
    gutter,
    ui,
    manager,
    document,
    key,
    /** Selects lines first..last (0-based, inclusive), as a drag over the text does. */
    select(first: number, last: number) {
      const start = { line: first, character: 0 };
      const end = { line: last, character: lines()[last].length };
      editor.selections = [{ start, end, active: end, anchor: start, isEmpty: false }];
    },
    index: () => r.git("show", `:${name}`),
    inIndex: () => r.git("ls-files", "--", name).trim() === name,
    ready: () => until(() => (gutter.blocksFor(uri as never) ?? []).length > 0, "the blocks are read"),
    hover: (line: number) => ui.hover(document as never, { line, character: 3 } as never) as unknown as Hover | undefined,
    done() {
      ui.dispose();
      gutter.dispose();
    },
  };
}

/** The hover's links: [label, command, its one argument]. */
function links(hover: Hover | undefined): [string, string, Record<string, unknown>][] {
  if (!hover) return [];
  return [...hover.contents.value.matchAll(/\[([^\]]+)\]\(command:([\w.]+)\?([^)]+)\)/g)].map((m) => [
    m[1],
    m[2],
    (JSON.parse(decodeURIComponent(m[3])) as Record<string, unknown>[])[0],
  ]);
}
const labels = (hover: Hover | undefined) => links(hover).map(([label]) => label);
/** Runs a hover link as VS Code would: the command it names, with its argument. */
async function click(t: ReturnType<typeof setup>, hover: Hover | undefined, label: RegExp): Promise<void> {
  const link = links(hover).find(([l]) => label.test(l));
  assert.ok(link, `a link matching ${label} in ${JSON.stringify(labels(hover))}`);
  const [, command, arg] = link;
  if (command === actions.SET_CHANGE_COMMAND) await runSetChange(t.gutter, arg);
  else if (command === actions.SET_SELECTED_LINES_COMMAND) await runSetSelectedLines(t.manager as never, { refresh() {} }, arg);
  else assert.fail(`unknown command ${command}`);
}

// ── the rules, without an editor ──

test("each state offers only what would do something; the line verbs only with a selection", () => {
  assert.deepEqual(actions.verbsFor("unstaged", false), ["stage"]);
  assert.deepEqual(actions.verbsFor("staged", false), ["unstage"]);
  assert.deepEqual(actions.verbsFor("partial", false), ["stage", "unstage"]);
  assert.deepEqual(actions.verbsFor("unstaged", true), ["stage", "stageLines"]);
  assert.deepEqual(actions.verbsFor("staged", true), ["unstage", "unstageLines"]);
  assert.deepEqual(actions.verbsFor("partial", true), ["stage", "unstage", "stageLines", "unstageLines"]);
});

test("a selection touches a change it overlaps; a deletion is touched on the line it sits above", () => {
  const block = (start: number, end: number) => ({ head: { start, end }, working: { start, end }, state: "unstaged" as const });
  assert.equal(actions.selectionTouches(block(4, 6), [{ start: 0, end: 3 }]), false);
  assert.equal(actions.selectionTouches(block(4, 6), [{ start: 0, end: 4 }]), true);
  assert.equal(actions.selectionTouches(block(4, 6), [{ start: 6, end: 9 }]), true);
  assert.equal(actions.selectionTouches(block(4, 6), [{ start: 7, end: 9 }]), false);
  // A deletion (zero-width working span) above line 5.
  assert.equal(actions.selectionTouches(block(5, 4), [{ start: 5, end: 5 }]), true);
  assert.equal(actions.selectionTouches(block(5, 4), [{ start: 5, end: 4 }]), true, "the boundary it sits on");
  assert.equal(actions.selectionTouches(block(5, 4), [{ start: 6, end: 8 }]), false);
});

test("a link's argument survives the trip through the markdown, and a stranger's does not run", () => {
  const { command, args } = actions.commandFor("stage", "file:///r/a b#c.ts", 7);
  const link = actions.commandLink(command, args);
  const [, id, query] = /^command:([\w.]+)\?(.*)$/.exec(link)!;
  assert.equal(id, actions.SET_CHANGE_COMMAND);
  assert.deepEqual(JSON.parse(decodeURIComponent(query)), [{ uri: "file:///r/a b#c.ts", line: 7, staged: true }]);
  assert.equal(actions.isSetChangeArgs({ uri: "x", line: -1, staged: true }), false);
  assert.equal(actions.isSetChangeArgs({ uri: "x", line: 1 }), false);
  assert.equal(actions.isSetSelectedLinesArgs({ uri: 3, staged: true }), false);
});

// ── the hover, against git ──

test("an unchanged line has no hover; an unstaged change offers Stage, and it stages exactly what the menu's toggle stages", async () => {
  const base = "a\nb\nc\nd\ne\n";
  const working = "a\nB\nc\nd\nE\n";
  const viaHover = setup("hover-stage", { committed: base, working });
  await viaHover.ready();
  assert.equal(viaHover.hover(0), undefined, "line 0 is unchanged");
  const hover = viaHover.hover(1);
  assert.deepEqual(labels(hover), ["$(add) Stage change"]);
  assert.match(hover!.contents.value, /Unstaged change/);
  assert.deepEqual(hover!.range.start, { line: 1, character: 0 }, "the hover spans the change");
  await click(viaHover, hover, /Stage change/);
  const hoverIndex = viaHover.index();
  viaHover.done();

  // The same file, staged by the line-number menu's toggle.
  const viaMenu = setup("hover-stage-menu", { committed: base, working });
  await viaMenu.ready();
  await viaMenu.gutter.toggleAtLine(viaMenu.document as never, 1);
  assert.equal(hoverIndex, viaMenu.index(), "the hover left the index as the menu does");
  assert.equal(hoverIndex, "a\nB\nc\nd\ne\n", "only line 1's change");
  viaMenu.done();
});

test("a partly staged change offers Stage the rest and Unstage; each does what it says", async () => {
  const committed = "a\nb\nc\nd\n";
  const staged = "a\nB\nc\nd\n"; // half of the change b,c → B,C staged
  const working = "a\nB\nC\nd\n";
  const t = setup("hover-partial", { committed, staged, working });
  await t.ready();
  const hover = t.hover(2);
  assert.match(hover!.contents.value, /Partly staged change/);
  assert.deepEqual(labels(hover), ["$(add) Stage the rest", "$(remove) Unstage change"]);
  await click(t, hover, /Stage the rest/);
  assert.equal(t.index(), working, "the rest is staged");
  writeFileSync(join(t.r.dir, "f.txt"), staged);
  t.r.git("add", "f.txt");
  writeFileSync(join(t.r.dir, "f.txt"), working);
  t.gutter.refreshAll();
  await until(() => t.gutter.blocksFor(t.document.uri as never)?.[0]?.state === "partial", "partly staged again");
  await click(t, t.hover(1), /Unstage change/);
  assert.equal(t.index(), committed, "what was staged is taken back");
  t.done();
});

test("a staged change offers Unstage only", async () => {
  const t = setup("hover-staged", { committed: "a\nb\n", staged: "a\nB\n", working: "a\nB\n" });
  await t.ready();
  assert.deepEqual(labels(t.hover(1)), ["$(remove) Unstage change"]);
  await click(t, t.hover(1), /Unstage/);
  assert.equal(t.index(), "a\nb\n");
  t.done();
});

test("an untracked file is one change: Stage adds it", async () => {
  const t = setup("hover-untracked", { name: "new.txt", working: "one\ntwo\n" });
  await t.ready();
  assert.equal(t.inIndex(), false);
  await click(t, t.hover(1), /Stage change/);
  assert.equal(t.inIndex(), true, "added");
  assert.equal(t.index(), "one\ntwo\n");
  t.done();
});

test("with a selection on the change, Stage selected lines stages only those lines of an insertion", async () => {
  const t = setup("hover-lines", { committed: "a\nb\n", working: "a\nX\nY\nZ\nb\n" });
  await t.ready();
  assert.deepEqual(labels(t.hover(2)), ["$(add) Stage change"], "no selection: the change only");
  t.select(2, 2); // "Y"
  assert.deepEqual(labels(t.hover(2)), ["$(add) Stage change", "Stage selected lines"]);
  await click(t, t.hover(2), /Stage selected lines/);
  assert.equal(t.index(), "a\nY\nb\n", "only the selected line of the insertion");
  t.gutter.refreshAll();
  await until(() => t.gutter.blocksFor(t.document.uri as never)?.[0]?.state === "partial", "now partly staged");
  assert.deepEqual(labels(t.hover(2)), ["$(add) Stage the rest", "$(remove) Unstage change", "Stage selected lines", "Unstage selected lines"]);
  await click(t, t.hover(2), /Unstage selected lines/);
  assert.equal(t.index(), "a\nb\n", "and only that line taken back");
  t.done();
});

test("a selection elsewhere does not offer the line verbs", async () => {
  const t = setup("hover-lines-elsewhere", { committed: "a\nb\nc\nd\n", working: "A\nb\nc\nD\n" });
  await t.ready();
  t.select(3, 3);
  assert.deepEqual(labels(t.hover(0)), ["$(add) Stage change"]);
  t.done();
});

test("the hover can be turned off; the CodeLens is off until turned on", async () => {
  const t = setup("hover-settings", { committed: "a\nb\n", working: "a\nB\n" });
  await t.ready();
  assert.deepEqual(t.ui.lenses(t.document as never), [], "no CodeLens by default");
  settings.set("staging.hoverActions", false);
  try {
    assert.equal(t.hover(1), undefined);
  } finally {
    settings.delete("staging.hoverActions");
  }
  settings.set("staging.codeLens", true);
  try {
    const lenses = t.ui.lenses(t.document as never) as unknown as CodeLens[];
    assert.deepEqual(
      lenses.map((l) => [l.range.start.line, l.command.title, l.command.command, l.command.arguments[0]]),
      [[1, "$(add) Stage change", actions.SET_CHANGE_COMMAND, { uri: t.key, line: 1, staged: true }]],
    );
  } finally {
    settings.delete("staging.codeLens");
  }
  t.done();
});

test("the marks can be off while the hover still has its changes", async () => {
  settings.set("staging.showGutterState", false);
  const t = setup("hover-no-marks", { committed: "a\nb\n", working: "a\nB\n" });
  try {
    await t.ready();
    assert.deepEqual(labels(t.hover(1)), ["$(add) Stage change"]);
  } finally {
    settings.delete("staging.showGutterState");
    t.done();
  }
});
