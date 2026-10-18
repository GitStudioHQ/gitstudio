// What the staging marks in VS Code's own gutter LOOK like — #87, reopened.
//
// A VS Code extension cannot make a gutter icon clickable: the decoration API
// has no click, and Monaco swallows a left click in the glyph margin. The marks
// used to be drawn as checkboxes — an empty box for an unstaged change, a
// ticked one for a staged change — so a user in VS Code's diff editor saw a
// column of checkboxes that did nothing when clicked. A mark that can only
// REPORT must not be drawn as a control: no box, and no tick.
//
// The glyphs are read through the decoration types StagedGutter really makes,
// so a new state or a renamed file cannot slip past.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { vscode } from "./changesHost";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { StagedGutter } = require("../src/changes/stagedGutter") as typeof import("../src/changes/stagedGutter");
/* eslint-enable @typescript-eslint/no-require-imports */

const vs = vscode as unknown as { window: Record<string, unknown>; workspace: Record<string, unknown>; Uri: object };

Object.assign(vs.Uri, {
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }),
});
const made: { gutterIconPath?: { fsPath: string } }[] = [];
vs.window.createTextEditorDecorationType = (options: { gutterIconPath?: { fsPath: string } }) => {
  made.push(options);
  return { dispose() {} };
};
vs.window.visibleTextEditors = [];

const extensionRoot = join(__dirname, "..");
const manager = { getAll: () => [], onDidChange: () => ({ dispose() {} }) };
const gutter = new StagedGutter({ extensionUri: { fsPath: extensionRoot } } as never, manager as never);
gutter.dispose();

const glyphs = made.map((options) => {
  const file = options.gutterIconPath?.fsPath ?? "";
  assert.ok(existsSync(file), `a decoration type's gutter icon exists: ${file}`);
  return { name: file.split(/[\\/]/).pop() ?? file, svg: readFileSync(file, "utf8") };
});

test("there is a gutter glyph for every staging state", () => {
  assert.deepEqual(glyphs.map((g) => g.name).sort(), ["partial.svg", "staged.svg", "unstaged.svg"]);
});

test("no gutter glyph is drawn as a checkbox, since none of them can be clicked (#87)", () => {
  for (const { name, svg } of glyphs) {
    assert.doesNotMatch(svg, /<rect\b/, `${name} draws no box`);
    assert.doesNotMatch(svg, /<(path|polyline)\b[^>]*fill="none"/, `${name} draws no stroked tick`);
  }
});

test("the states differ in shape, not only in colour", () => {
  const shapes = glyphs.map((g) => g.svg.replace(/#[0-9a-f]{3,8}\b/gi, "COLOUR"));
  assert.equal(new Set(shapes).size, shapes.length);
});
