// `gitstudio.avatars.gravatar` — whether the Commit Graph, the Commits rail and
// commit details look commit authors' pictures up on the internet (an MD5 hash
// of each email to www.gravatar.com; a GitHub noreply address's account name to
// avatars.githubusercontent.com). The page decides every such URL
// (webview-ui's graph/avatar.ts); the host's part is to tell it which way the
// switch is, BEFORE the first rows arrive — a page that drew its first rows
// with lookups on would already have sent them — and again whenever the setting
// changes. The page half is packages/webview-ui/test/gravatarSwitch.test.ts.

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
const vscode = require("vscode") as { workspace: Record<string, unknown> };
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");
/* eslint-enable @typescript-eslint/no-require-imports */

// The user's settings, as the stand-in's workspace answers them.
let gravatar: unknown;
const configListeners: Array<(e: { affectsConfiguration(section: string): boolean }) => void> = [];
Object.assign(vscode.workspace, {
  getConfiguration: (section?: string) => ({
    get: (key: string, fallback?: unknown) =>
      section === "gitstudio.avatars" && key === "gravatar" && gravatar !== undefined ? gravatar : fallback,
  }),
  onDidChangeConfiguration: (fn: (e: { affectsConfiguration(section: string): boolean }) => void) => {
    configListeners.push(fn);
    return { dispose: () => configListeners.splice(configListeners.indexOf(fn), 1) };
  },
});
const changeSetting = (section: string): void => {
  for (const fn of [...configListeners]) fn({ affectsConfiguration: (s) => section === s || section.startsWith(`${s}.`) });
};

const noop = { dispose() {} };
const noRepos = { onDidChange: () => noop, getActive: () => undefined, getAll: () => [], isDiscovering: () => false };

/** A graph host told its page is ready; `posted` is every message it sent. */
function openHost(sidebar: boolean) {
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
  const panel = CommitGraphPanel.forView(webview as never, noRepos as never, {} as never, { sidebar, layout: "side" });
  return { panel, posted, ready: () => deliver({ type: "ready" }) };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

for (const sidebar of [false, true]) {
  const name = sidebar ? "the Commits rail" : "the Commit Graph";

  test(`${name}: the page hears the switch before its first rows`, async () => {
    gravatar = false;
    const { panel, posted, ready } = openHost(sidebar);
    try {
      ready();
      await until(() => posted.some((m) => m.type === "graphInit"));
      const types = posted.map((m) => m.type);
      const prefs = types.indexOf("avatarPrefs");
      assert.ok(prefs >= 0, `the host says which way the switch is (${types.join(", ")})`);
      assert.ok(prefs < types.indexOf("graphInit"), `…before the first graphInit (${types.join(", ")})`);
      assert.deepEqual(posted[prefs], { type: "avatarPrefs", gravatar: false });
    } finally {
      panel.dispose();
      gravatar = undefined;
    }
  });
}

test("a setting nobody changed means lookups stay on, as before the switch existed", async () => {
  gravatar = undefined;
  const { panel, posted, ready } = openHost(false);
  try {
    ready();
    await until(() => posted.some((m) => m.type === "avatarPrefs"));
    assert.deepEqual(posted.find((m) => m.type === "avatarPrefs"), { type: "avatarPrefs", gravatar: true });
  } finally {
    panel.dispose();
  }
});

test("changing the setting reaches an open page at once; another setting, or a page not yet up, hears nothing", async () => {
  gravatar = true;
  const listening = configListeners.length;
  const { panel, posted, ready } = openHost(false);
  assert.equal(configListeners.length, listening + 1, "the host listens for the setting");
  try {
    // Not ready yet: nothing to repaint, and the ready handshake will say it.
    changeSetting("gitstudio.avatars.gravatar");
    assert.equal(posted.filter((m) => m.type === "avatarPrefs").length, 0, "a page still loading is told on ready, not before");
    ready();
    await until(() => posted.some((m) => m.type === "graphInit"));
    const count = () => posted.filter((m) => m.type === "avatarPrefs").length;
    const before = count();
    gravatar = false;
    changeSetting("gitstudio.avatars.gravatar");
    assert.equal(count(), before + 1, "the change is posted");
    assert.deepEqual(posted.at(-1), { type: "avatarPrefs", gravatar: false });
    changeSetting("gitstudio.fetch.prune");
    assert.equal(count(), before + 1, "an unrelated setting posts nothing");
  } finally {
    panel.dispose();
    gravatar = undefined;
  }
  assert.equal(configListeners.length, listening, "a disposed host stops listening");
});

test("the setting is declared as it is documented: on by default, and it says what goes where", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    contributes: { configuration: Array<{ title: string; properties: Record<string, { type?: string; default?: unknown; markdownDescription?: string }> }> };
  };
  const general = pkg.contributes.configuration.find((c) => c.title === "General");
  const schema = general?.properties["gitstudio.avatars.gravatar"];
  assert.ok(schema, "declared in General");
  assert.equal(schema.type, "boolean");
  assert.equal(schema.default, true);
  const text = schema.markdownDescription ?? "";
  for (const said of [/MD5 hash/, /www\.gravatar\.com/, /avatars\.githubusercontent\.com/, /noreply/, /initials/]) {
    assert.match(text, said);
  }
});
