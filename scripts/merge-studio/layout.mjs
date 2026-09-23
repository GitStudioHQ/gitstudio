// layout: the one map between gitstudio and an exported merge-studio checkout.
//
// export.mjs writes merge-studio by this table, and import.mjs maps a
// merge-studio change back by it, so the two directions cannot drift: a path
// the export would not write from a gitstudio file is a path the import
// refuses.
//
// Every path in a merge-studio checkout is one of three things:
// - COPIED: the bytes of one gitstudio file. The vendored packages, GitStudio's
//   LICENSE and NOTICE, the two files the parity test reads, check-parity and
//   its test, and the shell (apps/merge-studio) at the repository root.
// - GENERATED: computed by the export (VENDORED_FROM.json, the standalone
//   package.json, tsconfig.json, package-lock.json, vendor/gitstudio/.gitattributes).
// - merge-studio's own: everything else (.github/, docs/, SECURITY.md, …). The
//   export never writes or removes these, and the import refuses them.

import { join, posix } from "node:path";
import { listFiles, MANIFEST_FILE, VENDOR_DIR } from "./check-parity.mjs";

export { MANIFEST_FILE, VENDOR_DIR };

export const SHELL_DIR = "apps/merge-studio";
export const VENDORED_PACKAGES = ["engine", "git-service", "host-bridge", "webview-ui", "merge-vscode"];

/**
 * gitstudio path → merge-studio path, bytes unchanged. A path ending in "/" is
 * a folder: every file under it, including files added later. The shell row
 * comes last: apps/merge-studio's files land at the root, minus SHELL_SKIP and
 * anything GENERATED.
 */
export const COPIED = [
  ...VENDORED_PACKAGES.flatMap((p) => [
    { gitstudio: `packages/${p}/src/`, mergeStudio: `${VENDOR_DIR}/${p}/src/` },
    { gitstudio: `packages/${p}/package.json`, mergeStudio: `${VENDOR_DIR}/${p}/package.json` },
  ]),
  { gitstudio: "LICENSE", mergeStudio: `${VENDOR_DIR}/LICENSE` },
  { gitstudio: "NOTICE", mergeStudio: `${VENDOR_DIR}/NOTICE` },
  // The two GitStudio files merge-studio's parity test compares against.
  { gitstudio: "apps/extension/package.json", mergeStudio: `${VENDOR_DIR}/extension/package.json`, parityInput: true },
  { gitstudio: "apps/extension/src/merge/mergeIds.ts", mergeStudio: `${VENDOR_DIR}/extension/src/merge/mergeIds.ts`, parityInput: true },
  // The parity check travels with the vendored code.
  { gitstudio: "scripts/merge-studio/check-parity.mjs", mergeStudio: "scripts/check-parity.mjs" },
  { gitstudio: "scripts/merge-studio/test/checkParity.test.mjs", mergeStudio: "scripts/test/checkParity.test.mjs" },
  { gitstudio: `${SHELL_DIR}/`, mergeStudio: "", shell: true },
];

/** Files the export computes, what it computes them from, and why the import leaves them out. */
export const GENERATED = [
  {
    mergeStudio: MANIFEST_FILE,
    from: [],
    why: "the export writes it (the gitstudio sha and a hash per file)",
  },
  {
    mergeStudio: "package.json",
    from: [`${SHELL_DIR}/package.json`, ...VENDORED_PACKAGES.map((p) => `packages/${p}/package.json`), "package.json", "package-lock.json"],
    why: "the export writes it from apps/merge-studio/package.json, with the dependency block pinned from gitstudio's lockfile",
  },
  {
    mergeStudio: "tsconfig.json",
    from: ["tsconfig.base.json"],
    why: "the export writes it from gitstudio's tsconfig.base.json, with @gitstudio/* paths into vendor/gitstudio",
  },
  {
    mergeStudio: "package-lock.json",
    from: ["package-lock.json"],
    why: "the export cuts it from gitstudio's package-lock.json",
  },
  {
    mergeStudio: `${VENDOR_DIR}/.gitattributes`,
    from: [],
    why: "the export writes it (no line-ending conversion of the hashed files)",
  },
];

/** Paths in the target the export replaces: removed before writing. */
export const REPLACED = ["src", "webview", "test", "test-harness", VENDOR_DIR, "scripts/check-parity.mjs", "scripts/test/checkParity.test.mjs"];

/** Shell files that are never copied as they are: regenerated, or build output. */
export const SHELL_SKIP = [/^node_modules(\/|$)/, /^dist(\/|$)/, /\.vsix$/, /^package\.json$/, /^tsconfig\.json$/, /(^|\/)\.DS_Store$/];

const generatedByPath = new Map(GENERATED.map((g) => [g.mergeStudio, g]));

/** The shell's files the export copies to the root, relative to apps/merge-studio. */
export function shellFiles(gitstudioRoot) {
  return listFiles(join(gitstudioRoot, SHELL_DIR)).filter((rel) => !SHELL_SKIP.some((re) => re.test(rel)) && !generatedByPath.has(rel));
}

