import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkManifest,
  configurationProperties,
  JB_MERGE_COMMAND_TWINS,
  JB_MERGE_SETTING_TWINS,
  MERGE_SETTINGS_SPEC,
  type CommandRole,
} from "@gitstudio/merge-vscode/contract";
import {
  GITSTUDIO_SHARED_MERGE_COMMAND,
  hasSharedMergeExperience,
  type MergeCommandIds,
} from "@gitstudio/merge-vscode/product";
import { MS_IDE_CONTEXT_KEY, MS_MERGE_COMMANDS, MS_SETTINGS_SECTION, MS_WALKTHROUGH_COMMAND } from "../src/ids";

// "No diff between the standalone extension and the combined one, no parts
// missing" (POLISH §3 iii), as a test: Merge Studio's package.json against
// GitStudio's, both ways. Every jbMerge.* command, setting and menu entry must
// have its gitstudio.* twin, and every merge capability GitStudio contributes
// must have its jbMerge.* twin — so a capability added to one manifest and not
// the other fails here, in whichever repository this runs:
// - the gitstudio monorepo, where GitStudio's side is ../extension;
// - the standalone merge-studio repository, where scripts/merge-studio/export.mjs
//   vendors GitStudio's manifest and ids under vendor/gitstudio/extension
//   (hash-checked by check-parity.mjs like every other vendored file).

type Entry = { command?: string; when?: string; group?: string };
interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, Entry[]>;
    configuration: unknown;
    keybindings?: { command: string; key: string }[];
  };
}

const MS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GS_ROOT = existsSync(join(MS_ROOT, "vendor/gitstudio"))
  ? join(MS_ROOT, "vendor/gitstudio/extension")
  : resolve(MS_ROOT, "../extension");

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const ms = readJson<Manifest>(join(MS_ROOT, "package.json"));
const gs = readJson<Manifest>(join(GS_ROOT, "package.json"));

let GS_COMMANDS: MergeCommandIds;
let GS_SECTION: string;
let GS_IDE_KEY: string;
let GS_WALKTHROUGH: string;

before(async () => {
  // GitStudio's ids module (vscode-free). Loaded by path, so the same test
  // runs in both layouts.
  const ids = (await import(pathToFileURL(join(GS_ROOT, "src/merge/mergeIds.ts")).href)) as {
    GITSTUDIO_MERGE_COMMANDS: MergeCommandIds;
    GITSTUDIO_MERGE_SECTION: string;
    GITSTUDIO_IDE_CONTEXT_KEY: string;
    GITSTUDIO_WALKTHROUGH_COMMAND: string;
  };
  GS_COMMANDS = ids.GITSTUDIO_MERGE_COMMANDS;
  GS_SECTION = ids.GITSTUDIO_MERGE_SECTION;
  GS_IDE_KEY = ids.GITSTUDIO_IDE_CONTEXT_KEY;
  GS_WALKTHROUGH = ids.GITSTUDIO_WALKTHROUGH_COMMAND;
});

type Role = CommandRole | "openWalkthrough";

function roleIn(ids: MergeCommandIds, walkthrough: string, command: string | undefined): Role | undefined {
  if (!command) return undefined;
  if (command === walkthrough) return "openWalkthrough";
  return (Object.keys(ids) as CommandRole[]).find((r) => ids[r] === command);
}

const msRole = (command: string | undefined) => roleIn(MS_MERGE_COMMANDS, MS_WALKTHROUGH_COMMAND, command);
const gsRole = (command: string | undefined) => roleIn(GS_COMMANDS, GS_WALKTHROUGH, command);
const declared = (m: Manifest) => new Set(m.contributes.commands.map((c) => c.command));

