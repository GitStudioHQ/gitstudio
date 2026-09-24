#!/usr/bin/env node
// export: write Merge Studio, as built from this gitstudio checkout, into a
// checkout of the standalone merge-studio repository (PLAN §1, option B).
//
// gitstudio stays the single source: apps/merge-studio is the shell, and
// packages/{engine,git-service,host-bridge,webview-ui,merge-vscode} are the
// shared code. The export
// 1. removes what the shell replaces in the target (the old src/, webview/,
//    test/ and test-harness/, and the previous vendor/gitstudio/), and any
//    other file the previous export wrote (its VENDORED_FROM.json lists them)
//    that apps/merge-studio no longer has, so a deleted or moved shell file
//    does not stay behind in merge-studio;
// 2. vendors the packages' source (src/** and their package.json) under
//    vendor/gitstudio/<pkg>/, with GitStudio's LICENSE and NOTICE, plus the two
//    GitStudio files the parity test compares against (apps/extension's
//    package.json and src/merge/mergeIds.ts) under vendor/gitstudio/extension/;
// 3. copies apps/merge-studio's files to the target's root (2 and 3 follow
//    layout.mjs, the same table import.mjs maps a merge-studio change back by);
// 4. rewrites what differs standalone: package.json (no @gitstudio/*
//    workspace dependencies; the packages' own third-party dependencies added;
//    every version pinned to what gitstudio builds with), tsconfig.json
//    (`paths` for @gitstudio/* → vendor/gitstudio/<pkg>/src), and a
//    package-lock.json cut from gitstudio's own lockfile, so `npm ci` installs
//    exactly gitstudio's toolchain. esbuild.js needs no rewrite: it sees
//    vendor/gitstudio and aliases @gitstudio/* there itself;
// 5. copies check-parity.mjs (and its test) to scripts/, and the CI workflow
//    that runs it (scripts/merge-studio/merge-studio-ci.yml) to
//    .github/workflows/ci.yml: check-parity in a job of its own, reporting a
//    pull request's change to vendor/ for a maintainer to import and failing
//    only on main. Then it writes VENDORED_FROM.json: the gitstudio sha, and a
//    sha256 for every vendored file (checked) and every shell file (reported).
//
// Every file is written with the bytes git stores for it (gitBytes), so an
// export from a Windows checkout, whose working tree has CRLF line endings
// (core.autocrlf), writes what an export from anywhere else does.
//
// Nothing is committed, pushed or published: the target is left as a working
// tree change for a human to review. The other direction, a merge-studio pull
// request replayed into gitstudio, is import.mjs.
//
// usage: node scripts/merge-studio/export.mjs --into <merge-studio checkout> [--allow-dirty] [--no-lock] [--gitstudio <checkout>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFiles, listFiles, MANIFEST_FILE, VENDOR_DIR } from "./check-parity.mjs";
import { COPIED, copiedFiles, GENERATED, REPLACED, SHELL_DIR, sourcePaths, VENDORED_PACKAGES } from "./layout.mjs";

export { REPLACED, SHELL_DIR, sourcePaths, VENDORED_PACKAGES };

export const GITSTUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** GitStudio files the parity test reads, and where the export puts them. */
export const PARITY_INPUTS = COPIED.filter((row) => row.parityInput).map((row) => [row.gitstudio, row.mergeStudio]);

/** vendor/gitstudio/.gitattributes: the hashed bytes are stored and checked out as they are. */
export const VENDOR_GITATTRIBUTES =
  "# Written by gitstudio's scripts/merge-studio/export.mjs. check-parity hashes these\n" +
  "# files, so git must not convert their line endings on any platform.\n" +
  "* -text\n";

/** The scripts the standalone package.json always has, whatever the shell says. */
export const STANDALONE_SCRIPTS = {
  "check-types": "tsc --noEmit -p tsconfig.json",
  test: 'tsx --test "test/**/*.test.ts" && node --test "scripts/test/*.test.mjs"',
  "check-parity": "node scripts/check-parity.mjs",
};

/**
 * The parts of the standalone package.json the export computes rather than
 * copies from apps/merge-studio/package.json, as key paths. import.mjs reports
 * a change to them and does not import it.
 */
export const GENERATED_PACKAGE_FIELDS = [["dependencies"], ["devDependencies"], ["overrides"], ...Object.keys(STANDALONE_SCRIPTS).map((k) => ["scripts", k])];

