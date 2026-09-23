// import.mjs: a merge-studio pull request replayed into gitstudio.
//
// The scenario tests build two scratch repositories from this checkout: a
// "gitstudio" holding the files the export reads, and a "merge-studio" written
// by export.mjs from it. A contributor branches merge-studio, the import
// replays the branch into the scratch gitstudio, and export.mjs is run again on
// the result to prove the round trip. Nothing touches this checkout's git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkParity } from "../check-parity.mjs";
import { exportTo, GITSTUDIO_ROOT } from "../export.mjs";
import {
  applyHunks,
  blobId,
  diffJson,
  ImportRefused,
  ImportStopped,
  importPullRequest,
  packageJsonChange,
  parsePatch,
  renderFile,
  setLockVersion,
} from "../import.mjs";
import { copiedFiles, GENERATED, shellFiles, sourcePaths, toGitstudio } from "../layout.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "import.mjs");

// Hermetic git: no user or system config (signing, hooks, default branch) leaks in.
const EMPTY_CONFIG = join(mkdtempSync(join(tmpdir(), "ms-import-config-")), "gitconfig");
writeFileSync(EMPTY_CONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const JANE = "Jane Contributor <jane@example.com>";
const MERGE_MODEL = "vendor/gitstudio/engine/src/mergeModel.ts";

// The release a contributor's "Release x.y.z" bumps from, and to: whatever
// Merge Studio's version is, never a number typed here.
const SHELL_VERSION = JSON.parse(readFileSync(join(GITSTUDIO_ROOT, "apps/merge-studio/package.json"), "utf8")).version;
const NEXT_VERSION = SHELL_VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));

const g = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");

function identity(repo) {
  g(repo, "config", "user.name", "Maintainer");
  g(repo, "config", "user.email", "maintainer@example.com");
}

/** A gitstudio repository holding what the export reads, copied from this checkout's working tree. */
function scratchGitstudio() {
  const root = mkdtempSync(join(tmpdir(), "ms-import-gs-"));
  const listed = execFileSync("git", ["-C", GITSTUDIO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...sourcePaths()], {
    encoding: "utf8",
  });
  for (const rel of listed.split("\0").filter(Boolean)) {
    if (!existsSync(join(GITSTUDIO_ROOT, rel))) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(GITSTUDIO_ROOT, rel), join(root, rel));
  }
  g(root, "init", "-q", "-b", "main");
  identity(root);
  g(root, "add", "-A");
  g(root, "commit", "-qm", "gitstudio");
  g(root, "switch", "-qc", "import/pr-12");
  return root;
}