test("Merge Studio's manifest satisfies the shared merge contract (the same table GitStudio's is checked against)", () => {
  const problems = checkManifest(ms, MS_MERGE_COMMANDS, MS_IDE_CONTEXT_KEY, MS_SETTINGS_SECTION);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("GitStudio's manifest satisfies the same contract (the other half of the pair)", () => {
  const problems = checkManifest(gs, GS_COMMANDS, GS_IDE_KEY, GS_SECTION);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every jbMerge.* command Merge Studio declares has a declared gitstudio.* twin", () => {
  const gsDeclared = declared(gs);
  const problems: string[] = [];
  for (const { command } of ms.contributes.commands) {
    const role = msRole(command);
    if (!role) {
      problems.push(`${command}: not a merge role — add it to MergeCommandIds (both products) or remove it`);
      continue;
    }
    const twin = role === "openWalkthrough" ? GS_WALKTHROUGH : GS_COMMANDS[role];
    if (!gsDeclared.has(twin)) problems.push(`${command} → ${twin} is not declared by GitStudio`);
  }
  assert.deepEqual(problems, []);
});

test("every merge command GitStudio declares has a declared jbMerge.* twin", () => {
  const msDeclared = declared(ms);
  const problems: string[] = [];
  const gsMerge = gs.contributes.commands
    .map((c) => c.command)
    .filter((c) => gsRole(c) !== undefined || c.startsWith("gitstudio.merge."));
  for (const command of gsMerge) {
    const role = gsRole(command);
    if (!role) {
      problems.push(`${command}: a gitstudio.merge.* command with no role in MergeCommandIds`);
      continue;
    }
    const twin = role === "openWalkthrough" ? MS_WALKTHROUGH_COMMAND : MS_MERGE_COMMANDS[role];
    if (!msDeclared.has(twin)) problems.push(`${command} → ${twin} is not declared by Merge Studio`);
  }
  // …and every role GitStudio registers, declared or not (a registered command
  // missing from Merge Studio's manifest is unreachable from its UI).
  for (const role of Object.keys(GS_COMMANDS) as CommandRole[]) {
    if (!msDeclared.has(MS_MERGE_COMMANDS[role])) problems.push(`${role}: ${MS_MERGE_COMMANDS[role]} is not declared`);
  }
  assert.deepEqual(problems, []);
});

test("Merge Studio 0.3.4's command and setting ids are all still contributed", () => {
  const msDeclared = declared(ms);
  for (const id of Object.keys(JB_MERGE_COMMAND_TWINS)) {
    assert.ok(msDeclared.has(id), `${id} (0.3.4) is gone`);
  }
  const props = configurationProperties(ms.contributes.configuration);
  for (const id of Object.keys(JB_MERGE_SETTING_TWINS)) {
    assert.ok(props[id], `${id} (0.3.4) is gone`);
  }
  // The 0.3.4 roles map onto the same ids the product registers.
  for (const [id, role] of Object.entries(JB_MERGE_COMMAND_TWINS)) {
    const registered = role === "openWalkthrough" ? MS_WALKTHROUGH_COMMAND : MS_MERGE_COMMANDS[role];
    assert.equal(registered, id);
  }
});

test("settings: every jbMerge.* has its gitstudio.merge.* twin and the reverse, with the same type, default, values and scope", () => {
  type Prop = { type?: string; default?: unknown; enum?: unknown[]; scope?: string };
  const msProps = configurationProperties(ms.contributes.configuration) as Record<string, Prop>;
  const gsProps = configurationProperties(gs.contributes.configuration) as Record<string, Prop>;
  const msKeys = Object.keys(msProps)
    .filter((k) => k.startsWith(`${MS_SETTINGS_SECTION}.`))
    .map((k) => k.slice(MS_SETTINGS_SECTION.length + 1));
  const gsKeys = Object.keys(gsProps)
    .filter((k) => k.startsWith(`${GS_SECTION}.`))
    .map((k) => k.slice(GS_SECTION.length + 1));
  assert.deepEqual([...msKeys].sort(), [...gsKeys].sort(), "the two products contribute different merge settings");
  assert.deepEqual([...msKeys].sort(), MERGE_SETTINGS_SPEC.map((s) => s.key).sort());
  for (const key of msKeys) {
    const a = msProps[`${MS_SETTINGS_SECTION}.${key}`];
    const b = gsProps[`${GS_SECTION}.${key}`];
    assert.equal(a.type, b.type, `${key}: type`);
    assert.deepEqual(a.default, b.default, `${key}: default`);
    assert.deepEqual(a.enum, b.enum, `${key}: values`);
    assert.equal(a.scope, b.scope, `${key}: scope`);
  }
  // Decision for this build: auto-apply is off by default in both.
  assert.equal(msProps["jbMerge.autoApplyNonConflicting"].default, false);
});

/** Menus that are one product's own surface, not a merge capability the other lacks. */
const MENU_EXCEPTIONS: ReadonlyArray<{ product: "gitstudio" | "merge-studio"; menu: string; role: Role; why: string }> = [
  {
    product: "gitstudio",
    menu: "view/title",
    role: "openWalkthrough",
    why: "GitStudio's Changes view title; Merge Studio has no view of its own",
  },
];

test("menus: every merge command sits in the same menus in both products", () => {
  const where = (m: Manifest, role: (c: string | undefined) => Role | undefined) => {
    const out = new Set<string>();
    for (const [menu, entries] of Object.entries(m.contributes.menus)) {
      if (menu === "commandPalette") continue; // visibility rules, per product
      for (const e of entries) {
        const r = role(e.command);
        if (r) out.add(`${menu} ${r}`);
      }
    }
    return out;
  };
  const msWhere = where(ms, msRole);
  const gsWhere = where(gs, gsRole);
  const excused = (product: string, key: string) =>
    MENU_EXCEPTIONS.some((x) => x.product === product && `${x.menu} ${x.role}` === key);
  const onlyGs = [...gsWhere].filter((k) => !msWhere.has(k) && !excused("gitstudio", k));
  const onlyMs = [...msWhere].filter((k) => !gsWhere.has(k) && !excused("merge-studio", k));
  assert.deepEqual({ onlyGitStudio: onlyGs, onlyMergeStudio: onlyMs }, { onlyGitStudio: [], onlyMergeStudio: [] });
  // An exception that no longer applies is removed, not kept "just in case".
  for (const x of MENU_EXCEPTIONS) {
    const mine = x.product === "gitstudio" ? gsWhere : msWhere;
    assert.ok(mine.has(`${x.menu} ${x.role}`), `stale exception: ${x.menu} ${x.role} (${x.why})`);
  }
});

/** Keybindings each product owns alone, with the reason. */
const KEYBINDING_EXCEPTIONS: Readonly<Partial<Record<Role, string>>> = {
  openChanges:
    "GitStudio's Ctrl/Cmd+Alt+G chord family. Merge Studio 0.3.4 had no keybindings, and the same chord in both would collide when both are installed.",
};

test("keybindings: a merge command bound in one product is bound in the other, or excused with a reason", () => {
  const bound = (m: Manifest, role: (c: string | undefined) => Role | undefined) =>
    new Set((m.contributes.keybindings ?? []).map((k) => role(k.command)).filter((r): r is Role => r !== undefined));
  const msBound = bound(ms, msRole);
  const gsBound = bound(gs, gsRole);
  const differ = [...new Set([...msBound, ...gsBound])].filter((r) => msBound.has(r) !== gsBound.has(r));
  assert.deepEqual(differ.sort(), (Object.keys(KEYBINDING_EXCEPTIONS) as Role[]).sort());
});

test("D4's capability marker is GitStudio's own Resolve Conflicts… command, and GitStudio's manifest carries it", () => {
  // Merge Studio stands down only for a GitStudio whose manifest has this
  // command (merge-vscode's hasSharedMergeExperience). Renaming GitStudio's
  // command without this would make Merge Studio never defer, silently.
  assert.equal(GITSTUDIO_SHARED_MERGE_COMMAND, GS_COMMANDS.showConflicts);
  assert.ok(hasSharedMergeExperience(gs), "GitStudio's manifest reads as the shared experience");
  assert.ok(!hasSharedMergeExperience(ms), "and Merge Studio's own does not");
});

test("the SCM view's Merge Changes header offers Resolve Conflicts… as a button in both products", () => {
  for (const [m, id] of [
    [ms, MS_MERGE_COMMANDS.showConflicts],
    [gs, GS_COMMANDS.showConflicts],
  ] as const) {
    const header = m.contributes.menus["scm/resourceGroup/context"] ?? [];
    assert.ok(header.some((e) => e.command === id && e.group === "inline"), id);
  }
});

test("the engine floor is VS Code 1.82 (the shared CSS needs color-mix)", () => {
  assert.equal((ms as unknown as { engines: { vscode: string } }).engines.vscode, "^1.82.0");
});

test(
  "the engine floor is the same in GitStudio",
  { todo: "POLISH A7.3: apps/extension still declares ^1.78.0 (owner decision 3; not this build's file)" },
  () => {
    assert.equal((gs as unknown as { engines: { vscode: string } }).engines.vscode, "^1.82.0");
  },
);

test("Open Changes shows only on a changed file in Merge Studio (POLISH B1)", () => {
  const e = ms.contributes.menus["editor/title"].find((x) => x.command === MS_MERGE_COMMANDS.openChanges);
  assert.ok(e?.when?.includes("scmActiveResourceHasChanges"), e?.when);
});

test(
  "…and in GitStudio",
  { todo: "POLISH B1: apps/extension's gitstudio.openChanges still shows on every file in a repository" },
  () => {
    const e = gs.contributes.menus["editor/title"].find((x) => x.command === GS_COMMANDS.openChanges);
    assert.ok(e?.when?.includes("scmActiveResourceHasChanges"), e?.when);
  },
);
