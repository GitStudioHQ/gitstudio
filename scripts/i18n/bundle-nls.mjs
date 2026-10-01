#!/usr/bin/env node
/**
 * The runtime half of GitStudio's localization pipeline, for all three products.
 *
 * Each product has an English source bundle, `<app>/l10n/bundle.l10n.json`:
 * every message its code (and the shared packages it ships) asks `l10n.t()`
 * for. The translations live ONCE, in `l10n/<locale>.json` at the repository
 * root — a message the extension, the desktop app and Merge Studio all show is
 * translated one time — and each product's `bundle.l10n.<locale>.json` is that
 * catalog cut down to the product's own messages.
 *
 *   node scripts/i18n/bundle-nls.mjs              # gate every locale
 *   node scripts/i18n/bundle-nls.mjs zh-cn        # gate one
 *   node scripts/i18n/bundle-nls.mjs --write      # refresh the source bundles
 *                                                 # and the products' cuts
 *
 * `--write` regenerates each source bundle from `l10n.t()` calls with the
 * official extractor, then folds in the messages the extractor cannot see: the
 * `l10nT()` calls inside the extension's embedded webview programs. Then it
 * writes each shipped
 * product's per-locale cut. The desktop's cut is not committed: its build
 * (apps/desktop/esbuild.js) makes it from the catalog.
 *
 * The extractor (`@vscode/l10n-dev`) is maintainer tooling, not a dependency of
 * the workspace: `npm ci` does not install it. `--write` uses a local copy when
 * there is one and otherwise fetches that exact version with npx, so the
 * command still works on a fresh clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CATALOG = join(ROOT, "l10n");

const pkg = (name) => `packages/${name}/src/**/*.ts`;
const PRODUCTS = {
  extension: {
    dir: "apps/extension/l10n",
    sources: ["apps/extension/src/**/*.ts", ...["engine", "git-service", "ai", "webview-ui", "host-bridge", "merge-vscode", "l10n"].map(pkg)],
    /** Webview programs embedded in the extension host as String.raw strings. */
    embedded: [
      "apps/extension/src/changes/commitView.ts",
      "apps/extension/src/rebase/rebaseWorkspacePanel.ts",
      "apps/extension/src/compare/comparePanel.ts",
      "apps/extension/src/ai/aiCommands.ts",
    ],
    ships: true,
  },
  "merge-studio": {
    dir: "apps/merge-studio/l10n",
    sources: ["apps/merge-studio/src/**/*.ts", ...["engine", "git-service", "webview-ui", "host-bridge", "merge-vscode", "l10n"].map(pkg)],
    ships: true,
  },
  desktop: {
    dir: "apps/desktop/l10n",
    sources: ["apps/desktop/src/**/*.ts", ...["engine", "git-service", "ai", "webview-ui", "host-bridge", "l10n"].map(pkg)],
    ships: false,
  },
};

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const requested = argv.filter((arg) => !arg.startsWith("-"));

const problems = [];
const report = (message) => problems.push(message);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((key) => [key, obj[key]]));

/** The version whose output the committed bundles were generated with. */
const EXTRACTOR = "@vscode/l10n-dev@0.0.35";

if (write) {
  const local = join(ROOT, "node_modules/@vscode/l10n-dev/dist/cli.js");
  const [command, ...prefix] = existsSync(local)
    ? [process.execPath, local]
    : process.platform === "win32"
      ? ["npx.cmd", "--yes", EXTRACTOR]
      : ["npx", "--yes", EXTRACTOR];
  for (const [name, product] of Object.entries(PRODUCTS)) {
    const out = join(ROOT, product.dir);
    mkdirSync(out, { recursive: true });
    try {
      execFileSync(command, [...prefix, "export", "-o", out, ...product.sources], { stdio: ["ignore", "ignore", "inherit"], cwd: ROOT });
    } catch {
      console.error(
        `bundle-nls: the extractor did not run — install ${EXTRACTOR} (\`npm i -D ${EXTRACTOR}\`) or retry with a network connection, since npx has to fetch it`,
      );
      process.exit(1);
    }
    const bundle = readJson(join(out, "bundle.l10n.json"));
    const more = [];
    if (product.embedded) {
      const inline = execFileSync(
        process.execPath,
        [join(ROOT, "scripts/i18n/embedded-keys.mjs"), ...product.embedded.map((file) => join(ROOT, file))],
        { encoding: "utf8" },
      );
      more.push(...JSON.parse(inline));
    }
    for (const message of more) bundle[message] ??= message;
    writeJson(join(out, "bundle.l10n.json"), sortKeys(bundle));
    console.log(`bundle-nls: ${name}: ${Object.keys(bundle).length} messages`);
  }
}

