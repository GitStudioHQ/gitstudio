#!/usr/bin/env node
// export: write Merge Studio, as built from this gitstudio checkout, into a
// checkout of the standalone merge-studio repository (PLAN §1, option B).
//
// gitstudio stays the single source: apps/merge-studio is the shell, and
// packages/{engine,git-service,host-bridge,webview-ui,merge-vscode} are the
// shared code. The export
// 1. removes what the shell replaces in the target (the old src/, webview/,
//    test/ and test-harness/, and the previous vendor/gitstudio/);
// 2. vendors the packages' source (src/** and their package.json) under
//    vendor/gitstudio/<pkg>/, with GitStudio's LICENSE and NOTICE, plus the two
//    GitStudio files the parity test compares against (apps/extension's
//    package.json and src/merge/mergeIds.ts) under vendor/gitstudio/extension/;
// 3. copies apps/merge-studio's files to the target's root;
// 4. rewrites what differs standalone: package.json (no @gitstudio/*
//    workspace dependencies; the packages' own third-party dependencies added;
//    every version pinned to what gitstudio builds with), tsconfig.json
//    (`paths` for @gitstudio/* → vendor/gitstudio/<pkg>/src), and a
//    package-lock.json cut from gitstudio's own lockfile, so `npm ci` installs
//    exactly gitstudio's toolchain. esbuild.js needs no rewrite: it sees
//    vendor/gitstudio and aliases @gitstudio/* there itself;
// 5. copies check-parity.mjs (and its test) to scripts/, and writes
//    VENDORED_FROM.json: the gitstudio sha, and a sha256 for every vendored
//    file (checked) and every shell file (reported).
//
// Nothing is committed, pushed or published: the target is left as a working
// tree change for a human to review.
//
// usage: node scripts/merge-studio/export.mjs --into <merge-studio checkout> [--allow-dirty] [--no-lock]

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFiles, listFiles, MANIFEST_FILE, VENDOR_DIR } from "./check-parity.mjs";

export const GITSTUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SHELL_DIR = "apps/merge-studio";
export const VENDORED_PACKAGES = ["engine", "git-service", "host-bridge", "webview-ui", "merge-vscode"];

/** GitStudio files the parity test reads, and where the export puts them. */
export const PARITY_INPUTS = [
  ["apps/extension/package.json", `${VENDOR_DIR}/extension/package.json`],
  ["apps/extension/src/merge/mergeIds.ts", `${VENDOR_DIR}/extension/src/merge/mergeIds.ts`],
];

/** Paths in the target the shell replaces; removed before writing. */
export const REPLACED = ["src", "webview", "test", "test-harness", VENDOR_DIR, "scripts/check-parity.mjs", "scripts/test/checkParity.test.mjs"];

/** Shell files that are not copied as they are (regenerated) or never (build output). */
const SHELL_SKIP = [/^node_modules(\/|$)/, /^dist(\/|$)/, /\.vsix$/, /^package\.json$/, /^tsconfig\.json$/, /(^|\/)\.DS_Store$/];

const git = (...args) =>
  execFileSync("git", ["-C", GITSTUDIO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** The gitstudio paths an export reads (for the dirty check and staleness). */
export function sourcePaths() {
  return [
    ...VENDORED_PACKAGES.flatMap((p) => [`packages/${p}/src`, `packages/${p}/package.json`]),
    ...PARITY_INPUTS.map(([from]) => from),
    SHELL_DIR,
    "scripts/merge-studio",
    "LICENSE",
    "NOTICE",
    "tsconfig.base.json",
    "package-lock.json",
  ];
}

/**
 * The version gitstudio's lockfile resolves `name` to when `fromPath` (a lock
 * path such as "packages/webview-ui" or "") requires it: node's lookup, walking
 * up node_modules folders.
 */
export function resolveInLock(lockPackages, name, fromPath) {
  let at = fromPath;
  for (;;) {
    const candidate = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (lockPackages[candidate]) return candidate;
    if (!at) return undefined;
    const i = at.lastIndexOf("/node_modules/");
    at = i >= 0 ? at.slice(0, i) : "";
  }
}

/**
 * The standalone package.json: the shell's, without the workspace packages,
 * with the vendored packages' third-party dependencies, every version pinned
 * to the one gitstudio's lockfile resolves (so the bundles are the same bytes).
 */
export function standalonePackageJson({ shell, packages, lock, rootPackage }) {
  const pkg = structuredClone(shell);
  const wanted = new Map(); // name -> lock path of the version gitstudio uses
  const want = (name, fromPath) => {
    if (name.startsWith("@gitstudio/")) return;
    const at = resolveInLock(lock.packages, name, fromPath);
    if (!at) throw new Error(`${name} (needed by ${fromPath || "the root"}) is not in gitstudio's package-lock.json`);
    const prev = wanted.get(name);
    if (prev && lock.packages[prev].version !== lock.packages[at].version) {
      throw new Error(`${name}: ${fromPath} uses ${lock.packages[at].version}, another package ${lock.packages[prev].version}`);
    }
    wanted.set(name, at);
  };
  for (const name of Object.keys({ ...shell.dependencies, ...shell.devDependencies })) want(name, SHELL_DIR);
  for (const [p, manifest] of Object.entries(packages)) {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) want(name, `packages/${p}`);
  }
  delete pkg.dependencies;
  pkg.devDependencies = Object.fromEntries(
    [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, at]) => [name, lock.packages[at].version]),
  );
  if (rootPackage.overrides) pkg.overrides = rootPackage.overrides;
  pkg.scripts = {
    ...pkg.scripts,
    "check-types": "tsc --noEmit -p tsconfig.json",
    test: 'tsx --test "test/**/*.test.ts" && node --test "scripts/test/*.test.mjs"',
    "check-parity": "node scripts/check-parity.mjs",
  };
  return { pkg, resolved: wanted };
}

