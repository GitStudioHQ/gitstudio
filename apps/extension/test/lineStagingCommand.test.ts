// Stage / Unstage Selected Lines through the COMMAND (lineStaging.ts, under the
// vscode stand-in) against a real repository — the editor's selection all the
// way to what git's index holds (#87, round 3).
//
// Select All in a file ending in a line break ends at column 0 of the empty
// row after it. Adding that final line break, or emptying the last line, is a
// change on exactly that row, and the column-0 rule dropped it: "nothing to
// stage in the selection", or the edit staged without its line break while the
// status bar said "Staged 1 change".

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { scratchRepo, vscode } from "./changesHost";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { stageSelectedLines, unstageSelectedLines } = require("../src/changes/lineStaging") as typeof import("../src/changes/lineStaging");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const vs = vscode as unknown as { window: Record<string, unknown>; __said: { kind: string; message: string }[] };
const repos: { done: () => void }[] = [];
after(() => repos.forEach((r) => r.done()));

/** A repo whose f.txt is `committed` in HEAD and `working` on disk, an editor on it with Select All. */
function setup(name: string, committed: string, working: string) {
  const r = scratchRepo(name);
  repos.push(r);
  const file = join(r.dir, "f.txt");
  writeFileSync(file, committed);
  r.git("add", "f.txt");
  r.git("commit", "-qm", "base");
  writeFileSync(file, working);
  const text = () => readFileSync(file, "utf8");
  const lines = () => text().split("\n");
  const document = {
    uri: { scheme: "file", fsPath: file, toString: () => `file://${file}` },
    getText: text,
    get lineCount() {
      return lines().length;
    },
    lineAt: (i: number) => ({ text: lines()[i].replace(/\r$/, "") }),
  };
  // Select All, as VS Code reports it: (0, 0) → the end of the last line.
  const last = lines().length - 1;
  const end = { line: last, character: lines()[last].length };
  vs.window.activeTextEditor = {
    document,
    selections: [{ start: { line: 0, character: 0 }, end, active: end, anchor: { line: 0, character: 0 } }],
  };
  const manager = { getAll: () => [{ root: r.dir, ctx: new GitContext({ root: r.dir }) }] };
  return { r, manager, index: () => r.git("show", ":f.txt") };
}

const refresh = { refresh() {} };

for (const [committed, working, what] of [
  ["foo\nbar", "foo\nbar\n", "adding the final line break"],
  ["foo\nbar", "FOO\nbar\n", "an edit and the final line break"],
  ["foo\nbar", "foo\n", "emptying the last line"],
] as const) {
  test(`Select All ▸ Stage Selected Lines stages ${what}; Unstage Selected Lines takes it back`, async () => {
    const t = setup(`cmd-${what.replace(/\W+/g, "-")}`, committed, working);
    vs.__said.length = 0;
    await stageSelectedLines(t.manager as never, refresh);
    assert.equal(t.index(), working, `the whole change is staged (said: ${JSON.stringify(vs.__said)})`);
    await unstageSelectedLines(t.manager as never, refresh);
    assert.equal(t.index(), committed, `and all of it unstaged again (said: ${JSON.stringify(vs.__said)})`);
  });
}
