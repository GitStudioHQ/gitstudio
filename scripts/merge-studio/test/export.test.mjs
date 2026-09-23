// export.mjs: the pure pieces on hand-built inputs, then one real export of
// this checkout into a scratch folder that stands in for a merge-studio
// checkout — which check-parity must accept, and must reject after one
// vendored byte changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkParity, sha256 } from "../check-parity.mjs";
import {
  exportTo,
  GITSTUDIO_ROOT,
  lockSubset,
  resolveInLock,
  standalonePackageJson,
  standaloneTsconfig,
  VENDOR_GITATTRIBUTES,
  VENDORED_PACKAGES,
} from "../export.mjs";

const entry = (version, extra = {}) => ({
  version,
  resolved: `https://registry.example/${version}.tgz`,
  integrity: `sha512-${version}`,
  ...extra,
});

/** A miniature gitstudio lockfile: one hoisted tool, one nested under a workspace, one nested dep. */
function fakeLock() {
  return {
    packages: {
      "": { name: "gitstudio-workspace" },
      "apps/merge-studio": { name: "merge-studio" },
      "apps/merge-studio/node_modules/@types/vscode": entry("1.78.0", { dev: true }),
      "packages/ui": { name: "@gitstudio/ui" },
      "node_modules/@gitstudio/ui": { resolved: "packages/ui", link: true },
      "node_modules/esbuild": entry("0.28.1", { dev: true, optionalDependencies: { "@esbuild/linux-x64": "0.28.1" } }),
      "node_modules/@esbuild/linux-x64": entry("0.28.1", { dev: true, optional: true, os: ["linux"], cpu: ["x64"] }),
      "node_modules/monaco-editor": entry("0.55.1", { dependencies: { dompurify: "3.2.7", marked: "14.0.0" } }),
      "node_modules/dompurify": entry("3.4.11"),
      "node_modules/marked": entry("14.0.0"),
      "node_modules/lit": entry("3.3.3", { dependencies: { "lit-html": "^3.3.0" } }),
      "node_modules/lit/node_modules/lit-html": entry("3.3.9"),
      "node_modules/lit-html": entry("2.0.0"),
    },
  };
}

test("resolveInLock follows node's lookup: nested first, then up to the root", () => {
  const p = fakeLock().packages;
  assert.equal(resolveInLock(p, "@types/vscode", "apps/merge-studio"), "apps/merge-studio/node_modules/@types/vscode");
  assert.equal(resolveInLock(p, "esbuild", "apps/merge-studio"), "node_modules/esbuild");
  assert.equal(resolveInLock(p, "lit-html", "node_modules/lit"), "node_modules/lit/node_modules/lit-html");
  assert.equal(resolveInLock(p, "lit-html", "packages/ui"), "node_modules/lit-html");
  assert.equal(resolveInLock(p, "nope", "packages/ui"), undefined);
});

test("the standalone package.json drops the workspace packages and pins every version gitstudio resolves", () => {
  const lock = fakeLock();
  const shell = {
    name: "merge-studio",
    version: "0.4.0",
    scripts: { package: "node esbuild.js --production", test: "old" },
    dependencies: { "@gitstudio/ui": "*" },
    devDependencies: { esbuild: "^0.28.0", "@types/vscode": "1.78.0" },
  };
  const packages = { ui: { dependencies: { "@gitstudio/engine": "*", lit: "^3.3.1", "monaco-editor": "^0.55.1" } } };
  const { pkg, resolved } = standalonePackageJson({ shell, packages, lock, rootPackage: { overrides: { dompurify: "3.4.11" } } });
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(pkg.devDependencies, { "@types/vscode": "1.78.0", esbuild: "0.28.1", lit: "3.3.3", "monaco-editor": "0.55.1" });
  assert.deepEqual(pkg.overrides, { dompurify: "3.4.11" });
  assert.equal(pkg.scripts["check-parity"], "node scripts/check-parity.mjs");
  assert.match(pkg.scripts.test, /scripts\/test\/\*\.test\.mjs/);
  assert.equal(pkg.scripts.package, "node esbuild.js --production", "the shell's other scripts are kept");
  assert.equal(shell.dependencies["@gitstudio/ui"], "*", "the input is not mutated");
  assert.equal(resolved.get("@types/vscode"), "apps/merge-studio/node_modules/@types/vscode");
});