/**
 * package-lock.json for the standalone package.json, cut from gitstudio's own
 * lockfile: the root's (dev) dependencies and everything they pull in, at the
 * exact versions, integrity hashes and nesting gitstudio installs. A root
 * dependency gitstudio keeps nested under a workspace (apps/x/node_modules/…)
 * moves to the top level.
 */
export function lockSubset({ lock, pkg, resolved }) {
  const src = lock.packages;
  const out = {
    "": {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      devDependencies: pkg.devDependencies,
      ...(pkg.engines ? { engines: pkg.engines } : {}),
    },
  };
  const KEEP = ["version", "resolved", "integrity", "license", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "bin", "cpu", "os", "libc", "hasInstallScript", "funding", "deprecated"];
  const copy = (from, to) => {
    const e = src[from];
    const entry = { dev: true };
    for (const k of KEEP) if (e[k] !== undefined) entry[k] = e[k];
    if (e.optional || e.devOptional) entry.optional = true;
    // Put the flags where npm writes them (after the identity fields).
    const { dev, optional, ...rest } = entry;
    const ordered = { version: rest.version, resolved: rest.resolved, integrity: rest.integrity, dev, ...(optional ? { optional } : {}), ...rest };
    if (out[to] && out[to].version !== e.version) {
      throw new Error(`${to}: two versions (${out[to].version}, ${e.version}) would land at the same path`);
    }
    out[to] = ordered;
  };
  // Map a gitstudio lock path to the standalone one: a workspace prefix
  // (apps/x/ or packages/x/) is dropped, so apps/x/node_modules/a → node_modules/a.
  const target = (lockPath) => lockPath.replace(/^(apps|packages)\/[^/]+\//, "");
  const seen = new Set();
  const queue = [...resolved.values()];
  while (queue.length) {
    const at = queue.shift();
    if (seen.has(at)) continue;
    seen.add(at);
    const e = src[at];
    if (!e || e.link) continue;
    copy(at, target(at));
    for (const name of Object.keys({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies })) {
      const dep = resolveInLock(src, name, at);
      if (dep && !src[dep].link) queue.push(dep);
    }
  }
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, "en"))));
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: sorted };
}

/** tsconfig.json for the standalone layout: gitstudio's base options, @gitstudio/* → vendor. */
export function standaloneTsconfig(base) {
  return {
    compilerOptions: {
      ...base.compilerOptions,
      types: ["node", "vscode"],
      paths: Object.fromEntries(VENDORED_PACKAGES.map((p) => [`@gitstudio/${p}/*`, [`./${VENDOR_DIR}/${p}/src/*`]])),
    },
    include: ["src", "test"],
  };
}

/**
 * Export into `into`. Returns what was written.
 * @param {{ into: string, allowDirty?: boolean, lock?: boolean }} opts
 */
