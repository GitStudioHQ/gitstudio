// The blame surface (blameController.ts) over a REAL repository: the inline
// current-line annotation and status bar item, the hover, the JetBrains-style
// annotate gutter and its settings, and the annotation's right-click actions.
// Editors and documents are small fakes over the real files on disk; `vscode`
// is graphPanel.kit.ts's recording stand-in, so each test reads what was
// painted, said, copied and opened.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as kit from "./graphPanel.kit";
import { repoChange } from "../src/git/repoChange";
import { relativeTime } from "../src/util/relativeTime";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { BlameController } = require("../src/blame/blameController") as typeof import("../src/blame/blameController");
const { EMPTY_TREE } = require("../src/history/revisionContentProvider") as typeof import("../src/history/revisionContentProvider");

const live: { dispose(): void }[] = [];
afterEach(() => {
  while (live.length) live.pop()!.dispose();
  kit.resetRecords();
  kit.settings.clear();
  kit.settingWrites.length = 0;
  kit.inspected.clear();
  kit.editors.active = undefined;
  kit.editors.visible = [];
});

// ── Fakes over real files ────────────────────────────────────────────────────

interface Doc {
  uri: ReturnType<typeof kit.Uri.file>;
  version: number;
  isDirty: boolean;
  lines: string[];
  readonly lineCount: number;
  getText(): string;
  lineAt(n: number): { range: kit.Range };
}
function doc(path: string, opts: { text?: string; scheme?: string; lineCount?: number } = {}): Doc {
  const text = opts.text ?? readFileSync(path, "utf8");
  const lines = text.replace(/\n$/, "").split("\n");
  const uri = opts.scheme ? { ...kit.Uri.file(path), scheme: opts.scheme } : kit.Uri.file(path);
  return {
    uri,
    version: 1,
    isDirty: opts.text !== undefined,
    lines,
    get lineCount() {
      return opts.lineCount ?? lines.length;
    },
    getText: () => text,
    lineAt: (n: number) => ({ range: new kit.Range(n, 0, n, (lines[n] ?? "").length) }),
  };
}
interface Editor {
  document: Doc;
  selection: kit.Selection;
  visibleRanges: kit.Range[];
  painted: Map<number, any[]>;
  setDecorations(type: { id: number }, decos: any[]): void;
}
function editor(d: Doc, line = 0): Editor {
  const e: Editor = {
    document: d,
    selection: new kit.Selection(new kit.Position(line, 0), new kit.Position(line, 0)),
    visibleRanges: [new kit.Range(0, 0, d.lineCount, 0)],
    painted: new Map(),
    setDecorations: (type, decos) => void e.painted.set(type.id, decos),
  };
  return e;
}
function focus(e: Editor | undefined): void {
  kit.editors.active = e;
  kit.editors.visible = e ? [e] : [];
}

/** Commit `body` as `file` with a fixed author date. */
function commitAt(r: kit.Repo, file: string, body: string, msg: string, date: string, author = "Test Person <t@t.t>"): string {
  r.write(file, body);
  r.git("add", "-A");
  r.git("commit", "-qm", msg, `--date=${date}`, `--author=${author}`);
  return r.git("rev-parse", "HEAD");
}

function setup() {
  const r = kit.mkRepo();
  live.push(r);
  const first = commitAt(r, "f.txt", "one\ntwo\n", "add f", "2020-01-02T00:00:00Z");
  const second = commitAt(r, "f.txt", "one\nTWO\nthree\n", "change f", "2021-06-01T00:00:00Z", "Ada Lovelace <ada@x.y>");
  const entry = { root: r.dir, ctx: r.ctx };
  const listeners = new Set<(e: unknown) => void>();
  const repos = {
    findByPath: (p: string) => (p.startsWith(r.dir) ? entry : undefined),
    onDidChange: (fn: (e: unknown) => void) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire: (e: unknown) => [...listeners].forEach((l) => l(e)),
  };
  const state = new Map<string, unknown>();
  const context = {
    globalState: {
      get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
      update: async (k: string, v: unknown) => void state.set(k, v),
    },
  };
  const file = join(r.dir, "f.txt");
  return { r, first, second, entry, repos, state, context, file };
}

