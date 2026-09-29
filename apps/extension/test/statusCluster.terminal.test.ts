// The status bar's Commit Graph and terminal buttons (StatusCluster): shown
// only while a repository is open and each only while its setting allows it;
// the terminal button counts the terminals and names them in its hover, and a
// click opens a terminal AT THE REPOSITORY ROOT — reusing GitStudio's own one
// for that root, and putting it away when it is the focused one.
//
// vscodeStub.cjs stands in for VS Code; the terminals, the settings and the
// status bar items are modelled here, with the events that drive the button.

import Module from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

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
  command?: string;
  tooltip?: string;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}
interface Terminal {
  name: string;
  cwd?: string;
  shown: number;
  show(): void;
}

const created: Item[] = [];
const handlers = new Map<string, () => unknown>();
const executed: string[] = [];
/** Commands the host does not know: executeCommand rejects for them. */
const unknownCommands = new Set<string>();
const settings = new Map<string, boolean>();
const on = {
  open: [] as (() => void)[],
  close: [] as (() => void)[],
  active: [] as (() => void)[],
  config: [] as ((e: { affectsConfiguration(s: string): boolean }) => void)[],
};
const term = { list: [] as Terminal[], active: undefined as Terminal | undefined };

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
  workspace: Record<string, unknown>;
  commands: Record<string, unknown>;
};
const listen = (list: unknown[]) => (l: unknown) => {
  list.push(l);
  return { dispose: () => list.splice(list.indexOf(l), 1) };
};
Object.assign(vscode.window, {
  createStatusBarItem: (...args: unknown[]): Item => {
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
  },
  onDidOpenTerminal: listen(on.open),
  onDidCloseTerminal: listen(on.close),
  onDidChangeActiveTerminal: listen(on.active),
  createTerminal: (opts: { name: string; cwd?: string }): Terminal => {
    const t: Terminal = {
      name: opts.name,
      cwd: opts.cwd,
      shown: 0,
      show() {
        this.shown++;
        term.active = this;
      },
    };
    term.list.push(t);
    return t;
  },
});
Object.defineProperty(vscode.window, "terminals", { get: () => term.list.slice(), configurable: true });
Object.defineProperty(vscode.window, "activeTerminal", { get: () => term.active, configurable: true });
vscode.workspace.onDidChangeConfiguration = listen(on.config);
vscode.workspace.getConfiguration = (section: string) => ({
  get: (key: string, fallback: boolean) => {
    const k = `${section}.${key}`;
    return settings.has(k) ? settings.get(k) : fallback;
  },
});
vscode.commands.registerCommand = (id: string, fn: () => unknown) => {
  handlers.set(id, fn);
  return { dispose: () => handlers.delete(id) };
};
vscode.commands.executeCommand = (id: string) => {
  executed.push(id);
  return unknownCommands.has(id) ? Promise.reject(new Error(`command '${id}' not found`)) : Promise.resolve(undefined);
};
const { StatusCluster } = require("../src/statusBar/statusCluster") as typeof import("../src/statusBar/statusCluster");
/* eslint-enable @typescript-eslint/no-require-imports */

function cluster(active: () => { root: string } | undefined) {
  created.length = 0;
  handlers.clear();
  executed.length = 0;
  vscode.__said.length = 0;
  const listeners: (() => void)[] = [];
  const repos = {
    getActive: active,
    onDidChange: (l: () => void) => {
      listeners.push(l);
      return { dispose() {} };
    },
  };
  const c = new StatusCluster(repos as never);
  const [graph, terminal] = created;
  return {
    c,
    graph,
    terminal,
    change: () => listeners.forEach((l) => l()),
    click: async () => {
      const fn = handlers.get(terminal.command ?? "");
      assert.ok(fn, "the terminal button's command is registered");
      await fn();
    },
  };
}

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

function resetWorld(): void {
  term.list.length = 0;
  term.active = undefined;
  settings.clear();
  unknownCommands.clear();
}

const root = ["", "work", "my-repo"].join("/");

test("both buttons show once a repository is open: the graph button goes to the graph, the terminal one to a terminal", async () => {
  resetWorld();
  const k = cluster(() => ({ root }));
  try {
    assert.deepEqual(created.map((i) => i.args[0]), ["gitstudio.graph", "gitstudio.terminal"]);
    assert.equal(k.graph.text, "$(git-commit)");
    assert.equal(k.graph.command, "gitstudio.showCommitGraph");
    assert.equal(k.terminal.command, "gitstudio.openTerminal");
    await until(() => k.graph.visible && k.terminal.visible, "both shown");
  } finally {
    k.c.dispose();
  }
});

