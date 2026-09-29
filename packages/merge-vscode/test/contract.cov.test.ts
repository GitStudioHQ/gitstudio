import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkManifest,
  COMMAND_TITLES,
  configurationProperties,
  MERGE_SETTINGS_SPEC,
  WHEN,
  type CommandRole,
} from "../src/contract";
import type { MergeCommandIds } from "../src/product";

// The manifest checker's remaining ways a manifest can break the contract:
// a menu entry with the wrong gate, settings missing or mistyped, and a
// configuration split over several blocks.

const ids = Object.fromEntries(
  (Object.keys(COMMAND_TITLES) as CommandRole[]).map((r) => [r, `p.${r}`]),
) as unknown as MergeCommandIds;

function manifest(configuration: unknown) {
  return {
    contributes: {
      commands: (Object.keys(COMMAND_TITLES) as CommandRole[]).map((r) => ({ command: `p.${r}`, title: COMMAND_TITLES[r] })),
      menus: {
        "scm/resourceGroup/context": [{ command: "p.showConflicts", when: WHEN.scmMergeGroup }],
        "scm/resourceState/context": [{ command: "p.resolveInMergeEditor", when: WHEN.scmMergeGroup }],
        "editor/title": [
          { command: "p.resolveInMergeEditor", when: WHEN.editorHasMergeConflicts },
          { command: "p.openChanges", when: "resourceScheme == file" },
          // An entry with no command (a submenu) is not a merge action.
          { when: "true" },
        ],
        "explorer/context": [{ command: "p.compare", when: "!explorerResourceIsFolder" }],
      } as Record<string, { command?: string; when?: string }[]>,
      configuration,
    },
  };
}

const settings = (section: string) =>
  Object.fromEntries(MERGE_SETTINGS_SPEC.map((s) => [`${section}.${s.key}`, { type: s.type, default: s.default }]));

test("settings contributed across several configuration blocks conform", () => {
  const props = settings("p.merge");
  const [first, ...rest] = Object.entries(props);
  const blocks = [{ title: "A", properties: Object.fromEntries([first]) }, { title: "B", properties: Object.fromEntries(rest) }, { title: "C" }];
  assert.deepEqual(checkManifest(manifest(blocks), ids, "p.merge"), []);
});

test("configurationProperties: an object, an array of them, or nothing", () => {
  assert.deepEqual(configurationProperties(undefined), {});
  assert.deepEqual(configurationProperties({ properties: { a: 1 } }), { a: 1 });
  assert.deepEqual(configurationProperties([{ properties: { a: 1 } }, { properties: { b: 2 } }, {}]), { a: 1, b: 2 });
});

test("a menu entry gated on the wrong clause is reported with both clauses", () => {
  const m = manifest({ properties: settings("p.merge") });
  m.contributes.menus["scm/resourceState/context"] = [{ command: "p.resolveInMergeEditor", when: "scmProvider == git" }];
  const problems = checkManifest(m, ids, "p.merge");
  assert.deepEqual(problems, [
    `scm/resourceState/context p.resolveInMergeEditor: when is "scmProvider == git", expected "${WHEN.scmMergeGroup}"`,
  ]);
});

test("a menu entry missing a required piece of its clause is reported; one with no clause at all too", () => {
  const m = manifest({ properties: settings("p.merge") });
  m.contributes.menus["explorer/context"] = [{ command: "p.compare" }];
  const problems = checkManifest(m, ids, "p.merge");
  assert.deepEqual(problems, [`explorer/context p.compare: when "" must include "!explorerResourceIsFolder"`]);
});

test("a setting missing from the manifest, or with the wrong type, is reported", () => {
  const props = settings("p.merge") as Record<string, { type: string; default: unknown }>;
  delete props["p.merge.autoOpen"];
  props["p.merge.autoApplyNonConflicting"] = { type: "string", default: false };
  const problems = checkManifest(manifest({ properties: props }), ids, "p.merge");
  assert.deepEqual(problems, [
    "setting p.merge.autoOpen is not contributed",
    "setting p.merge.autoApplyNonConflicting has type string, expected boolean",
  ]);
});

test("settings under another product's section do not count", () => {
  const problems = checkManifest(manifest({ properties: settings("other") }), ids, "p.merge");
  assert.deepEqual(
    problems,
    MERGE_SETTINGS_SPEC.map((s) => `setting p.merge.${s.key} is not contributed`),
  );
});

test("a manifest that contributes nothing reports every command, menu and setting", () => {
  const problems = checkManifest({}, ids, "p.merge");
  for (const role of Object.keys(ids) as CommandRole[]) {
    assert.ok(problems.includes(`command p.${role} (${role}) is registered but not declared in contributes.commands`));
  }
  assert.ok(problems.includes("editor/title has no entry for p.resolveInMergeEditor"));
  assert.ok(problems.includes("setting p.merge.autoOpen is not contributed"));
});