type Setup = ReturnType<typeof setup>;
function start(s: Setup, log?: (m: string) => void) {
  const typesBefore = kit.decorationTypes.length;
  const barsBefore = kit.statusBars.length;
  const hoversBefore = kit.hoverProviders.length;
  const c = new BlameController(s.repos as never, s.context as never, log);
  live.push(c);
  return {
    c,
    inline: kit.decorationTypes[typesBefore],
    bar: kit.statusBars[barsBefore],
    hover: kit.hoverProviders[hoversBefore],
    command: (id: string) => kit.registeredCommands.get(id)!(),
  };
}

const cmd = (id: string) => kit.ran.filter((c) => c.command === id);

// ── Inline current-line blame ────────────────────────────────────────────────

test("the current line's commit is written after the line and summarised in the status bar", async () => {
  const s = setup();
  const e = editor(doc(s.file), 1);
  focus(e);
  const ui = start(s);
  const [deco] = await kit.until(() => e.painted.get(ui.inline.id)?.length && e.painted.get(ui.inline.id), "inline blame");
  const when = relativeTime(Date.parse("2021-06-01T00:00:00Z") / 1000);
  assert.equal(deco.renderOptions.after.contentText, `  Ada Lovelace, ${when} • change f`);
  assert.deepEqual([deco.range.start.line, deco.range.start.character], [1, 3], "at the end of the line");
  assert.equal(ui.bar.text, `$(git-commit) Ada Lovelace, ${when}`);
  assert.equal(ui.bar.visible, true);
  assert.equal(ui.bar.command, "gitstudio.blame.showLineActions");
  assert.equal(ui.bar.tooltip.value, `**change f**\n\n$(git-commit) \`${s.second.slice(0, 7)}\``);
});

test("a line not yet committed reads as yours, now", async () => {
  const s = setup();
  const e = editor(doc(s.file, { text: "one\nTWO\nthree\nfresh\n" }), 3);
  focus(e);
  const ui = start(s);
  const [deco] = await kit.until(() => e.painted.get(ui.inline.id)?.length && e.painted.get(ui.inline.id), "inline blame");
  assert.equal(deco.renderOptions.after.contentText, "  You, now • Uncommitted changes");
  assert.equal(ui.bar.text, "$(git-commit) Uncommitted changes");
  assert.equal(ui.bar.tooltip.value, "Uncommitted changes");
});

test("with inline annotations off only the status bar speaks; with the status bar off, only the line", async () => {
  const s = setup();
  kit.settings.set("gitstudio.blame.inlineEnabled", false);
  const e = editor(doc(s.file), 0);
  focus(e);
  const ui = start(s);
  await kit.until(() => ui.bar.visible, "status bar");
  assert.deepEqual(e.painted.get(ui.inline.id), []);
  assert.match(ui.bar.text, /Test Person/);
  ui.c.dispose();

  kit.settings.set("gitstudio.blame.inlineEnabled", true);
  kit.settings.set("gitstudio.blame.statusBarEnabled", false);
  const e2 = editor(doc(s.file), 0);
  focus(e2);
  const ui2 = start(s);
  await kit.until(() => e2.painted.get(ui2.inline.id)?.length, "inline");
  assert.equal(ui2.bar.visible, false);
});

test("moving the caret re-blames the new line; leaving every editor clears the annotation", async () => {
  const s = setup();
  const e = editor(doc(s.file), 0);
  focus(e);
  const ui = start(s);
  await kit.until(() => /Test Person/.test(ui.bar.text), "line 1 is the first commit's");
  e.selection = new kit.Selection(new kit.Position(2, 0), new kit.Position(2, 0));
  kit.editorEvents.selection.fire({ textEditor: e, kind: 1, selections: [e.selection] });
  await kit.until(() => /Ada Lovelace/.test(ui.bar.text), "line 3 is the second commit's");
  focus(undefined);
  kit.editorEvents.active.fire(undefined);
  assert.equal(ui.bar.visible, false);
});

