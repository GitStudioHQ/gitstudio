// A stand-in for the `vscode` module with enough WORKING surface to drive the
// pull request feature (src/pr/*) end to end in node: registerPrFeature's
// commands, the Pull Requests tree, the PR panel's webview, the review
// CommentController, the content provider and the window's messages.
//
// Unlike vscodeStub.cjs (a Proxy that answers anything), the members the PR
// code reads are modelled — a TreeItem keeps its description, a comment
// thread keeps its comments, a panel keeps its html and what it was posted —
// so a test can read back exactly what VS Code would have been handed.
// Everything is recorded on `__pr`, which a test resets between cases.
// Anything not modelled still answers harmlessly (the Proxy at the bottom).

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    };
  }
  fire(e) {
    for (const l of [...this.listeners]) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}

class Disposable {
  constructor(onDispose) {
    this.onDispose = onDispose;
  }
  dispose() {
    this.onDispose?.();
  }
  static from(...ds) {
    return new Disposable(() => ds.forEach((d) => d?.dispose?.()));
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}

class Uri {
  constructor(scheme, path, query, fragment, authority) {
    this.scheme = scheme;
    this.authority = authority ?? "";
    this.path = path;
    this.query = query ?? "";
    this.fragment = fragment ?? "";
    this.fsPath = path;
  }
  static from(c) {
    return new Uri(c.scheme, c.path ?? "", c.query, c.fragment, c.authority);
  }
  static parse(s) {
    const u = new URL(s);
    return new Uri(u.protocol.replace(/:$/, ""), u.pathname, u.search.replace(/^\?/, ""), "", u.host);
  }
  static file(p) {
    return new Uri("file", p, "");
  }
  static joinPath(base, ...parts) {
    return new Uri(base?.scheme ?? "file", [base?.path ?? "", ...parts].join("/"), "", "", base?.authority);
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
      change.authority ?? this.authority,
    );
  }
  toString() {
    return `${this.scheme}:${this.authority ? `//${this.authority}` : ""}${this.path}${this.query ? `?${this.query}` : ""}`;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendText(s) {
    this.value += s;
    return this;
  }
}

class CancellationTokenSource {
  constructor() {
    const e = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: e.event };
    this.emitter = e;
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose() {}
}

/** Everything the feature did, for a test to read back. */
const pr = {
  commands: new Map(),
  executed: [],
  contexts: {},
  said: [],
  views: [],
  webviewViews: [],
  panels: [],
  controllers: [],
  statusBars: [],
  shown: [],
  providers: new Map(),
  opened: [],
  clipboard: undefined,
  config: {},
  session: { accessToken: "tok", account: { label: "me", id: "1" }, scopes: ["repo"] },
  /** (kind, message, items) → the item the "user" clicks, or undefined. */
  answer: () => undefined,
  sessionsChanged: new EventEmitter(),
  reset() {
    this.executed.length = 0;
    this.said.length = 0;
    this.opened.length = 0;
    this.shown.length = 0;
    this.statusBars.length = 0;
    this.answer = () => undefined;
  },
};

