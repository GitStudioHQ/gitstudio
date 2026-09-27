import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// No test in this repository reaches the network or a credential helper.
//
// ghRepoOpen.test.ts cloned https://github.com/acme/elsewhere for real, and git
// asked the macOS keychain's credential helper, which waits on a dialog on the
// screen of whoever runs the suite. scripts/test/no-network-git.mjs makes that
// impossible for any git a test process runs; this is the census that every
// test file in the repository runs in such a process, and the proof that the
// guard holds.

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
// Spelled out, not imported: importing the guard would apply it to this very
// process, and the tests below must prove the RUNNER applied it.
const NO_NETWORK_MARK = "GS_TEST_GIT_NO_NETWORK";
const GUARDS = ["hermetic-git.mjs", "no-network-git.mjs"].map((f) => join(REPO, "scripts", "test", f));

const toPosix = (p: string): string => p.split(sep).join("/");

/** Split a script command the way a shell would, quotes and all (enough for package.json). */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A test-runner glob as a regex over absolute posix paths. */
function globRegex(absPattern: string): RegExp {
  let re = "";
  for (let i = 0; i < absPattern.length; i++) {
    const c = absPattern[i];
    if (c === "*" && absPattern[i + 1] === "*" && absPattern[i + 2] === "/") {
      re += "(?:.*/)?";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

interface Workspace {
  dir: string;
  test?: string;
}

function workspaces(): Workspace[] {
  const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const out: Workspace[] = [];
  for (const pattern of root.workspaces as string[]) {
    const parent = join(REPO, pattern.replace(/\/\*$/, ""));
    for (const name of readdirSync(parent)) {
      const pkg = join(parent, name, "package.json");
      if (!existsSync(pkg)) continue;
      out.push({ dir: join(parent, name), test: JSON.parse(readFileSync(pkg, "utf8")).scripts?.test });
    }
  }
  return out;
}

/** Every test file in the repository, wherever it lives. */
function testFiles(dir = REPO): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist" || entry.name === "out") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Run {
  workspace: string;
  command: string;
  guarded: boolean;
  globs: RegExp[];
}

/** Each test-runner command of each workspace's `test` script, and whether it loads a guard. */
function runs(): { runs: Run[]; unknown: string[] } {
  const all: Run[] = [];
  const unknown: string[] = [];
  for (const ws of workspaces()) {
    if (!ws.test) continue;
    for (const command of ws.test.split("&&").map((c) => c.trim())) {
      const w = words(command);
      if (!(w[0] === "tsx" || w[0] === "node") || !w.includes("--test")) {
        // A runner this census cannot read is a runner it cannot vouch for.
        unknown.push(`${toPosix(relative(REPO, ws.dir))}: ${command}`);
        continue;
      }
      const imports = w.flatMap((x, i) => (x === "--import" ? [w[i + 1]] : x.startsWith("--import=") ? [x.slice(9)] : []));
      const guarded = imports.some((spec) => GUARDS.includes(resolve(ws.dir, spec)));
      const globs = w
        .slice(w.indexOf("--test") + 1)
        .filter((x) => !x.startsWith("-"))
        .map((g) => globRegex(toPosix(resolve(ws.dir, g))));
      all.push({ workspace: toPosix(relative(REPO, ws.dir)), command, guarded, globs });
    }
  }
  return { runs: all, unknown };
}

/** Does the file load a guard itself (a test run by hand, outside `npm test`)? */
function loadsGuardItself(file: string, text = readFileSync(file, "utf8")): boolean {
  return [...text.matchAll(/^import\s+["']([^"']+)["']/gm)].some((m) => GUARDS.includes(resolve(dirname(file), m[1])));
}

test("every workspace's test runner loads the guard before its tests", () => {
  const { runs: all, unknown } = runs();
  assert.ok(all.length >= 10, `found the workspaces' test runs (${all.length})`);
  assert.deepEqual(unknown, [], "a test command this census cannot read");
  const unguarded = all.filter((r) => !r.guarded).map((r) => `${r.workspace}: ${r.command}`);
  assert.deepEqual(unguarded, [], "a test run with no --import of scripts/test/hermetic-git.mjs (or no-network-git.mjs)");
});

test("every test file in the repository runs guarded — by its workspace's runner, or by importing the guard itself", () => {
  const files = testFiles();
  assert.ok(files.length > 300, `scanned the repository's tests (${files.length})`);
  const { runs: all } = runs();
  const offenders = files.filter((file) => {
    const p = toPosix(file);
    const covering = all.filter((r) => r.globs.some((g) => g.test(p)));
    if (covering.length > 0) return covering.some((r) => !r.guarded);
    return !loadsGuardItself(file);
  });
  assert.deepEqual(
    offenders.map((f) => toPosix(relative(REPO, f))),
    [],
    "test files that could run git with the machine's credential helper and network",
  );
});

test("the census reads a runner and a file the way it should (it would catch one)", () => {
  // A census that matches nothing passes on a broken tree: prove it can fail.
  assert.equal(globRegex("/r/apps/x/test/**/*.test.ts").test("/r/apps/x/test/a.test.ts"), true);
  assert.equal(globRegex("/r/apps/x/test/**/*.test.ts").test("/r/apps/x/test/deep/b.test.ts"), true);
  assert.equal(globRegex("/r/apps/x/test/**/*.test.ts").test("/r/apps/y/test/a.test.ts"), false);
  assert.equal(globRegex("/r/scripts/m/test/*.test.mjs").test("/r/scripts/m/test/sub/a.test.mjs"), false);
  assert.deepEqual(words(`tsx --import ../../scripts/test/hermetic-git.mjs --test "test/**/*.test.ts"`), [
    "tsx",
    "--import",
    "../../scripts/test/hermetic-git.mjs",
    "--test",
    "test/**/*.test.ts",
  ]);
  const byHand = join(REPO, "scripts", "merge-e2e", "x.test.ts");
  assert.equal(loadsGuardItself(byHand, `import { test } from "node:test";\n`), false);
  assert.equal(loadsGuardItself(byHand, `import "../test/no-network-git.mjs";\nimport { test } from "node:test";\n`), true);
  assert.equal(loadsGuardItself(byHand, `import "./test/no-network-git.mjs";\n`), false, "a path that is not the guard");
});

// ── The guard itself, in this very process ──────────────────────────────────

function git(args: string[], cwd?: string): { status: number | null; out: string; ms: number } {
  const t = Date.now();
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, ms: Date.now() - t };
}

test("this process is guarded: no credential helper, no prompt, the global and system config empty", () => {
  assert.equal(process.env[NO_NETWORK_MARK], "1", "scripts/test/no-network-git.mjs ran before this file");
  assert.equal(process.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(readFileSync(process.env.GIT_CONFIG_GLOBAL!, "utf8"), "", "the global config is an empty file");
  const helpers = git(["config", "--show-scope", "--get-all", "credential.helper"]);
  assert.equal(helpers.status, 0);
  // One value, empty, at the command scope: it empties the list before it.
  assert.deepEqual(helpers.out.split("\n").filter(Boolean), ["command\t"]);
});

test("a remote on the network fails at once, and never leaves the machine", () => {
  // `.invalid` never resolves, so even a broken guard would not reach a host —
  // what proves the guard is WHERE each attempt failed.
  const https = git(["ls-remote", "https://example.invalid/acme/app.git"]);
  assert.notEqual(https.status, 0);
  assert.match(https.out, /127\.0\.0\.1 port 1\b/, `https went to the proxy nothing listens on: ${https.out}`);
  for (const url of ["git@example.invalid:acme/app.git", "ssh://git@example.invalid/acme/app.git"]) {
    const ssh = git(["ls-remote", url]);
    assert.notEqual(ssh.status, 0);
    assert.match(ssh.out, /no-network-in-tests[^\s'"]*[\\/]ssh/, `ssh is a program that is never there: ${ssh.out}`);
  }
  const plain = git(["ls-remote", "git://example.invalid/acme/app.git"]);
  assert.notEqual(plain.status, 0);
  assert.match(plain.out, /no-network-in-tests[^\s'"]*[\\/]git-proxy/, `git:// too: ${plain.out}`);
  for (const r of [https, plain]) assert.ok(r.ms < 10_000, `failed at once (${r.ms} ms)`);
});

test("a repository that serves its own ssh (core.sshCommand) is still served — on purpose, never by accident", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-own-ssh-"));
  try {
    const marker = join(dir, "called");
    const fake = join(dir, "fake-ssh.cjs");
    writeFileSync(fake, `require("fs").writeFileSync(${JSON.stringify(marker)}, "yes"); process.exit(1);\n`);
    assert.equal(git(["init", "-q", dir]).status, 0);
    // Forward slashes: git runs core.sshCommand through `sh -c`.
    assert.equal(git(["config", "core.sshCommand", `node "${posix.normalize(toPosix(fake))}"`], dir).status, 0);
    git(["ls-remote", "git@example.invalid:acme/app.git"], dir);
    assert.equal(existsSync(marker), true, "the repository's own ssh command ran, not the guard's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