test("a dependency gitstudio's lockfile does not have stops the export", () => {
  const shell = { name: "m", version: "1.0.0", devDependencies: { "left-pad": "1.0.0" } };
  assert.throws(
    () => standalonePackageJson({ shell, packages: {}, lock: fakeLock(), rootPackage: {} }),
    /left-pad .* is not in gitstudio's package-lock\.json/,
  );
});

test("the lockfile cut: the closure at gitstudio's versions, workspace-nested entries at the top, all dev", () => {
  const lock = fakeLock();
  const shell = { name: "merge-studio", version: "0.4.0", devDependencies: { esbuild: "^0.28.1", "@types/vscode": "1.78.0" } };
  const packages = { ui: { dependencies: { lit: "^3.3.1", "monaco-editor": "^0.55.1" } } };
  const { pkg, resolved } = standalonePackageJson({ shell, packages, lock, rootPackage: {} });
  const out = lockSubset({ lock, pkg, resolved });
  assert.equal(out.lockfileVersion, 3);
  assert.deepEqual(Object.keys(out.packages), [
    "",
    "node_modules/@esbuild/linux-x64",
    "node_modules/@types/vscode",
    "node_modules/dompurify",
    "node_modules/esbuild",
    "node_modules/lit",
    "node_modules/lit/node_modules/lit-html",
    "node_modules/marked",
    "node_modules/monaco-editor",
  ]);
  assert.deepEqual(out.packages[""].devDependencies, pkg.devDependencies);
  assert.equal(out.packages["node_modules/@types/vscode"].version, "1.78.0");
  assert.equal(out.packages["node_modules/lit/node_modules/lit-html"].version, "3.3.9", "nesting kept");
  assert.ok(!("node_modules/lit-html" in out.packages), "the unused hoisted copy is not pulled in");
  assert.equal(out.packages["node_modules/@esbuild/linux-x64"].optional, true);
  assert.deepEqual(out.packages["node_modules/@esbuild/linux-x64"].os, ["linux"]);
  for (const [k, v] of Object.entries(out.packages)) if (k) assert.equal(v.dev, true, k);
  assert.equal(out.packages["node_modules/monaco-editor"].integrity, "sha512-0.55.1");
});

test("the standalone tsconfig maps every vendored package into vendor/gitstudio", () => {
  const t = standaloneTsconfig({ compilerOptions: { strict: true, moduleResolution: "Bundler" } });
  assert.equal(t.compilerOptions.strict, true);
  assert.deepEqual(t.compilerOptions.types, ["node", "vscode"]);
  assert.deepEqual(Object.keys(t.compilerOptions.paths).sort(), VENDORED_PACKAGES.map((p) => `@gitstudio/${p}/*`).sort());
  assert.deepEqual(t.compilerOptions.paths["@gitstudio/engine/*"], ["./vendor/gitstudio/engine/src/*"]);
  assert.equal(t.compilerOptions.baseUrl, undefined, "paths resolve from the tsconfig itself (baseUrl is deprecated)");
});

