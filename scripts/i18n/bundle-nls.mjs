#!/usr/bin/env node
/**
 * The runtime half of GitStudio's localization pipeline.
 *
 * `apps/extension/l10n/bundle.l10n.json` is the English source: every message
 * the extension host, the shared packages and the webviews ask `l10n.t()` for.
 * `bundle.l10n.<locale>.json` is what a user gets when VS Code runs in that
 * language, and VS Code looks the file up by exact name — there is no fallback
 * chain inside a bundle, so a missing key shows the English message while the
 * rest of the UI is Chinese.
 *
 *   node scripts/i18n/bundle-nls.mjs              # gate every locale
 *   node scripts/i18n/bundle-nls.mjs zh-cn        # gate one
 *   node scripts/i18n/bundle-nls.mjs --write      # refresh the source bundle
 *
 * `--write` regenerates the source bundle from `l10n.t()` calls with the
 * official extractor, then folds in the messages the embedded webview programs
 * pass to the `l10nT()` global: those live inside `String.raw` strings, where
 * no extractor can see a call, so they are collected from the built bundles'
 * own source.
 *
 * The extractor (`@vscode/l10n-dev`) is maintainer tooling, not a dependency of
 * the workspace: `npm ci` does not install it. `--write` uses a local copy when
 * there is one and otherwise fetches that exact version with npx, so the
 * command still works on a fresh clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const L10N = join(ROOT, "apps/extension/l10n");
const SOURCE = join(L10N, "bundle.l10n.json");
const SOURCES = [
  "apps/extension/src/**/*.ts",
  "packages/engine/src/**/*.ts",
  "packages/git-service/src/**/*.ts",
  "packages/ai/src/**/*.ts",
  "packages/webview-ui/src/**/*.ts",
  "packages/host-bridge/src/**/*.ts",
  "packages/merge-vscode/src/**/*.ts",
  "packages/l10n/src/**/*.ts",
];
/** Webview programs embedded in the extension host as String.raw strings. */
const EMBEDDED = [
  "apps/extension/src/changes/commitView.ts",
  "apps/extension/src/rebase/rebaseWorkspacePanel.ts",
  "apps/extension/src/compare/comparePanel.ts",
  "apps/extension/src/ai/aiCommands.ts",
];

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const requested = argv.filter((arg) => !arg.startsWith("-"));

const problems = [];
const report = (message) => problems.push(message);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const locales = readdirSync(L10N)
  .map((name) => /^bundle\.l10n\.(.+)\.json$/.exec(name)?.[1])
  .filter(Boolean)
  .sort();

/** The version whose output the committed bundles were generated with. */
const EXTRACTOR = "@vscode/l10n-dev@0.0.35";

if (write) {
  const local = join(ROOT, "node_modules/@vscode/l10n-dev/dist/cli.js");
  const [command, ...prefix] = existsSync(local)
    ? [process.execPath, local]
    : process.platform === "win32"
      ? ["npx.cmd", "--yes", EXTRACTOR]
      : ["npx", "--yes", EXTRACTOR];
  try {
    execFileSync(command, [...prefix, "export", "-o", L10N, ...SOURCES], { stdio: "inherit", cwd: ROOT });
  } catch {
    console.error(
      `bundle-nls: the extractor did not run — install ${EXTRACTOR} (\`npm i -D ${EXTRACTOR}\`) or retry with a network connection, since npx has to fetch it`,
    );
    process.exit(1);
  }
  const bundle = readJson(SOURCE);
  const inline = execFileSync(
    process.execPath,
    [join(ROOT, "scripts/i18n/embedded-keys.mjs"), ...EMBEDDED.map((file) => join(ROOT, file))],
    { encoding: "utf8" },
  );
  let added = 0;
  for (const message of JSON.parse(inline)) {
    if (message in bundle) continue;
    bundle[message] = message;
    added += 1;
  }
  const sorted = Object.fromEntries(Object.keys(bundle).sort().map((key) => [key, bundle[key]]));
  writeFileSync(SOURCE, `${JSON.stringify(sorted, null, 1)}\n`);
  console.log(`bundle-nls: ${Object.keys(sorted).length} messages (${added} from embedded webview scripts)`);
}

const source = readJson(SOURCE);
const keys = Object.keys(source);
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const wanted = requested.length ? requested.map((locale) => (locale.endsWith(".json") ? locale : `bundle.l10n.${locale}.json`)) : null;
const files = wanted ?? locales.map((locale) => `bundle.l10n.${locale}.json`);
if (!files.length) console.log(`bundle-nls: ${keys.length} messages, no translations yet`);

for (const file of files) {
  const path = join(L10N, file);
  if (!existsSync(path)) {
    report(`${file}: missing (run the translation pass: one entry per message in bundle.l10n.json)`);
    continue;
  }
  const translated = readJson(path);
  const missing = keys.filter((key) => !(key in translated));
  const extra = Object.keys(translated).filter((key) => !(key in source));
  const blank = keys.filter((key) => key in translated && !String(translated[key]).trim());
  if (missing.length) report(`${file}: ${missing.length} message(s) without a translation (e.g. ${JSON.stringify(missing.slice(0, 3))})`);
  if (extra.length) report(`${file}: ${extra.length} message(s) not in the source bundle (e.g. ${JSON.stringify(extra.slice(0, 3))})`);
  if (blank.length) report(`${file}: ${blank.length} empty translation(s) (e.g. ${JSON.stringify(blank.slice(0, 3))})`);
  if (missing.length || extra.length) continue; // a shifted key set makes the rest noise

  // `{0}` / `{name}` are substituted at runtime; a translation that renames or
  // drops one renders a broken sentence ("Push  then"), and `{2}` in a message
  // with two arguments is a crash, not a typo.
  const broken = keys.filter((key) => placeholders(translated[key]).join(",") !== placeholders(source[key]).join(","));
  for (const key of broken.slice(0, 5)) {
    report(`${file}: placeholders changed for ${JSON.stringify(key)}: expected ${placeholders(source[key]).map((p) => `{${p}}`).join(" ")} got ${placeholders(translated[key]).map((p) => `{${p}}`).join(" ")}`);
  }
  if (broken.length > 5) report(`${file}: ${broken.length - 5} more message(s) with changed placeholders`);
  if (!missing.length && !extra.length && !blank.length && !broken.length) {
    console.log(`bundle-nls: ${file} covers all ${keys.length} messages`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`bundle-nls: ${problem}`);
  process.exit(1);
}
