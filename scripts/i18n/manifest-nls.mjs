#!/usr/bin/env node
/**
 * The manifest half of GitStudio's localization pipeline.
 *
 * VS Code localizes a `package.json` from `package.nls.json` (the English
 * source) and `package.nls.<locale>.json` (the translation): any string in the
 * manifest shaped `%someKey%` is swapped for the value of `someKey`, in whatever
 * locale VS Code is running in. Which strings those are is a decision this
 * script owns, so a new command, setting, view or walkthrough step cannot ship
 * an untranslatable label by accident:
 *
 *   node scripts/i18n/manifest-nls.mjs --check   # gate (CI): every key resolves,
 *                                                # every locale covers every key
 *   node scripts/i18n/manifest-nls.mjs --apply   # (re)write `%key%` + English
 *
 * `--apply` is idempotent: a field already holding `%key%` keeps its key, so a
 * rerun after an English wording change updates `package.nls.json` in place and
 * every translation file keeps the key it already had.
 *
 * Keys are derived from the manifest path (the command id, the setting id, the
 * view id …), never from the English text: rewording a label must not orphan
 * its six translations.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = join(ROOT, "apps/extension/package.json");
const DEFAULTS = join(ROOT, "apps/extension/package.nls.json");

const apply = process.argv.includes("--apply");

/** Keys are looked up verbatim between the `%` signs, so only keep sane ones. */
const slug = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, "-");

/** Fields the extension itself must not translate (ids, patterns, defaults). */
const BRAND = new Set(["GitStudio", "GitStudio Blame"]);

const problems = [];
const report = (message) => problems.push(message);

/**
 * Walk the localizable fields of the manifest.
 *
 * Only fields whose text a user sees are collected. A `when` clause, a settings
 * id, an `enum` value, a keybinding or an icon path looks like text and is not:
 * translating one would break the contribution, not localize it.
 */
function collect(pkg) {
  const found = [];

  /** Record one field: `%key%` -> key, anything else -> a new key to mint. */
  const add = (holder, field, key) => {
    const value = holder?.[field];
    if (typeof value !== "string") return;
    if (value.length > 2 && value.startsWith("%") && value.endsWith("%")) {
      found.push({ holder, field, key: value.slice(1, -1), existing: true });
      return;
    }
    found.push({ holder, field, key, existing: false, english: value });
  };

  add(pkg, "displayName", "displayName");
  add(pkg, "description", "description");

  const c = pkg.contributes ?? {};

  for (const container of Object.values(c.viewsContainers ?? {})) {
    for (const view of container) add(view, "title", `viewContainer.${view.id}.title`);
  }
  for (const group of Object.values(c.views ?? {})) {
    for (const view of group) add(view, "name", `view.${view.id}.name`);
  }
  for (const editor of c.customEditors ?? []) {
    add(editor, "displayName", `customEditor.${slug(editor.viewType)}.displayName`);
  }
  for (const command of c.commands ?? []) {
    add(command, "title", `command.${command.command}.title`);
    // The palette category is the brand: "GitStudio: Push" reads as well in
    // Chinese as in English, and splitting it would rename the product.
    if (typeof command.category === "string" && !BRAND.has(command.category)) {
      add(command, "category", `commandCategory.${slug(command.category)}`);
    }
  }
  for (const submenu of c.submenus ?? []) add(submenu, "label", `submenu.${submenu.id}.label`);

  const sections = Array.isArray(c.configuration) ? c.configuration : [c.configuration];
  for (const section of sections.filter(Boolean)) {
    add(section, "title", `config.${section.id}.title`);
    for (const [id, property] of Object.entries(section.properties ?? {})) {
      add(property, "description", `config.${id}.description`);
      add(property, "markdownDescription", `config.${id}.markdownDescription`);
      add(property, "deprecationMessage", `config.${id}.deprecationMessage`);
      (property.enumDescriptions ?? []).forEach((_, i) =>
        add(property.enumDescriptions, String(i), `config.${id}.enumDescriptions.${i}`),
      );
      (property.enumItemLabels ?? []).forEach((_, i) =>
        add(property.enumItemLabels, String(i), `config.${id}.enumItemLabels.${i}`),
      );
    }
  }

  for (const walkthrough of c.walkthroughs ?? []) {
    const id = slug(walkthrough.id);
    add(walkthrough, "title", `walkthrough.${id}.title`);
    add(walkthrough, "description", `walkthrough.${id}.description`);
    for (const step of walkthrough.steps ?? []) {
      const stepId = `${id}.${slug(step.id)}`;
      add(step, "title", `walkthrough.${stepId}.title`);
      add(step, "description", `walkthrough.${stepId}.description`);
      add(step.media, "markdown", `walkthrough.${stepId}.markdown`);
      add(step.media, "altText", `walkthrough.${stepId}.altText`);
    }
  }

  (c.viewsWelcome ?? []).forEach((welcome, i) => add(welcome, "contents", `viewsWelcome.${i}.contents`));

  for (const scope of ["untrustedWorkspaces", "virtualWorkspaces"]) {
    add(pkg.capabilities?.[scope], "description", `capabilities.${scope}.description`);
  }

  return found;
}

