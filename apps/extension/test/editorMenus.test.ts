// GitStudio's buttons and items in the editor's own menus: only where they can
// act, and grouped under one name.
//
// Every file in a repository got Open Changes and Stage with Ticks in its
// title bar — a clean file too, where both had nothing to show — and six
// GitStudio items at the top level of the editor's right-click menu. The
// blame button did not show whether blame was on. Merge Studio, the same
// commands' twin, already gated them on the file having changes; GitStudio
// now wears the same gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Item = { command?: string; submenu?: string; when?: string; group?: string };
interface Manifest {
  contributes: {
    commands: { command: string; title: string; toggled?: string }[];
    menus: Record<string, Item[]>;
    submenus: { id: string; label: string }[];
  };
}
const read = (app: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", app, "package.json"), "utf8")) as Manifest;
const gs = read("extension");
const ms = read("merge-studio");

/** The clauses of a when, product ids left out, so the two products' gates compare. */
function changeGate(when: string | undefined): string[] {
  return (when ?? "")
    .split("&&")
    .map((c) => c.trim())
    .filter((c) => /scmActiveResourceHasChanges|isInDiffEditor|activeCustomEditorId|resourceScheme/.test(c))
    .map((c) => c.replace(/'(gitstudio|jbMerge)\.mergeEditor'/, "'<merge editor>'"))
    .sort();
}

test("Open Changes and Stage with Ticks are in a file's title bar only when the file has changes — Merge Studio's gate, word for word", () => {
  for (const role of ["openChanges", "stageWithTicks"]) {
    const mine = gs.contributes.menus["editor/title"].find((i) => i.command === `gitstudio.${role}`);
    const twin = ms.contributes.menus["editor/title"].find((i) => i.command === `jbMerge.${role}`);
    assert.ok(mine && twin, role);
    assert.ok(mine.when!.includes("scmActiveResourceHasChanges"), `${role}: gated on changes`);
    assert.deepEqual(changeGate(mine.when), changeGate(twin.when), `${role}: the twins' gates agree`);
  }
});

test("the editor's right-click menu has one GitStudio entry, and its staging items need a change to act on", () => {
  const top = gs.contributes.menus["editor/context"];
  assert.deepEqual(
    top.filter((i) => i.command).map((i) => i.command),
    [],
    "no GitStudio command sits at the top level of the editor's menu",
  );
  const sub = top.find((i) => i.submenu === "gitstudio.editorMenu");
  assert.ok(sub, "the GitStudio submenu is there");
  assert.equal(gs.contributes.submenus.find((s) => s.id === "gitstudio.editorMenu")?.label, "GitStudio");
  const items = gs.contributes.menus["gitstudio.editorMenu"];
  assert.deepEqual(items.map((i) => i.command), [
    "gitstudio.showLineHistory",
    "gitstudio.openFileAtRevision",
    "gitstudio.stageSelectedLines",
    "gitstudio.unstageSelectedLines",
    "gitstudio.stageHunk",
    "gitstudio.unstageHunk",
  ]);
  for (const i of items.filter((x) => /stage/i.test(x.command ?? ""))) {
    assert.match(i.when ?? "", /scmActiveResourceHasChanges/, `${i.command} only where there is a change`);
  }
  const atLine = gs.contributes.menus["editor/lineNumber/context"].find((i) => i.command === "gitstudio.toggleStageAtLine");
  assert.match(atLine?.when ?? "", /scmActiveResourceHasChanges/, "the gutter's Stage or Unstage too");
});

test("Annotate with Git Blame shows whether it is on", () => {
  const cmd = gs.contributes.commands.find((c) => c.command === "gitstudio.toggleFileBlame");
  assert.equal(cmd?.toggled, "gitstudio.blameAnnotated");
  const src = readFileSync(join(__dirname, "..", "src", "blame", "blameController.ts"), "utf8");
  assert.match(src, /"setContext",\s*"gitstudio\.blameAnnotated"/, "the key it reads is the one blame publishes");
});

test("every submenu a menu names is declared, and every declared one is used", () => {
  const declared = new Set(gs.contributes.submenus.map((s) => s.id));
  const used = new Set<string>();
  for (const items of Object.values(gs.contributes.menus)) {
    for (const i of items) if (i.submenu) used.add(i.submenu);
  }
  assert.deepEqual([...used].filter((id) => !declared.has(id)), []);
  assert.deepEqual([...declared].filter((id) => !used.has(id)), []);
});
