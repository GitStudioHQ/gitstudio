// The optional whole-line highlights for changed lines (#160), driven for real:
// StagedGutter under the vscode stand-in, against a real repository, painting
// into stand-in editors that record every decoration they are given.
//
// What is pinned: nothing is painted (or even made) while the setting is off,
// which is the default; on, the right lines get the right kind; a diff editor
// is never painted on top of its own colours; a file that is not in HEAD is
// left alone, while an EMPTY file HEAD does have is painted; and the setting
// and the tabs apply live, with no git read for a tab move.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { scratchRepo, vscode } from "./changesHost";
import { readManifest } from "./manifest";
import type { RepoChangeEvent } from "../src/git/repoChange";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { StagedGutter } = require("../src/changes/stagedGutter") as typeof import("../src/changes/stagedGutter");
const highlights = require("../src/changes/changedLineHighlights") as typeof import("../src/changes/changedLineHighlights");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const { CHANGED_LINE_COLORS, changedLineDecorationOptions, deletedLabel } = highlights;

type Pos = { line: number; character: number };
const vs = vscode as unknown as {
  window: Record<string, unknown>;
  workspace: Record<string, unknown>;
  Range: unknown;
  ThemeColor: unknown;
  TabInputText: unknown;
  TabInputTextDiff: unknown;
};

// Real value classes where the code reads what it built.
vs.Range = class {
  start: Pos;
  end: Pos;
  constructor(a: number | Pos, b: number | Pos, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = { line: a, character: b as number };
      this.end = { line: c as number, character: d as number };
    } else {
      this.start = a;
      this.end = b as Pos;
    }
  }
};
class ThemeColor {
  constructor(readonly id: string) {}
}
vs.ThemeColor = ThemeColor;
class TabInputText {
  constructor(readonly uri: { toString(): string }) {}
}
class TabInputTextDiff {
  constructor(
    readonly original: { toString(): string },
    readonly modified: { toString(): string },
  ) {}
}
vs.TabInputText = TabInputText;
vs.TabInputTextDiff = TabInputTextDiff;

// Every decoration type made, with its options, and whether it was disposed.
interface Made {
  options: { isWholeLine?: boolean; gutterIconPath?: unknown; backgroundColor?: ThemeColor };
  disposed: boolean;
  dispose(): void;
}
const made: Made[] = [];
vs.window.createTextEditorDecorationType = (options: Made["options"]) => {
  const type: Made = {
    options,
    disposed: false,
    dispose() {
      type.disposed = true;
    },
  };
  made.push(type);
  return type;
};
type Kind = "mark" | "added" | "modified" | "deleted";
function kindOf(type: Made): Kind {
  if (type.options.gutterIconPath) return "mark";
  if (!type.options.isWholeLine) return "deleted";
  return type.options.backgroundColor?.id === CHANGED_LINE_COLORS.added ? "added" : "modified";
}
const highlightTypes = () => made.filter((t) => kindOf(t) !== "mark");

// Settings, read the way StagedGutter reads them, and the change event.
const settings = new Map<string, unknown>();
let onConfig: ((e: { affectsConfiguration: (key: string) => boolean }) => void) | undefined;
vs.workspace.getConfiguration = (section?: string) => ({
  get: (key: string, fallback?: unknown) => {
    const value = settings.get(section ? `${section}.${key}` : key);
    return value === undefined ? fallback : value;
  },
});
vs.workspace.onDidChangeConfiguration = (listener: typeof onConfig) => {
  onConfig = listener;
  return { dispose() {} };
};
function setSetting(key: string, value: unknown): void {
  settings.set(key, value);
  onConfig?.({ affectsConfiguration: (k) => k === key || key.startsWith(`${k}.`) });
}
const HIGHLIGHT = "gitstudio.staging.highlightChangedLines";

// The editor's text-change event, so a test can type.
let onEdit: ((e: { document: unknown }) => void) | undefined;
vs.workspace.onDidChangeTextDocument = (listener: (e: { document: unknown }) => void) => {
  onEdit = listener;
  return { dispose() {} };
};

// The tab groups: which tab each column shows.
interface Group {
  viewColumn: number;
  activeTab: { input: unknown } | undefined;
}
let groups: Group[] = [];
let onTabs: (() => void) | undefined;
vs.window.tabGroups = {
  get all() {
    return groups;
  },
  onDidChangeTabs: (listener: () => void) => {
    onTabs = listener;
    return { dispose() {} };
  },
};

