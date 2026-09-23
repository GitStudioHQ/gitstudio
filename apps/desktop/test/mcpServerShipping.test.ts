// Settings ▸ Agent Access: the MCP server the app offers to install must be one
// the app actually SHIPS, launched by a runtime the user actually HAS.
//
// Report #16 was "The MCP server isn't built yet (apps/mcp/dist/index.js)" —
// filed from a shipped desktop build. It was marked expected, which silenced
// the report and left the defect: electron-builder.yml never packaged apps/mcp,
// so EVERY shipped build showed an "Add" button that could not work, and told
// the user to "Run npm run build in apps/mcp" — a repository they do not have.
// And the config it would have written launched the server with `node`, which
// a desktop user need not have installed, and which Claude Desktop — started
// from the Dock with a bare PATH — does not find even when they do.
//
// What is pinned here:
//   · the server resolves in BOTH layouts: beside the main bundle in a dev
//     tree (the desktop's own esbuild writes it), and under the app's
//     resources in a packaged build (electron-builder's extraResources);
//   · the launch is the app's OWN executable with ELECTRON_RUN_AS_NODE=1 — or,
//     from an AppImage, the AppImage itself and a copy of the server that
//     outlives the per-launch mount;
//   · Add writes a config whose command really starts the server and answers
//     an MCP `initialize` over stdio;
//   · a missing server is a condition only in a dev tree. In a shipped build it
//     is OUR defect, and reports.

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { installMcp, mcpInfo, mcpLaunch, resolveMcpBin, type McpRuntime } from "../src/main/mcpConfig";
import { reportableResultMessage } from "../src/main/expectedError";
import { removeTempRepo } from "./tmpRepo";

const scratch = mkdtempSync(join(tmpdir(), "gs-mcp-ship-"));
after(() => removeTempRepo(scratch));

/** A runtime description with every path under `scratch`. */
function runtime(over: Partial<McpRuntime> = {}): McpRuntime {
  return {
    packaged: false,
    execPath: process.execPath,
    resourcesPath: join(scratch, "no-resources"),
    mainDir: join(scratch, "no-dist", "main"),
    userData: join(scratch, "userData"),
    ...over,
  };
}

/**
 * Point every home-directory lookup the client configs use at `home` — and
 * NEVER at the developer's real Claude / Cursor / VS Code configs. HOME is
 * what os.homedir() reads on POSIX; USERPROFILE on Windows, where APPDATA
 * locates Claude's and VS Code's. Returns the restore.
 */
function pointHomeAt(home: string): () => void {
  const keys = ["HOME", "USERPROFILE", "APPDATA"] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  return () =>
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
}

function touch(p: string, body = "// server\n"): string {
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
}

test("a packaged build finds the server it ships under its resources", () => {
  const res = join(scratch, "pkg", "Resources");
  const bin = touch(join(res, "mcp", "gitstudio-mcp.js"));
  assert.equal(resolveMcpBin(runtime({ packaged: true, resourcesPath: res })), bin);
});

test("a dev build finds the bundle the desktop's own esbuild writes beside dist/main", () => {
  const dist = join(scratch, "dev", "dist");
  const bin = touch(join(dist, "mcp", "gitstudio-mcp.js"));
  assert.equal(resolveMcpBin(runtime({ mainDir: join(dist, "main") })), bin);
});

test("the launch is the app's own runtime, never a bare `node`", () => {
  const exe = "/Applications/GitStudio.app/Contents/MacOS/GitStudio";
  const plan = mcpLaunch(runtime({ packaged: true, execPath: exe }));
  assert.equal(plan.command, exe);
  assert.deepEqual(plan.env, { ELECTRON_RUN_AS_NODE: "1" });
});