test("with no repository both buttons are hidden, and the terminal command says there is none", async () => {
  resetWorld();
  const k = cluster(() => undefined);
  try {
    k.graph.visible = true;
    k.terminal.visible = true;
    await until(() => !k.graph.visible && !k.terminal.visible, "both hidden");
    await k.click();
    assert.deepEqual(vscode.__said, [{ kind: "info", message: "GitStudio: No repository is open." }]);
    assert.equal(term.list.length, 0, "no terminal opened");
  } finally {
    k.c.dispose();
  }
});

test("a button whose setting is off stays hidden, and a settings change is followed", async () => {
  resetWorld();
  settings.set("gitstudio.statusBar.showGraph", false);
  const k = cluster(() => ({ root }));
  try {
    await until(() => k.terminal.visible, "terminal shown");
    assert.equal(k.graph.visible, false);
    settings.set("gitstudio.statusBar.showGraph", true);
    settings.set("gitstudio.statusBar.showTerminal", false);
    // A change elsewhere is not ours to follow…
    for (const l of on.config) l({ affectsConfiguration: (s) => s === "editor.fontSize" });
    // …ours is.
    for (const l of on.config) l({ affectsConfiguration: (s) => s === "gitstudio.statusBar" });
    await until(() => k.graph.visible && !k.terminal.visible, "the settings are followed");
  } finally {
    k.c.dispose();
  }
});

test("the terminal button counts terminals past one and names them all in its hover, following opens and closes", async () => {
  resetWorld();
  const k = cluster(() => ({ root }));
  try {
    assert.equal(k.terminal.text, "$(terminal)");
    assert.equal(k.terminal.tooltip, "GitStudio: Open a terminal at the repository root");
    term.list.push({ name: "zsh", shown: 0, show() {} }, { name: "node", shown: 0, show() {} });
    on.open.forEach((l) => l());
    assert.equal(k.terminal.text, "$(terminal) 2");
    assert.equal(k.terminal.tooltip, "GitStudio: Show the terminal\n\n2 terminals\n• zsh\n• node");
    term.list.pop();
    on.close.forEach((l) => l());
    assert.equal(k.terminal.text, "$(terminal)");
    assert.equal(k.terminal.tooltip, "GitStudio: Show the terminal\n\n1 terminal\n• zsh");
  } finally {
    k.c.dispose();
  }
});

test("clicking opens a terminal named for the repository, in its root, and a second click reuses it", async () => {
  resetWorld();
  const k = cluster(() => ({ root }));
  try {
    await k.click();
    assert.equal(term.list.length, 1);
    const [t] = term.list;
    assert.equal(t.name, "GitStudio: my-repo");
    assert.equal(t.cwd, root);
    assert.equal(t.shown, 1);
    // Focus moves to another terminal: the click brings ours back, not a new one.
    term.active = { name: "zsh", shown: 0, show() {} };
    await k.click();
    assert.equal(term.list.length, 1, "reused, not stacked");
    assert.equal(t.shown, 2);
  } finally {
    k.c.dispose();
  }
});

test("with our terminal focused the hover says Hide, and a click puts the panel away instead of opening another", async () => {
  resetWorld();
  const k = cluster(() => ({ root: "C:\\work\\win-repo" }));
  try {
    await k.click();
    const [t] = term.list;
    assert.equal(t.name, "GitStudio: win-repo", "a Windows path's last segment");
    on.active.forEach((l) => l());
    assert.match(k.terminal.tooltip ?? "", /^GitStudio: Hide the terminal/);
    await k.click();
    assert.deepEqual(executed, ["workbench.action.terminal.toggleTerminal"]);
    assert.equal(term.list.length, 1);
    assert.equal(t.shown, 1, "not shown again");
  } finally {
    k.c.dispose();
  }
});

test("a host without the terminal toggle falls back to toggling the panel, without an unhandled rejection", async () => {
  resetWorld();
  unknownCommands.add("workbench.action.terminal.toggleTerminal");
  const k = cluster(() => ({ root }));
  try {
    await k.click();
    await k.click();
    await until(() => executed.includes("workbench.action.togglePanel"), "fell back to the panel toggle");
    assert.deepEqual(executed, ["workbench.action.terminal.toggleTerminal", "workbench.action.togglePanel"]);
  } finally {
    k.c.dispose();
  }
});

test("refresh and a repository change repaint; dispose stops listening and unregisters the command", async () => {
  resetWorld();
  let active: { root: string } | undefined = { root };
  const k = cluster(() => active);
  try {
    await until(() => k.terminal.visible, "shown");
    active = undefined;
    k.c.refresh();
    await until(() => !k.terminal.visible, "hidden after refresh");
    active = { root };
    k.change();
    await until(() => k.terminal.visible, "shown after a repository change");
  } finally {
    k.c.dispose();
  }
  assert.ok(!handlers.has("gitstudio.openTerminal"));
  assert.equal(on.open.length + on.close.length + on.active.length + on.config.length, 0, "every listener disposed");
});