test("a file outside every repository, or not on disk, or too long to blame, gets no annotation", async () => {
  const s = setup();
  const outside = editor(doc("/elsewhere/x.txt", { text: "x\n" }), 0);
  focus(outside);
  const ui = start(s);
  await kit.until(() => outside.painted.has(ui.inline.id), "cleared");
  assert.deepEqual(outside.painted.get(ui.inline.id), []);
  const untitled = editor(doc(s.file, { scheme: "untitled", text: "x\n" }), 0);
  focus(untitled);
  kit.editorEvents.active.fire(untitled);
  await kit.until(() => untitled.painted.has(ui.inline.id), "cleared");
  const huge = editor(doc(s.file, { lineCount: 20_001 }), 0);
  focus(huge);
  kit.editorEvents.active.fire(huge);
  await kit.until(() => huge.painted.has(ui.inline.id), "cleared");
  assert.deepEqual(huge.painted.get(ui.inline.id), []);
  assert.equal(ui.bar.visible, false);
});

test("a blame git cannot run is logged, and the line is left bare", async () => {
  const s = setup();
  const logged: string[] = [];
  const e = editor(doc(join(s.r.dir, "never-committed.txt"), { text: "x\n" }), 0);
  e.document.isDirty = false;
  focus(e);
  const ui = start(s, (m) => logged.push(m));
  await kit.until(() => logged.length, "logged");
  assert.match(logged[0], /^blame failed for never-committed\.txt: /);
  await kit.until(() => e.painted.has(ui.inline.id), "cleared");
  assert.deepEqual(e.painted.get(ui.inline.id), []);
});

test("a commit elsewhere drops the cached blame and repaints the line", async () => {
  const s = setup();
  const e = editor(doc(s.file), 0);
  focus(e);
  const ui = start(s);
  await kit.until(() => /Test Person/.test(ui.bar.text), "first");
  commitAt(s.r, "f.txt", "ONE\nTWO\nthree\n", "shout", "2022-01-01T00:00:00Z", "Grace Hopper <g@h.i>");
  // A working-tree-only event is not enough: blame is about commits.
  s.repos.fire(repoChange(["workingTree"]));
  s.repos.fire(repoChange(["refs"]));
  // The same line again: lastRendered would skip it, so move off and back.
  e.selection = new kit.Selection(new kit.Position(2, 0), new kit.Position(2, 0));
  kit.editorEvents.selection.fire({ textEditor: e, kind: 1, selections: [e.selection] });
  await kit.until(() => /Ada/.test(ui.bar.text), "moved");
  e.selection = new kit.Selection(new kit.Position(0, 0), new kit.Position(0, 0));
  kit.editorEvents.selection.fire({ textEditor: e, kind: 1, selections: [e.selection] });
  await kit.until(() => /Grace Hopper/.test(ui.bar.text), "the new commit");
});

// ── The hover ────────────────────────────────────────────────────────────────

const token = () => new kit.CancellationTokenSource().token;

test("the hover names the commit, its author and date, with Copy SHA and Show in Graph links", async () => {
  const s = setup();
  const ui = start(s);
  const d = doc(s.file);
  const h = await ui.hover.provideHover(d, new kit.Position(1, 0), token());
  const md: string = h.contents.value;
  assert.match(md, /^\*\*change f\*\*\n\n/);
  assert.match(md, /\$\(account\) Ada Lovelace <ada@x\\\.y>/);
  const arg = encodeURIComponent(JSON.stringify([s.second]));
  assert.ok(md.includes(`[$(copy) Copy SHA](command:gitstudio.copyCommitSha?${arg})`));
  assert.ok(md.includes(`[$(eye) Show in Graph](command:gitstudio.revealCommitInGraph?${arg})`));
  assert.deepEqual(h.contents.isTrusted, { enabledCommands: ["gitstudio.copyCommitSha", "gitstudio.revealCommitInGraph"] });
  assert.equal(h.range.start.line, 1);

  const dirty = doc(s.file, { text: "one\nTWO\nthree\nnew\n" });
  dirty.version = 2; // an edit bumps the version, which is what drops the cached blame
  const u = await ui.hover.provideHover(dirty, new kit.Position(3, 0), token());
  assert.match(u.contents.value, /\*\*Uncommitted changes\*\*/);
  assert.equal(await ui.hover.provideHover(doc(s.file), new kit.Position(40, 0), token()), undefined, "past the end");
  assert.equal(await ui.hover.provideHover(doc("/elsewhere/x.txt", { text: "x\n" }), new kit.Position(0, 0), token()), undefined);
  kit.settings.set("gitstudio.blame.showDiffOnHover", false);
  assert.equal(await ui.hover.provideHover(d, new kit.Position(1, 0), token()), undefined, "Show Diff On Hover off");
});