const repos: { done: () => void }[] = [];
after(() => repos.forEach((r) => r.done()));

interface Editor {
  document: ReturnType<typeof docOf>;
  viewColumn: number | undefined;
  painted: Map<Made, unknown[]>;
  setDecorations(type: Made, ranges: unknown[]): void;
}

function docOf(file: string) {
  const uri = { scheme: "file", fsPath: file, toString: () => `file://${file}` };
  const text = () => readFileSync(file, "utf8");
  return {
    uri,
    version: 1,
    getText: text,
    get lineCount() {
      return text().split("\n").length;
    },
    lineAt: (line: number) => {
      const content = text().split("\n")[line] ?? "";
      return { range: { start: { line, character: 0 }, end: { line, character: content.length } } };
    },
  };
}

function editorOf(document: Editor["document"], viewColumn: number | undefined): Editor {
  const painted = new Map<Made, unknown[]>();
  return { document, viewColumn, painted, setDecorations: (type, ranges) => painted.set(type, ranges) };
}

/**
 * What `editor` shows right now: for each live highlight type, the lines it
 * paints; for a deletion, `line:text` of each label. A disposed type shows
 * nothing anywhere, as in VS Code.
 */
function shown(editor: Editor): { added: number[]; modified: number[]; deleted: string[] } {
  const out = { added: [] as number[], modified: [] as number[], deleted: [] as string[] };
  for (const type of highlightTypes()) {
    if (type.disposed) continue;
    const kind = kindOf(type) as "added" | "modified" | "deleted";
    for (const entry of editor.painted.get(type) ?? []) {
      if (kind === "deleted") {
        const d = entry as { range: { start: Pos }; renderOptions: { after: { contentText: string } } };
        out.deleted.push(`${d.range.start.line}:${d.renderOptions.after.contentText}`);
      } else {
        const r = entry as { start: Pos; end: Pos };
        for (let l = r.start.line; l <= r.end.line; l++) out[kind].push(l);
      }
    }
  }
  return out;
}
const nothing = { added: [], modified: [], deleted: [] };

/** The staging marks painted into `editor`, as lines. */
function marks(editor: Editor): number[] {
  const lines: number[] = [];
  for (const [type, ranges] of editor.painted) {
    if (kindOf(type) === "mark") for (const r of ranges as { start: Pos }[]) lines.push(r.start.line);
  }
  return lines.sort((a, b) => a - b);
}

/**
 * A repository whose f.txt has one change of each kind against HEAD:
 * line 1 modified (b→B), d and e deleted (the label on "f", line 3), and X
 * added at line 5. `editors` says which editors show it, by view column.
 */
function setup(name: string, columns: (number | undefined)[] = [1]) {
  const r = scratchRepo(name);
  repos.push(r);
  const file = join(r.dir, "f.txt");
  writeFileSync(file, "a\nb\nc\nd\ne\nf\ng\nh\n");
  r.git("add", "f.txt");
  r.git("commit", "-qm", "base");
  writeFileSync(file, "a\nB\nc\nf\ng\nX\nh\n");

  const document = docOf(file);
  const editors = columns.map((column) => editorOf(document, column));
  vs.window.visibleTextEditors = editors;
  groups = columns
    .filter((c): c is number => c !== undefined)
    .map((viewColumn) => ({ viewColumn, activeTab: { input: new TabInputText(document.uri) } }));

  const entry = { root: r.dir, ctx: new GitContext({ root: r.dir }) };
  let reads = 0;
  const staging = entry.ctx.staging as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const method of ["indexContent", "headContent"]) {
    const real = staging[method].bind(staging);
    staging[method] = (...a: unknown[]) => {
      reads++;
      return real(...a);
    };
  }
  // Every "is it in HEAD at all?" probe (git cat-file -e).
  let probes = 0;
  const process = entry.ctx.process as unknown as { run: (args: string[], ...rest: unknown[]) => Promise<unknown> };
  const run = process.run.bind(process);
  process.run = (args: string[], ...rest: unknown[]) => {
    if (args[0] === "cat-file") probes++;
    return run(args, ...rest);
  };
  const manager = {
    getAll: () => [entry],
    onDidChange: (_listener: (e: RepoChangeEvent) => void) => ({ dispose() {} }),
  };
  const gutter = new StagedGutter({ extensionUri: {} } as never, manager as never);
  return { r, file, gutter, document, editors, reads: () => reads, probes: () => probes };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A paint runs git; on a Windows runner that can take seconds.
