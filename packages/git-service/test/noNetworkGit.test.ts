import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, createServer as createNetServer, type AddressInfo } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// No test in this repository reaches the network or a credential helper.
//
// ghRepoOpen.test.ts cloned https://github.com/acme/elsewhere for real, and git
// asked the macOS keychain's credential helper, which waits on a dialog on the
// screen of whoever runs the suite; prFeature.test.ts's checks batch sent a
// real POST to api.github.com after its test had put the machine's own fetch
// back. scripts/test/no-network-git.mjs makes both impossible — for any git a
// test process runs, and (no-network-node.mjs) for the process itself; this is
// the census that every test file in the repository runs in such a process,
// and the proof that the guard holds.

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
// Spelled out, not imported: importing the guard would apply it to this very
// process, and the tests below must prove the RUNNER applied it.
const NO_NETWORK_MARK = "GS_TEST_GIT_NO_NETWORK";
const NO_NETWORK_CODE = "ERR_TEST_NO_NETWORK";
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
  // ssh is the guard's, above every core.sshCommand.
  assert.match(process.env.GIT_SSH_COMMAND ?? "", /no-network-in-tests[^\s'"]*[\\/]ssh"$/);
});

// Where an https attempt died: the guard's proxy, which nothing listens on.
// curl on macOS and Linux names its port ("127.0.0.1 port 1"); Git for
// Windows' curl says "… over proxy 127.0.0.1 …" instead.
const VIA_GUARD_PROXY = /127\.0\.0\.1 port 1\b|over proxy 127\.0\.0\.1\b/;