// ── The annotate gutter ──────────────────────────────────────────────────────

const gutterText = (decos: any[]) => decos.map((d) => d.renderOptions.before.contentText);

test("Annotate: a column of date and author down every line, padded to one width, tinted by age", async () => {
  const s = setup();
  const e = editor(doc(s.file), 0);
  focus(e);
  const ui = start(s);
  await ui.command("gitstudio.toggleFileBlame");
  assert.equal(s.state.get("gitstudio.blame.annotateAll"), true, "the mode is remembered");
  assert.ok(kit.ran.some((c) => c.command === "setContext" && c.args[0] === "gitstudio.blameAnnotated" && c.args[1] === true));
  const type = kit.decorationTypes.at(-1)!;
  const decos = e.painted.get(type.id)!;
  assert.deepEqual(gutterText(decos), ["2020-01-02  Test Person ", "2021-06-01  Ada Lovelace", "2021-06-01  Ada Lovelace"]);
  assert.equal(decos[0].renderOptions.before.width, "25ch");
  assert.equal(decos[0].renderOptions.before.backgroundColor, "rgba(60, 120, 220, 0.12)", "oldest: cool");
  assert.equal(decos[1].renderOptions.before.backgroundColor, "rgba(255, 153, 51, 0.12)", "newest: warm");
  assert.equal(ui.c.ownsGutterStrip(e.document.uri as never), true);

  await ui.command("gitstudio.blame.closeAnnotations");
  assert.equal(type.disposed, true);
  assert.deepEqual(e.painted.get(type.id), []);
  assert.equal(s.state.get("gitstudio.blame.annotateAll"), false);
  assert.equal(ui.c.ownsGutterStrip(e.document.uri as never), false);
});

test("the gutter's columns, name style and colours follow the settings, repainting on a change", async () => {
  const s = setup();
  const e = editor(doc(s.file), 0);
  focus(e);
  const ui = start(s);
  await ui.command("gitstudio.toggleFileBlame");
  const type = kit.decorationTypes.at(-1)!;
  const repaint = async (key: string, value: unknown) => {
    const before = e.painted.get(type.id);
    kit.settings.set(key, value);
    kit.configChanged.fire({ affectsConfiguration: (x: string) => key.startsWith(x) });
    return kit.until(() => e.painted.get(type.id) !== before && e.painted.get(type.id), `repaint for ${key}`);
  };
  let decos = await repaint("gitstudio.blame.gutter.fields", ["revision", "author", "commitNumber"]);
  assert.deepEqual(gutterText(decos), [
    `${s.first.slice(0, 7)}  Test Person  #1 `,
    `${s.second.slice(0, 7)}  Ada Lovelace  #2`,
    `${s.second.slice(0, 7)}  Ada Lovelace  #2`,
  ]);
  const byStyle: [string, string, string][] = [
    ["initials", "TP", "AL"],
    ["firstName", "Test", "Ada"],
    ["lastName", "Person", "Lovelace"],
    ["email", "t@t.t", "ada@x.y"],
  ];
  kit.settings.set("gitstudio.blame.gutter.fields", ["author"]);
  for (const [style, a, b] of byStyle) {
    decos = await repaint("gitstudio.blame.gutter.nameStyle", style);
    assert.deepEqual(gutterText(decos).map((t: string) => t.trim()), [a, b, b], style);
  }
  decos = await repaint("gitstudio.blame.gutter.colors", "author");
  assert.match(decos[0].renderOptions.before.backgroundColor, /^hsla\(\d+, 70%, 55%, 0\.14\)$/);
  assert.notEqual(decos[0].renderOptions.before.backgroundColor, decos[1].renderOptions.before.backgroundColor);
  decos = await repaint("gitstudio.blame.gutter.colors", "hide");
  assert.equal(decos[0].renderOptions.before.backgroundColor, undefined);
  // The legacy switch only supplies the default once no colour is chosen.
  kit.settings.delete("gitstudio.blame.gutter.colors");
  decos = await repaint("gitstudio.blame.heatmap", false);
  assert.equal(decos[1].renderOptions.before.backgroundColor, undefined);
});