test("from an AppImage: launch the AppImage, and a server copy that outlives the mount", () => {
  // An AppImage runs from a per-launch mount under /tmp/.mount_*, so both the
  // executable and the resources path are gone the moment the app quits.
  const mount = join(scratch, ".mount_GitStudio", "resources");
  touch(join(mount, "mcp", "gitstudio-mcp.js"), "// shipped server\n");
  const rt = runtime({
    packaged: true,
    resourcesPath: mount,
    execPath: join(scratch, ".mount_GitStudio", "gitstudio"),
    appImage: "/home/someone/Apps/GitStudio.AppImage",
  });
  const plan = mcpLaunch(rt);
  assert.equal(plan.command, "/home/someone/Apps/GitStudio.AppImage");
  const info = mcpInfo(undefined, rt);
  assert.ok(info.binPath.startsWith(rt.userData), `the config points outside the mount: ${info.binPath}`);
  assert.equal(readFileSync(info.binPath, "utf8"), "// shipped server\n", "…at a real copy of the server");
});

test("a missing server is a condition in a dev tree and a defect in a shipped build", () => {
  const req = { client: "cursor", write: false, destructive: false };
  const home = mkdtempSync(join(tmpdir(), "gs-mcp-home-"));
  const restore = pointHomeAt(home);
  try {
    const dev = installMcp(undefined, req, runtime());
    assert.equal(dev.ok, false);
    assert.equal(dev.expected, true, "in a dev tree it only means the bundle was not built");
    assert.match(dev.message, /isn't built yet/);

    const shipped = installMcp(undefined, req, runtime({ packaged: true }));
    assert.equal(shipped.ok, false);
    assert.notEqual(shipped.expected, true, "a shipped build without its server is ours to hear about");
    assert.equal(reportableResultMessage(shipped), shipped.message);
    assert.doesNotMatch(shipped.message, /npm run build|apps\/mcp/, "no instructions for a repo the user lacks");
    assert.equal(existsSync(join(home, ".cursor", "mcp.json")), false, "nothing was written");
  } finally {
    restore();
    removeTempRepo(home);
  }
});

test("Add writes a config whose command starts the server and answers `initialize`", async () => {
  // The real server, bundled exactly as the desktop's esbuild bundles it.
  const bin = join(scratch, "built", "mcp", "gitstudio-mcp.js");
  await build({
    entryPoints: [fileURLToPathSafe("../../mcp/src/index.ts")],
    outfile: bin,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
  });
  const repo = join(scratch, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);

  const home = mkdtempSync(join(tmpdir(), "gs-mcp-home-"));
  const restore = pointHomeAt(home);
  let cfg: { mcpServers: { gitstudio: { command: string; args: string[]; env?: Record<string, string> } } };
  try {
    const rt = runtime({ mainDir: join(scratch, "built", "main") });
    const r = installMcp(repo, { client: "cursor", write: false, destructive: false }, rt);
    assert.equal(r.ok, true, r.message);
    cfg = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  } finally {
    restore();
    removeTempRepo(home);
  }
  const entry = cfg.mcpServers.gitstudio;
  assert.equal(entry.command, process.execPath, "the app's own runtime");
  assert.deepEqual(entry.env, { ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(entry.args, [bin, "--repo", repo]);

  // Launch it EXACTLY as a client would, and speak MCP to it.
  const child = spawn(entry.command, entry.args, {
    env: { ...process.env, ...entry.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reply = await new Promise<string>((resolveReply, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("no reply to initialize within 10s")), 10_000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolveReply(out.slice(0, nl));
      }
    });
    child.on("error", reject);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gitstudio-test", version: "0" },
        },
      }) + "\n",
    );
  });
  child.kill();
  const msg = JSON.parse(reply) as { id: number; result?: { serverInfo?: { name?: string } } };
  assert.equal(msg.id, 1);
  assert.match(msg.result?.serverInfo?.name ?? "", /gitstudio/i, reply);
});

/** A path relative to this test file — `fileURLToPath`, not `.pathname`, which
 *  yields "/C:/…" on Windows, where the release workflow runs this suite too. */
function fileURLToPathSafe(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}
