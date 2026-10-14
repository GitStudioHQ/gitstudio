// GitStudio's buttons and items in the editor's own menus: only where they can
// act, and grouped under one name.
//
// Every file in a repository got Open Changes and Stage with Ticks in its
// title bar — a clean file too, where both had nothing to show — and six
// GitStudio items at the top level of the editor's right-click menu. The
// blame button did not show whether blame was on. Merge Studio, the same
// commands' twin, already gated them on the file having changes; GitStudio
// now wears the same gate.
//
// That gate alone hid every staging item in a DIFF editor (#87): VS Code
// computes `scmActiveResourceHasChanges` from the active editor's resource
// without looking inside a side-by-side editor, so it is false in every diff —
// including the one GitStudio's own Changes list opens, where the staging
// glyphs are drawn. The staging items are asked about in the editors a user
// right-clicks in, through a real when-clause evaluator, not by substring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAppManifest } from "./manifest";
import { evalWhen, type WhenContext } from "./whenClause";

type Item = { command?: string; submenu?: string; when?: string; group?: string };
interface Manifest {
  contributes: {
    commands: { command: string; title: string; toggled?: string }[];
    menus: Record<string, Item[]>;
    submenus: { id: string; label: string }[];
  };
}
const read = (app: string) => readAppManifest<Manifest>(join(__dirname, "..", "..", app));
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
    "gitstudio.revealCommitInGraph",
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

// The editors a user right-clicks in, with the context keys VS Code 1.140 sets
// there — read in a real window, over a diff opened from the Changes list
// (left: gitstudio-rev:, the index; right: the file) and over a plain editor:
//
//   - scmActiveResourceHasChanges is false in EVERY diff editor;
//   - resourceScheme is the diff's PRIMARY (working) resource on both sides;
//   - isInDiffRightEditor follows FOCUS, and right-clicking a gutter does not
//     move focus — so with the left side focused, the right side's line-number
//     menu said it was not in the right editor;
//   - editorReadonly belongs to each side: the left (HEAD / index) is read-only;
//   - diffEditorOriginalUri is the left side's URI, on both sides: a Git
//     revision (gitstudio-rev: from GitStudio, git: from VS Code's Git) only
//     when the diff is a change against the repository.
const COMMON: WhenContext = { "gitstudio.hasRepo": true, editorTextFocus: true };
const DIFF: WhenContext = {
  ...COMMON,
  resourceScheme: "file",
  scmActiveResourceHasChanges: false,
  isInDiffEditor: true,
  diffEditorOriginalUri: "gitstudio-rev:/src/app.ts?rev%3D%26root%3D%252Frepo",
};
const EDITORS: Record<string, { ctx: WhenContext; staging: boolean }> = {
  "a plain editor on a changed file": {
    ctx: { ...COMMON, resourceScheme: "file", scmActiveResourceHasChanges: true },
    staging: true,
  },
  "a plain editor on a clean file": {
    ctx: { ...COMMON, resourceScheme: "file", scmActiveResourceHasChanges: false },
    staging: false,
  },
  "the working side of a diff": {
    ctx: { ...DIFF, isInDiffRightEditor: true, editorReadonly: false },
    staging: true,
  },
  "the working side of a diff, its other side focused": {
    ctx: { ...DIFF, isInDiffRightEditor: false, isInDiffLeftEditor: true, editorReadonly: false },
    staging: true,
  },
  "the index/HEAD side of a diff": {
    ctx: { ...DIFF, isInDiffRightEditor: false, isInDiffLeftEditor: true, editorReadonly: true },
    staging: false,
  },
  "the working side of VS Code's own Git: Open Changes diff": {
    ctx: {
      ...DIFF,
      isInDiffRightEditor: true,
      editorReadonly: false,
      diffEditorOriginalUri: "git:/repo/src/app.ts?%7B%22path%22%3A%22%2Frepo%2Fsrc%2Fapp.ts%22%2C%22ref%22%3A%22~%22%7D",
    },
    staging: true,
  },
  // A diff embedded in another view (a peek, an inline chat edit) is no place
  // to stage from; VS Code's own git items leave it out too.
  "an embedded diff": {
    ctx: { ...DIFF, isInDiffRightEditor: true, editorReadonly: false, isEmbeddedDiffEditor: true },
    staging: false,
  },
  // Explorer ▸ Compare with Selected: the items would stage B's own changes
  // against its index, not the A ↔ B differences on screen — and for two files
  // outside every repository they could only say so.
  "a compare of two files": {
    ctx: { ...DIFF, isInDiffRightEditor: true, editorReadonly: false, diffEditorOriginalUri: "file:///repo/src/a.ts" },
    staging: false,
  },
  "Compare with Saved": {
    ctx: {
      ...DIFF,
      isInDiffRightEditor: true,
      editorReadonly: false,
      diffEditorOriginalUri: "showModifications:/repo/src/app.ts",
    },
    staging: false,
  },
  // VS Code before the diff editor published its sides: no key, no items in a
  // diff — what 1.15–1.18 did everywhere, never worse.
  "a diff in a VS Code too old to say its left side": {
    ctx: { ...DIFF, isInDiffRightEditor: true, editorReadonly: false, diffEditorOriginalUri: undefined },
    staging: false,
  },
};