test("the annotation menu's options write the settings and keep their checkmarks in sync", async () => {
  const s = setup();
  const ui = start(s);
  await ui.command("gitstudio.blame.field.revision.on");
  assert.deepEqual(kit.settings.get("gitstudio.blame.gutter.fields"), ["revision", "date", "author"], "canonical column order");
  await ui.command("gitstudio.blame.field.date.off");
  assert.deepEqual(kit.settings.get("gitstudio.blame.gutter.fields"), ["revision", "author"]);
  await ui.command("gitstudio.blame.colors.author.on");
  assert.equal(kit.settings.get("gitstudio.blame.gutter.colors"), "author");
  await ui.command("gitstudio.blame.names.initials.on");
  assert.equal(kit.settings.get("gitstudio.blame.gutter.nameStyle"), "initials");
  await ui.command("gitstudio.blame.hover.on");
  assert.equal(kit.settings.get("gitstudio.blame.showDiffOnHover"), false);
  const ctx = (key: string) => kit.ran.filter((c) => c.command === "setContext" && c.args[0] === key).at(-1)?.args[1];
  assert.equal(ctx("gitstudio.blame.f.revision"), true);
  assert.equal(ctx("gitstudio.blame.f.date"), false);
  assert.equal(ctx("gitstudio.blame.c"), "author");
  assert.equal(ctx("gitstudio.blame.n"), "initials");
  assert.equal(ctx("gitstudio.blame.h"), false);

  // The last column cannot be switched off.
  kit.settings.set("gitstudio.blame.gutter.fields", ["author"]);
  const writes = kit.settingWrites.length;
  await ui.command("gitstudio.blame.field.author.off");
  assert.equal(kit.settingWrites.length, writes);
  assert.match(kit.said.at(-1)!.text, /keep at least one blame column/);
});

test("annotate mode follows you to the next file, stays off files outside a repository, and survives a restart", async () => {
  const s = setup();
  commitAt(s.r, "g.txt", "g\n", "add g", "2022-02-02T00:00:00Z");
  const f = editor(doc(s.file), 0);
  focus(f);
  const ui = start(s);
  await ui.command("gitstudio.toggleFileBlame");
  const g = editor(doc(join(s.r.dir, "g.txt")), 0);
  focus(g);
  kit.editorEvents.active.fire(g);
  const gType = await kit.until(() => kit.decorationTypes.find((t) => g.painted.get(t.id)?.length), "g annotated");
  assert.deepEqual(gutterText(g.painted.get(gType.id)!), ["2022-02-02  Test Person"]);
  const outside = editor(doc("/elsewhere/x.txt", { text: "x\n" }), 0);
  const types = kit.decorationTypes.length;
  kit.editorEvents.active.fire(outside);
  assert.equal(kit.decorationTypes.length, types, "no gutter made for it");
  ui.c.dispose();

  // Next session: the gutter is there before anything is touched.
  focus(f);
  const before = kit.decorationTypes.length;
  start(s);
  await kit.until(() => kit.decorationTypes.slice(before).find((t) => f.painted.get(t.id)?.length), "restored");
});

test("turning annotate on in a file outside a repository says why nothing appears", async () => {
  const s = setup();
  focus(editor(doc("/elsewhere/x.txt", { text: "x\n" }), 0));
  const ui = start(s);
  await ui.command("gitstudio.toggleFileBlame");
  assert.deepEqual(kit.said.map((x) => x.text), ["GitStudio: this file isn't in an open Git repository."]);
});