function makeThread(uri, range, comments) {
  return {
    uri,
    range,
    comments: comments ?? [],
    label: undefined,
    contextValue: undefined,
    collapsibleState: 0,
    canReply: true,
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
}

const say = (kind) => (message, ...items) => {
  pr.said.push({ kind, message, items: items.filter((i) => typeof i === "string") });
  return Promise.resolve(pr.answer(kind, message, items));
};

const window = {
  showErrorMessage: say("error"),
  showWarningMessage: say("warning"),
  showInformationMessage: say("info"),
  setStatusBarMessage: (message) => {
    pr.said.push({ kind: "status", message, items: [] });
    return new Disposable();
  },
  withProgress: async (opts, task) => {
    pr.said.push({ kind: "progress", message: opts.title ?? "", items: [] });
    const src = new CancellationTokenSource();
    try {
      return await task({ report() {} }, src.token);
    } finally {
      pr.said.push({ kind: "progress-end", message: opts.title ?? "", items: [] });
    }
  },
  createTreeView: (id, opts) => {
    const visibility = new EventEmitter();
    const view = {
      id,
      opts,
      title: undefined,
      description: undefined,
      message: undefined,
      visible: true,
      onDidChangeVisibility: visibility.event,
      setVisible(v) {
        this.visible = v;
        visibility.fire({ visible: v });
      },
      reveal: async () => undefined,
      dispose() {},
    };
    pr.views.push(view);
    return view;
  },
  createWebviewPanel: (viewType, title, column, options) => {
    const received = new EventEmitter();
    const disposed = new EventEmitter();
    const panel = {
      viewType,
      title,
      options,
      visible: true,
      reveals: 0,
      htmlWrites: 0,
      posted: [],
      webview: {
        cspSource: "vscode-webview:",
        _html: "",
        get html() {
          return this._html;
        },
        set html(v) {
          this._html = v;
          panel.htmlWrites++;
        },
        asWebviewUri: (u) => u,
        onDidReceiveMessage: received.event,
        postMessage: (m) => {
          panel.posted.push(m);
          return Promise.resolve(true);
        },
      },
      /** A message from the page, as the webview would deliver it. */
      receive: (m) => received.fire(m),
      /** The last state the page was sent. */
      state() {
        const s = [...this.posted].reverse().find((m) => m && m.type === "state");
        return s ? s.state : undefined;
      },
      reveal() {
        panel.reveals++;
      },
      onDidDispose: disposed.event,
      dispose() {
        disposed.fire();
      },
    };
    pr.panels.push(panel);
    return panel;
  },
  /**
   * A sidebar webview view, resolved at once and in sight — as VS Code does
   * when the view is open. `receive(m)` is a message from the page;
   * `posted` is everything the host sent it, `state()` the last state.
   */
  registerWebviewViewProvider: (id, provider) => {
    const received = new EventEmitter();
    const visibility = new EventEmitter();
    const disposed = new EventEmitter();
    const view = {
      id,
      provider,
      title: undefined,
      description: undefined,
      visible: true,
      posted: [],
      htmlWrites: 0,
      webview: {
        cspSource: "vscode-webview:",
        options: undefined,
        _html: "",
        get html() {
          return this._html;
        },
        set html(v) {
          this._html = v;
          view.htmlWrites++;
        },
        asWebviewUri: (u) => u,
        onDidReceiveMessage: received.event,
        postMessage: (m) => {
          view.posted.push(JSON.parse(JSON.stringify(m)));
          return Promise.resolve(true);
        },
      },
      onDidChangeVisibility: visibility.event,
      onDidDispose: disposed.event,
      receive: (m) => received.fire(m),
      setVisible(v) {
        this.visible = v;
        visibility.fire();
      },
      state() {
        const s = [...this.posted].reverse().find((m) => m.type === "state");
        return s ? s.state : undefined;
      },
      dispose() {
        disposed.fire();
      },
    };
    pr.webviewViews.push(view);
    provider.resolveWebviewView(view, {}, new CancellationTokenSource().token);
    return new Disposable();
  },
  state: { focused: true },
  createStatusBarItem: () => {
    const item = {
      text: "",
      tooltip: undefined,
      command: undefined,
      shown: false,
      show() {
        this.shown = true;
      },
      hide() {
        this.shown = false;
      },
      dispose() {
        this.shown = false;
      },
    };
    pr.statusBars.push(item);
    return item;
  },
  showTextDocument: async (uri, options) => {
    pr.shown.push({ uri, options });
    return {};
  },
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: new EventEmitter().event,
};

const api = {
  EventEmitter,
  Disposable,
  Position,
  Range,
  Uri,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  CancellationTokenSource,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window,
  commands: {
    registerCommand: (id, fn) => {
      pr.commands.set(id, fn);
      return new Disposable(() => pr.commands.delete(id));
    },
    executeCommand: async (id, ...args) => {
      pr.executed.push({ id, args });
      if (id === "setContext") {
        pr.contexts[args[0]] = args[1];
        return undefined;
      }
      const fn = pr.commands.get(id);
      return fn ? fn(...args) : undefined;
    },
  },
  comments: {
    createCommentController: (id, label) => {
      const controller = {
        id,
        label,
        commentingRangeProvider: undefined,
        threads: [],
        createCommentThread(uri, range, comments) {
          const t = makeThread(uri, range, comments);
          this.threads.push(t);
          return t;
        },
        dispose() {},
      };
      pr.controllers.push(controller);
      return controller;
    },
  },
  workspace: {
    registerTextDocumentContentProvider: (scheme, provider) => {
      pr.providers.set(scheme, provider);
      return new Disposable(() => pr.providers.delete(scheme));
    },
    getConfiguration: (section) => ({
      get: (key, def) => {
        const v = pr.config[section ? `${section}.${key}` : key];
        return v === undefined ? def : v;
      },
    }),
    workspaceFolders: [],
    onDidChangeConfiguration: new EventEmitter().event,
  },
  authentication: {
    getSession: async () => pr.session,
    onDidChangeSessions: pr.sessionsChanged.event,
  },
  env: {
    openExternal: async (u) => {
      pr.opened.push(String(u));
      return true;
    },
    clipboard: {
      writeText: async (t) => {
        pr.clipboard = t;
      },
    },
  },
  __pr: pr,
  __makeThread: makeThread,
};

/** Any member, callable and constructible, answering more of itself. */
function anything(path) {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, p) {
      if (p === "prototype") return {};
      if (p === Symbol.toPrimitive) return () => path;
      if (p === "then") return undefined;
      return anything(`${path}.${String(p)}`);
    },
    apply: () => anything(`${path}()`),
    construct: () => anything(`new ${path}`),
  });
}

module.exports = new Proxy(api, { get: (t, p) => (p in t ? t[p] : anything(`vscode.${String(p)}`)) });