/** A merge-studio repository: its own files, then an export of `gs`; the contributor's branch is checked out. */
function scratchMergeStudio(gs) {
  const root = mkdtempSync(join(tmpdir(), "ms-import-ms-"));
  g(root, "init", "-q", "-b", "main");
  identity(root);
  for (const [rel, text] of Object.entries({
    ".github/workflows/ci.yml": "name: CI\n",
    "SECURITY.md": "# Security\n",
    "docs/index.md": "# Merge Studio\n",
    "test-fixtures/make-conflict.sh": "#!/bin/sh\n",
  })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  exportTo({ into: root, gitstudio: gs });
  g(root, "add", "-A");
  g(root, "commit", "-qm", "Export from gitstudio");
  g(root, "switch", "-qc", "contrib");
  return root;
}

/**
 * One contributor commit: each edit maps a path to a function of its old text,
 * null (delete it), { renameTo, edit? } (move it, and change its text), or
 * { bytes } (a function of its old bytes, for a binary file).
 */
function contribute(ms, subject, edits, date, author = JANE) {
  for (const [rel, fn] of Object.entries(edits)) {
    const file = join(ms, rel);
    if (fn === null) {
      unlinkSync(file);
      continue;
    }
    if (fn.renameTo) {
      const to = join(ms, fn.renameTo);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(file, to);
      if (fn.edit) writeFileSync(to, fn.edit(readFileSync(to, "utf8")));
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    if (fn.bytes) writeFileSync(file, fn.bytes(existsSync(file) ? readFileSync(file) : Buffer.alloc(0)));
    else writeFileSync(file, fn(existsSync(file) ? readFileSync(file, "utf8") : ""));
  }
  g(ms, "add", "-A");
  g(ms, "commit", "-q", "-m", subject, `--author=${author}`, ...(date ? [`--date=${date}`] : []));
  return g(ms, "rev-parse", "HEAD");
}

/** `gh pr diff --patch`: one mail per commit, as `git format-patch` writes them. */
function mbox(ms, range, dir) {
  const file = join(dir, "pr.patch");
  writeFileSync(file, execFileSync("git", ["-C", ms, "format-patch", "--stdout", range]));
  return file;
}

/**
 * The next export as it really runs: over merge-studio's main, where the pull
 * request was never merged. Returns how that tree differs from the
 * contributor's `head` (the manifest, which records the gitstudio sha, aside).
 */
function exportOverMain(ms, gs, head) {
  const wt = join(mkdtempSync(join(tmpdir(), "ms-import-main-")), "wt");
  g(ms, "worktree", "add", "-q", "--detach", wt, "main");
  try {
    exportTo({ into: wt, gitstudio: gs, allowDirty: true });
    g(wt, "add", "-A");
    return g(wt, "diff", "--cached", "--name-status", head, "--", ".", ":!VENDORED_FROM.json");
  } finally {
    g(ms, "worktree", "remove", "--force", wt);
    rmSync(dirname(wt), { recursive: true, force: true });
  }
}

/** Change line `n` (0-based) of a file's text. */
const lineEdit = (n, fn) => (text) => {
  const lines = text.split("\n");
  lines[n] = fn(lines[n]);
  return lines.join("\n");
};
const append = (extra) => (text) => `${text}${extra}`;

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

const generatedPaths = new Set(GENERATED.map((x) => x.mergeStudio));

test("a contributor's branch comes back commit by commit, and exports to their exact files", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  const again = mkdtempSync(join(tmpdir(), "ms-import-again-"));
  try {
    const engine = contribute(
      ms,
      "engine: keep the base side's blank line",
      {
        [MERGE_MODEL]: append("// contributed: a vendored file\n"),
        "vendor/gitstudio/engine/src/contributedHelper.ts": () => "export const contributed = true;\n",
      },
      "2026-09-01T10:00:00+02:00",
    );
    const shell = contribute(ms, "Link the new docs page\n\nThe walkthrough's link was stale.", {
      "src/links.ts": append("// contributed: a shell file\n"),
      "README.md": (t) => t.replace(/\n$/, "\n\nContributed line.\n"),
      "test/contributed.test.ts": () => 'import { test } from "node:test";\ntest("contributed", () => {});\n',
    });
    const release = contribute(ms, `Release ${NEXT_VERSION}`, {
      "package.json": (t) => t.replace(/"version": "[^"]+"/, `"version": "${NEXT_VERSION}"`),
      "CHANGELOG.md": (t) => t.replace(/^(# [^\n]*\n)/, `$1\n## ${NEXT_VERSION}\n\n- A contributed fix.\n`),
    });
    // Only files the export generates: nothing of it is imported.
    const generated = contribute(ms, "Bump esbuild and regenerate", {
      "package.json": (t) => t.replace(/"esbuild": "[^"]+"/, '"esbuild": "0.99.0"'),
      "package-lock.json": (t) => t.replace(/"node_modules\/esbuild": \{\n(\s+)"version": "[^"]+"/, '"node_modules/esbuild": {\n$1"version": "0.99.0"'),
      "tsconfig.json": (t) => t.replace('"strict": true', '"strict": false'),
      "VENDORED_FROM.json": (t) => t.replace(/"dirty": (true|false)/, '"dirty": true'),
    });

    const r = importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib", pr: "12" });

    // One gitstudio commit per upstream commit that carries something, the contributor as author.
    assert.deepEqual(
      r.commits.map((c) => [c.upstream, Boolean(c.sha), Boolean(c.skipped)]),
      [
        [engine, true, false],
        [shell, true, false],
        [release, true, false],
        [generated, false, true],
      ],
    );
    const log = g(gs, "log", "--reverse", "--format=%an <%ae>|%aI|%s|%(trailers:key=Imported-from,valueonly,separator=)", "main..HEAD").split("\n");
    assert.deepEqual(log, [
      `${JANE}|2026-09-01T10:00:00+02:00|engine: keep the base side's blank line|GitStudioHQ/merge-studio#12 / ${engine}`,
      `${JANE}|${g(ms, "log", "-1", "--format=%aI", shell)}|Link the new docs page|GitStudioHQ/merge-studio#12 / ${shell}`,
      `${JANE}|${g(ms, "log", "-1", "--format=%aI", release)}|Release ${NEXT_VERSION}|GitStudioHQ/merge-studio#12 / ${release}`,
    ]);
    assert.equal(g(gs, "log", "-1", "--format=%b", "HEAD~1").split("\n")[0], "The walkthrough's link was stale.", "the message body is kept");
    assert.equal(g(gs, "log", "-1", "--format=%cn", "HEAD"), "Maintainer", "the maintainer commits it");

    // The monorepo diff: every path mapped back, nothing else.
    assert.deepEqual(g(gs, "diff", "--name-status", "main", "HEAD").split("\n").sort(), [
      "A\tapps/merge-studio/test/contributed.test.ts",
      "A\tpackages/engine/src/contributedHelper.ts",
      "M\tapps/merge-studio/CHANGELOG.md",
      "M\tapps/merge-studio/README.md",
      "M\tapps/merge-studio/package.json",
      "M\tapps/merge-studio/src/links.ts",
      "M\tpackage-lock.json",
      "M\tpackages/engine/src/mergeModel.ts",
    ]);
    // package.json: the version bump is imported, the dependency block is not.
    const pkg = (rev) => JSON.parse(g(gs, "show", `${rev}:apps/merge-studio/package.json`));
    assert.equal(pkg("HEAD").version, NEXT_VERSION);
    assert.deepEqual(pkg("HEAD").devDependencies, pkg("main").devDependencies);
    assert.deepEqual({ ...pkg("HEAD"), version: "x" }, { ...pkg("main"), version: "x" }, "nothing but the version changed");
    // From gitstudio's own lockfile, whose entry must already say the release
    // package.json says: the import moves it from there, and nothing else.
    const lockDiff = g(gs, "diff", "-U0", "main", "HEAD", "--", "package-lock.json").split("\n").filter((l) => /^[-+] /.test(l));
    assert.deepEqual(lockDiff, [`-      "version": "${SHELL_VERSION}",`, `+      "version": "${NEXT_VERSION}",`], "gitstudio's lockfile entry follows the version");
    const notes = g(gs, "log", "-1", "--format=%(trailers:key=Import-note,valueonly)", "HEAD");
    assert.match(notes, /package\.json version applied to apps\/merge-studio\/package\.json/);
    // The generated-only commit is reported, not imported.
    assert.deepEqual(r.notImported.map((n) => n.path).sort(), ["VENDORED_FROM.json", "package-lock.json", "package.json", "tsconfig.json"]);
    assert.deepEqual(r.notImported.find((n) => n.path === "package.json").keys, ["devDependencies"]);

    // The round trip, as the import checked it...
    assert.deepEqual(
      r.roundTrip.map((x) => [x.path, x.status]).sort(),
      [
        [MERGE_MODEL, "identical"],
        ["CHANGELOG.md", "identical"],
        ["README.md", "identical"],
        ["package.json", "identical"],
        ["src/links.ts", "identical"],
        ["test/contributed.test.ts", "identical"],
        ["vendor/gitstudio/engine/src/contributedHelper.ts", "identical"],
      ].sort(),
    );
    // ...and proven independently: export.mjs on the result writes, byte for
    // byte, every file the contributor changed in the imported commits
    // (package.json included), and check-parity accepts it.
    exportTo({ into: again, gitstudio: gs });
    const changed = g(ms, "diff", "--name-only", "main", release).split("\n");
    assert.ok(changed.includes("package.json") && changed.includes(MERGE_MODEL) && changed.includes("src/links.ts"));
    for (const rel of changed) {
      assert.ok(readFileSync(join(again, rel)).equals(execFileSync("git", ["-C", ms, "show", `${release}:${rel}`])), `${rel} round-trips`);
    }
    // The generated-only commit's files are the export's, not the contributor's.
    for (const rel of g(ms, "diff", "--name-only", release, generated).split("\n")) {
      assert.ok(generatedPaths.has(rel), `${rel} is generated`);
    }
    assert.equal(checkParity(again).ok, true);
  } finally {
    cleanup(gs, ms, again);
  }
});

test("a path outside the mapping is refused before anything changes, and --exclude leaves it out on purpose", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  try {
    contribute(ms, "A mixed pull request", {
      [MERGE_MODEL]: append("// contributed\n"),
      ".github/workflows/ci.yml": append("# merge-studio's own CI\n"),
      "docs/index.md": append("More docs.\n"),
      "NEWS.md": () => "News.\n",
      "vendor/gitstudio/extra/helper.ts": () => "export {};\n",
      "scripts/release.mjs": () => "// a new script\n",
      "media/screenshots/new.png": () => "png",
    });
    const head = g(gs, "rev-parse", "HEAD");
    let refused;
    assert.throws(
      () => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }),
      (e) => {
        refused = e;
        return e instanceof ImportRefused;
      },
    );
    for (const path of [".github/workflows/ci.yml", "docs/index.md", "NEWS.md", "vendor/gitstudio/extra/helper.ts", "scripts/release.mjs", "media/screenshots/new.png"]) {
      assert.match(refused.message, new RegExp(`^  ${path.replace(/[./]/g, "\\$&")} \\([0-9a-f]{7}\\): `, "m"), path);
    }
    assert.doesNotMatch(refused.message, /mergeModel/, "the mapped path is not listed");
    assert.match(refused.message, /nothing was changed/);
    assert.match(refused.message, /--exclude/);
    assert.equal(g(gs, "rev-parse", "HEAD"), head);
    assert.equal(g(gs, "status", "--porcelain"), "");

    const r = importPullRequest({
      gitstudio: gs,
      from: ms,
      range: "main..contrib",
      excludes: [".github/", "docs", "NEWS.md", "vendor/gitstudio/extra/", "scripts/release.mjs", "media/screenshots/"],
    });
    assert.equal(r.commits.length, 1);
    assert.deepEqual(g(gs, "diff", "--name-only", "main", "HEAD").split("\n"), ["packages/engine/src/mergeModel.ts"]);
    assert.equal(r.excluded.length, 6);
  } finally {
    cleanup(gs, ms);
  }
});

test("a change to lines gitstudio also changed is a 3-way conflict with markers, never an overwrite", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  try {
    const gsFile = join(gs, "packages/engine/src/mergeModel.ts");
    writeFileSync(gsFile, lineEdit(5, () => "// gitstudio's own change")(readFileSync(gsFile, "utf8")));
    g(gs, "commit", "-qam", "gitstudio moves on");
    const head = g(gs, "rev-parse", "HEAD");
    contribute(ms, "A clean change first", { "README.md": append("A clean line.\n") });
    const sha = contribute(ms, "The contributor's change", {
      [MERGE_MODEL]: lineEdit(5, () => "// the contributor's change"),
      "src/links.ts": append("// fine\n"),
    });
    contribute(ms, "One more after it", { "CHANGELOG.md": append("- More.\n") });

    let stopped;
    assert.throws(
      () => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib", pr: "3" }),
      (e) => {
        stopped = e;
        return e instanceof ImportStopped;
      },
    );
    assert.match(stopped.message, /git apply --3way left conflicts in\n {2}packages\/engine\/src\/mergeModel\.ts\n/);
    assert.match(stopped.message, /git commit --author='Jane Contributor <jane@example\.com>'/);
    assert.match(stopped.message, /stopped at 2\/3 /);
    assert.match(stopped.message, /1 earlier commit\(s\) are imported\./);
    assert.ok(stopped.message.includes(`import the rest with --range ${sha}..<head>`));
    assert.equal(g(gs, "rev-parse", "HEAD~1"), head, "the clean commit before it is imported, and nothing after");
    assert.equal(g(gs, "log", "-1", "--format=%s"), "A clean change first");
    const text = readFileSync(gsFile, "utf8");
    assert.match(text, /<<<<<<< ours\n\/\/ gitstudio's own change\n=======\n\/\/ the contributor's change\n>>>>>>> theirs\n/);
    assert.match(g(gs, "ls-files", "-u"), /\tpackages\/engine\/src\/mergeModel\.ts$/m, "unmerged in the index");
    assert.equal(readFileSync(join(gs, "apps/merge-studio/src/links.ts"), "utf8").endsWith("// fine\n"), true, "the rest of the commit is applied");
    const msg = readFileSync(join(gs, ".git/MERGE_STUDIO_IMPORT_MSG"), "utf8");
    assert.match(msg, new RegExp(`^Imported-from: GitStudioHQ/merge-studio#3 / ${sha}$`, "m"));
  } finally {
    cleanup(gs, ms);
  }
});