test("editing an annotated file re-blames the buffer after typing settles; closing it drops its gutter", async () => {
  const s = setup();
  const e = editor(doc(s.file), 0);
  focus(e);
  const ui = start(s);
  await ui.command("gitstudio.toggleFileBlame");
  const type = kit.decorationTypes.at(-1)!;
  const edited = doc(s.file, { text: "one\nTWO\nthree\ntyped\n" });
  edited.version = 2;
  e.document = edited;
  kit.editorEvents.docChanged.fire({ document: edited });
  const decos = await kit.until(() => e.painted.get(type.id)?.length === 4 && e.painted.get(type.id), "re-annotated");
  assert.equal(gutterText(decos)[3].trim(), "Uncommitted");
  kit.editorEvents.docClosed.fire(edited);
  assert.equal(type.disposed, true);
});

test("scrolling a long annotated file paints only a window around what is on screen", async () => {
  const s = setup();
  const body = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  commitAt(s.r, "long.txt", body, "long", "2023-03-03T00:00:00Z");
  const e = editor(doc(join(s.r.dir, "long.txt")), 0);
  e.visibleRanges = [new kit.Range(3000, 0, 3040, 0)];
  focus(e);
  const ui = start(s);
  await ui.command("gitstudio.toggleFileBlame");
  const type = kit.decorationTypes.at(-1)!;
  let decos = e.painted.get(type.id)!;
  assert.equal(decos.length, 440);
  assert.equal(decos[0].range.start.line, 2800);
  e.visibleRanges = [new kit.Range(0, 0, 30, 0)];
  kit.editorEvents.visibleRanges.fire({ textEditor: e });
  decos = await kit.until(() => e.painted.get(type.id)![0].range.start.line === 0 && e.painted.get(type.id), "scrolled");
  assert.equal(decos.length, 230);
});

// ── Clicking the gutter, and the annotation's right-click actions ───────────

test("a mouse click in the annotated gutter opens that line's commit; the keyboard and a setting say no", async () => {
  const s = setup();
  const e = editor(doc(s.file), 1);
  focus(e);
  const ui = start(s);
  const click = (kind: number, character = 0) =>
    kit.editorEvents.selection.fire({
      textEditor: e,
      kind,
      selections: [new kit.Selection(new kit.Position(1, character), new kit.Position(1, character))],
    });
  click(2);
  assert.equal(cmd("gitstudio.revealCommitInGraph").length, 0, "not annotating: not a gutter click");
  await ui.command("gitstudio.toggleFileBlame");
  click(1);
  click(2, 3);
  kit.settings.set("gitstudio.blame.clickOpensCommit", false);
  click(2);
  kit.settings.delete("gitstudio.blame.clickOpensCommit");
  click(2);
  await kit.until(() => cmd("gitstudio.revealCommitInGraph").length, "revealed");
  assert.deepEqual(cmd("gitstudio.revealCommitInGraph").map((c) => c.args[0]), [s.second]);
});

test("Copy Revision, Show Commit and the status bar item act on the caret line's commit", async () => {
  const s = setup();
  focus(editor(doc(s.file), 0));
  const ui = start(s);
  await ui.command("gitstudio.blame.copyRevision");
  assert.equal(kit.clip.text, s.first);
  assert.match(kit.said.at(-1)!.text, new RegExp(s.first.slice(0, 7)));
  await ui.command("gitstudio.blame.showCommit");
  await ui.command("gitstudio.blame.showLineActions");
  assert.deepEqual(cmd("gitstudio.revealCommitInGraph").map((c) => c.args[0]), [s.first, s.first]);
});

test("on an uncommitted line the actions say there is no revision yet, and do nothing", async () => {
  const s = setup();
  focus(editor(doc(s.file, { text: "one\nTWO\nthree\nnew\n" }), 3));
  const ui = start(s);
  await ui.command("gitstudio.blame.copyRevision");
  assert.equal(kit.clip.text, "");
  assert.deepEqual(kit.said.map((x) => x.text), ["GitStudio: this line has uncommitted changes — there's no revision yet."]);
  focus(undefined);
  await ui.command("gitstudio.blame.showDiff");
  assert.equal(kit.said.length, 1, "no editor: nothing to act on");
});