async function until(ok: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await sleep(25);
  }
}
/** The highlights `f.txt` should show in an ordinary tab. */
const EXPECTED = { added: [5], modified: [1], deleted: ["3:2 lines deleted above"] };

test("added and modified lines are painted whole, in the theme's colours", () => {
  for (const kind of ["added", "modified"] as const) {
    const options = changedLineDecorationOptions(kind) as { isWholeLine?: boolean; backgroundColor?: ThemeColor };
    assert.equal(options.isWholeLine, true, kind);
    assert.ok(options.backgroundColor instanceof ThemeColor, `${kind}: a theme colour, so a theme can change it`);
    assert.equal(options.backgroundColor.id, CHANGED_LINE_COLORS[kind]);
  }
  // A deletion has no line of its own: its type paints no line at all.
  const deleted = changedLineDecorationOptions("deleted") as { isWholeLine?: boolean; backgroundColor?: unknown };
  assert.equal(deleted.isWholeLine, undefined);
  assert.equal(deleted.backgroundColor, undefined);
});

test("a deletion is a label at the end of the line after the cut, with its count and direction", () => {
  const document = { lineAt: (line: number) => ({ range: { end: { line, character: 7 } } }) } as never;
  type Label = { range: { start: Pos; end: Pos }; renderOptions: { after: { contentText: string; backgroundColor: ThemeColor } } };
  const one = deletedLabel(document, 4, 1) as unknown as Label;
  assert.deepEqual([one.range.start, one.range.end], [{ line: 4, character: 7 }, { line: 4, character: 7 }]);
  assert.equal(one.renderOptions.after.contentText, "1 line deleted above");
  assert.equal(one.renderOptions.after.backgroundColor.id, CHANGED_LINE_COLORS.deleted);
  const text = (count: number, above: boolean) =>
    (deletedLabel(document, 4, count, above) as unknown as Label).renderOptions.after.contentText;
  assert.equal(text(3, true), "3 lines deleted above");
  assert.equal(text(1, false), "1 line deleted below");
  assert.equal(text(3, false), "3 lines deleted below");
});

