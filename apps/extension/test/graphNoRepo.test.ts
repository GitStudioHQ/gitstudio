// The graph host with no repository open says so: its empty graphInit carries
// `noRepo`, so the Commit Graph and the Commits rail read "No repository open"
// rather than "No commits yet — Make your first commit…" (the page half is
// packages/webview-ui/test/graphNoRepo.test.ts).
//
// "No repository YET" is not "none": while RepoManager is still discovering
// (vscode.git's first scan finds a repository below the opened folder that our
// own rev-parse cannot), the init says `discovering` instead — the Changes view
// above the rail already says "Looking for a repository…", and the rail under
// it said "No repository open" at the same moment.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
// graphPanel.ts opens Compare These Two Commits, and comparePanel.ts imports
// the shared tokens.css as text (esbuild's "text" loader does it in the build).
const loaders = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions;
loaders[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");
/* eslint-enable @typescript-eslint/no-require-imports */

const noop = { dispose() {} };

/** A graph host over `repos`, told the page is ready; `inits(n)` waits for the n-th graphInit. */
function openHost(sidebar: boolean, repos: Record<string, unknown>) {
  const posted: Record<string, unknown>[] = [];
  let deliver: (m: unknown) => void = () => {};
  const webview = {
    html: "",
    options: {},
    cspSource: "",
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage: (fn: (m: unknown) => void) => {
      deliver = fn;
      return noop;
    },
    postMessage: async (m: Record<string, unknown>) => {
      posted.push(m);
      return true;
    },
  };
  const panel = CommitGraphPanel.forView(webview as never, repos as never, {} as never, { sidebar, layout: "side" });
  deliver({ type: "ready" });
  const inits = async (n: number): Promise<Record<string, unknown>[]> => {
    const got = () => posted.filter((m) => m.type === "graphInit");
    for (let i = 0; i < 150 && got().length < n; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(got().length >= n, JSON.stringify(posted));
    return got();
  };
  return { panel, inits };
}

/** Open a graph host over `repos`, say ready, and return its first graphInit. */
async function firstInit(sidebar: boolean, repos: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { panel, inits } = openHost(sidebar, repos);
  try {
    return (await inits(1))[0];
  } finally {
    panel.dispose();
  }
}

for (const sidebar of [false, true]) {
  const name = sidebar ? "the Commits rail" : "the Commit Graph";
  test(`${name}: while repositories are still being discovered, the empty init says so — not "none"`, async () => {
    const init = await firstInit(sidebar, {
      onDidChange: () => noop,
      getActive: () => undefined,
      getAll: () => [],
      isDiscovering: () => true,
    });
    assert.deepEqual(init.rows, []);
    assert.equal(init.discovering, true, "the page is told discovery is still running");
    assert.ok(!init.noRepo, "and is NOT told there is no repository");
  });
}

for (const sidebar of [false, true]) {
  test(`${sidebar ? "the Commits rail" : "the Commit Graph"}: with no repository, the empty init says there is none`, async () => {
    const init = await firstInit(sidebar, {
      onDidChange: () => noop,
      getActive: () => undefined,
      getAll: () => [],
      isDiscovering: () => false,
    });
    assert.deepEqual(init.rows, []);
    assert.equal(init.noRepo, true);
    assert.ok(!init.discovering, "discovery has settled");
  });
}

test("once discovery settles with nothing found, the waiting graph says there is no repository", async () => {
  let discovering = true;
  let changed: () => void = () => {};
  const { panel, inits } = openHost(true, {
    onDidChange: (fn: () => void) => {
      changed = fn;
      return noop;
    },
    getActive: () => undefined,
    getAll: () => [],
    isDiscovering: () => discovering,
  });
  try {
    const [first] = await inits(1);
    assert.equal(first.discovering, true);
    // RepoManager.markDiscovered: the flag flips, then onDidChange fires.
    discovering = false;
    changed();
    const [, second] = await inits(2);
    assert.equal(second.noRepo, true, "the refresh the settle triggers says 'none'");
    assert.ok(!second.discovering);
  } finally {
    panel.dispose();
  }
});
