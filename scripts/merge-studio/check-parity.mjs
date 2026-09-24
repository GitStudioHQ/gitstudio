#!/usr/bin/env node
// check-parity: the standalone merge-studio repository's guard against drift
// (PLAN §1, option B).
//
// scripts/merge-studio/export.mjs vendors GitStudio's shared packages into
// merge-studio's vendor/gitstudio/ and records, in VENDORED_FROM.json, the
// gitstudio commit they came from and a sha256 for every vendored file. This
// re-hashes vendor/gitstudio/** and fails on ANY difference:
// - a vendored file edited in merge-studio ("modified");
// - one deleted ("missing");
// - one added that GitStudio never had ("added").
// The fix is always the same: the change goes into gitstudio (made there, or a
// contributor's pull request imported with scripts/merge-studio/import.mjs),
// then gitstudio is exported again. The failure message says so in plain words
// for a contributor, whose pull request is welcome and fails here by design.
//
// The shell files the export writes at the repository root (src/, test/,
// package.json, …) are reported as warnings when they differ from the export
// (`--strict` makes them failures): merge-studio may carry a local fix there
// between syncs, but it should flow back to gitstudio's apps/merge-studio.
//
// With `--gitstudio <checkout>`, it also warns when GitStudio has commits
// touching the vendored sources after the recorded sha (the copy is stale).
//
// With `--pull-request` (merge-studio's CI passes it on a pull request), a
// difference is reported, not failed: a contributor may change
// vendor/gitstudio, and a maintainer imports the change into GitStudio. The
// run says so in plain words (a notice and a step summary in GitHub Actions)
// and exits 0. A missing or unreadable manifest still fails: then nothing can
// be compared. A push to main runs without the flag and must match exactly.
//
// usage: node scripts/check-parity.mjs [--root <merge-studio checkout>] [--strict] [--pull-request] [--gitstudio <gitstudio checkout>]
// Exit 0 when the vendored tree matches (or, with --pull-request, differs), 1
// when it does not match (or the manifest is missing).
//
// No dependencies: node's own crypto and fs only, so it runs before `npm ci`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FILE = "VENDORED_FROM.json";
export const VENDOR_DIR = "vendor/gitstudio";

/** What a failure tells the reader: most often a contributor, whose pull request is welcome. */
export const FAILURE_HELP = [
  `${VENDOR_DIR}/ is a copy of GitStudio's shared code (https://github.com/GitStudioHQ/gitstudio), where it is kept.`,
  "",
  "Contributing a change? Keep it and open your pull request anyway: on a pull request, CI reports this",
  "change for a maintainer to import instead of failing (`npm run check-parity -- --pull-request` says the",
  "same here). Check the change itself with `npm run check-types && npm test`. A maintainer brings the",
  "pull request into GitStudio (scripts/merge-studio/import.mjs there), with you as the author of every",
  "commit, and the next export brings it back here. CONTRIBUTING.md has the details.",
  "",
  "Maintaining? main must match GitStudio: import the pull request into gitstudio with",
  "scripts/merge-studio/import.mjs, or make the change in gitstudio, then run scripts/merge-studio/export.mjs again.",
].join("\n");

/** What a pull request that changes the vendored code is told: nothing is wrong with it. */
export const PULL_REQUEST_NOTE =
  "a maintainer will import this change into GitStudio (https://github.com/GitStudioHQ/gitstudio), " +
  "with you as the author of every commit, and the next export brings it back here. " +
  "Nothing to fix on your side: the type-check and test results are in the build job.";

