#!/usr/bin/env node
/**
 * The translation work list for one language, in numbered batches, and the
 * step that folds finished batches back into the catalog.
 *
 *   node scripts/i18n/todo.mjs <locale> [--batch 250]   # write the batches
 *   node scripts/i18n/todo.mjs <locale> --merge         # fold answers in
 *
 * Batches go to `l10n/.todo/<locale>/batch-NNN.json` as `[[id, english], …]`:
 * every message some product asks for that `l10n/<locale>.json` lacks. A
 * translator answers each with `answer-NNN.json`, `{ "<id>": "<translation>" }`
 * — the English is never written back, so an answer costs only its own words.
 * `--merge` adds every answer whose placeholders match its English to the
 * catalog (sorted), reports the rest, and removes the batches it finished.
 * `l10n/.todo/` is git-ignored.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRODUCTS = ["apps/extension", "apps/merge-studio", "apps/desktop"];

const [locale, ...rest] = process.argv.slice(2);
if (!locale || locale.startsWith("-")) {
  console.error("usage: node scripts/i18n/todo.mjs <locale> [--batch N | --merge]");
  process.exit(2);
}
const merge = rest.includes("--merge");
const size = Number(rest[rest.indexOf("--batch") + 1]) || 250;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const english = Object.assign({}, ...PRODUCTS.map((app) => readJson(join(ROOT, app, "l10n/bundle.l10n.json"))));
const keys = Object.keys(english).sort();
const catalogPath = join(ROOT, "l10n", `${locale}.json`);
const catalog = existsSync(catalogPath) ? readJson(catalogPath) : {};
const work = join(ROOT, "l10n/.todo", locale);
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const count = (text, ch) => String(text).split(ch).length - 1;
/** A translation may not add a character markup or an attribute reads (bundle-nls's gate). */
const addsMarkup = (text, key) => ["<", ">", "&", '"'].some((ch) => count(text, ch) > count(key, ch));

if (!merge) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const todo = keys.filter((key) => !(key in catalog));
  for (let i = 0; i * size < todo.length; i++) {
    const batch = todo.slice(i * size, (i + 1) * size).map((key, j) => [i * size + j, key]);
    writeFileSync(join(work, `batch-${String(i).padStart(3, "0")}.json`), `${JSON.stringify(batch, null, 1)}\n`);
  }
  console.log(`todo: ${locale}: ${todo.length} message(s) in ${Math.ceil(todo.length / size)} batch(es) under l10n/.todo/${locale}/`);
  process.exit(0);
}

let added = 0;
const rejected = [];
for (const name of existsSync(work) ? readdirSync(work).sort() : []) {
  const m = /^batch-(\d+)\.json$/.exec(name);
  if (!m) continue;
  const answerPath = join(work, `answer-${m[1]}.json`);
  if (!existsSync(answerPath)) continue;
  const batch = readJson(join(work, name));
  const answer = readJson(answerPath);
  let complete = true;
  for (const [id, key] of batch) {
    const text = answer[String(id)];
    if (typeof text !== "string" || !text.trim()) {
      complete = false;
      continue;
    }
    if (placeholders(text) !== placeholders(key)) {
      rejected.push(`#${id} placeholders differ: ${JSON.stringify(key)} → ${JSON.stringify(text)}`);
      complete = false;
      continue;
    }
    if (addsMarkup(text, key)) {
      rejected.push(`#${id} adds < > & or " the English does not have: ${JSON.stringify(text)}`);
      complete = false;
      continue;
    }
    catalog[key] = text;
    added += 1;
  }
  if (complete) {
    rmSync(join(work, name));
    rmSync(answerPath);
  }
}
const sorted = Object.fromEntries(Object.keys(catalog).filter((key) => key in english).sort().map((key) => [key, catalog[key]]));
mkdirSync(dirname(catalogPath), { recursive: true });
writeFileSync(catalogPath, `${JSON.stringify(sorted, null, 1)}\n`);
const left = keys.filter((key) => !(key in sorted)).length;
for (const line of rejected) console.error(`todo: ${locale}: ${line}`);
console.log(`todo: ${locale}: ${added} added, ${left} still to translate`);