test("Show Diff diffs the file as the line's commit changed it; the first commit against nothing", async () => {
  const s = setup();
  const e = editor(doc(s.file), 1);
  focus(e);
  const ui = start(s);
  await ui.command("gitstudio.blame.showDiff");
  e.selection = new kit.Selection(new kit.Position(0, 0), new kit.Position(0, 0));
  await ui.command("gitstudio.blame.showDiff");
  const [changed, added] = cmd("vscode.diff");
  const rev = (u: any) => new URLSearchParams(u.query).get("rev");
  assert.equal(rev(changed.args[0]), s.first);
  assert.equal(rev(changed.args[1]), s.second);
  assert.equal(changed.args[2], `f.txt (${s.second.slice(0, 7)})`);
  assert.equal(rev(added.args[0]), EMPTY_TREE);
  assert.equal(rev(added.args[1]), s.first);
});

test("Open Previous Revision opens the file as it was before the line's commit — or says the commit added it", async () => {
  const s = setup();
  const e = editor(doc(s.file), 1);
  focus(e);
  const ui = start(s);
  await ui.command("gitstudio.blame.openPreviousRevision");
  assert.equal(kit.openedDocuments.length, 1);
  const u = kit.openedDocuments[0];
  assert.equal(u.scheme, "gitstudio-rev");
  assert.equal(new URLSearchParams(u.query).get("rev"), s.first);
  assert.equal(kit.shownDocuments.length, 1);
  e.selection = new kit.Selection(new kit.Position(0, 0), new kit.Position(0, 0));
  await ui.command("gitstudio.blame.openPreviousRevision");
  assert.deepEqual(kit.said.map((x) => x.text), [
    `GitStudio: f.txt was added by ${s.first.slice(0, 7)}, so there is no earlier revision of it.`,
  ]);
  assert.equal(kit.openedDocuments.length, 1);
});

test("View in Browser: the reason when there is no web remote; the commit's page when there is", async () => {
  const s = setup();
  focus(editor(doc(s.file), 1));
  const ui = start(s);
  await ui.command("gitstudio.blame.viewInBrowser");
  assert.match(kit.said.at(-1)!.text, /no remote/);
  s.r.git("remote", "add", "origin", "https://gitlab.com/acme/widgets.git");
  await ui.command("gitstudio.blame.viewInBrowser");
  assert.deepEqual(kit.opened, [`https://gitlab.com/acme/widgets/commit/${s.second}`]);
});

// ── The editor's own blame ───────────────────────────────────────────────────

test("the editor's built-in blame is turned off once, when on by default and not set by the user", async () => {
  const s = setup();
  kit.inspected.set("git.blame.editorDecoration.enabled", { defaultValue: true });
  kit.inspected.set("git.blame.statusBarItem.enabled", { defaultValue: true });
  start(s);
  await kit.until(() => kit.said.length, "told");
  assert.deepEqual(
    kit.settingWrites.map((w) => [w.key, w.value]),
    [
      ["git.blame.editorDecoration.enabled", false],
      ["git.blame.statusBarItem.enabled", false],
    ],
  );
  assert.match(kit.said[0].text, /built-in blame is turned off/);
  assert.equal(s.state.get("gitstudio.blame.disabledNativeBlame"), true);
  kit.said.length = 0;
  kit.settingWrites.length = 0;
  start(s);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(kit.settingWrites, [], "never again on this machine");
});

test("a built-in blame the user set themselves is left alone", async () => {
  const s = setup();
  kit.inspected.set("git.blame.editorDecoration.enabled", { defaultValue: true, globalValue: true });
  kit.inspected.set("git.blame.statusBarItem.enabled", { defaultValue: false });
  start(s);
  await kit.until(() => s.state.get("gitstudio.blame.disabledNativeBlame"), "marked handled");
  assert.deepEqual(kit.settingWrites, []);
  assert.equal(kit.said.length, 0);
});
