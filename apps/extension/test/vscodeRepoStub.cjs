// A stand-in for the `vscode` module that is real enough to run RepoManager:
// working events, an active editor a test can move, context keys it can read,
// and a vscode.git API whose repositories a test opens and closes. Everything
// else falls through to vscodeStub.cjs's harmless answers.
//
// builtInGit.ts caches the git API handle for the life of the module, so the
// fake API is ONE object whose insides each test resets (see __test.reset).

const base = require("./vscodeStub.cjs");

class Disposable {
  constructor(onDispose) {
    this.onDispose = onDispose;
  }
  dispose() {
    this.onDispose?.();
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }
  fire(value) {
    for (const l of [...this.listeners]) l(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

const contexts = new Map();
const editorMoved = new EventEmitter();
const current = { editor: undefined, folders: [] };

const git = {
  state: "initialized",
  repositories: [],
  opened: new EventEmitter(),
  closed: new EventEmitter(),
  stateChanged: new EventEmitter(),
};
const gitApi = {
  get state() {
    return git.state;
  },
  onDidChangeState: (l) => git.stateChanged.event(l),
  git: { path: "git" },
  get repositories() {
    return git.repositories.slice();
  },
  onDidOpenRepository: (l) => git.opened.event(l),
  onDidCloseRepository: (l) => git.closed.event(l),
  getRepository: () => null,
};

const Uri = {
  file: (p) => ({ fsPath: p, path: p, scheme: "file", toString: () => `file://${p}` }),
  joinPath: (u, ...parts) => Uri.file([u.fsPath, ...parts].join("/")),
};

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

const watcher = () => ({
  onDidCreate: () => new Disposable(),
  onDidChange: () => new Disposable(),
  onDidDelete: () => new Disposable(),
  dispose() {},
});

const window = new Proxy(
  {
    get activeTextEditor() {
      return current.editor;
    },
    onDidChangeActiveTextEditor: editorMoved.event,
  },
  { get: (t, p) => (p in t ? t[p] : base.window[p]) },
);

const workspace = new Proxy(
  {
    get workspaceFolders() {
      return current.folders.map((f, index) => ({ name: f.name, index, uri: Uri.file(f.fsPath) }));
    },
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    createFileSystemWatcher: watcher,
  },
  { get: (t, p) => (p in t ? t[p] : base.workspace[p]) },
);

const commands = {
  executeCommand: (command, key, value) => {
    if (command === "setContext") contexts.set(key, value);
    return Promise.resolve(undefined);
  },
  registerCommand: () => new Disposable(),
};

const extensions = {
  getExtension: (id) =>
    id === "vscode.git" ? { isActive: true, exports: { enabled: true, getAPI: () => gitApi } } : undefined,
};

/** A vscode.git Repository, as much of one as RepoManager and the picker read. */
function repository(root, head = { name: "main" }, changes = {}) {
  const change = (p) => ({ uri: Uri.file(p) });
  return {
    rootUri: Uri.file(root),
    state: {
      HEAD: head,
      mergeChanges: (changes.merge ?? []).map(change),
      indexChanges: (changes.staged ?? []).map(change),
      workingTreeChanges: (changes.unstaged ?? []).map(change),
      untrackedChanges: (changes.untracked ?? []).map(change),
      onDidChange: new EventEmitter().event,
    },
    show: async () => "",
    add: async () => undefined,
  };
}

const __test = {
  contexts,
  repository,
  /** Focus an editor on this file (undefined: no editor). */
  openEditor(fsPath) {
    current.editor = fsPath ? { document: { uri: Uri.file(fsPath) } } : undefined;
    editorMoved.fire(current.editor);
  },
  setFolders(folders) {
    current.folders = folders;
  },
  /** vscode.git found a repository. */
  gitOpen(repo) {
    git.repositories.push(repo);
    git.opened.fire(repo);
  },
  /** vscode.git closed one (deleted, or its folder left the workspace). */
  gitClose(root) {
    const i = git.repositories.findIndex((r) => r.rootUri.fsPath === root);
    const [repo] = git.repositories.splice(i, 1);
    git.closed.fire(repo);
  },
  /** vscode.git finished its initial scan. */
  gitSettle() {
    git.state = "initialized";
    git.stateChanged.fire("initialized");
  },
  /** A fresh window: no editor, no folders, these repositories known to vscode.git. */
  reset({ repositories = [], state = "initialized" } = {}) {
    current.editor = undefined;
    current.folders = [];
    contexts.clear();
    git.repositories = [...repositories];
    git.state = state;
  },
};

// Own properties: a namespace import copies own keys and never asks the Proxy.
const target = {};
for (const key of Object.getOwnPropertyNames(base)) target[key] = base[key];
Object.assign(target, {
  Disposable,
  EventEmitter,
  Uri,
  RelativePattern,
  window,
  workspace,
  commands,
  extensions,
  __test,
});

module.exports = new Proxy(target, { get: (t, p) => (p in t ? t[p] : base[p]) });