/**
 * Every file the export copies, as [gitstudio path, merge-studio path] pairs,
 * listed from a gitstudio checkout. Throws when two rows would write one path.
 */
export function copiedFiles(gitstudioRoot) {
  const out = [];
  for (const row of COPIED) {
    if (row.shell) {
      for (const rel of shellFiles(gitstudioRoot)) out.push([`${SHELL_DIR}/${rel}`, rel]);
    } else if (row.gitstudio.endsWith("/")) {
      for (const rel of listFiles(join(gitstudioRoot, row.gitstudio))) out.push([row.gitstudio + rel, row.mergeStudio + rel]);
    } else {
      out.push([row.gitstudio, row.mergeStudio]);
    }
  }
  const seen = new Map();
  for (const [from, to] of out) {
    if (seen.has(to)) throw new Error(`${seen.get(to)} and ${from} would both be written to ${to}`);
    if (from.startsWith(`${SHELL_DIR}/`) && to.startsWith(`${VENDOR_DIR}/`)) {
      throw new Error(`${from} would be written into ${VENDOR_DIR}/, which holds the vendored code alone`);
    }
    seen.set(to, from);
  }
  return out;
}

/** The gitstudio paths an export reads (for the dirty check and the staleness warning). */
export function sourcePaths() {
  const paths = [
    ...COPIED.map((row) => row.gitstudio.replace(/\/$/, "")),
    "scripts/merge-studio", // export.mjs and this table: changing them changes the export
    ...GENERATED.flatMap((g) => g.from),
  ];
  const unique = [...new Set(paths)];
  return unique.filter((p) => !unique.some((q) => q !== p && p.startsWith(`${q}/`)));
}

/** The shell's folders the export replaces as a whole (src/, test/): anything in them is the shell's. */
function shellFolders(shell) {
  return REPLACED.filter((r) => !r.includes("/") && [...shell].some((f) => f.startsWith(`${r}/`))).map((r) => `${r}/`);
}

/**
 * Where a merge-studio path comes from in gitstudio.
 *
 * @param {string} msPath forward-slashed, relative to the merge-studio root
 * @param {{ shell: Set<string>, isNew?: boolean }} ctx `shell`: the shell's
 *   files (shellFiles(), plus any the import has already added); `isNew`: the
 *   change creates the file
 * @returns {{ kind: "copied", gitstudio: string, shell: boolean }
 *   | { kind: "generated", why: string }
 *   | { kind: "unmapped", why: string }}
 */
export function toGitstudio(msPath, { shell, isNew = false }) {
  const p = posix.normalize(msPath);
  if (p !== msPath || p.startsWith("../") || p.startsWith("/") || p === "." || p === "") {
    return { kind: "unmapped", why: "not a plain path inside the repository" };
  }
  const generated = generatedByPath.get(p);
  if (generated) return { kind: "generated", why: generated.why };
  for (const row of COPIED) {
    if (row.shell) continue;
    if (row.mergeStudio.endsWith("/") ? p.startsWith(row.mergeStudio) : p === row.mergeStudio) {
      return { kind: "copied", gitstudio: row.mergeStudio.endsWith("/") ? row.gitstudio + p.slice(row.mergeStudio.length) : row.gitstudio, shell: false };
    }
  }
  if (p.startsWith(`${VENDOR_DIR}/`)) {
    return {
      kind: "unmapped",
      why: `GitStudio has no such file: ${VENDOR_DIR}/ holds only <package>/src/**, <package>/package.json, LICENSE, NOTICE and the extension's two parity files (a new vendored file goes under ${VENDOR_DIR}/<package>/src/)`,
    };
  }
  if (p.startsWith("scripts/")) {
    return { kind: "unmapped", why: "the export writes only scripts/check-parity.mjs and scripts/test/checkParity.test.mjs; anything else under scripts/ is merge-studio's own" };
  }
  if (SHELL_SKIP.some((re) => re.test(p))) {
    return { kind: "unmapped", why: "build output or a file the export regenerates: never copied from apps/merge-studio" };
  }
  if (shell.has(p) || shellFolders(shell).some((f) => p.startsWith(f))) {
    return { kind: "copied", gitstudio: `${SHELL_DIR}/${p}`, shell: true };
  }
  const dir = posix.dirname(p);
  if (isNew && dir !== "." && [...shell].some((f) => posix.dirname(f) === dir)) {
    return { kind: "copied", gitstudio: `${SHELL_DIR}/${p}`, shell: true };
  }
  if (isNew) {
    return {
      kind: "unmapped",
      why:
        dir === "."
          ? "a new file at the repository root: if it belongs to the extension, add it to gitstudio's apps/merge-studio by hand; if it is merge-studio's own, merge it there"
          : `a new file in ${dir}/, a folder the shell (apps/merge-studio) does not have: merge-studio's own`,
    };
  }
  return { kind: "unmapped", why: "merge-studio's own file (the export never writes it): change it in merge-studio directly" };
}