/** The translation files sitting beside the manifest: package.nls.<locale>.json. */
function localeFiles() {
  return readdirSync(join(ROOT, "apps/extension"))
    .filter((name) => /^package\.nls\..+\.json$/.test(name))
    .sort();
}

/** English key -> text, from the file on disk (so rewording is a diff, not a loss). */
function readDefaults() {
  if (!existsSync(DEFAULTS)) return new Map();
  const parsed = JSON.parse(readFileSync(DEFAULTS, "utf8"));
  return new Map(Object.entries(parsed));
}

const pkg = JSON.parse(readFileSync(MANIFEST, "utf8"));
const found = collect(pkg);
// Read in both modes: --apply needs it as the previous-text map, and the gate
// needs it to know which keys the English catalog actually carries.
const english = readDefaults();

// Mint keys for fields that are still English, and keep the ones already keyed.
const minted = new Map();
for (const entry of found) {
  if (entry.existing) {
    if (!english.has(entry.key)) {
      report(`package.nls.json has no value for %${entry.key}% (${entry.field} would render as "%${entry.key}%")`);
    }
    continue;
  }
  const previous = minted.get(entry.key) ?? english.get(entry.key);
  if (previous !== undefined && previous !== entry.english) {
    report(`key ${entry.key} is claimed by two different strings: ${JSON.stringify(previous)} and ${JSON.stringify(entry.english)}`);
  }
  minted.set(entry.key, entry.english);
}

if (apply) {
  const next = new Map(english);
  for (const [key, value] of minted) next.set(key, value);
  for (const entry of found) {
    if (entry.existing) continue;
    entry.holder[entry.field] = `%${entry.key}%`;
  }
  // Sorted so a rerun with a new label is a one-line diff, not a reorder.
  const sorted = Object.fromEntries([...next.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(DEFAULTS, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`manifest-nls: ${found.length} localizable fields, ${next.size} keys, ${minted.size} newly keyed`);
}

// The gate: every field a user reads must be keyed, and every locale must carry
// every key. A missing key is not a cosmetic bug — VS Code leaves the literal
// `%theKey%` on screen.
const known = apply
  ? new Set([...english.keys(), ...minted.keys()])
  : new Set([...found.map((entry) => entry.key), ...english.keys()]);
if (!apply) {
  for (const entry of found) {
    if (!entry.existing) report(`${entry.field} (${entry.key}) is still English — run --apply to key it`);
  }
}
for (const locale of localeFiles()) {
  const translated = JSON.parse(readFileSync(join(ROOT, "apps/extension", locale), "utf8"));
  const missing = [...known].filter((key) => !(key in translated));
  const extra = Object.keys(translated).filter((key) => !known.has(key));
  if (missing.length) report(`${locale}: ${missing.length} key(s) without a translation (e.g. ${missing.slice(0, 3).join(", ")})`);
  if (extra.length) report(`${locale}: ${extra.length} key(s) no longer in the manifest (e.g. ${extra.slice(0, 3).join(", ")})`);
}

if (problems.length) {
  for (const problem of problems) console.error(`manifest-nls: ${problem}`);
  process.exit(1);
}
console.log(`manifest-nls: ${found.length} localizable fields OK`);
