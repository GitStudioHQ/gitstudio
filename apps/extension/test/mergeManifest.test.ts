import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkManifest,
  configurationProperties,
  JB_MERGE_COMMAND_TWINS,
  JB_MERGE_SETTING_TWINS,
} from "@gitstudio/merge-vscode/contract";
import {
  GITSTUDIO_IDE_CONTEXT_KEY,
  GITSTUDIO_MERGE_COMMANDS,
  GITSTUDIO_MERGE_SECTION,
  GITSTUDIO_WALKTHROUGH_COMMAND,
} from "../src/merge/mergeIds";

// GitStudio's package.json against the merge experience's manifest contract
// (packages/merge-vscode/src/contract.ts) — the same table Merge Studio's
// manifest is checked against, so a merge capability one product contributes
// and the other does not fails here.

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command?: string; when?: string; group?: string }[]>;
    configuration: unknown;
    customEditors: { viewType: string; priority?: string }[];
  };
  capabilities?: {
    untrustedWorkspaces?: { supported: boolean | "limited"; restrictedConfigurations?: string[] };
  };
};

test("GitStudio contributes every merge command, gated menu and setting the shared experience registers", () => {
  const problems = checkManifest(manifest, GITSTUDIO_MERGE_COMMANDS, GITSTUDIO_IDE_CONTEXT_KEY, GITSTUDIO_MERGE_SECTION);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every Merge Studio command has its GitStudio twin", () => {
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));
  const missing: string[] = [];
  for (const [jb, role] of Object.entries(JB_MERGE_COMMAND_TWINS)) {
    const id = role === "openWalkthrough" ? GITSTUDIO_WALKTHROUGH_COMMAND : GITSTUDIO_MERGE_COMMANDS[role];
    if (!declared.has(id)) {
      missing.push(`${jb} → ${id}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every Merge Studio setting has its gitstudio.merge.* twin, and auto-apply is off by default", () => {
  const props = configurationProperties(manifest.contributes.configuration) as Record<string, { default?: unknown }>;
  for (const [jb, key] of Object.entries(JB_MERGE_SETTING_TWINS)) {
    assert.ok(props[`${GITSTUDIO_MERGE_SECTION}.${key}`], `${jb} has no GitStudio twin`);
  }
  assert.equal(props["gitstudio.merge.autoApplyNonConflicting"].default, false);
});

test("the launcher path cannot be set by an untrusted workspace", () => {
  // Either GitStudio is off in Restricted Mode altogether, or the setting is
  // restricted there (a workspace-supplied executable path is an exec vector).
  const u = manifest.capabilities?.untrustedWorkspaces;
  assert.ok(u, "declare untrustedWorkspaces explicitly");
  const protectedPath =
    u.supported === false ||
    (u.supported === "limited" && (u.restrictedConfigurations ?? []).includes("gitstudio.merge.jetbrainsPath"));
  assert.ok(protectedPath, JSON.stringify(u));
});

test("the merge editor stays an 'Open With…' option, never the default for every file", () => {
  const editor = manifest.contributes.customEditors.find((e) => e.viewType === "gitstudio.mergeEditor");
  assert.equal(editor?.priority, "option");
});

test("the SCM view's Merge Changes header offers Resolve Conflicts… as a button, not only in its menu", () => {
  const header = manifest.contributes.menus["scm/resourceGroup/context"] ?? [];
  assert.ok(header.some((e) => e.command === GITSTUDIO_MERGE_COMMANDS.showConflicts && e.group === "inline"));
});