test("a change elsewhere in a file gitstudio also changed merges, and the round trip says so", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  try {
    const gsFile = join(gs, "packages/engine/src/mergeModel.ts");
    writeFileSync(gsFile, lineEdit(5, () => "// gitstudio's own change")(readFileSync(gsFile, "utf8")));
    g(gs, "commit", "-qam", "gitstudio moves on");
    contribute(ms, "Far from gitstudio's change", { [MERGE_MODEL]: append("// the contributor's change\n") });

    const r = importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" });
    const text = readFileSync(gsFile, "utf8");
    assert.match(text, /^\/\/ gitstudio's own change$/m);
    assert.ok(text.endsWith("// the contributor's change\n"));
    assert.deepEqual(r.roundTrip, [{ path: MERGE_MODEL, status: "merged", projected: false }]);
  } finally {
    cleanup(gs, ms);
  }
});

test("a patch file: `gh pr diff --patch` keeps each commit and author; a plain `gh pr diff` needs --author", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  const files = mkdtempSync(join(tmpdir(), "ms-import-patch-"));
  try {
    const one = contribute(ms, "engine: one", { [MERGE_MODEL]: append("// one\n") }, "2026-09-02T09:30:00+03:00");
    const two = contribute(ms, `Release ${NEXT_VERSION}`, {
      "src/links.ts": append("// two\n"),
      "package.json": (t) => t.replace(/"version": "[^"]+"/, `"version": "${NEXT_VERSION}"`),
    });
    const mbox = join(files, "pr.patch");
    writeFileSync(mbox, execFileSync("git", ["-C", ms, "format-patch", "--stdout", "main..contrib"]));
    const plain = join(files, "pr.diff");
    writeFileSync(plain, execFileSync("git", ["-C", ms, "diff", "main", "contrib"]));

    const r = importPullRequest({ gitstudio: gs, patch: mbox, pr: "7" });
    assert.deepEqual(
      g(gs, "log", "--reverse", "--format=%an <%ae>|%s|%(trailers:key=Imported-from,valueonly,separator=)", "main..HEAD").split("\n"),
      [`${JANE}|engine: one|GitStudioHQ/merge-studio#7 / ${one}`, `${JANE}|Release ${NEXT_VERSION}|GitStudioHQ/merge-studio#7 / ${two}`],
    );
    assert.equal(g(gs, "log", "-1", "--format=%aI", "HEAD~1"), "2026-09-02T09:30:00+03:00");
    assert.ok(r.roundTrip.every((x) => x.status === "identical"), JSON.stringify(r.roundTrip));
    assert.equal(JSON.parse(g(gs, "show", "HEAD:apps/merge-studio/package.json")).version, NEXT_VERSION);

    g(gs, "reset", "-q", "--hard", "main");
    assert.throws(() => importPullRequest({ gitstudio: gs, patch: plain, pr: "7" }), (e) => e instanceof ImportRefused && /--author "Name <email>"/.test(e.message));
    const s = importPullRequest({ gitstudio: gs, patch: plain, pr: "7", author: JANE });
    assert.equal(s.commits.length, 1);
    assert.equal(g(gs, "log", "-1", "--format=%an <%ae>|%s|%(trailers:key=Imported-from,valueonly,separator=)"), `${JANE}|Import GitStudioHQ/merge-studio#7|GitStudioHQ/merge-studio#7`);
    assert.ok(s.roundTrip.every((x) => x.status === "identical"), JSON.stringify(s.roundTrip));
    assert.deepEqual(g(gs, "diff", "--name-only", "main", "HEAD").split("\n").sort(), [
      "apps/merge-studio/package.json",
      "apps/merge-studio/src/links.ts",
      "package-lock.json",
      "packages/engine/src/mergeModel.ts",
    ]);
  } finally {
    cleanup(gs, ms, files);
  }
});

