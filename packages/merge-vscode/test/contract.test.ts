import { test } from "node:test";
import assert from "node:assert/strict";
import { checkManifest, COMMAND_TITLES, MERGE_SETTINGS_SPEC, WHEN, type CommandRole } from "../src/contract";
import type { MergeCommandIds } from "../src/product";

// The manifest checker itself: a conforming manifest passes, and each way of
// breaking the contract is reported. (Each product's own test runs it against
// its real package.json.)

const ids = Object.fromEntries(
  (Object.keys(COMMAND_TITLES) as CommandRole[]).map((r) => [r, `p.${r}`]),
) as unknown as MergeCommandIds;
const IDE = "p.ideAvailable";

function conforming() {
  return {
    contributes: {
      commands: (Object.keys(COMMAND_TITLES) as CommandRole[]).map((r) => ({ command: `p.${r}`, title: COMMAND_TITLES[r] })),
      menus: {
        "scm/resourceGroup/context": [{ command: "p.showConflicts", when: WHEN.scmMergeGroup, group: "inline" }],
        "scm/resourceState/context": [
          { command: "p.resolveInMergeEditor", when: WHEN.scmMergeGroup },
          { command: "p.mergeWithJetBrains", when: `${WHEN.scmMergeGroup} && ${IDE}` },
        ],
        "editor/title": [
          { command: "p.resolveInMergeEditor", when: WHEN.editorHasMergeConflicts },
          { command: "p.mergeWithJetBrains", when: `${WHEN.editorHasMergeConflicts} && ${IDE}` },
          { command: "p.openChanges", when: "resourceScheme == file" },
        ],
        "explorer/context": [{ command: "p.compare", when: "!explorerResourceIsFolder" }],
      },
      configuration: {
        properties: Object.fromEntries(
          MERGE_SETTINGS_SPEC.map((s) => [`p.merge.${s.key}`, { type: s.type, default: s.default, ...(s.enum ? { enum: s.enum } : {}) }]),
        ),
      },
    },
  };
}

test("a conforming manifest has no problems", () => {
  assert.deepEqual(checkManifest(conforming(), ids, IDE, "p.merge"), []);
});

test("an ungated editor-title merge action is reported (the GitStudio 1.13 manifest's defect)", () => {
  const m = conforming();
  m.contributes.menus["editor/title"][0].when = "gitstudio.hasRepo && resourceScheme == file";
  const problems = checkManifest(m, ids, IDE, "p.merge");
  assert.ok(problems.some((p) => /not gated on git\.activeResourceHasMergeConflicts/.test(p)), problems.join("\n"));
});

test("a JetBrains entry shown without the ideAvailable key is reported", () => {
  const m = conforming();
  m.contributes.menus["scm/resourceState/context"][1].when = WHEN.scmMergeGroup;
  assert.ok(checkManifest(m, ids, IDE, "p.merge").some((p) => /shown without p\.ideAvailable/.test(p)));
});

test("a registered command missing from contributes.commands, or a menu naming an undeclared one, is reported", () => {
  const m = conforming();
  m.contributes.commands = m.contributes.commands.filter((c) => c.command !== "p.operationSkip");
  m.contributes.menus["explorer/context"].push({ command: "p.nope", when: "true" });
  const problems = checkManifest(m, ids, IDE, "p.merge");
  assert.ok(problems.some((p) => /p\.operationSkip \(operationSkip\) is registered but not declared/.test(p)));
  assert.ok(problems.some((p) => /uses p\.nope/.test(p)));
});

test("auto-apply defaulting ON (the plan's D3 before the override) is reported", () => {
  const m = conforming();
  (m.contributes.configuration.properties as Record<string, { default: unknown }>)["p.merge.autoApplyNonConflicting"].default = true;
  assert.ok(checkManifest(m, ids, IDE, "p.merge").some((p) => /autoApplyNonConflicting defaults to true, expected false/.test(p)));
});

test("the SCM 'Merge Changes' header entry is required", () => {
  const m = conforming();
  m.contributes.menus["scm/resourceGroup/context"] = [];
  assert.ok(checkManifest(m, ids, IDE, "p.merge").some((p) => /scm\/resourceGroup\/context has no entry for p\.showConflicts/.test(p)));
});
