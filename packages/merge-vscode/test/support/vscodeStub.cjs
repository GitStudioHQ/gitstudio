// A small stand-in for the `vscode` module, so this package's HOST modules
// (conflictsPanel, vscodeGitLocator, …) can run under plain node in a test.
// It implements only what those modules touch, and records what they do on
// `stub` (exported as `__stub`) for the test to read: panels created and
// disposed, messages posted, tabs closed, documents saved, watchers made.
//
// Loaded only by test files that ask for it (support/useVscodeStub.ts); the
// guard test that proves the pure modules are vscode-free runs in its own
// process without it.
"use strict";

const posix = require("node:path").posix;

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    const fn = this._fn;
    this._fn = undefined;
    if (fn) fn();
  }
  static from(...items) {
    return new Disposable(() => {
      for (const d of items) d && d.dispose && d.dispose();
    });
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(value) {
    for (const l of [...this._listeners]) l(value);
  }
  dispose() {
    this._listeners.clear();
  }
}

class Uri {
  constructor(scheme, path) {
    this.scheme = scheme;
    this.path = path;
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
  }
  static file(p) {
    return new Uri("file", String(p).replace(/\\/g, "/"));
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, posix.join(base.path, ...parts));
  }
  static parse(s) {
    const m = /^([a-z][\w+.-]*):\/\/(.*)$/i.exec(s);
    return m ? new Uri(m[1], m[2]) : new Uri("file", s);
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, text) {
    this.edits.push({ uri, range, text });
  }
  set(uri, edits) {
    for (const e of edits) this.edits.push({ uri, ...e });
  }
}
const EndOfLine = { LF: 1, CRLF: 2 };
class TextEdit {
  static replace(range, newText) {
    const e = new TextEdit();
    e.range = range;
    e.text = newText;
    return e;
  }
  static setEndOfLine(eol) {
    const e = new TextEdit();
    e.newEol = eol;
    return e;
  }
}

const stub = {
  panels: [],
  messages: [],
  statusMessages: [],
  commands: [],
  registered: new Map(),
  opened: [],
  watchers: [],
  closedTabs: [],
  config: {},
  extensions: {},
  /** Answer a toast: (kind, message, actions) => chosen action | undefined. */
  answer: undefined,
  /** Called by tabGroups.close with the tabs, before they go. */
  onCloseTabs: undefined,
  tabGroupsAll: [],
  onDidChangeTabs: new EventEmitter(),
  onDidChangeActiveTextEditor: new EventEmitter(),
  onDidChangeConfiguration: new EventEmitter(),
  onDidChangeTextDocument: new EventEmitter(),
  /** Every WorkspaceEdit handed to workspace.applyEdit, in order. */
  applied: [],
  reset() {
    this.applied.length = 0;
    this.panels.length = 0;
    this.messages.length = 0;
    this.statusMessages.length = 0;
    this.commands.length = 0;
    this.registered.clear();
    this.opened.length = 0;
    this.watchers.length = 0;
    this.closedTabs.length = 0;
    this.config = {};
    this.extensions = {};
    this.answer = undefined;
    this.onCloseTabs = undefined;
    this.tabGroupsAll = [];
    workspace.textDocuments = [];
    window.activeTextEditor = undefined;
  },
};

function toast(kind) {
  return (message, ...actions) => {
    const items = actions.filter((a) => typeof a === "string");
    stub.messages.push({ kind, message, actions: items });
    return Promise.resolve(stub.answer ? stub.answer(kind, message, items) : undefined);
  };
}

function createWebviewPanel(viewType, title, showOptions, options) {
  const onDispose = new EventEmitter();
  let receive;
  const panel = {
    viewType,
    title,
    showOptions,
    options,
    posted: [],
    revealed: [],
    disposed: false,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview-resource:",
      asWebviewUri: (u) => u,
      postMessage: (m) => {
        panel.posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (l) => {
        receive = l;
        return new Disposable(() => {
          receive = undefined;
        });
      },
    },
    reveal: (...args) => {
      panel.revealed.push(args);
    },
    /** Also what VS Code does when the user closes the tab (its ✕). */
    dispose: () => {
      if (panel.disposed) return;
      panel.disposed = true;
      onDispose.fire();
    },
    onDidDispose: (l) => onDispose.event(l),
    /** The page posting a message to the host. */
    receive: (m) => receive && receive(m),
  };
  stub.panels.push(panel);
  return panel;
}

const window = {
  activeTextEditor: undefined,
  createWebviewPanel,
  showInformationMessage: toast("info"),
  showWarningMessage: toast("warn"),
  showErrorMessage: toast("error"),
  setStatusBarMessage: (m) => {
    stub.statusMessages.push(m);
    return new Disposable();
  },
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    name: "",
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose() {},
  }),
  tabGroups: {
    get all() {
      return stub.tabGroupsAll;
    },
    close: async (tabs) => {
      const list = Array.isArray(tabs) ? tabs : [tabs];
      if (stub.onCloseTabs) await stub.onCloseTabs(list);
      stub.closedTabs.push(...list);
      for (const g of stub.tabGroupsAll) g.tabs = g.tabs.filter((t) => !list.includes(t));
      return true;
    },
    onDidChangeTabs: stub.onDidChangeTabs.event,
  },
  onDidChangeActiveTextEditor: stub.onDidChangeActiveTextEditor.event,
  registerCustomEditorProvider: () => new Disposable(),
  registerWebviewPanelSerializer: () => new Disposable(),
};

const workspace = {
  textDocuments: [],
  getConfiguration: (section) => ({
    get: (key, dflt) => {
      const full = section ? `${section}.${key}` : key;
      return full in stub.config ? stub.config[full] : dflt;
    },
    update: async (key, value) => {
      const full = section ? `${section}.${key}` : key;
      if (value === undefined) delete stub.config[full];
      else stub.config[full] = value;
    },
    // Every stored value is a USER (global) value in this stand-in.
    inspect: (key) => {
      const full = section ? `${section}.${key}` : key;
      return { key: full, globalValue: stub.config[full] };
    },
  }),
  onDidChangeConfiguration: stub.onDidChangeConfiguration.event,
  onDidChangeTextDocument: stub.onDidChangeTextDocument.event,
  createFileSystemWatcher: (pattern) => {
    const w = {
      pattern,
      disposed: false,
      onDidCreate: () => new Disposable(),
      onDidChange: () => new Disposable(),
      onDidDelete: () => new Disposable(),
      dispose() {
        w.disposed = true;
      },
    };
    stub.watchers.push(w);
    return w;
  },
  applyEdit: async (edit) => {
    stub.applied.push(edit);
    return true;
  },
  openTextDocument: async (uri) => {
    const doc = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!doc) throw new Error(`no document for ${uri}`);
    return doc;
  },
  fs: {
    readFile: async () => new Uint8Array(),
  },
};

module.exports = {
  __stub: stub,
  Disposable,
  EventEmitter,
  Uri,
  ThemeColor,
  RelativePattern,
  Position,
  Range,
  WorkspaceEdit,
  TextEdit,
  EndOfLine,
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window,
  workspace,
  commands: {
    executeCommand: async (id, ...args) => {
      stub.commands.push([id, ...args]);
      return undefined;
    },
    registerCommand: (id, fn) => {
      stub.registered.set(id, fn);
      return new Disposable(() => stub.registered.delete(id));
    },
  },
  env: {
    openExternal: async (uri) => {
      stub.opened.push(uri.toString());
      return true;
    },
  },
  extensions: {
    getExtension: (id) => stub.extensions[id],
  },
};