test("a dependency added to a vendored package.json is imported with a note, and the round trip says why it cannot run yet", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  try {
    contribute(ms, "engine: use left-pad", {
      "vendor/gitstudio/engine/package.json": (t) => {
        const pkg = JSON.parse(t);
        pkg.dependencies = { ...pkg.dependencies, "left-pad": "^1.3.0" };
        return `${JSON.stringify(pkg, null, 2)}\n`;
      },
    });
    assert.throws(
      () => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }),
      (e) => e instanceof ImportStopped && /1 commit\(s\) are imported, but export\.mjs cannot run on the result/.test(e.message) && /left-pad/.test(e.message) && /npm install/.test(e.message),
    );
    assert.equal(JSON.parse(g(gs, "show", "HEAD:packages/engine/package.json")).dependencies["left-pad"], "^1.3.0");
    assert.match(g(gs, "log", "-1", "--format=%(trailers:key=Import-note,valueonly)"), /packages\/engine\/package\.json changes its dependencies: run npm install/);
  } finally {
    cleanup(gs, ms);
  }
});

test("it refuses main, a dirty tree, merge commits and a range with nothing in it", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  try {
    contribute(ms, "A change", { [MERGE_MODEL]: append("// x\n") });
    g(gs, "switch", "-q", "main");
    assert.throws(() => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }), (e) => e instanceof ImportRefused && /refused on main/.test(e.message));
    g(gs, "switch", "-q", "import/pr-12");
    writeFileSync(join(gs, "LICENSE"), "edited\n");
    assert.throws(() => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }), (e) => e instanceof ImportRefused && /uncommitted changes/.test(e.message));
    g(gs, "checkout", "--", "LICENSE");
    assert.throws(() => importPullRequest({ gitstudio: gs, from: ms, range: "contrib..contrib" }), (e) => e instanceof ImportRefused && /has no commits/.test(e.message));
    g(ms, "switch", "-qc", "other", "main");
    contribute(ms, "Elsewhere", { "src/links.ts": append("// y\n") });
    g(ms, "switch", "-q", "contrib");
    g(ms, "merge", "-q", "--no-edit", "other");
    assert.throws(() => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }), (e) => e instanceof ImportRefused && /merge commits/.test(e.message));
    assert.equal(g(gs, "log", "--format=%s", "-1"), "gitstudio");
  } finally {
    cleanup(gs, ms);
  }
});

test("the CLI: usage without a change, and --dry-run shows the mapping and changes nothing", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  try {
    contribute(ms, "A change", { [MERGE_MODEL]: append("// x\n"), "package-lock.json": append(" ") });
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    const usage = cli();
    assert.equal(usage.status, 2);
    assert.match(usage.stdout, /gh pr diff <n> --repo GitStudioHQ\/merge-studio > pr\.patch/);
    const dry = cli("--gitstudio", gs, "--from", ms, "--range", "main..contrib", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /vendor\/gitstudio\/engine\/src\/mergeModel\.ts {2}→ {2}packages\/engine\/src\/mergeModel\.ts/);
    assert.match(dry.stdout, /package-lock\.json {2}generated by the export: not imported/);
    assert.match(dry.stdout, /dry run: nothing was changed/);
    assert.equal(g(gs, "log", "--format=%s", "-1"), "gitstudio");
    const real = cli("--gitstudio", gs, "--from", ms, "--range", "main..contrib", "--pr", "5");
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /imported 1 commit\(s\)/);
    assert.match(real.stdout, /vendor\/gitstudio\/engine\/src\/mergeModel\.ts: identical/);
    assert.match(real.stdout, /not imported, because the export generates them:\n {2}package-lock\.json/);
  } finally {
    cleanup(gs, ms);
  }
});

// ---------------------------------------------------------------- what a pull request can hold

test("renames, deletions and a binary file come back from a range and from `gh pr diff --patch`, and the next export over main writes the contributor's tree", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  const files = mkdtempSync(join(tmpdir(), "ms-import-files-"));
  try {
    const vendored = g(ms, "ls-files", "vendor/gitstudio/engine/src").split("\n").filter((p) => p.endsWith(".ts") && p !== MERGE_MODEL);
    const [moved, gone] = vendored;
    const head = [
      // A pure rename is a header-only section: in a mail, the signature follows it.
      contribute(ms, "Rename a vendored file", { [moved]: { renameTo: moved.replace(/\.ts$/, "Renamed.ts") } }),
      contribute(ms, "[shell] Rename and edit links.ts", { "src/links.ts": { renameTo: "src/linksRenamed.ts", edit: append("// edited\n") } }),
      contribute(ms, "Delete files", { [gone]: null, "media/banner.svg": null, "SHOTS.md": null }),
      contribute(ms, "Sharper icon", {
        "media/icon.png": { bytes: (b) => Buffer.concat([b.subarray(0, 64), Buffer.from([0, 255, 0, 255, 7]), b.subarray(64)]) },
        "media/walkthrough/new-shot.png": { bytes: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 9, 1, 2, 3]) },
      }),
    ].at(-1);
    const expected = [
      `R100\tpackages/engine/src/${moved.slice("vendor/gitstudio/engine/src/".length)}\tpackages/engine/src/${moved.slice("vendor/gitstudio/engine/src/".length).replace(/\.ts$/, "Renamed.ts")}`,
      `D\tpackages/engine/src/${gone.slice("vendor/gitstudio/engine/src/".length)}`,
      "D\tapps/merge-studio/SHOTS.md",
      "D\tapps/merge-studio/media/banner.svg",
      "M\tapps/merge-studio/media/icon.png",
      "A\tapps/merge-studio/media/walkthrough/new-shot.png",
    ];
    for (const how of ["range", "patch"]) {
      g(gs, "reset", "-q", "--hard", "main");
      const r =
        how === "range"
          ? importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib", pr: "21" })
          : importPullRequest({ gitstudio: gs, patch: mbox(ms, "main..contrib", files), pr: "21" });
      assert.equal(r.commits.filter((c) => c.sha).length, 4, how);
      assert.deepEqual(r.roundTrip.filter((x) => x.status !== "identical"), [], `${how}: every file round-trips`);
      const diff = g(gs, "diff", "--name-status", "-M", "main", "HEAD").split("\n");
      for (const line of expected) assert.ok(diff.includes(line), `${how}: ${line}\n${diff.join("\n")}`);
      assert.ok(diff.some((l) => /^R\d+\tapps\/merge-studio\/src\/links\.ts\tapps\/merge-studio\/src\/linksRenamed\.ts$/.test(l)), how);
      assert.equal(g(gs, "log", "-1", "--format=%s", "HEAD~2"), "[shell] Rename and edit links.ts", `${how}: the contributor's own [bracket] stays`);
      assert.ok(
        readFileSync(join(gs, "apps/merge-studio/media/icon.png")).equals(execFileSync("git", ["-C", ms, "show", `${head}:media/icon.png`])),
        `${how}: the png's bytes`,
      );
      // The deleted and moved shell files must not stay behind in merge-studio.
      assert.equal(exportOverMain(ms, gs, head), "", `${how}: the next export writes the contributor's tree`);
    }
  } finally {
    cleanup(gs, ms, files);
  }
});