test("the manifest contributes each colour for every kind of theme, and the setting is off by default", () => {
  const pkg = readManifest() as {
    contributes: {
      colors: { id: string; description: string; defaults: Record<string, string> }[];
      configuration: { title: string; properties: Record<string, { type: string; default: unknown }> }[];
    };
  };
  const colors = pkg.contributes.colors;
  assert.deepEqual(colors.map((c) => c.id).sort(), Object.values(CHANGED_LINE_COLORS).sort());
  const ids = new Set(colors.map((c) => c.id));
  for (const color of colors) {
    assert.ok(color.description && !color.description.startsWith("%"), `${color.id} has an English description`);
    assert.deepEqual(Object.keys(color.defaults).sort(), ["dark", "highContrast", "highContrastLight", "light"], color.id);
    for (const [theme, value] of Object.entries(color.defaults)) {
      const where = `${color.id} (${theme})`;
      if (value.startsWith("#")) {
        // A background under code must leave the code readable: translucent.
        assert.match(value, /^#[0-9a-f]{8}$/i, `${where} carries an alpha`);
        assert.ok(parseInt(value.slice(7), 16) <= 0x66, `${where} is subtle (alpha ${value.slice(7)})`);
      } else {
        // Or the theme's own diff colour, which a theme already keeps readable.
        assert.match(value, /^diffEditor\.(inserted|removed)LineBackground$/, where);
        assert.ok(!ids.has(value), `${where} does not point at itself`);
      }
    }
  }
  const group = pkg.contributes.configuration.find((c) => HIGHLIGHT in c.properties);
  assert.equal(group?.title, "Changes & Staging");
  assert.equal(group?.properties[HIGHLIGHT].type, "boolean");
  assert.equal(group?.properties[HIGHLIGHT].default, false, "nobody's editor changes on update");
});

test("off (the default): the marks are painted and no highlight is even made", async () => {
  settings.clear();
  const before = highlightTypes().length;
  const t = setup("hl-off");
  const [editor] = t.editors;
  await until(() => marks(editor).length === 3, "the marks painted");
  assert.deepEqual(marks(editor), [1, 3, 5]);
  assert.equal(highlightTypes().length, before, "no highlight decoration type for a user who never turns it on");
  assert.deepEqual(shown(editor), nothing);
  // Nor any extra git call: an untracked file's mark is painted as before,
  // without asking whether HEAD has it.
  writeFileSync(join(t.r.dir, "new.txt"), "one\n");
  const untracked = openBeside(t, join(t.r.dir, "new.txt"), 3);
  t.gutter.refreshAll();
  await until(() => marks(untracked).length === 1, "the untracked file's mark painted");
  assert.equal(t.probes(), 0, "no in-HEAD probe while the highlights are off");
  t.gutter.dispose();
});

test("on: each kind of change gets its own highlight in an ordinary tab", async () => {
  settings.clear();
  settings.set(HIGHLIGHT, true);
  const t = setup("hl-on");
  const [editor] = t.editors;
  await until(() => shown(editor).added.length > 0, "the highlights painted");
  assert.deepEqual(shown(editor), EXPECTED);
  assert.deepEqual(marks(editor), [1, 3, 5], "the marks are painted beside them, from the same blocks");
  t.gutter.dispose();
});

test("on, with the marks off: the highlights still read and paint the changes", async () => {
  settings.clear();
  settings.set(HIGHLIGHT, true);
  settings.set("gitstudio.staging.showGutterState", false);
  settings.set("gitstudio.staging.hoverActions", false);
  const t = setup("hl-nomarks");
  const [editor] = t.editors;
  await until(() => shown(editor).added.length > 0, "the highlights painted");
  assert.deepEqual(shown(editor), EXPECTED);
  assert.deepEqual(marks(editor), []);
  t.gutter.dispose();
});

test("a diff editor of the same file is never painted; the ordinary tab beside it is", async () => {
  settings.clear();
  settings.set(HIGHLIGHT, true);
  // Column 1: the file in an ordinary tab. Column 2: a diff of it. And one
  // editor with no column at all — embedded in something else.
  const t = setup("hl-diff", [1, 2, undefined]);
  const [plain, diff, embedded] = t.editors;
  groups[1].activeTab = { input: new TabInputTextDiff({ toString: () => "git:/f.txt" }, t.document.uri) };
  await until(() => shown(plain).added.length > 0, "the ordinary tab painted");
  assert.deepEqual(shown(plain), EXPECTED);
  assert.deepEqual(shown(diff), nothing, "the diff colours its own changes; a second tint would stack on them");
  assert.deepEqual(shown(embedded), nothing);
  assert.deepEqual(marks(diff), [1, 3, 5], "the staging marks still show in the diff");
  t.gutter.dispose();
});

/** Opens `file` in its own ordinary tab in `column`, beside the setup's editors. */
function openBeside(t: ReturnType<typeof setup>, file: string, column: number): Editor {
  const editor = editorOf(docOf(file), column);
  groups.push({ viewColumn: column, activeTab: { input: new TabInputText(editor.document.uri) } });
  vs.window.visibleTextEditors = [...(vs.window.visibleTextEditors as Editor[]), editor];
  return editor;
}

test("a file that is not in HEAD is not painted from top to bottom", async () => {
  settings.clear();
  settings.set(HIGHLIGHT, true);
  const t = setup("hl-new");
  // An untracked file and an ignored one: every line of each reads as added —
  // as would any build output or local config file opened from the repository.
  writeFileSync(join(t.r.dir, ".gitignore"), "*.out\n");
  t.r.git("add", ".gitignore");
  t.r.git("commit", "-qm", "ignore");
  writeFileSync(join(t.r.dir, "new.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(t.r.dir, "build.out"), "one\ntwo\n");
  const untracked = openBeside(t, join(t.r.dir, "new.txt"), 3);
  const ignored = openBeside(t, join(t.r.dir, "build.out"), 4);
  t.gutter.refreshAll();
  await until(() => marks(untracked).length === 1 && marks(ignored).length === 1, "the new files' marks painted");
  await until(() => shown(t.editors[0]).added.length > 0, "the tracked file painted");
  assert.deepEqual(shown(untracked), nothing);
  assert.deepEqual(shown(ignored), nothing);
  assert.deepEqual(shown(t.editors[0]), EXPECTED, "a tracked file beside them is painted as usual");
  t.gutter.dispose();
});

test("an EMPTY file HEAD has is painted: the lines typed into it are added", async () => {
  settings.clear();
  settings.set(HIGHLIGHT, true);
  const t = setup("hl-empty");
  await until(() => shown(t.editors[0]).added.length > 0, "the tracked file painted");
  assert.equal(t.probes(), 0, "a file with committed text never asks whether HEAD has it");

  // `git show HEAD:<path>` answers "" for it exactly as for a path HEAD lacks.
  const file = join(t.r.dir, "__init__.py");
  writeFileSync(file, "");
  t.r.git("add", "__init__.py");
  t.r.git("commit", "-qm", "empty module");
  writeFileSync(file, "one\ntwo\nthree\n");
  const editor = openBeside(t, file, 3);
  t.gutter.refreshAll();
  await until(() => shown(editor).added.length > 0, "the empty file's new lines painted");
  assert.deepEqual(shown(editor), { added: [0, 1, 2], modified: [], deleted: [] }, "added, not modified; the empty last line unpainted");
  assert.deepEqual(marks(editor), [0], "beside the staging mark");

  // Typing re-diffs against the baselines already read: no git, no probe.
  const probes = t.probes();
  const reads = t.reads();
  writeFileSync(file, "one\ntwo\nthree\nfour\n");
  editor.document.version++;
  onEdit?.({ document: editor.document });
  await until(() => shown(editor).added.length === 4, "the typed line painted");
  assert.deepEqual(shown(editor).added, [0, 1, 2, 3]);
  assert.equal(t.probes(), probes, "the answer is kept with the baselines");
  assert.equal(t.reads(), reads);
  t.gutter.dispose();
});

test("the setting applies live: on paints, off clears at once, on again repaints", async () => {
  settings.clear();
  const t = setup("hl-live");
  const [editor] = t.editors;
  await until(() => marks(editor).length === 3, "the marks painted");
  assert.deepEqual(shown(editor), nothing);

  setSetting(HIGHLIGHT, true);
  await until(() => shown(editor).added.length > 0, "painted once turned on");
  assert.deepEqual(shown(editor), EXPECTED);

  setSetting(HIGHLIGHT, false);
  // At once — not after the git reads the repaint makes.
  assert.deepEqual(shown(editor), nothing, "cleared the moment it is turned off");
  await until(() => marks(editor).length === 3, "the marks repainted");
  await sleep(200);
  assert.deepEqual(shown(editor), nothing, "and nothing paints it back");

  setSetting(HIGHLIGHT, true);
  await until(() => shown(editor).added.length > 0, "painted again");
  assert.deepEqual(shown(editor), EXPECTED);
  t.gutter.dispose();
});

test("a tab that turns into an ordinary one is painted from what was read, with no git", async () => {
  settings.clear();
  settings.set(HIGHLIGHT, true);
  const t = setup("hl-tabs");
  const [editor] = t.editors;
  // The column first reports a diff — VS Code tells the extension about tabs
  // apart from editors, so the editor can arrive before its tab does.
  groups[0].activeTab = { input: new TabInputTextDiff({ toString: () => "git:/f.txt" }, t.document.uri) };
  await until(() => marks(editor).length === 3, "the marks painted");
  await sleep(100);
  assert.deepEqual(shown(editor), nothing, "not painted while its column shows a diff");

  const reads = t.reads();
  groups[0].activeTab = { input: new TabInputText(t.document.uri) };
  onTabs?.();
  assert.deepEqual(shown(editor), EXPECTED, "painted as soon as the tab says it is ordinary");
  assert.equal(t.reads(), reads, "from the blocks already read");

  groups[0].activeTab = { input: new TabInputTextDiff({ toString: () => "git:/f.txt" }, t.document.uri) };
  onTabs?.();
  assert.deepEqual(shown(editor), nothing, "and taken off again when it turns back into a diff");
  t.gutter.dispose();
});