export function exportTo({ into, allowDirty = false, lock = true }) {
  const target = resolve(into);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`--into ${target}: not a directory`);
  if (resolve(target) === GITSTUDIO_ROOT || resolve(target).startsWith(`${GITSTUDIO_ROOT}/packages`)) {
    throw new Error("--into must be a merge-studio checkout, not this gitstudio checkout");
  }
  const sha = git("rev-parse", "HEAD");
  const dirtyLines = git("status", "--porcelain", "--", ...sourcePaths());
  const dirty = dirtyLines.length > 0;
  if (dirty && !allowDirty) {
    throw new Error(`gitstudio has uncommitted changes in the exported paths (pass --allow-dirty to export anyway):\n${dirtyLines}`);
  }

  // 1. What the shell replaces.
  const removed = [];
  for (const rel of REPLACED) {
    const p = join(target, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(rel);
    }
  }

  // 2. The vendored packages, GitStudio's licence, and the parity inputs.
  const packages = {};
  for (const p of VENDORED_PACKAGES) {
    const from = join(GITSTUDIO_ROOT, "packages", p);
    cpSync(join(from, "src"), join(target, VENDOR_DIR, p, "src"), {
      recursive: true,
      filter: (s) => !s.endsWith(".DS_Store"),
    });
    cpSync(join(from, "package.json"), join(target, VENDOR_DIR, p, "package.json"));
    packages[p] = readJson(join(from, "package.json"));
  }
  cpSync(join(GITSTUDIO_ROOT, "LICENSE"), join(target, VENDOR_DIR, "LICENSE"));
  cpSync(join(GITSTUDIO_ROOT, "NOTICE"), join(target, VENDOR_DIR, "NOTICE"));
  for (const [from, to] of PARITY_INPUTS) {
    mkdirSync(dirname(join(target, to)), { recursive: true });
    cpSync(join(GITSTUDIO_ROOT, from), join(target, to));
  }

  // 3. The shell.
  const shellRoot = join(GITSTUDIO_ROOT, SHELL_DIR);
  const shellFiles = listFiles(shellRoot).filter((rel) => !SHELL_SKIP.some((re) => re.test(rel)));
  for (const rel of shellFiles) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    cpSync(join(shellRoot, rel), join(target, rel));
  }

  // 4. What differs standalone.
  const gsLock = readJson(join(GITSTUDIO_ROOT, "package-lock.json"));
  const { pkg, resolved } = standalonePackageJson({
    shell: readJson(join(shellRoot, "package.json")),
    packages,
    lock: gsLock,
    rootPackage: readJson(join(GITSTUDIO_ROOT, "package.json")),
  });
  writeJson(join(target, "package.json"), pkg);
  writeJson(join(target, "tsconfig.json"), standaloneTsconfig(readJson(join(GITSTUDIO_ROOT, "tsconfig.base.json"))));
  if (lock) writeJson(join(target, "package-lock.json"), lockSubset({ lock: gsLock, pkg, resolved }));

  // 5. The parity check travels with the vendored code.
  cpSync(join(GITSTUDIO_ROOT, "scripts/merge-studio/check-parity.mjs"), join(target, "scripts/check-parity.mjs"));
  mkdirSync(join(target, "scripts/test"), { recursive: true });
  cpSync(join(GITSTUDIO_ROOT, "scripts/merge-studio/test/checkParity.test.mjs"), join(target, "scripts/test/checkParity.test.mjs"));

  const vendored = listFiles(join(target, VENDOR_DIR), target);
  const shellWritten = [...shellFiles, "package.json", "tsconfig.json", ...(lock ? ["package-lock.json"] : []), "scripts/check-parity.mjs", "scripts/test/checkParity.test.mjs"].sort();
  const manifest = {
    schema: 1,
    note: "Written by gitstudio's scripts/merge-studio/export.mjs. Files under vendor/gitstudio are GitStudio's: change them there and export again; `npm run check-parity` fails on any edit here.",
    gitstudio: { repository: "https://github.com/GitStudioHQ/gitstudio", sha, dirty },
    sources: sourcePaths(),
    packages: VENDORED_PACKAGES,
    files: hashFiles(target, vendored),
    shell: hashFiles(target, shellWritten),
  };
  writeJson(join(target, MANIFEST_FILE), manifest);
  return { sha, dirty, removed, vendored: vendored.length, shell: shellWritten.length, target };
}

function parseArgs(argv) {
  const args = { into: undefined, allowDirty: false, lock: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--into") args.into = argv[++i];
    else if (a === "--allow-dirty") args.allowDirty = true;
    else if (a === "--no-lock") args.lock = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.into) {
      console.log("usage: node scripts/merge-studio/export.mjs --into <merge-studio checkout> [--allow-dirty] [--no-lock]");
      process.exitCode = args.help ? 0 : 2;
    } else {
      const r = exportTo(args);
      console.log(`exported gitstudio ${r.sha.slice(0, 7)}${r.dirty ? " (dirty)" : ""} into ${r.target}`);
      console.log(`  removed: ${r.removed.join(", ") || "nothing"}`);
      console.log(`  vendored files: ${r.vendored}; shell files: ${r.shell}; manifest: ${MANIFEST_FILE}`);
    }
  } catch (e) {
    console.error(`export: ${e.message}`);
    process.exitCode = 1;
  }
}