test("a real export: replaces the old layout, vendors the packages, and passes check-parity until a byte changes", () => {
  const into = mkdtempSync(join(tmpdir(), "ms-export-test-"));
  try {
    // What a merge-studio 0.3.4 checkout has that the shell replaces, and what it keeps.
    for (const rel of ["src/extension.ts", "webview/main.ts", "test/old.test.ts", "test-harness/index.html", "test-fixtures/make-conflict.sh"]) {
      mkdirSync(join(into, rel, ".."), { recursive: true });
      writeFileSync(join(into, rel), "old\n");
    }
    const r = exportTo({ into, allowDirty: true });
    assert.deepEqual(r.removed.sort(), ["src", "test", "test-harness", "webview"]);
    assert.equal(existsSync(join(into, "webview")), false);
    assert.equal(readFileSync(join(into, "test-fixtures/make-conflict.sh"), "utf8"), "old\n", "not the shell's: kept");
    assert.ok(existsSync(join(into, "src/extension.ts")), "the shell's src");
    assert.ok(existsSync(join(into, "test/parity.test.ts")));
    for (const p of VENDORED_PACKAGES) assert.ok(existsSync(join(into, "vendor/gitstudio", p, "src")), p);
    assert.ok(existsSync(join(into, "vendor/gitstudio/extension/src/merge/mergeIds.ts")));
    assert.ok(existsSync(join(into, "vendor/gitstudio/LICENSE")));
    // A Windows checkout must not rewrite the hashed bytes (core.autocrlf).
    assert.equal(readFileSync(join(into, "vendor/gitstudio/.gitattributes"), "utf8"), VENDOR_GITATTRIBUTES);
    assert.match(VENDOR_GITATTRIBUTES, /^\* -text$/m);

    const pkg = JSON.parse(readFileSync(join(into, "package.json"), "utf8"));
    assert.equal(pkg.name, "merge-studio");
    assert.equal(pkg.dependencies, undefined);
    assert.ok(!Object.keys(pkg.devDependencies).some((d) => d.startsWith("@gitstudio/")));
    for (const v of Object.values(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, "pinned");
    const tsconfig = JSON.parse(readFileSync(join(into, "tsconfig.json"), "utf8"));
    assert.deepEqual(tsconfig.compilerOptions.paths["@gitstudio/merge-vscode/*"], ["./vendor/gitstudio/merge-vscode/src/*"]);
    const lock = JSON.parse(readFileSync(join(into, "package-lock.json"), "utf8"));
    assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);

    const manifest = JSON.parse(readFileSync(join(into, "VENDORED_FROM.json"), "utf8"));
    const head = execFileSync("git", ["-C", GITSTUDIO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(manifest.gitstudio.sha, head);
    const mergeModel = "vendor/gitstudio/engine/src/mergeModel.ts";
    assert.equal(
      manifest.files[mergeModel],
      sha256(readFileSync(join(GITSTUDIO_ROOT, "packages/engine/src/mergeModel.ts"))),
      "the hash is of gitstudio's bytes",
    );
    assert.ok(existsSync(join(into, "scripts/check-parity.mjs")));

    assert.deepEqual(checkParity(into).problems, []);
    const bytes = readFileSync(join(into, mergeModel));
    bytes[0] ^= 1;
    writeFileSync(join(into, mergeModel), bytes);
    assert.deepEqual(checkParity(into).problems, [`modified: ${mergeModel}`]);

    // Idempotent: exporting again restores the vendored byte.
    exportTo({ into, allowDirty: true });
    assert.equal(checkParity(into).ok, true);
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
});

test("a shell file the previous export wrote and gitstudio no longer has is removed; nothing else is, whatever the manifest says", () => {
  const outside = mkdtempSync(join(tmpdir(), "ms-export-outside-"));
  const into = join(outside, "merge-studio");
  mkdirSync(into);
  try {
    const files = {
      "media/old-shot.png": "gone from gitstudio",
      "docs/walkthrough/old.md": "gone from gitstudio, and its folder with it",
      "OLD.md": "gone from gitstudio",
      "SECURITY.md": "merge-studio's own: never listed",
      "package-lock.json": "generated: an export without --no-lock writes it",
      ".git/config": "never",
      "escape/kept.txt": "through a symbolic link",
    };
    mkdirSync(join(outside, "elsewhere"));
    for (const [rel, text] of Object.entries(files)) {
      const at = rel.startsWith("escape/") ? join(outside, "elsewhere", "kept.txt") : join(into, rel);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, text);
    }
    symlinkSync(join(outside, "elsewhere"), join(into, "escape"));
    writeFileSync(join(outside, "outside.txt"), "outside the checkout");
    // What a previous export recorded, plus what a pull request could add to it.
    const listed = ["media/old-shot.png", "docs/walkthrough/old.md", "OLD.md", "package-lock.json", "README.md", "../outside.txt", ".git/config", "escape/kept.txt", "vendor/gitstudio/LICENSE", "/etc/hosts"];
    writeFileSync(join(into, "VENDORED_FROM.json"), JSON.stringify({ schema: 1, files: {}, shell: Object.fromEntries(listed.map((p) => [p, "0"])) }));

    const r = exportTo({ into, allowDirty: true, lock: false });
    assert.deepEqual(r.stale.sort(), ["OLD.md", "docs/walkthrough/old.md", "media/old-shot.png"]);
    for (const rel of r.stale) assert.equal(existsSync(join(into, rel)), false, rel);
    assert.equal(existsSync(join(into, "docs")), false, "a folder left empty goes too");
    assert.ok(existsSync(join(into, "media/icon.png")), "the shell's own media stay");
    assert.ok(existsSync(join(into, "README.md")), "written by this export too");
    assert.ok(existsSync(join(into, "vendor/gitstudio/LICENSE")), "the vendored copy is never removed");
    assert.equal(readFileSync(join(into, "SECURITY.md"), "utf8"), files["SECURITY.md"]);
    assert.equal(readFileSync(join(into, "package-lock.json"), "utf8"), files["package-lock.json"], "generated: --no-lock leaves it be");
    assert.equal(readFileSync(join(into, ".git/config"), "utf8"), files[".git/config"]);
    assert.ok(existsSync(join(outside, "outside.txt")));
    assert.ok(existsSync(join(outside, "elsewhere", "kept.txt")), "never through a symbolic link");
    // The new manifest lists what this export wrote, so the next one removes by it.
    const shell = Object.keys(JSON.parse(readFileSync(join(into, "VENDORED_FROM.json"), "utf8")).shell);
    assert.ok(shell.includes("README.md") && !shell.includes("OLD.md"));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

/** A workflow's jobs, by name: the lines of each, read by indentation (no YAML library in either repository). */
function workflowJobs(yml) {
  const lines = yml.split("\n");
  const start = lines.indexOf("jobs:");
  assert.ok(start >= 0, "the workflow has jobs");
  const jobs = {};
  let current;
  for (const line of lines.slice(start + 1)) {
    const name = /^ {2}([\w-]+):\s*$/.exec(line);
    if (name) jobs[(current = name[1])] = [];
    else if (current && !/^\s*#/.test(line)) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join("\n")]));
}

test("the export writes merge-studio's CI: check-parity in a job of its own, neutral on a pull request, strict on main", () => {
  const into = mkdtempSync(join(tmpdir(), "ms-export-ci-"));
  try {
    // merge-studio's hand-kept workflow before the first export that writes it.
    mkdirSync(join(into, ".github/workflows"), { recursive: true });
    writeFileSync(join(into, ".github/workflows/ci.yml"), "name: CI\n# hand-kept\n");
    writeFileSync(join(into, ".github/workflows/release.yml"), "name: Release\n");
    exportTo({ into, allowDirty: true, lock: false });

    const yml = readFileSync(join(into, ".github/workflows/ci.yml"), "utf8");
    assert.equal(yml, readFileSync(join(GITSTUDIO_ROOT, "scripts/merge-studio/merge-studio-ci.yml"), "utf8"), "written from gitstudio's template, byte for byte");
    assert.equal(readFileSync(join(into, ".github/workflows/release.yml"), "utf8"), "name: Release\n", "merge-studio's own release workflow is left alone");
    assert.match(yml, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/m, "it runs on pushes to main and on pull requests");

    const jobs = workflowJobs(yml);
    assert.deepEqual(Object.keys(jobs).sort(), ["build", "parity"]);
    // The parity job: the one place check-parity runs, relaxed on a pull request only.
    const parityRuns = jobs.parity.split("\n").filter((l) => /check-parity/.test(l));
    assert.deepEqual(parityRuns.map((l) => l.trim()), [
      "run: node scripts/check-parity.mjs ${{ github.event_name == 'pull_request' && '--pull-request' || '' }}",
    ]);
    assert.doesNotMatch(jobs.parity, /npm ci/, "it needs no install");
    // The build job type-checks and tests whatever the parity job says.
    assert.doesNotMatch(jobs.build, /check-parity/);
    assert.doesNotMatch(jobs.build, /\bneeds:/);
    assert.doesNotMatch(jobs.build, /continue-on-error/);
    for (const step of ["run: npm ci", "run: npm run check-types", "run: npm test"]) assert.ok(jobs.build.includes(step), step);

    // Every npm script it runs is one the exported package.json has.
    const pkg = JSON.parse(readFileSync(join(into, "package.json"), "utf8"));
    for (const [, script] of yml.matchAll(/npm run ([\w:-]+)/g)) assert.ok(pkg.scripts[script], `npm run ${script}`);
    assert.ok(existsSync(join(into, "scripts/check-parity.mjs")));

    // The export records it with the shell files, so check-parity warns when merge-studio edits it by hand.
    const manifest = JSON.parse(readFileSync(join(into, "VENDORED_FROM.json"), "utf8"));
    assert.ok(".github/workflows/ci.yml" in manifest.shell);
    writeFileSync(join(into, ".github/workflows/ci.yml"), `${yml}# local edit\n`);
    assert.match(checkParity(into).warnings.join("\n"), /shell modified: \.github\/workflows\/ci\.yml/);
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
});

test("the export never writes into this gitstudio checkout", () => {
  assert.throws(() => exportTo({ into: GITSTUDIO_ROOT, allowDirty: true }), /must be a merge-studio checkout/);
});