/** Finder litter is never drift. */
const IGNORED_NAMES = new Set([".DS_Store"]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `dir`, as sorted forward-slashed paths relative to `base`. */
export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(base, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** sha256 of each file, keyed by its path relative to `root`. */
export function hashFiles(root, relPaths) {
  const out = {};
  for (const rel of relPaths) out[rel] = sha256(readFileSync(join(root, rel)));
  return out;
}

/**
 * Whether a shell file still has the bytes the export wrote (`hash`). A
 * checkout with core.autocrlf (git for Windows' default) has it with CRLF line
 * endings where git stores the export's LF: git's conversion, not an edit.
 * (vendor/gitstudio is compared byte for byte: git never converts it there.)
 */
function sameAsExported(bytes, hash) {
  if (sha256(bytes) === hash) return true;
  return bytes.includes("\r\n") && sha256(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")) === hash;
}

/**
 * Compare the checkout at `root` with its VENDORED_FROM.json. `broken` says
 * the manifest itself cannot be used (missing, not JSON, or empty): nothing was
 * compared, so no difference can be reported as a contribution.
 * @returns {{ ok: boolean, broken: boolean, problems: string[], warnings: string[], checked: number, manifest?: object }}
 */
export function checkParity(root, { strict = false } = {}) {
  const problems = [];
  const warnings = [];
  const manifestPath = join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { ok: false, broken: true, problems: [`${MANIFEST_FILE} is missing: this checkout was not written by export.mjs`], warnings, checked: 0 };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { ok: false, broken: true, problems: [`${MANIFEST_FILE} is not valid JSON: ${e.message}`], warnings, checked: 0 };
  }
  const expected = manifest.files ?? {};
  const broken = Object.keys(expected).length === 0;
  if (broken) {
    problems.push(`${MANIFEST_FILE} lists no vendored files`);
  }
  const actual = listFiles(join(root, VENDOR_DIR), root);
  const actualSet = new Set(actual);
  for (const [rel, hash] of Object.entries(expected)) {
    if (!actualSet.has(rel)) {
      problems.push(`missing: ${rel}`);
      continue;
    }
    if (sha256(readFileSync(join(root, rel))) !== hash) problems.push(`modified: ${rel}`);
  }
  for (const rel of actual) {
    if (!(rel in expected)) problems.push(`added: ${rel}`);
  }
  for (const [rel, hash] of Object.entries(manifest.shell ?? {})) {
    const file = join(root, rel);
    const differs = !existsSync(file) || !sameAsExported(readFileSync(file), hash);
    if (differs) (strict ? problems : warnings).push(`shell ${existsSync(file) ? "modified" : "missing"}: ${rel} (differs from the export of gitstudio ${short(manifest)})`);
  }
  return { ok: problems.length === 0, broken, problems, warnings, checked: Object.keys(expected).length, manifest };
}

/**
 * Commits in a gitstudio checkout that touch the vendored sources after the
 * recorded sha: the vendored copy is behind by that many. Undefined when it
 * cannot be told (not a checkout, or the sha is unknown there).
 */
export function commitsBehind(manifest, gitstudioDir) {
  const sha = manifest?.gitstudio?.sha;
  const sources = manifest?.sources ?? [];
  if (!sha || sources.length === 0 || !existsSync(gitstudioDir)) return undefined;
  try {
    const out = execFileSync("git", ["-C", gitstudioDir, "rev-list", "--count", `${sha}..HEAD`, "--", ...sources], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Number(out.trim());
  } catch {
    return undefined;
  }
}

function short(manifest) {
  return String(manifest?.gitstudio?.sha ?? "?").slice(0, 7);
}

export function parseArgs(argv) {
  const args = { root: process.cwd(), strict: false, pullRequest: false, gitstudio: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = resolve(argv[++i]);
    else if (a === "--strict") args.strict = true;
    else if (a === "--pull-request") args.pullRequest = true;
    else if (a === "--gitstudio") args.gitstudio = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** A pull request that changes the vendored code: said as what it is, and the run passes. */
function reportContribution(result) {
  const lines = [
    `check-parity: this pull request changes ${result.problems.length} file(s) in ${VENDOR_DIR}/, GitStudio's shared code:`,
    ...result.problems.map((p) => `  ${p}`),
    "",
    `That is expected: ${PULL_REQUEST_NOTE}`,
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_ACTIONS === "true") {
    // A notice, not an error: the check is neutral on a pull request. (%0A is
    // how a workflow command carries a line break.)
    console.log(`::notice title=Vendored GitStudio code changed::This pull request changes ${VENDOR_DIR}/: ${PULL_REQUEST_NOTE}`.replace(/\n/g, "%0A"));
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const md = [
      "### Vendored GitStudio code",
      "",
      `This pull request changes ${result.problems.length} file(s) in \`${VENDOR_DIR}/\`, GitStudio's shared code. That is expected: ${PULL_REQUEST_NOTE}`,
      "",
      ...result.problems.map((p) => `- \`${p}\``),
      "",
    ].join("\n");
    try {
      appendFileSync(summary, md);
    } catch (e) {
      console.warn(`warning: could not write the step summary: ${e.message}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/check-parity.mjs [--root <dir>] [--strict] [--pull-request] [--gitstudio <gitstudio checkout>]");
    return;
  }
  const result = checkParity(args.root, { strict: args.strict });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (args.gitstudio && result.manifest) {
    const behind = commitsBehind(result.manifest, args.gitstudio);
    if (behind === undefined) console.warn(`warning: could not compare with ${args.gitstudio}`);
    else if (behind > 0) console.warn(`warning: vendored from gitstudio ${short(result.manifest)}, which is ${behind} commit(s) behind on the vendored paths — export again`);
  }
  if (!result.ok && args.pullRequest && !result.broken) {
    reportContribution(result);
    return;
  }
  if (!result.ok) {
    console.error(`check-parity: FAILED — ${result.problems.length} problem(s) in ${VENDOR_DIR} against ${MANIFEST_FILE}:`);
    for (const p of result.problems) console.error(`  ${p}`);
    console.error(`\n${FAILURE_HELP}`);
    process.exitCode = 1;
    return;
  }
  const m = result.manifest;
  console.log(`check-parity: ok — ${result.checked} vendored files match gitstudio ${short(m)}${m?.gitstudio?.dirty ? " (exported from a dirty tree)" : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