const sources = Object.fromEntries(
  Object.entries(PRODUCTS).map(([name, product]) => [name, readJson(join(ROOT, product.dir, "bundle.l10n.json"))]),
);
/** Every message any product asks for, with its English (the same text everywhere). */
const english = Object.assign({}, ...Object.values(sources));
const keys = Object.keys(english);
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const count = (text, ch) => String(text).split(ch).length - 1;

const locales = (existsSync(CATALOG) ? readdirSync(CATALOG) : [])
  .map((name) => /^(.+)\.json$/.exec(name)?.[1])
  .filter(Boolean)
  .sort();
const checked = requested.length ? requested : locales;
if (!checked.length) console.log(`bundle-nls: ${keys.length} messages, no translations yet`);

for (const locale of checked) {
  const file = `l10n/${locale}.json`;
  const path = join(CATALOG, `${locale}.json`);
  if (!existsSync(path)) {
    report(`${file}: missing (one entry per message of every product's bundle.l10n.json)`);
    continue;
  }
  const translated = readJson(path);
  const missing = keys.filter((key) => !(key in translated));
  const extra = Object.keys(translated).filter((key) => !(key in english));
  const blank = keys.filter((key) => key in translated && !String(translated[key]).trim());
  if (missing.length) report(`${file}: ${missing.length} message(s) without a translation (e.g. ${JSON.stringify(missing.slice(0, 3))})`);
  if (extra.length) report(`${file}: ${extra.length} message(s) no product asks for (e.g. ${JSON.stringify(extra.slice(0, 3))})`);
  if (blank.length) report(`${file}: ${blank.length} empty translation(s) (e.g. ${JSON.stringify(blank.slice(0, 3))})`);
  if (missing.length || extra.length) continue; // a shifted key set makes the rest noise

  // `{0}` / `{name}` are substituted at runtime; a translation that renames or
  // drops one renders a broken sentence ("Push  then"), and `{2}` in a message
  // with two arguments is a crash, not a typo.
  const broken = keys.filter((key) => placeholders(translated[key]).join(",") !== placeholders(english[key]).join(","));
  for (const key of broken.slice(0, 5)) {
    report(`${file}: placeholders changed for ${JSON.stringify(key)}: expected ${placeholders(english[key]).map((p) => `{${p}}`).join(" ")} got ${placeholders(translated[key]).map((p) => `{${p}}`).join(" ")}`);
  }
  if (broken.length > 5) report(`${file}: ${broken.length - 5} more message(s) with changed placeholders`);

  // Translations reach pages through innerHTML and quoted attributes, which
  // trust the English source not to carry markup. A translation may not add a
  // character that markup or an attribute would read: < > & " beyond what its
  // English source already has.
  const markup = keys.filter((key) => ["<", ">", "&", '"'].some((ch) => count(translated[key], ch) > count(english[key], ch)));
  for (const key of markup.slice(0, 5)) {
    report(`${file}: adds markup characters (< > & ") the English does not have, in ${JSON.stringify(key)}: ${JSON.stringify(translated[key])}`);
  }
  if (markup.length > 5) report(`${file}: ${markup.length - 5} more message(s) adding markup characters`);

  // Each shipped product's cut of this catalog: written by --write, and
  // otherwise required to be exactly what --write would write.
  for (const [name, product] of Object.entries(PRODUCTS)) {
    if (!product.ships) continue;
    const cut = Object.fromEntries(Object.keys(sources[name]).map((key) => [key, translated[key]]));
    const out = join(ROOT, product.dir, `bundle.l10n.${locale}.json`);
    const text = `${JSON.stringify(cut, null, 1)}\n`;
    if (write) writeFileSync(out, text);
    else if (!existsSync(out) || readFileSync(out, "utf8") !== text) report(`${product.dir}/bundle.l10n.${locale}.json is not the catalog's cut — run --write`);
  }
  if (!missing.length && !blank.length && !broken.length && !markup.length) {
    console.log(`bundle-nls: ${file} covers all ${keys.length} messages`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`bundle-nls: ${problem}`);
  process.exit(1);
}
