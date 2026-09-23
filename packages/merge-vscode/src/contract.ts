// The manifest contract for the merge experience: which commands, menus and
// settings a product's package.json must contribute for `registerMergeExperience`
// to be fully reachable, and the when-clauses that gate them. Both extensions'
// manifest tests check themselves against this one table, so a capability
// added to one manifest and not the other fails CI (PLAN §1, "how drift is
// prevented").
//
// vscode-free data + one pure checker.

import { JETBRAINS_IDES } from "@gitstudio/host-bridge/conflictsProtocol";
import type { MergeCommandIds } from "./product";

export type CommandRole = keyof MergeCommandIds;

/** Canonical titles (sentence-cased verbs, the user's words). */
export const COMMAND_TITLES: Record<CommandRole, string> = {
  showConflicts: "Resolve Conflicts…",
  resolveInMergeEditor: "Resolve in Merge Editor",
  mergeWithJetBrains: "Merge with JetBrains IDE",
  diffWithJetBrains: "Diff with JetBrains IDE",
  compare: "Compare File…",
  openDiff: "Open in Embedded Diff",
  openChanges: "Open Changes (vs HEAD)",
  stageWithTicks: "Stage Changes with Ticks",
  openDemo: "Open Sample Merge",
  openDemoDiff: "Open Sample Diff",
  operationContinue: "Continue Operation",
  operationSkip: "Skip This Commit",
  operationAbort: "Abort Operation",
  restoreBuiltInMergeEditor: "Restore VS Code's Merge Editor",
};

/**
 * Merge Studio 0.3.4's commands (its package.json at origin/main d86cf21) and
 * the role each one plays. Every one must have a twin in every product.
 * `openWalkthrough` is a brand slot, checked separately.
 */
export const JB_MERGE_COMMAND_TWINS: Readonly<Record<string, CommandRole | "openWalkthrough">> = {
  "jbMerge.mergeWithJetBrains": "mergeWithJetBrains",
  "jbMerge.diffWithJetBrains": "diffWithJetBrains",
  "jbMerge.resolveInMergeEditor": "resolveInMergeEditor",
  "jbMerge.showConflicts": "showConflicts",
  "jbMerge.compare": "compare",
  "jbMerge.openDiff": "openDiff",
  "jbMerge.openChanges": "openChanges",
  "jbMerge.openWalkthrough": "openWalkthrough",
  "jbMerge.openDemo": "openDemo",
  "jbMerge.openDemoDiff": "openDemoDiff",
};

/** Merge Studio 0.3.4's settings and the MergeHostSettings key each one is. */
export const JB_MERGE_SETTING_TWINS: Readonly<Record<string, string>> = {
  "jbMerge.conflictResolver": "conflictResolver",
  "jbMerge.diffTool": "diffTool",
  "jbMerge.preferredIde": "preferredIde",
  "jbMerge.jetbrainsPath": "jetbrainsPath",
  "jbMerge.autoOpen": "autoOpen",
};

/** The settings every product contributes under its section, with their types and defaults. */
export const MERGE_SETTINGS_SPEC: ReadonlyArray<{
  key: string;
  type: "boolean" | "string";
  default: boolean | string;
  enum?: readonly string[];
  /**
   * "machine": settable in user settings only — never by a workspace's own
   * .vscode/settings.json, which the repository supplies. For the one value
   * the product SPAWNS (as VS Code's own git.path).
   */
  scope?: "machine";
}> = [
  { key: "autoOpen", type: "boolean", default: true },
  // D3, orchestrator override: OFF by default, as JetBrains ships it.
  { key: "autoApplyNonConflicting", type: "boolean", default: false },
  { key: "conflictResolver", type: "string", default: "embedded", enum: ["embedded", "jetbrains"] },
  { key: "diffTool", type: "string", default: "embedded", enum: ["embedded", "jetbrains"] },
  {
    key: "preferredIde",
    type: "string",
    default: "auto",
    enum: ["auto", ...JETBRAINS_IDES.map((i) => i.id)],
  },
  { key: "jetbrainsPath", type: "string", default: "", scope: "machine" },
];

/** When-clause pieces the merge menus are gated on. `IDE` is replaced by the product's context key. */
export const WHEN = {
  scmMergeGroup: "scmProvider == git && scmResourceGroup == merge",
  editorHasMergeConflicts:
    "config.git.enabled && !git.missing && resource in git.mergeChanges && git.activeResourceHasMergeConflicts",
} as const;

export interface MenuRule {
  menu: string;
  role: CommandRole;
  /** The when-clause the entry must have (IDE → the product's ideAvailable key). */
  when?: string;
  /** The when-clause must CONTAIN this (when an exact clause is product-specific). */
  whenIncludes?: string[];
}

/** The menu entries every product must contribute (mirrors ms package.json:255-320, gated). */
export const MERGE_MENU_RULES: readonly MenuRule[] = [
  // The SCM view's "Merge Changes" group header.
  { menu: "scm/resourceGroup/context", role: "showConflicts", when: WHEN.scmMergeGroup },
  // A conflicted row in the SCM view.
  { menu: "scm/resourceState/context", role: "resolveInMergeEditor", when: WHEN.scmMergeGroup },
  {
    menu: "scm/resourceState/context",
    role: "mergeWithJetBrains",
    when: `${WHEN.scmMergeGroup} && IDE`,
  },
  // The editor title — ONLY on a file that has merge conflicts (row 10).
  { menu: "editor/title", role: "resolveInMergeEditor", when: WHEN.editorHasMergeConflicts },
  { menu: "editor/title", role: "mergeWithJetBrains", when: `${WHEN.editorHasMergeConflicts} && IDE` },
  { menu: "editor/title", role: "openChanges", whenIncludes: ["resourceScheme == file"] },
  // Explorer: the routed Compare, which diffs two selected files.
  { menu: "explorer/context", role: "compare", whenIncludes: ["!explorerResourceIsFolder"] },
];