const gitIn = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** git's blob id for these bytes. */
export function blobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The bytes git stores for each of `rels` (forward-slashed, relative to the
 * checkout `root`), in their order: what the export writes. With
 * core.autocrlf, git for Windows' default, the working tree has CRLF line
 * endings where git stores LF, and copying it would give merge-studio other
 * bytes (and VENDORED_FROM.json other hashes) than an export from anywhere
 * else; merge-studio keeps vendor/gitstudio byte for byte (`* -text`). A file
 * changed since its last commit (--allow-dirty) is taken as `git add` would
 * store it. `env`: the environment git runs in.
 */
export function gitBytes(root, rels, { env = process.env } = {}) {
  if (rels.length === 0) return [];
  const git = (args, input) =>
    execFileSync("git", ["-C", root, ...args], { input, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  // The blob git makes of each file, by its attributes and core.autocrlf...
  const ids = git(["hash-object", "--stdin-paths"], `${rels.join("\n")}\n`).split("\n");
  let storedCrlf;
  return rels.map((rel, i) => {
    const bytes = readFileSync(join(root, rel));
    if (blobId(bytes) === ids[i]) return bytes;
    // ...except that hash-object reads no index, so it misses autocrlf's
    // "safer" rule: git never converts a file it already stores with CRLF.
    storedCrlf ??= new Set(
      git(["ls-files", "--eol", "-z"])
        .split("\0")
        .filter((rec) => /^i\/(crlf|mixed) /.test(rec))
        .map((rec) => rec.slice(rec.indexOf("\t") + 1)),
    );
    if (storedCrlf.has(rel)) return bytes;
    const lf = Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    if (blobId(lf) === ids[i]) return lf;
    throw new Error(`${rel}: git stores other bytes for it than it has, with or without CRLF line endings (a filter in .gitattributes?), and the export cannot tell which to write`);
  });
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
  pkg.scripts = { ...pkg.scripts, ...STANDALONE_SCRIPTS };
  return { pkg, resolved: wanted };
}

/** standalonePackageJson() for the gitstudio checkout at `root`, as it is on disk. */
export function standaloneFrom(root = GITSTUDIO_ROOT) {
  const lock = readJson(join(root, "package-lock.json"));
  const packages = Object.fromEntries(VENDORED_PACKAGES.map((p) => [p, readJson(join(root, "packages", p, "package.json"))]));
  const { pkg, resolved } = standalonePackageJson({
    shell: readJson(join(root, SHELL_DIR, "package.json")),
    packages,
    lock,
    rootPackage: readJson(join(root, "package.json")),
  });
  return { pkg, resolved, lock };
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

/** The shell files the previous export recorded in the target's manifest (none when it has no readable one). */
export function previousShellFiles(target) {
  try {
    const shell = JSON.parse(readFileSync(join(target, MANIFEST_FILE), "utf8")).shell;
    return shell && typeof shell === "object" && !Array.isArray(shell) ? Object.keys(shell) : [];
  } catch {
    return [];
  }
}

/**
 * Remove the file `rel` from `target`, and any folder that leaves empty.
 * `rel` comes from the target's own manifest, which a pull request can edit,
 * so only a plain relative path whose folder really is inside `target` (no
 * "..", no symbolic link out, never .git) is touched. Returns whether it was
 * removed.
 */
export function removeInside(target, rel) {
  if (typeof rel !== "string" || !rel || /[\\\0]/.test(rel) || posix.isAbsolute(rel) || posix.normalize(rel) !== rel) return false;
  if (rel.split("/").some((part) => part === ".." || part === ".git")) return false;
  const file = join(target, rel);
  let root;
  let folder;
  try {
    root = realpathSync(target);
    folder = realpathSync(dirname(file));
    if (lstatSync(file).isDirectory()) return false;
  } catch {
    return false;
  }
  if (folder !== root && !folder.startsWith(`${root}${sep}`)) return false;
  rmSync(file, { force: true });
  for (let dir = dirname(file); dir.startsWith(`${target}${sep}`) && readdirSync(dir).length === 0; dir = dirname(dir)) rmdirSync(dir);
  return true;
}

/**
 * Export the gitstudio checkout at `gitstudio` (this one by default) into
 * `into`. Returns what was written.
 * @param {{ into: string, allowDirty?: boolean, lock?: boolean, gitstudio?: string }} opts
 */
export function exportTo({ into, allowDirty = false, lock = true, gitstudio = GITSTUDIO_ROOT }) {
  const root = resolve(gitstudio);
  const target = resolve(into);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`--into ${target}: not a directory`);
  if (target === root || target.startsWith(`${root}${sep}packages`) || target.startsWith(`${root}${sep}apps`)) {
    throw new Error("--into must be a merge-studio checkout, not this gitstudio checkout");
  }
  const git = (...args) => gitIn(root, ...args);
  const sha = git("rev-parse", "HEAD");
  const dirtyLines = git("status", "--porcelain", "--", ...sourcePaths());
  const dirty = dirtyLines.length > 0;
  if (dirty && !allowDirty) {
    throw new Error(`gitstudio has uncommitted changes in the exported paths (pass --allow-dirty to export anyway):\n${dirtyLines}`);
  }
  // The shell files the previous export wrote (its manifest says which): one
  // that gitstudio has since deleted or moved is removed below, or it would
  // stay in merge-studio for good.
  const previousShell = previousShellFiles(target);

  // 1. What the shell replaces.
  const removed = [];
  for (const rel of REPLACED) {
    const p = join(target, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(rel);
    }
  }

  // 2 and 3. Every copied file, by layout.mjs's table: the vendored packages,
  // GitStudio's licence, the parity inputs, check-parity and the CI that runs
  // it (they travel with the vendored code) and the shell.
  const copied = copiedFiles(root);
  const files = copied.map(([from]) => from).filter((from) => lstatSync(join(root, from)).isFile());
  const stored = new Map(gitBytes(root, files).map((bytes, i) => [files[i], bytes]));
  for (const [from, to] of copied) {
    mkdirSync(dirname(join(target, to)), { recursive: true });
    // The file with its mode (a symbolic link as it is), then the bytes git stores for it.
    cpSync(join(root, from), join(target, to));
    if (stored.has(from)) writeFileSync(join(target, to), stored.get(from));
  }
  // Vendored bytes are hashed, so git must never rewrite them: no line-ending
  // conversion on a Windows checkout (core.autocrlf), in either repository.
  writeFileSync(join(target, VENDOR_DIR, ".gitattributes"), VENDOR_GITATTRIBUTES);

  // 4. What differs standalone.
  const { pkg, resolved, lock: gsLock } = standaloneFrom(root);
  writeJson(join(target, "package.json"), pkg);
  writeJson(join(target, "tsconfig.json"), standaloneTsconfig(readJson(join(root, "tsconfig.base.json"))));
  if (lock) writeJson(join(target, "package-lock.json"), lockSubset({ lock: gsLock, pkg, resolved }));

  const vendored = listFiles(join(target, VENDOR_DIR), target);
  const shellWritten = [
    ...copied.map(([, to]) => to).filter((to) => !to.startsWith(`${VENDOR_DIR}/`)),
    "package.json",
    "tsconfig.json",
    ...(lock ? ["package-lock.json"] : []),
  ].sort();
  const writtenNow = new Set(shellWritten);
  const generated = new Set(GENERATED.map((g) => g.mergeStudio));
  const stale = previousShell.filter(
    (rel) => !writtenNow.has(rel) && !generated.has(rel) && !rel.startsWith(`${VENDOR_DIR}/`) && removeInside(target, rel),
  );
  const manifest = {
    schema: 1,
    note:
      "Written by gitstudio's scripts/merge-studio/export.mjs. Files under vendor/gitstudio are copies of GitStudio's shared code, " +
      "and `npm run check-parity` reports any difference. A pull request may still change them: a maintainer imports it into gitstudio " +
      "(scripts/merge-studio/import.mjs) and exports again.",
    gitstudio: { repository: "https://github.com/GitStudioHQ/gitstudio", sha, dirty },
    sources: sourcePaths(),
    packages: VENDORED_PACKAGES,
    files: hashFiles(target, vendored),
    shell: hashFiles(target, shellWritten),
  };
  writeJson(join(target, MANIFEST_FILE), manifest);
  return { sha, dirty, removed, stale, vendored: vendored.length, shell: shellWritten.length, target };
}

export function parseArgs(argv) {
  const args = { into: undefined, allowDirty: false, lock: true, gitstudio: GITSTUDIO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--into") args.into = argv[++i];
    else if (a === "--allow-dirty") args.allowDirty = true;
    else if (a === "--no-lock") args.lock = false;
    else if (a === "--gitstudio") args.gitstudio = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.into) {
      console.log("usage: node scripts/merge-studio/export.mjs --into <merge-studio checkout> [--allow-dirty] [--no-lock] [--gitstudio <checkout>]");
      process.exitCode = args.help ? 0 : 2;
    } else {
      const r = exportTo(args);
      console.log(`exported gitstudio ${r.sha.slice(0, 7)}${r.dirty ? " (dirty)" : ""} into ${r.target}`);
      console.log(`  removed: ${r.removed.join(", ") || "nothing"}`);
      if (r.stale.length) console.log(`  removed, as gitstudio no longer has them: ${r.stale.join(", ")}`);
      console.log(`  vendored files: ${r.vendored}; shell files: ${r.shell}; manifest: ${MANIFEST_FILE}`);
    }
  } catch (e) {
    console.error(`export: ${e.message}`);
    process.exitCode = 1;
  }
}
