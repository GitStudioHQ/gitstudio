// The graph host with no repository open says so: its empty graphInit carries
// `noRepo`, so the Commit Graph and the Commits rail read "No repository open"
// rather than "No commits yet — Make your first commit…" (the page half is
// packages/webview-ui/test/graphNoRepo.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { join } from "node:path";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");
/* eslint-enable @typescript-eslint/no-require-imports */

const noop = { dispose() {} };

for (const sidebar of [false, true]) {
  test(`${sidebar ? "the Commits rail" : "the Commit Graph"}: with no repository, the empty init says there is none`, async () => {
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
    const repos = { onDidChange: () => noop, getActive: () => undefined, getAll: () => [] };
    const panel = CommitGraphPanel.forView(webview as never, repos as never, {} as never, { sidebar, layout: "side" });
    try {
      deliver({ type: "ready" });
      for (let i = 0; i < 50 && !posted.some((m) => m.type === "graphInit"); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const init = posted.find((m) => m.type === "graphInit");
      assert.ok(init, JSON.stringify(posted));
      assert.deepEqual(init.rows, []);
      assert.equal(init.noRepo, true);
    } finally {
      panel.dispose();
    }
  });
}