/** Commands whose every non-palette menu entry must be gated on the IDE key. */
export const IDE_ONLY_ROLES: readonly CommandRole[] = ["mergeWithJetBrains"];

/** Commands that are merge ACTIONS: never on an editor title without a conflict gate. */
export const MERGE_ACTION_ROLES: readonly CommandRole[] = ["resolveInMergeEditor", "mergeWithJetBrains"];

interface ManifestShape {
  contributes?: {
    commands?: { command: string; title?: string }[];
    menus?: Record<string, { command?: string; when?: string; group?: string }[]>;
    configuration?: unknown;
  };
}

/**
 * Every way `manifest` fails the contract, in plain words (empty = conforms).
 * `ids` maps roles to the product's command ids; `ideKey` is its ideAvailable
 * context key; `section` its settings section.
 */
export function checkManifest(
  manifest: ManifestShape,
  ids: MergeCommandIds,
  ideKey: string,
  section: string,
): string[] {
  const problems: string[] = [];
  const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
  const menus = manifest.contributes?.menus ?? {};

  for (const role of Object.keys(ids) as CommandRole[]) {
    if (!declared.has(ids[role])) {
      problems.push(`command ${ids[role]} (${role}) is registered but not declared in contributes.commands`);
    }
  }

  for (const [menu, entries] of Object.entries(menus)) {
    for (const e of entries) {
      if (e.command && !declared.has(e.command)) {
        problems.push(`${menu} uses ${e.command}, which is not declared`);
      }
    }
  }

  for (const rule of MERGE_MENU_RULES) {
    const id = ids[rule.role];
    const entries = (menus[rule.menu] ?? []).filter((e) => e.command === id);
    if (entries.length === 0) {
      problems.push(`${rule.menu} has no entry for ${id}`);
      continue;
    }
    const want = rule.when?.replace(/\bIDE\b/g, ideKey);
    for (const e of entries) {
      if (want !== undefined && e.when !== want) {
        problems.push(`${rule.menu} ${id}: when is "${e.when ?? ""}", expected "${want}"`);
      }
      for (const piece of rule.whenIncludes ?? []) {
        if (!(e.when ?? "").includes(piece)) {
          problems.push(`${rule.menu} ${id}: when "${e.when ?? ""}" must include "${piece}"`);
        }
      }
    }
  }

  for (const e of menus["editor/title"] ?? []) {
    const role = roleOf(ids, e.command);
    if (role && MERGE_ACTION_ROLES.includes(role) && !(e.when ?? "").includes("git.activeResourceHasMergeConflicts")) {
      problems.push(`editor/title ${e.command} is not gated on git.activeResourceHasMergeConflicts`);
    }
  }

  for (const [menu, entries] of Object.entries(menus)) {
    if (menu === "commandPalette") {
      continue;
    }
    for (const e of entries) {
      const role = roleOf(ids, e.command);
      if (role && IDE_ONLY_ROLES.includes(role) && !(e.when ?? "").includes(ideKey)) {
        problems.push(`${menu} ${e.command} is shown without ${ideKey}`);
      }
    }
  }

  const props = configurationProperties(manifest.contributes?.configuration);
  for (const spec of MERGE_SETTINGS_SPEC) {
    const key = `${section}.${spec.key}`;
    const p = props[key] as { type?: string; default?: unknown; enum?: unknown[]; scope?: string } | undefined;
    if (!p) {
      problems.push(`setting ${key} is not contributed`);
      continue;
    }
    if (p.type !== spec.type) {
      problems.push(`setting ${key} has type ${p.type}, expected ${spec.type}`);
    }
    if (p.default !== spec.default) {
      problems.push(`setting ${key} defaults to ${JSON.stringify(p.default)}, expected ${JSON.stringify(spec.default)}`);
    }
    if (spec.enum && JSON.stringify(p.enum) !== JSON.stringify(spec.enum)) {
      problems.push(`setting ${key} enum is ${JSON.stringify(p.enum)}, expected ${JSON.stringify(spec.enum)}`);
    }
    if (spec.scope && p.scope !== spec.scope) {
      problems.push(`setting ${key} has scope ${JSON.stringify(p.scope)}, expected "${spec.scope}" (a workspace must not set it)`);
    }
  }
  return problems;
}

function roleOf(ids: MergeCommandIds, command: string | undefined): CommandRole | undefined {
  if (!command) {
    return undefined;
  }
  return (Object.keys(ids) as CommandRole[]).find((r) => ids[r] === command);
}

/** contributes.configuration is an object or an array of them. */
export function configurationProperties(configuration: unknown): Record<string, unknown> {
  const blocks = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const out: Record<string, unknown> = {};
  for (const b of blocks) {
    const props = (b as { properties?: Record<string, unknown> }).properties ?? {};
    Object.assign(out, props);
  }
  return out;
}