test("CRLF lines survive a range, `gh pr diff --patch` and a plain diff", () => {
  const gs = scratchGitstudio();
  writeFileSync(join(gs, "packages/engine/src/crlf.ts"), "export const a = 1;\r\nexport const b = 2;\r\nexport const c = 3;\r\n");
  g(gs, "add", "-A");
  g(gs, "commit", "-qm", "a CRLF file");
  g(gs, "branch", "-qf", "main");
  const ms = scratchMergeStudio(gs);
  const files = mkdtempSync(join(tmpdir(), "ms-import-files-"));
  try {
    const head = contribute(ms, "Edit a CRLF file, and turn an LF one into CRLF", {
      "vendor/gitstudio/engine/src/crlf.ts": (t) => t.replace("export const b = 2;\r\n", "export const b = 22;\r\n"),
      "src/links.ts": (t) => `${t.replace(/\n/g, "\r\n")}// trailing\r\n`,
    });
    const plain = join(files, "pr.diff");
    writeFileSync(plain, execFileSync("git", ["-C", ms, "diff", "main", "contrib"]));
    for (const how of ["range", "patch", "plain"]) {
      g(gs, "reset", "-q", "--hard", "main");
      const r = {
        range: () => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }),
        patch: () => importPullRequest({ gitstudio: gs, patch: mbox(ms, "main..contrib", files) }),
        plain: () => importPullRequest({ gitstudio: gs, patch: plain, author: JANE }),
      }[how]();
      assert.deepEqual(r.roundTrip.filter((x) => x.status !== "identical"), [], how);
      for (const [gsPath, msPath] of [
        ["packages/engine/src/crlf.ts", "vendor/gitstudio/engine/src/crlf.ts"],
        ["apps/merge-studio/src/links.ts", "src/links.ts"],
      ]) {
        const committed = execFileSync("git", ["-C", gs, "show", `HEAD:${gsPath}`]);
        assert.ok(committed.equals(execFileSync("git", ["-C", ms, "show", `${head}:${msPath}`])), `${how}: ${gsPath} is the contributor's bytes`);
      }
    }
  } finally {
    cleanup(gs, ms, files);
  }
});