test("#87: the staging items are in the GitStudio menu wherever there is a working file to stage from — a diff's working side included", () => {
  const top = gs.contributes.menus["editor/context"].find((i) => i.submenu === "gitstudio.editorMenu");
  const items = gs.contributes.menus["gitstudio.editorMenu"].filter((i) => /stage/i.test(i.command ?? ""));
  assert.equal(items.length, 4);
  for (const [where, { ctx, staging }] of Object.entries(EDITORS)) {
    assert.ok(evalWhen(top?.when, ctx), `the GitStudio submenu is in ${where}`);
    for (const i of items) {
      assert.equal(evalWhen(i.when, ctx), staging, `${i.command} in ${where}`);
    }
  }
});

test("#87: right-clicking a change's line number — or its gutter mark, which opens the same menu — offers Stage or Unstage in a diff too", () => {
  const atLine = gs.contributes.menus["editor/lineNumber/context"].find((i) => i.command === "gitstudio.toggleStageAtLine");
  assert.ok(atLine);
  for (const [where, { ctx, staging }] of Object.entries(EDITORS)) {
    assert.equal(evalWhen(atLine.when, ctx), staging, `Stage or Unstage the Change at This Line in ${where}`);
  }
});

test("#87: the staging commands are listed in the Command Palette", () => {
  // The palette evaluates its entries with the palette's own input focused, so
  // `editorTextFocus` is never true there: an entry gated on it is never listed
  // (seen in a real window — "GitStudio: Stage Selected Lines" was missing).
  const palette = gs.contributes.menus.commandPalette;
  const ctx: WhenContext = { "gitstudio.hasRepo": true, resourceScheme: "file", editorTextFocus: false };
  for (const id of [
    "gitstudio.stageSelectedLines",
    "gitstudio.unstageSelectedLines",
    "gitstudio.stageHunk",
    "gitstudio.unstageHunk",
    "gitstudio.toggleStageAtLine",
  ]) {
    const entry = palette.find((e) => e.command === id);
    assert.ok(entry, id);
    assert.ok(evalWhen(entry.when, ctx), `${id} is listed (when: ${entry.when})`);
    assert.doesNotMatch(entry.when ?? "", /editorTextFocus/, `${id}: editorTextFocus hides it`);
  }
});

test("#87: the line-number command acts on the document the menu was opened on, not on whichever editor is active", () => {
  const src = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");
  const at = src.indexOf('"gitstudio.toggleStageAtLine"');
  const handler = src.slice(at, src.indexOf("registerCommand(", at));
  assert.match(handler, /lineMenuTarget\(\s*arg,/, "the menu's { lineNumber, uri } decides the target");
  assert.match(handler, /toggleAtUri\(target\.uri, target\.line\)/);
  assert.doesNotMatch(handler, /toggleAtLine\(editor\.document/, "never the active editor's document when the menu named one");
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

// Issue #111: a revision opened from a file's history — Show File History,
// Line History — finds its commit in the Commit Graph from the
// editor's title bar and its GitStudio menu. Only there: a working file is no commit.
test("Show Commit in Graph sits on a revision's title bar and GitStudio menu, nowhere else", () => {
  const cmd = gs.contributes.commands.find((c) => c.command === "gitstudio.revealCommitInGraph") as { icon?: string } | undefined;
  assert.ok(cmd?.icon, "a title-bar button needs an icon");
  const title = gs.contributes.menus["editor/title"].find((i) => i.command === "gitstudio.revealCommitInGraph");
  const menu = gs.contributes.menus["gitstudio.editorMenu"].find((i) => i.command === "gitstudio.revealCommitInGraph");
  assert.ok(title && menu);
  assert.match(title.group ?? "", /^navigation/);
  const revision: WhenContext = { ...COMMON, resourceScheme: "gitstudio-rev", isInDiffEditor: true };
  const working: WhenContext = { ...COMMON, resourceScheme: "file", scmActiveResourceHasChanges: true };
  assert.equal(evalWhen(title.when, revision), true, "a history diff's title bar");
  assert.equal(evalWhen(menu.when, revision), true, "its GitStudio menu");
  assert.equal(evalWhen(title.when, working), false, "not a working file's");
  assert.equal(evalWhen(menu.when, working), false);
});
