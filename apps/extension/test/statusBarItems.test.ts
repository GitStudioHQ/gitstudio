// GitStudio's status-bar items each have their own id and a name.
//
// All four (branch sync, Commit Graph, terminal, blame) were created without
// an id, and VS Code then gives every one the extension's id: the status bar's
// right-click menu listed them under one entry, so none could be hidden alone,
// and none had a name to show there. The branch item's text is icons and
// numbers ("main ↓1 ↑2 ✎3"), which a screen reader cannot make sense of, and
// the graph button is an icon alone.

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

interface Item {
  args: unknown[];
  name?: string;
  text?: string;
  accessibilityInformation?: { label: string; role?: string };
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}
const created: Item[] = [];
const noop = { dispose() {} };

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  window: Record<string, unknown>;
  commands: Record<string, unknown>;
};
vscode.window.createStatusBarItem = (...args: unknown[]): Item => {
  const item: Item = {
    args,
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose() {},
  };
  created.push(item);
  return item;
};
vscode.commands.registerCommand = () => noop;
const { SyncStatusItem } = require("../src/statusBar/syncStatus") as typeof import("../src/statusBar/syncStatus");
const { StatusCluster } = require("../src/statusBar/statusCluster") as typeof import("../src/statusBar/statusCluster");
const { BlameController } = require("../src/blame/blameController") as typeof import("../src/blame/blameController");
const { syncAccessibleLabel } = require("../src/statusBar/syncLabel") as typeof import("../src/statusBar/syncLabel");
/* eslint-enable @typescript-eslint/no-require-imports */

/** A repository on main, tracking origin/main, 2 ahead and 1 behind, 3 files changed. */
const entry = {
  root: "/r",
  ctx: {
    refs: { getHead: async () => ({ detached: false, branch: "main", fullName: "refs/heads/main", sha: "a".repeat(40) }) },
    sync: {
      currentUpstream: async () => "origin/main",
      aheadBehind: async () => ({ ahead: 2, behind: 1 }),
    },
    status: {
      read: async () => ({ staged: [{ path: "a" }], unstaged: [{ path: "a" }, { path: "b" }, { path: "c" }] }),
    },
  },
};
const repos = { onDidChange: () => noop, getActive: () => entry, getAll: () => [entry] };
const context = {
  globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} },
  subscriptions: [],
};

test("each item has an id of its own and a name", () => {
  created.length = 0;
  const sync = new SyncStatusItem(repos as never);
  const cluster = new StatusCluster(repos as never);
  const blame = new BlameController(repos as never, context as never);
  try {
    assert.equal(created.length, 4, "sync, graph, terminal, blame");
    const ids = created.map((i) => i.args[0]);
    for (const id of ids) assert.match(String(id), /^gitstudio\.[a-z]+$/, `an id, not an alignment: ${String(id)}`);
    assert.equal(new Set(ids).size, ids.length, `distinct ids: ${ids.join(", ")}`);
    const names = created.map((i) => i.name ?? "");
    for (const n of names) assert.match(n, /^GitStudio /, `named: ${JSON.stringify(n)}`);
    assert.equal(new Set(names).size, names.length, `distinct names: ${names.join(", ")}`);
    // The graph button is an icon alone: it says what it is to a screen reader.
    const graph = created.find((i) => i.args[0] === "gitstudio.graph");
    assert.match(graph?.accessibilityInformation?.label ?? "", /Commit Graph/);
  } finally {
    sync.dispose();
    cluster.dispose();
    blame.dispose();
  }
});

test("the branch item reads out in words what its icons and numbers say", async () => {
  created.length = 0;
  const sync = new SyncStatusItem(repos as never);
  try {
    const item = created[0];
    for (let i = 0; i < 100 && !item.visible; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(item.text, "$(git-branch) main $(arrow-down)1 $(arrow-up)2 $(pencil)3");
    assert.equal(
      item.accessibilityInformation?.label,
      "Branch main: 1 commit to pull, 2 commits to push, 3 changed files. Opens the branch menu.",
    );
  } finally {
    sync.dispose();
  }
});

test("the words for the other states", () => {
  const base = { branch: "feature", upstream: true, ahead: 0, behind: 0, dirty: 0 };
  assert.equal(syncAccessibleLabel(base), "Branch feature: nothing to pull or push. Opens the branch menu.");
  assert.equal(
    syncAccessibleLabel({ ...base, upstream: false, dirty: 1 }),
    "Branch feature: not published, 1 changed file. Opens the branch menu.",
  );
  assert.equal(
    syncAccessibleLabel({ ...base, ahead: 1 }),
    "Branch feature: 1 commit to push. Opens the branch menu.",
  );
});

// A detached HEAD is not an unpublished branch: there is no branch to publish.
// The item said "Branch abc1234 (detached): not published" to a screen reader,
// showed the publish cloud, and its hover offered Publish Branch — which
// answers "cannot publish a detached HEAD".
test("a detached HEAD reads as one: no publishing, in words, icon or hover", async () => {
  const detached = {
    root: "/r",
    ctx: {
      ...entry.ctx,
      refs: { getHead: async () => ({ detached: true, branch: undefined, fullName: undefined, sha: "b".repeat(40) }) },
      sync: { currentUpstream: async () => null, aheadBehind: async () => ({ ahead: 0, behind: 0 }) },
    },
  };
  const api = vscode as unknown as { MarkdownString: unknown };
  const real = api.MarkdownString;
  const hovers: { value: string }[] = [];
  api.MarkdownString = class {
    value = "";
    constructor() {
      hovers.push(this);
    }
    appendMarkdown(md: string) {
      this.value += md;
      return this;
    }
  };
  created.length = 0;
  const sync = new SyncStatusItem({ onDidChange: () => noop, getActive: () => detached, getAll: () => [detached] } as never);
  try {
    const item = created[0];
    for (let i = 0; i < 100 && !item.visible; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(item.text, "$(git-branch) bbbbbbb (detached) $(pencil)3", "no publish cloud");
    assert.equal(
      item.accessibilityInformation?.label,
      "Detached HEAD at bbbbbbb: 3 changed files. Opens the branch menu.",
    );
    const hover = hovers.at(-1)?.value ?? "";
    assert.doesNotMatch(hover, /Publish|No upstream/, hover);
    assert.match(hover, /Detached HEAD/, hover);
  } finally {
    sync.dispose();
    api.MarkdownString = real;
  }
});

test("the words for a detached HEAD, with and without changes", () => {
  const base = { branch: "abc1234 (detached)", detachedAt: "abc1234", upstream: false, ahead: 0, behind: 0, dirty: 0 };
  assert.equal(syncAccessibleLabel(base), "Detached HEAD at abc1234. Opens the branch menu.");
  assert.equal(
    syncAccessibleLabel({ ...base, dirty: 2 }),
    "Detached HEAD at abc1234: 2 changed files. Opens the branch menu.",
  );
});
