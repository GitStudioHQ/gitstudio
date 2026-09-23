// A stand-in for the `vscode` module, for a test that drives the REAL
// extension doors (inTheWayStateTable.test.ts) — the runner has no VS Code to
// load. Anything the doors touch at load or run time answers something
// harmless; the window's messages are RECORDED in `__said`, so the test can
// read exactly what the user was told, and in what tone.
//
// Deliberately generic (a Proxy that answers any member) rather than a model
// of the API: the doors' behaviour under test is git's and the engine's, and
// what they say. Nothing here decides an outcome.
const said = [];

/** Any member, callable and constructible, answering more of itself. */
function anything(path) {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, p) {
      if (p === "prototype") return {};
      if (p === Symbol.toPrimitive) return () => path;
      if (p === "then") return undefined; // never a thenable: awaiting it must not hang
      return anything(`${path}.${String(p)}`);
    },
    apply: () => anything(`${path}()`),
    construct: () => anything(`new ${path}`),
  });
}

class Disposable {
  constructor(onDispose) {
    this.onDispose = onDispose;
  }
  dispose() {
    this.onDispose?.();
  }
}

const recorded = (kind) => (message) => {
  said.push({ kind, message });
  return Promise.resolve(undefined);
};

const window = new Proxy(
  {
    showErrorMessage: recorded("error"),
    showWarningMessage: recorded("warning"),
    showInformationMessage: recorded("info"),
    setStatusBarMessage: (message) => {
      said.push({ kind: "status", message });
      return new Disposable();
    },
  },
  { get: (t, p) => (p in t ? t[p] : anything(`window.${String(p)}`)) },
);

const api = {
  Disposable,
  window,
  commands: { executeCommand: () => Promise.resolve(undefined) },
  __said: said,
};
// Members read at MODULE LOAD (`class X extends vscode.TreeItem`) must exist as
// own properties: a namespace import copies own keys, and never asks a Proxy.
for (const name of [
  "TreeItem", "TreeItemCollapsibleState", "EventEmitter", "ThemeIcon", "ThemeColor", "Uri", "MarkdownString",
  "Range", "Position", "Selection", "StatusBarAlignment", "ViewColumn", "workspace", "env", "languages",
  "extensions", "ProgressLocation", "CancellationTokenSource", "RelativePattern", "FileType",
  "ConfigurationTarget", "DiagnosticSeverity", "TextEditorRevealType", "OverviewRulerLane",
  "DecorationRangeBehavior", "QuickPickItemKind", "l10n", "scm", "authentication", "tasks", "debug",
  "FileDecoration", "CodeLens", "Hover", "TabInputText", "TabInputTextDiff", "EndOfLine",
]) {
  api[name] = class extends function () {} {};
  Object.setPrototypeOf(api[name], anything(name));
}

module.exports = new Proxy(api, { get: (t, p) => (p in t ? t[p] : anything(`vscode.${String(p)}`)) });
