// The staging marks in VS Code's own gutter, driven for real (StagedGutter
// under the vscode stand-in) against a real repository — #87.
//
// The marks used to be painted once per edit or focus and then trusted: an
// index moved by anything else — VS Code's own Source Control view or diff
// gutter, a terminal — left them showing the old state, and the toggle read
// that stale state to decide its DIRECTION. A change staged elsewhere but
// still painted "unstaged" was staged again, which does nothing; one unstaged
// elsewhere but still painted "staged" was unstaged again — nothing. Seen in a
// real VS Code window: the toggle looked dead.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { scratchRepo, vscode } from "./changesHost";
import type { RepoChangeEvent } from "../src/git/repoChange";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { StagedGutter } = require("../src/changes/stagedGutter") as typeof import("../src/changes/stagedGutter");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const vs = vscode as unknown as { window: Record<string, unknown>; Range: unknown };

// A real Range: the stand-in's answers anything, including `start.line`.
vs.Range = class {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(sl: number, sc: number, el: number, ec: number) {
    this.start = { line: sl, character: sc };
    this.end = { line: el, character: ec };
  }
};

// The decoration types in the order StagedGutter makes them: staged, unstaged, partial.
const STATES = ["staged", "unstaged", "partial"] as const;
let made = 0;
vs.window.createTextEditorDecorationType = () => ({ state: STATES[made++ % 3], dispose() {} });

const repos: { done: () => void }[] = [];
after(() => repos.forEach((r) => r.done()));

function setup(name: string) {
  const r = scratchRepo(name);
  repos.push(r);
  const file = join(r.dir, "f.txt");
  writeFileSync(file, "a\nb\nc\nd\ne\n");
  r.git("add", "f.txt");
  r.git("commit", "-qm", "base");
  writeFileSync(file, "a\nB\nc\nd\nE\n"); // two one-line changes: lines 1 and 4 (0-based)

  const uri = { scheme: "file", fsPath: file, toString: () => `file://${file}` };
  const document = { uri, getText: () => readFileSync(file, "utf8"), lineCount: 6 };
  // What each change's mark was last painted as, by 0-based line.
  const painted = new Map<number, string>();
  const editor = {
    document,
    setDecorations: (type: { state: string }, ranges: { start: { line: number } }[]) => {
      for (const [line, state] of [...painted]) if (state === type.state) painted.delete(line);
      for (const range of ranges) painted.set(range.start.line, type.state);
    },
  };
  vs.window.visibleTextEditors = [editor];

  let onRepoChange: ((e: RepoChangeEvent) => void) | undefined;
  const entry = { root: r.dir, ctx: new GitContext({ root: r.dir }) };
  // Every read of git the marks make.
  let reads = 0;
  const staging = entry.ctx.staging as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ["indexContent", "headContent"]) {
    const real = staging[name].bind(staging);
    staging[name] = (...a: unknown[]) => {
      reads++;
      return real(...a);
    };
  }
  const manager = {
    getAll: () => [entry],
    onDidChange: (listener: (e: RepoChangeEvent) => void) => {
      onRepoChange = listener;
      return { dispose() {} };
    },
  };
  const gutter = new StagedGutter({ extensionUri: {} } as never, manager as never);
  return {
    r,
    gutter,
    document,
    painted,
    index: () => r.git("show", ":f.txt"),
    reads: () => reads,
    fireRepoChange: (kind: "workingTree" | "refs" = "workingTree") => onRepoChange?.({ kinds: new Set([kind]) }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

test("the marks follow the index when something else stages", async () => {
  const t = setup("gutter-follow");
  await settle();
  assert.equal(t.painted.get(1), "unstaged", "painted from git at the start");
  t.r.git("add", "f.txt"); // staged from a terminal (or VS Code's own Source Control)
  t.fireRepoChange();
  await settle();
  assert.equal(t.painted.get(1), "staged", "repainted when the repository says it changed");
  assert.equal(t.painted.get(4), "staged");
  t.gutter.dispose();
});

test("the toggle reads git, not the last paint: a change unstaged elsewhere is staged again, not 'unstaged' twice", async () => {
  const t = setup("gutter-toggle");
  await settle();
  await t.gutter.toggleAtLine(t.document as never, 1);
  assert.equal(t.index(), "a\nB\nc\nd\ne\n", "the first toggle stages line 1's change");
  // Unstaged behind the gutter's back (VS Code's own SCM view, a terminal):
  // the mark still says "staged" — no repository event is fired here.
  t.r.git("reset", "-q");
  assert.equal(t.painted.get(1), "staged", "the stale paint the old toggle trusted");
  await t.gutter.toggleAtLine(t.document as never, 1);
  assert.equal(t.index(), "a\nB\nc\nd\ne\n", "the toggle staged it again — it read git, not the paint");
  t.gutter.dispose();
});

test("a status run that left the index alone reads no git; a moved index or HEAD does", async () => {
  // vscode.git reports a working-tree change on every save and window focus.
  const t = setup("gutter-quiet");
  await settle();
  t.fireRepoChange(); // the first look records the index file
  await settle();
  const before = t.reads();
  t.fireRepoChange();
  t.fireRepoChange();
  await settle();
  assert.equal(t.reads(), before, "no repaint while the index file is the same file");
  t.r.git("add", "f.txt");
  t.fireRepoChange();
  await settle();
  assert.ok(t.reads() > before, "the index moved: repainted");
  assert.equal(t.painted.get(1), "staged");
  const afterAdd = t.reads();
  t.fireRepoChange("refs"); // a commit, a checkout: HEAD moved
  await settle();
  assert.ok(t.reads() > afterAdd, "a ref change always repaints");
  t.gutter.dispose();
});