test("a remote on the network fails at once, and never leaves the machine", () => {
  // `.invalid` never resolves, so even a broken guard would not reach a host —
  // what proves the guard is WHERE each attempt failed.
  const https = git(["ls-remote", "https://example.invalid/acme/app.git"]);
  assert.notEqual(https.status, 0);
  assert.match(https.out, VIA_GUARD_PROXY, `https went to the proxy nothing listens on: ${https.out}`);
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

test("a repository's own core.sshCommand does not outrank the guard — a test serving its own ssh says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-own-ssh-"));
  try {
    const marker = join(dir, "called");
    const fake = join(dir, "fake-ssh.cjs");
    writeFileSync(fake, `require("fs").writeFileSync(${JSON.stringify(marker)}, "yes"); process.exit(1);\n`);
    assert.equal(git(["init", "-q", dir]).status, 0);
    // Forward slashes: git runs an ssh command through `sh -c`.
    assert.equal(git(["config", "core.sshCommand", `node "${posix.normalize(toPosix(fake))}"`], dir).status, 0);
    const r = git(["ls-remote", "git@example.invalid:acme/app.git"], dir);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(marker), false, "the repository's ssh command never ran");
    assert.match(r.out, /no-network-in-tests[^\s'"]*[\\/]ssh/, `the guard's ssh, a program that is never there: ${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── A machine's own config, in a fresh process ──────────────────────────────
//
// The runs that load no-network-git.mjs alone (the merge-studio script tests,
// merge-e2e) keep the developer's global and system config, and git ranks some
// of it above anything an environment variable at the command scope says: a
// global core.sshCommand outranked GIT_SSH, and a URL-scoped
// http.<url>.proxy — or an empty one, straight out — outranked http.proxy.

/** Run `node [--import guard] child.mjs` with ONLY `env` (plus what a system needs to start a program). */
function node(args: string[], env: Record<string, string>, cwd?: string): Promise<{ status: number | null; out: string }> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[k] !== undefined) base[k] = process.env[k]!;
  }
  return new Promise((done) => {
    const p = spawn(process.execPath, args, { cwd, env: { ...base, ...env }, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => p.kill(), 60_000);
    p.on("close", (status) => {
      clearTimeout(kill);
      done({ status, out });
    });
  });
}

test("a machine's own config cannot outrank the guard: core.sshCommand, core.gitProxy, http.<url>.proxy, remote.<name>.proxy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-machine-config-"));
  // A "proxy" of our own: every connection git makes to it is recorded, and
  // dropped — so an unguarded run reaches this, never the network.
  const seen: string[] = [];
  const recorder = createNetServer((s) => {
    // Let a connection go once it has said what it wanted, not on a clock: a
    // flat 50 ms cut slow Windows runners off before git had sent its CONNECT
    // line, and "exact host AND host-and-path" counted 1 of 2.
    s.once("data", (d) => {
      seen.push(String(d).split("\r\n")[0]);
      s.destroy();
    });
    s.on("error", () => {});
    // …and one that never speaks, eventually.
    setTimeout(() => s.destroy(), 10_000).unref();
  });
  await new Promise<void>((r) => recorder.listen(0, "127.0.0.1", r));
  const REC = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
  try {
    const fwd = (p: string) => posix.normalize(toPosix(p));
    const marker = (name: string) => join(dir, `${name}.called`);
    const fakeNode = (name: string): string => {
      const f = join(dir, `${name}.cjs`);
      writeFileSync(f, `require("fs").writeFileSync(${JSON.stringify(marker(name))}, "yes"); process.exit(1);\n`);
      return `node "${fwd(f)}"`;
    };
    const machine = join(dir, "machine.gitconfig");
    writeFileSync(machine, "");
    const set = (key: string, value: string) => {
      const r = spawnSync("git", ["config", "--file", machine, key, value], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    set("core.sshCommand", fakeNode("machine-ssh"));
    set("http.proxy", REC);
    set("http.https://example.invalid.proxy", REC);
    set("http.https://example.invalid/deep.proxy", REC);
    set("http.https://*.*.proxy", REC);
    set("remote.upstream.proxy", REC);
    // core.gitProxy is run as a program, not through a shell.
    const posixOnly = process.platform !== "win32";
    if (posixOnly) {
      const gp = join(dir, "git-proxy.sh");
      writeFileSync(gp, `#!/bin/sh\necho yes > "${fwd(marker("machine-git-proxy"))}"\nexit 1\n`);
      chmodSync(gp, 0o755);
      set("core.gitProxy", fwd(gp));
    }
    // A repository whose remote the machine proxies by NAME…
    const repo = join(dir, "repo");
    const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    spawnSync("git", ["-C", repo, "remote", "add", "upstream", "https://named.invalid/acme/app.git"]);
    // …and config that applies only INSIDE it, which the guard, loading
    // elsewhere, never reads: only its own wildcards stand in its way.
    const inside = join(dir, "inside.gitconfig");
    writeFileSync(inside, "");
    spawnSync("git", ["config", "--file", inside, "http.https://*.*.*.proxy", REC]);
    set(`includeIf.gitdir:${fwd(realpathSync(repo))}/.path`, fwd(inside));

    // What the child tries, one git each: every way out the machine's config offers.
    const tries: [string, string[]][] = [
      ["exact host", ["ls-remote", "https://example.invalid/acme/app.git"]],
      ["host and path", ["ls-remote", "https://example.invalid/deep/app.git"]],
      ["wildcard host", ["ls-remote", "https://wild.invalid/acme/app.git"]],
      ["remote by name", ["-C", repo, "ls-remote", "upstream"]],
      ["only in that repository", ["-C", repo, "ls-remote", "https://a.inside.invalid/acme/app.git"]],
      ["ssh", ["ls-remote", "git@example.invalid:acme/app.git"]],
      ...(posixOnly ? ([["git://", ["ls-remote", "git://example.invalid/acme/app.git"]]] as [string, string[]][]) : []),
    ];
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      `import { spawnSync } from "node:child_process";\n` +
        `const tries = JSON.parse(process.argv[2]);\n` +
        `const out = {};\n` +
        `for (const [name, args] of tries) {\n` +
        `  const r = spawnSync("git", args, { encoding: "utf8", timeout: 20000 });\n` +
        `  out[name] = { status: r.status, err: String(r.stderr ?? "") };\n` +
        `}\n` +
        `if (process.argv[3]) {\n` +
        `  // A test that serves its own ssh, opting in the one way there is.\n` +
        `  const { serveOwnSsh } = await import(process.argv[3]);\n` +
        `  const undo = serveOwnSsh(process.argv[4]);\n` +
        `  out.own = spawnSync("git", ["ls-remote", "git@example.invalid:acme/app.git"], { encoding: "utf8" }).status;\n` +
        `  undo();\n` +
        `  const again = spawnSync("git", ["ls-remote", "git@example.invalid:acme/app.git"], { encoding: "utf8" });\n` +
        `  out.after = String(again.stderr);\n` +
        `}\n` +
        `console.log("RESULT" + JSON.stringify(out));\n`,
    );
    const env = { GIT_CONFIG_GLOBAL: machine, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const result = (r: { out: string }) => JSON.parse(/RESULT(.*)/.exec(r.out)?.[1] ?? "null") as Record<string, { status: number; err: string }> & { own?: number; after?: string };
    const guard = pathToFileURL(join(REPO, "scripts", "test", "no-network-git.mjs")).href;

    // Unguarded, the machine's config does take every one of them — else this proves nothing.
    const open = result(await node([child, JSON.stringify(tries)], env, dir));
    assert.ok(open, "the unguarded child reported");
    await new Promise((r) => setTimeout(r, 100));
    for (const host of ["example.invalid:443", "wild.invalid:443", "named.invalid:443", "a.inside.invalid:443"]) {
      assert.ok(seen.some((l) => l.startsWith(`CONNECT ${host} `)), `unguarded, the machine's proxy was asked for ${host} (${seen.join(" | ")})`);
    }
    assert.equal(seen.filter((l) => l.startsWith("CONNECT example.invalid:443 ")).length, 2, "exact host AND host-and-path");
    assert.equal(existsSync(marker("machine-ssh")), true, "unguarded, the machine's core.sshCommand ran");
    if (posixOnly) assert.equal(existsSync(marker("machine-git-proxy")), true, "unguarded, the machine's core.gitProxy ran");

    // Guarded: none of them, each failing where the guard says.
    seen.length = 0;
    rmSync(marker("machine-ssh"), { force: true });
    rmSync(marker("machine-git-proxy"), { force: true });
    set("http.https://direct.invalid.proxy", ""); // no proxy at all for this host
    tries.push(["no proxy", ["ls-remote", "https://direct.invalid/acme/app.git"]]);
    const own = fakeNode("own-ssh");
    const shut = result(await node(["--import", guard, child, JSON.stringify(tries), guard, own], env, dir));
    assert.ok(shut, "the guarded child reported");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen, [], "the machine's proxy was never asked");
    assert.equal(existsSync(marker("machine-ssh")), false, "the machine's core.sshCommand never ran");
    assert.equal(existsSync(marker("machine-git-proxy")), false, "the machine's core.gitProxy never ran");
    for (const name of ["exact host", "host and path", "wildcard host", "remote by name", "only in that repository", "no proxy"]) {
      assert.notEqual(shut[name].status, 0);
      assert.match(shut[name].err, VIA_GUARD_PROXY, `${name}: https went to the proxy nothing listens on: ${shut[name].err}`);
    }
    assert.match(shut.ssh.err, /no-network-in-tests[^\s'"]*[\\/]ssh/, `ssh is the guard's: ${shut.ssh.err}`);
    if (posixOnly) assert.match(shut["git://"].err, /no-network-in-tests[^\s'"]*[\\/]git-proxy/, `git:// too: ${shut["git://"].err}`);
    // …and a test that serves its own ssh says so, and is served — once.
    assert.equal(existsSync(marker("own-ssh")), true, "serveOwnSsh: the test's own ssh ran");
    assert.match(shut.after ?? "", /no-network-in-tests[^\s'"]*[\\/]ssh/, "and after its undo, the guard's again");
  } finally {
    recorder.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The test process itself: fetch, http(s), net, tls ───────────────────────
//
// Every host below is `.invalid` (never resolves), so even a broken guard
// reaches nothing: what proves the guard is the error each attempt fails
// with — the guard's own code, at once — not ENOTFOUND after a lookup.

/** Rejects with the guard's refusal — fetch's TypeError carries it as its cause. */
async function refused(what: string, attempt: () => Promise<unknown>): Promise<void> {
  const t = Date.now();
  await assert.rejects(attempt, (e: { code?: string; cause?: { code?: string }; message?: string }) => {
    assert.equal(e.code ?? e.cause?.code, NO_NETWORK_CODE, `${what}: refused by the guard, not ${e.code ?? e.cause?.code}: ${e.message}`);
    return true;
  });
  assert.ok(Date.now() - t < 5_000, `${what}: refused at once (${Date.now() - t} ms)`);
}

const viaRequest = (req: typeof httpRequest, url: string) =>
  new Promise((ok, fail) => {
    const r = req(url, (res) => {
      res.resume();
      ok(res.statusCode);
    });
    r.on("error", fail);
    r.end();
  });
const viaSocket = (s: ReturnType<typeof netConnect>, ready: string) =>
  new Promise((ok, fail) => {
    s.once(ready, () => {
      s.destroy();
      ok(true);
    });
    s.once("error", fail);
  });

test("this process reaches no host but this machine's: fetch, a fake's restored fetch, a redirect, http(s), net and tls", async () => {
  const server = createHttpServer((req, res) => {
    if (req.url === "/away") {
      res.writeHead(302, { location: "http://example.invalid/elsewhere" });
      res.end();
    } else res.end("here");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  // Each refusal below is on purpose: taken back off the record, or this
  // process would exit failed for them (see no-network-node.mjs).
  const record = (globalThis as unknown as Record<symbol, { refused: string[]; quiet: boolean } | undefined>)[
    Symbol.for("gitstudio.test.noNetwork")
  ];
  assert.ok(record, "the guard keeps its record on this process's globalThis");
  const before = record.refused.length;
  record.quiet = true;
  try {
    // This machine is reachable, by address and by name.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "here");
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "here");
    assert.equal(await viaRequest(httpRequest, `http://127.0.0.1:${port}/`), 200);

    await refused("fetch", () => fetch("https://api.example.invalid/graphql", { method: "POST", body: "{}" }));
    await refused("fetch(URL)", () => fetch(new URL("https://example.invalid/")));
    // A fake installed and put back the way fakeGitHub's restore() does: what
    // comes back is the guarded fetch — it was in place before any test loaded.
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response("fake")) as typeof fetch;
    try {
      assert.equal(await (await fetch("https://api.example.invalid/x")).text(), "fake", "a test's own fake is asked, not the guard");
    } finally {
      globalThis.fetch = saved;
    }
    await refused("a restored fetch", () => fetch("https://api.example.invalid/x"));
    // Under fetch: a local server's redirect off the machine.
    await refused("fetch, redirected away", () => fetch(`http://127.0.0.1:${port}/away`));
    await refused("http.request", () => viaRequest(httpRequest, "http://example.invalid/"));
    await refused("https.request", () => viaRequest(httpsRequest as typeof httpRequest, "https://example.invalid/"));
    await refused("net.connect", () => viaSocket(netConnect(443, "example.invalid"), "connect"));
    await refused("tls.connect", () => viaSocket(tlsConnect({ port: 443, host: "example.invalid", servername: "example.invalid" }), "secureConnect"));
  } finally {
    server.close();
    record.quiet = false;
    const mine = record.refused.splice(before);
    assert.equal(mine.length, 8, `every refusal is on the record: ${mine.join(" | ")}`);
    assert.ok(mine.every((r) => /example\.invalid/.test(r)), mine.join(" | "));
  }
});

test("a fresh process under either guard refuses fetch, and exits failed for it — without one it would not have", async () => {
  // The caller swallows the error, as the PR tree's checks batch did.
  const probe = `fetch("https://example.invalid/").then(() => console.log("CODE none"), (e) => console.log("CODE " + (e.cause?.code ?? e.code)))`;
  for (const f of GUARDS) {
    const r = await node(["--import", pathToFileURL(f).href, "-e", probe], {});
    assert.match(r.out, new RegExp(`CODE ${NO_NETWORK_CODE}\\b`), `${relative(REPO, f)}: ${r.out}`);
    assert.notEqual(r.status, 0, `${relative(REPO, f)}: a process refused anything exits failed`);
    assert.match(r.out, /tried to leave the machine 1 time\(s\)[^]*fetch https:\/\/example\.invalid\//, r.out);
  }
  // The same probe unguarded fails its own way (the name never resolves): so
  // the code above is the guard's doing, and this test can fail.
  const bare = await node(["-e", probe], {});
  assert.doesNotMatch(bare.out, new RegExp(NO_NETWORK_CODE), bare.out);
  assert.match(bare.out, /CODE \S+/, bare.out);
  assert.equal(bare.status, 0);
});