test("a pull request on an older export: a file gitstudio has since deleted or moved is refused, saying where it went", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  const files = mkdtempSync(join(tmpdir(), "ms-import-files-"));
  try {
    const engine = g(gs, "ls-files", "packages/engine/src").split("\n").filter((p) => p.endsWith(".ts") && !p.endsWith("mergeModel.ts"));
    const [deleted, moved, bothDeleted, movedHere, deletedRenamed, editedRenamed, movedDeleted] = engine;
    const msOf = (p) => p.replace(/^packages\//, "vendor/gitstudio/");
    // gitstudio moves on after the export the contributor works from.
    unlinkSync(join(gs, deleted));
    unlinkSync(join(gs, bothDeleted));
    unlinkSync(join(gs, deletedRenamed));
    writeFileSync(join(gs, editedRenamed), `// gitstudio's later edit\n${readFileSync(join(gs, editedRenamed), "utf8")}`);
    renameSync(join(gs, moved), join(gs, moved.replace(/\.ts$/, "Moved.ts")));
    renameSync(join(gs, movedHere), join(gs, movedHere.replace(/\.ts$/, "InGitstudio.ts")));
    renameSync(join(gs, movedDeleted), join(gs, movedDeleted.replace(/\.ts$/, "InGitstudio.ts")));
    unlinkSync(join(gs, "apps/merge-studio/SHOTS.md"));
    unlinkSync(join(gs, "apps/merge-studio/media/banner.svg"));
    g(gs, "add", "-A");
    g(gs, "commit", "-qm", "gitstudio tidies up");
    const tidy = g(gs, "rev-parse", "--short=7", "HEAD");
    contribute(ms, "A file that is new here, then changed", { "vendor/gitstudio/engine/src/brandNew.ts": () => "export {};\n" });
    contribute(ms, "Edits on the older export", {
      "vendor/gitstudio/engine/src/brandNew.ts": append("// changed\n"),
      [msOf(deleted)]: append("// edited\n"),
      [msOf(moved)]: append("// edited\n"),
      "SHOTS.md": append("Edited.\n"),
      [msOf(bothDeleted)]: null,
      "media/banner.svg": null,
      // Moved in gitstudio, deleted by the contributor: a real disagreement, not "already deleted".
      [msOf(movedDeleted)]: null,
      // Moved in gitstudio, renamed by the contributor: never two copies.
      [msOf(movedHere)]: { renameTo: msOf(movedHere).replace(/\.ts$/, "ByContributor.ts") },
      // Deleted in gitstudio, renamed by the contributor: it does not come back under the new name.
      [msOf(deletedRenamed)]: { renameTo: msOf(deletedRenamed).replace(/\.ts$/, "ByContributor.ts") },
      // Edited in gitstudio, renamed by the contributor: the edit moves with it.
      [msOf(editedRenamed)]: { renameTo: msOf(editedRenamed).replace(/\.ts$/, "ByContributor.ts") },
    });
    const head = g(gs, "rev-parse", "HEAD");
    for (const how of ["range", "patch"]) {
      let refused;
      assert.throws(
        () =>
          how === "range"
            ? importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" })
            : importPullRequest({ gitstudio: gs, patch: mbox(ms, "main..contrib", files) }),
        (e) => {
          refused = e;
          return e instanceof ImportRefused;
        },
      );
      const line = (p) => refused.message.split("\n").find((l) => l.startsWith(`  ${p} (`)) ?? "";
      assert.match(line(msOf(deleted)), new RegExp(`gitstudio deleted ${deleted} in ${tidy} "gitstudio tidies up"`), how);
      assert.match(line(msOf(moved)), new RegExp(`gitstudio moved ${moved} to ${moved.replace(/\.ts$/, "Moved.ts")} in ${tidy}`), how);
      assert.match(line("SHOTS.md"), /gitstudio deleted apps\/merge-studio\/SHOTS\.md in /, `${how}: not "merge-studio's own"`);
      assert.match(line("SHOTS.md"), /rebase onto merge-studio's latest export/);
      assert.equal(line("vendor/gitstudio/engine/src/brandNew.ts"), "", `${how}: made by an earlier commit of the same pull request`);
      assert.equal(line(msOf(bothDeleted)), "", `${how}: deleted on both sides is no conflict`);
      assert.equal(line("media/banner.svg"), "", `${how}: a root shell file deleted on both sides too`);
      assert.match(line(msOf(movedHere)), new RegExp(`gitstudio moved ${movedHere} to ${movedHere.replace(/\.ts$/, "InGitstudio.ts")}`), how);
      assert.match(line(msOf(deletedRenamed)), new RegExp(`gitstudio deleted ${deletedRenamed} in ${tidy}`), how);
      assert.match(line(msOf(movedDeleted)), new RegExp(`gitstudio moved ${movedDeleted} to `), how);
      assert.equal(line(msOf(editedRenamed)), "", `${how}: a rename of a file gitstudio edited is no conflict`);
      assert.equal(g(gs, "rev-parse", "HEAD"), head);
      assert.equal(g(gs, "status", "--porcelain"), "");
    }
    // Left out on purpose, the rest comes in, and a file deleted on both sides stays deleted.
    const r = importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib", excludes: [msOf(deleted), msOf(moved), "SHOTS.md", msOf(movedDeleted), ...[movedHere, deletedRenamed].flatMap((f) => [msOf(f), msOf(f).replace(/\.ts$/, "ByContributor.ts")])] });
    const renamedTo = editedRenamed.replace(/\.ts$/, "ByContributor.ts");
    assert.match(readFileSync(join(gs, renamedTo), "utf8"), /^\/\/ gitstudio's later edit\n/, "gitstudio's edit moved with the rename");
    assert.ok(!existsSync(join(gs, editedRenamed)) && !existsSync(join(gs, deletedRenamed.replace(/\.ts$/, "ByContributor.ts"))));
    assert.equal(r.commits.filter((c) => c.sha).length, 2);
    assert.match(r.commits[1].notes.join("\n"), new RegExp(`gitstudio has already deleted ${bothDeleted}`));
    assert.deepEqual(r.roundTrip.map((x) => [x.path, x.status]).sort(), [
      ["media/banner.svg", "identical"],
      [msOf(bothDeleted), "identical"],
      ["vendor/gitstudio/engine/src/brandNew.ts", "identical"],
      [msOf(editedRenamed), "identical"],
      [msOf(renamedTo), "identical"],
    ].sort());
  } finally {
    cleanup(gs, ms, files);
  }
});

test("a commit gitstudio already has is skipped; merge-studio's own export, carried by a pull request, is refused", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  const files = mkdtempSync(join(tmpdir(), "ms-import-files-"));
  try {
    const base = g(ms, "rev-parse", "main");
    // The maintainer made the same fix in gitstudio first.
    const gsFile = join(gs, "packages/engine/src/mergeModel.ts");
    const original = readFileSync(gsFile, "utf8");
    writeFileSync(gsFile, `${original}// the same fix\n`);
    g(gs, "commit", "-qam", "the maintainer's fix");
    const same = contribute(ms, "The same fix", { [MERGE_MODEL]: append("// the same fix\n") });
    contribute(ms, "Another", { "src/links.ts": append("// another\n") });
    const r = importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" });
    assert.deepEqual(
      r.commits.map((c) => [c.upstream, Boolean(c.sha), Boolean(c.skipped)]),
      [
        [same, false, true],
        [g(ms, "rev-parse", "contrib"), true, false],
      ],
    );
    assert.match(r.commits[0].notes.join("\n"), /already has every change/);
    assert.deepEqual(r.roundTrip.filter((x) => x.status !== "identical"), []);

    // Later, gitstudio exports a change, reverts it, and the contributor merges main (with that export) into the pull request.
    g(gs, "reset", "-q", "--hard", "main");
    writeFileSync(gsFile, lineEdit(1, (l) => `${l} // later reverted`)(original));
    g(gs, "commit", "-qam", "a change");
    g(ms, "switch", "-q", "main");
    exportTo({ into: ms, gitstudio: gs });
    g(ms, "add", "-A");
    g(ms, "commit", "-qm", "Export again");
    const exported = g(ms, "rev-parse", "HEAD");
    g(ms, "switch", "-q", "contrib");
    g(ms, "merge", "-q", "--no-edit", "main");
    writeFileSync(gsFile, original);
    g(gs, "commit", "-qam", "revert the change");
    const head = g(gs, "rev-parse", "HEAD");
    const patch = mbox(ms, `${base}..contrib`, files);
    for (const excludes of [[], ["VENDORED_FROM.json"]]) {
      assert.throws(
        () => importPullRequest({ gitstudio: gs, patch, excludes }),
        (e) =>
          e instanceof ImportRefused &&
          e.message.includes(`  VENDORED_FROM.json (${exported.slice(0, 7)}): this commit is merge-studio's export of gitstudio`) &&
          /gh pr diff <n> without --patch/.test(e.message),
      );
    }
    assert.equal(g(gs, "rev-parse", "HEAD"), head);
    assert.doesNotMatch(readFileSync(gsFile, "utf8"), /later reverted/, "the reverted change is not replayed");
  } finally {
    cleanup(gs, ms, files);
  }
});

test("a binary conflict says there are no markers, and the printed commands finish it for any author name", () => {
  const gs = scratchGitstudio();
  const ms = scratchMergeStudio(gs);
  const probe = mkdtempSync(join(tmpdir(), "ms-import-probe-"));
  try {
    const icon = join(gs, "apps/merge-studio/media/icon.png");
    writeFileSync(icon, Buffer.concat([readFileSync(icon), Buffer.from([1, 2, 3])]));
    g(gs, "commit", "-qam", "gitstudio's icon");
    // Everything in a name reaches a shell when the maintainer pastes the command.
    const author = `Jane "JJ" O'Brien $(touch ${join(probe, "pwned")}) <jane@example.com>`;
    const theirs = contribute(ms, "Contributor's icon", { "media/icon.png": { bytes: (b) => Buffer.concat([b, Buffer.from([9, 9])]) } }, undefined, author);
    let stopped;
    assert.throws(
      () => importPullRequest({ gitstudio: gs, from: ms, range: "main..contrib" }),
      (e) => {
        stopped = e;
        return e instanceof ImportStopped;
      },
    );
    assert.match(stopped.message, /\n {2}apps\/merge-studio\/media\/icon\.png \(binary\)\n/);
    assert.doesNotMatch(stopped.message, /conflict markers are in/);
    const commands = stopped.message.split("\n").filter((l) => /^ {2}git (add|commit) /.test(l) || /^Keep it, or take/.test(l));
    const checkout = /git checkout --theirs -- .*$/m.exec(stopped.message)[0];
    for (const cmd of [checkout, ...commands.filter((l) => l.startsWith("  git ")).map((l) => l.trim())]) {
      execFileSync("sh", ["-c", cmd], { cwd: gs, stdio: "pipe" });
    }
    assert.equal(existsSync(join(probe, "pwned")), false, "nothing in the author's name ran");
    assert.equal(g(gs, "log", "-1", "--format=%an <%ae>"), `Jane "JJ" O'Brien $(touch ${join(probe, "pwned")}) <jane@example.com>`);
    assert.ok(readFileSync(icon).equals(execFileSync("git", ["-C", ms, "show", `${theirs}:media/icon.png`])), "the contributor's bytes");
    assert.equal(g(gs, "status", "--porcelain"), "");
  } finally {
    cleanup(gs, ms, probe);
  }
});

// ---------------------------------------------------------------- the table

test("every file a real export writes maps back to the gitstudio file it came from, or is generated", () => {
  const into = mkdtempSync(join(tmpdir(), "ms-import-table-"));
  try {
    exportTo({ into, allowDirty: true, lock: false });
    const shell = new Set(shellFiles(GITSTUDIO_ROOT));
    const pairs = new Map(copiedFiles(GITSTUDIO_ROOT).map(([from, to]) => [to, from]));
    const written = execFileSync("find", [into, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => f.slice(into.length + 1));
    assert.ok(written.length > 150);
    for (const rel of written) {
      const m = toGitstudio(rel, { shell });
      if (m.kind === "generated") continue;
      assert.equal(m.kind, "copied", `${rel}: ${m.why}`);
      assert.equal(m.gitstudio, pairs.get(rel), rel);
      assert.ok(readFileSync(join(into, rel)).equals(readFileSync(join(GITSTUDIO_ROOT, m.gitstudio))), `${rel} is ${m.gitstudio}'s bytes`);
    }
    for (const [to, from] of pairs) assert.equal(toGitstudio(to, { shell }).gitstudio, from, `${to} ← ${from}`);
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
});

test("the table: new files map by the folder they land in; merge-studio's own files never map", () => {
  const shell = new Set(["src/extension.ts", "test/parity.test.ts", "media/walkthrough/diff.svg", "media/icon.png", "README.md"]);
  const map = (p, isNew = false) => toGitstudio(p, { shell, isNew });
  assert.deepEqual(map("vendor/gitstudio/webview-ui/src/new/thing.ts", true), { kind: "copied", gitstudio: "packages/webview-ui/src/new/thing.ts", shell: false });
  assert.equal(map("vendor/gitstudio/merge-vscode/package.json").gitstudio, "packages/merge-vscode/package.json");
  assert.equal(map("vendor/gitstudio/LICENSE").gitstudio, "LICENSE");
  assert.equal(map("vendor/gitstudio/extension/src/merge/mergeIds.ts").gitstudio, "apps/extension/src/merge/mergeIds.ts");
  assert.equal(map("scripts/check-parity.mjs").gitstudio, "scripts/merge-studio/check-parity.mjs");
  assert.equal(map("src/deep/new.ts", true).gitstudio, "apps/merge-studio/src/deep/new.ts", "src/ is the shell's as a whole");
  assert.equal(map("media/walkthrough/new.svg", true).gitstudio, "apps/merge-studio/media/walkthrough/new.svg");
  assert.equal(map("README.md").gitstudio, "apps/merge-studio/README.md");
  for (const p of ["package.json", "package-lock.json", "tsconfig.json", "VENDORED_FROM.json", "vendor/gitstudio/.gitattributes"]) {
    assert.equal(map(p).kind, "generated", p);
  }
  for (const [p, isNew] of [
    ["SECURITY.md", false],
    [".github/workflows/ci.yml", false],
    ["media/screenshots/new.png", true],
    ["NEWS.md", true],
    ["vendor/gitstudio/engine/package-lock.json", true],
    ["vendor/gitstudio/ai/src/x.ts", true],
    ["scripts/other.mjs", true],
    ["dist/extension.js", false],
    ["../outside", false],
  ]) {
    assert.equal(map(p, isNew).kind, "unmapped", p);
  }
});

// ---------------------------------------------------------------- the pieces

test("parsePatch reads paths, ids, renames, binary data and quoting, and renderFile writes them back", () => {
  const text = [
    "diff --git a/vendor/gitstudio/engine/src/a.ts b/vendor/gitstudio/engine/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/vendor/gitstudio/engine/src/a.ts",
    "+++ b/vendor/gitstudio/engine/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "diff --git a/src/old name.ts b/src/new name.ts",
    "similarity index 90%",
    "rename from src/old name.ts",
    "rename to src/new name.ts",
    "index 3333333..4444444 100644",
    "--- a/src/old name.ts\t",
    "+++ b/src/new name.ts\t",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    'diff --git "a/media/caf\\303\\251.png" "b/media/caf\\303\\251.png"',
    "new file mode 100644",
    "index 0000000..5555555",
    "GIT binary patch",
    "literal 3",
    "KcmZQzWME_f00D6T",
    "",
    "literal 0",
    "HcmV?d00001",
    "",
    "-- ",
    "2.49.0",
    "",
  ].join("\n");
  const files = parsePatch(text);
  assert.equal(files.length, 3);
  assert.deepEqual([files[0].oldPath, files[0].newPath, files[0].oldId, files[0].newId], ["vendor/gitstudio/engine/src/a.ts", "vendor/gitstudio/engine/src/a.ts", "1111111", "2222222"]);
  assert.deepEqual([files[1].oldPath, files[1].newPath, files[1].renamed], ["src/old name.ts", "src/new name.ts", true]);
  assert.deepEqual([files[2].oldPath, files[2].newPath, files[2].isNew, files[2].binary], [undefined, "media/café.png", true, "data"]);
  assert.equal(files[2].body.at(-1), "", "the signature after the binary block is dropped");
  // Written back unchanged, then with paths replaced.
  assert.equal(files.map((f) => renderFile(f)).join("\n"), text.slice(0, text.indexOf("-- \n")).replace(/\n$/, ""));
  const moved = renderFile(files[0], "packages/engine/src/a.ts", "packages/engine/src/a.ts");
  assert.match(moved, /^diff --git a\/packages\/engine\/src\/a\.ts b\/packages\/engine\/src\/a\.ts\nindex 1111111\.\.2222222 100644\n--- a\/packages\/engine\/src\/a\.ts\n\+\+\+ b\/packages\/engine\/src\/a\.ts\n@@/);
  assert.match(renderFile(files[1], "apps/merge-studio/src/old name.ts", "apps/merge-studio/src/new name.ts"), /\nrename from apps\/merge-studio\/src\/old name\.ts\nrename to apps\/merge-studio\/src\/new name\.ts\n/);
  assert.match(renderFile(files[2], undefined, "apps/merge-studio/media/café.png"), /^diff --git "a\/apps\/merge-studio\/media\/caf\\303\\251\.png" "b\/apps/);
});

test("parsePatch: a mail's signature after a section with no hunks ends it", () => {
  const mail = (section) => ["Subject: [PATCH] x", "", "---", " 1 file changed", "", ...section, "-- ", "2.49.0", "", ""].join("\n");
  const rename = parsePatch(mail(["diff --git a/src/a.ts b/src/b.ts", "similarity index 100%", "rename from src/a.ts", "rename to src/b.ts"]));
  assert.deepEqual(rename.map((f) => [f.oldPath, f.newPath, f.renamed, f.body.length]), [["src/a.ts", "src/b.ts", true, 0]]);
  const mode = parsePatch(mail(["diff --git a/esbuild.js b/esbuild.js", "old mode 100644", "new mode 100755"]));
  assert.deepEqual(mode.map((f) => [f.oldPath, f.newPath, f.header]), [["esbuild.js", "esbuild.js", ["old mode 100644", "new mode 100755"]]]);
  const empty = parsePatch(mail(["diff --git a/src/empty.ts b/src/empty.ts", "new file mode 100644", "index 0000000..e69de29"]));
  assert.deepEqual(empty.map((f) => [f.oldPath, f.newPath, f.isNew]), [[undefined, "src/empty.ts", true]]);
});

test("applyHunks applies at an offset and refuses context that is not there", () => {
  const body = ["@@ -2,3 +2,3 @@", " b", "-c", "+C", " d"];
  assert.equal(applyHunks("a\nb\nc\nd\ne\n", body), "a\nb\nC\nd\ne\n");
  assert.equal(applyHunks("0\n0\na\nb\nc\nd\ne\n", body), "0\n0\na\nb\nC\nd\ne\n", "two lines further down");
  assert.equal(applyHunks("a\nb\nX\nd\ne\n", body), undefined);
});

test("packageJsonChange imports shell keys three-way and leaves the generated ones out", () => {
  const base = { name: "m", version: "0.4.0", sponsor: { url: "s" }, contributes: { commands: [1] }, scripts: { compile: "a", test: "t" }, devDependencies: { esbuild: "1" } };
  const head = { ...structuredClone(base), version: "0.4.1", funding: "f", scripts: { compile: "b", test: "t2" }, devDependencies: { esbuild: "2" } };
  // "funding" is new: it goes after "sponsor", where the contributor put it.
  const headOrdered = { name: "m", version: "0.4.1", sponsor: { url: "s" }, funding: "f", contributes: { commands: [1] }, scripts: head.scripts, devDependencies: head.devDependencies };
  const shell = { name: "m", version: "0.4.0", sponsor: { url: "s" }, contributes: { commands: [1] }, scripts: { compile: "a", test: "monorepo" }, dependencies: { "@gitstudio/engine": "*" }, devDependencies: { esbuild: "^1" } };
  const r = packageJsonChange({ baseText: JSON.stringify(base), headText: JSON.stringify(headOrdered), shellText: JSON.stringify(shell) });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.apply.map((c) => c.path.join(".")).sort(), ["funding", "scripts.compile", "version"]);
  assert.deepEqual(r.skipped.map((c) => c.path.join(".")).sort(), ["devDependencies.esbuild", "scripts.test"]);
  assert.deepEqual(Object.keys(r.shell), ["name", "version", "sponsor", "funding", "contributes", "scripts", "dependencies", "devDependencies"]);
  assert.equal(r.shell.scripts.test, "monorepo", "a generated script is not imported");
  assert.equal(r.shell.devDependencies.esbuild, "^1");

  const moved = packageJsonChange({ baseText: JSON.stringify(base), headText: JSON.stringify(headOrdered), shellText: JSON.stringify({ ...shell, version: "0.5.0" }) });
  assert.deepEqual(moved.conflicts.map((c) => c.path.join(".")), ["version"], "gitstudio moved the same key the other way");
  assert.equal(moved.text, undefined);
  const already = packageJsonChange({ baseText: JSON.stringify(base), headText: JSON.stringify(headOrdered), shellText: JSON.stringify({ ...shell, version: "0.4.1" }) });
  assert.deepEqual(already.conflicts, [], "the same change on both sides is no conflict");
});

test("diffJson, setLockVersion and blobId", () => {
  assert.deepEqual(diffJson({ a: { b: 1, c: [1] } }, { a: { b: 2, c: [1] }, d: 1 }), [
    { path: ["a", "b"], before: 1, after: 2 },
    { path: ["d"], before: undefined, after: 1 },
  ]);
  const lock = '{\n  "packages": {\n    "apps/merge-studio": {\n      "name": "merge-studio",\n      "version": "0.4.0",\n      "license": "MIT"\n    },\n    "apps/x": {\n      "version": "0.4.0"\n    }\n  }\n}\n';
  assert.equal(setLockVersion(lock, "apps/merge-studio", "0.4.1"), lock.replace('"version": "0.4.0",', '"version": "0.4.1",'));
  assert.equal(setLockVersion(lock, "apps/nope", "1.0.0"), undefined);
  const bytes = Buffer.from("one\ntwo\n");
  assert.equal(blobId(bytes), execFileSync("git", ["hash-object", "--stdin", "--no-filters"], { input: bytes, encoding: "utf8" }).trim());
  assert.equal(blobId(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});
