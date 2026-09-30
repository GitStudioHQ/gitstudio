// A scripted `vscode` and ui/dialogs for tests that drive the REAL graph host
// (graphPanel.ts), its commit actions and the blame controller against real
// temporary repositories.
//
// Importing this module installs the stand-ins (the runner gives every test
// file its own process, so they never leak into another file). Everything a
// door tells the user, every command it runs, what it copies and what it
// opens is RECORDED here, so a test reads exactly what happened; the dialogs
// answer from a script the test sets. Members nobody here models fall through
// to vscodeStub.cjs's harmless answers.

import Module from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

// ── What the user was told / what ran ────────────────────────────────────────

export interface Said {
  kind: "info" | "warning" | "error" | "status";
  text: string;
  items: string[];
}
export const said: Said[] = [];
export const ran: { command: string; args: unknown[] }[] = [];
export const opened: string[] = [];
export const clip = { text: "" };
/** How a notification with buttons is answered: the label to "click", or undefined. */
export const notifyAnswer: { fn: (s: Said) => string | undefined } = { fn: () => undefined };

// ── Dialogs ──────────────────────────────────────────────────────────────────

export interface Asked {
  kind: "confirm" | "pick" | "input";
  title: string;
  text: string;
  choices?: { id: string; label: string }[];
  value?: string;
}
export const asked: Asked[] = [];
export const dialog: {
  confirm: boolean;
  pick?: string | ((a: Asked) => string | undefined);
  input?: string | ((a: Asked) => string | undefined);
} = { confirm: true };

const dialogsStub = {
  promptConfirm: async (spec: { title: string; message: string }) => {
    asked.push({ kind: "confirm", title: spec.title, text: spec.message });
    return dialog.confirm;
  },
  promptPick: async (spec: { title: string; hint?: string; choices: { id: string; label: string }[] }) => {
    const a: Asked = { kind: "pick", title: spec.title, text: spec.hint ?? "", choices: spec.choices };
    asked.push(a);
    return typeof dialog.pick === "function" ? dialog.pick(a) : dialog.pick;
  },
  promptInput: async (spec: { title: string; hint?: string; value?: string }) => {
    const a: Asked = { kind: "input", title: spec.title, text: spec.hint ?? "", value: spec.value };
    asked.push(a);
    return typeof dialog.input === "function" ? dialog.input(a) : dialog.input;
  },
  promptPickMany: async () => undefined,
  promptChoose: async () => undefined,
  promptAction: async () => undefined,
  questionsAsked: () => asked.length,
  registerDialogHost: () => ({ dispose() {} }),
};

// ── vscode ───────────────────────────────────────────────────────────────────

export class Emitter<T = unknown> {
  private readonly fns = new Set<(v: T) => void>();
  readonly event = (fn: (v: T) => void) => {
    this.fns.add(fn);
    return { dispose: () => this.fns.delete(fn) };
  };
  fire(v: T): void {
    for (const f of [...this.fns]) f(v);
  }
  dispose(): void {
    this.fns.clear();
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c ?? 0, d ?? 0);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}
export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position,
  ) {
    super(anchor, active);
  }
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export class MarkdownString {
  value = "";
  isTrusted: unknown;
  constructor(v?: string, readonly supportThemeIcons?: boolean) {
    this.value = v ?? "";
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}
export class Hover {
  constructor(
    readonly contents: MarkdownString,
    readonly range?: Range,
  ) {}
}
export class CancellationTokenSource {
  private readonly cancelled = new Emitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.cancelled.event,
  };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.cancelled.fire();
  }
  dispose(): void {
    this.cancelled.dispose();
  }
}

type FakeUri = { scheme: string; fsPath: string; path: string; query: string; toString(): string };
const mkUri = (scheme: string, path: string, query = ""): FakeUri => ({
  scheme,
  fsPath: path,
  path,
  query,
  toString: () => `${scheme}://${path}${query ? `?${query}` : ""}`,
});
export const Uri = {
  file: (p: string) => mkUri("file", p),
  parse: (s: string) => ({ ...mkUri(s.split(":")[0], s), toString: () => s }),
  joinPath: (u: FakeUri, ...parts: string[]) => mkUri(u.scheme, [u.fsPath, ...parts].join("/")),
  from: (c: { scheme: string; path: string; query?: string }) => mkUri(c.scheme, c.path, c.query ?? ""),
};

/** Settings, by "section.key". A test sets them; update() writes here too. */
export const settings = new Map<string, unknown>();
export const settingWrites: { key: string; value: unknown }[] = [];
export const configChanged = new Emitter<{ affectsConfiguration(s: string): boolean }>();
/** Keys that `inspect` reports as a default-true, user-unset native blame setting. */
export const inspected = new Map<string, Record<string, unknown>>();

function configuration(section?: string) {
  const full = (k: string) => (section ? `${section}.${k}` : k);
  return {
    get: (k: string, d?: unknown) => (settings.has(full(k)) ? settings.get(full(k)) : d),
    inspect: (k: string) => inspected.get(full(k)) ?? (settings.has(full(k)) ? { globalValue: settings.get(full(k)) } : {}),
    has: (k: string) => settings.has(full(k)),
    update: async (k: string, v: unknown) => {
      settings.set(full(k), v);
      settingWrites.push({ key: full(k), value: v });
      configChanged.fire({ affectsConfiguration: (s: string) => full(k) === s || full(k).startsWith(`${s}.`) });
    },
  };
}

export interface FakePanel {
  viewType: string;
  title: string;
  webview: FakeWebview;
  revealed: number;
  dispose(): void;
  onDidDispose(fn: () => void): { dispose(): void };
  reveal(): void;
}
export const panels: FakePanel[] = [];

/** A webview that records what the host posts, and delivers what the page says. */
export interface FakeWebview {
  html: string;
  options: unknown;
  cspSource: string;
  posted: Record<string, any>[];
  asWebviewUri(u: unknown): unknown;
  onDidReceiveMessage(fn: (m: unknown) => void): { dispose(): void };
  postMessage(m: Record<string, unknown>): Promise<boolean>;
  send(m: Record<string, unknown>): void;
}
export function fakeWebview(): FakeWebview {
  let deliver: (m: unknown) => void = () => {};
  const w: FakeWebview = {
    html: "",
    options: {},
    cspSource: "vscode-resource:",
    posted: [],
    asWebviewUri: (u: any) => ({ toString: () => `webview:${u.fsPath}` }),
    onDidReceiveMessage: (fn) => {
      deliver = fn;
      return { dispose() {} };
    },
    postMessage: async (m) => {
      w.posted.push(m);
      return true;
    },
    send: (m) => deliver(m),
  };
  return w;
}

// Editor side (blame): a test sets the active editor and plays its events.
export const editorEvents = {
  selection: new Emitter<any>(),
  active: new Emitter<any>(),
  visibleRanges: new Emitter<any>(),
  docChanged: new Emitter<any>(),
  docClosed: new Emitter<any>(),
};
export const editors: { active: any; visible: any[] } = { active: undefined, visible: [] };
export const decorationTypes: { id: number; options: unknown; disposed: boolean; dispose(): void }[] = [];
export const statusBars: any[] = [];
export const hoverProviders: any[] = [];
export const registeredCommands = new Map<string, (...a: any[]) => unknown>();
export const openedDocuments: FakeUri[] = [];
export const shownDocuments: unknown[] = [];

let decoSeq = 0;
const base = require("./vscodeStub.cjs");
const windowStub = {
  showWarningMessage: async (text: string, ...items: unknown[]) => note("warning", text, items),
  showErrorMessage: async (text: string, ...items: unknown[]) => note("error", text, items),
  showInformationMessage: async (text: string, ...items: unknown[]) => note("info", text, items),
  setStatusBarMessage: (text: string) => {
    said.push({ kind: "status", text, items: [] });
    return { dispose() {} };
  },
  createWebviewPanel: (viewType: string, title: string) => {
    const disposed = new Emitter<void>();
    const p: FakePanel = {
      viewType,
      title,
      webview: fakeWebview(),
      revealed: 0,
      dispose: () => disposed.fire(),
      onDidDispose: (fn) => disposed.event(fn),
      reveal: () => {
        p.revealed++;
      },
    };
    panels.push(p);
    return p;
  },
  createTextEditorDecorationType: (options: unknown) => {
    const t = {
      id: ++decoSeq,
      options,
      disposed: false,
      dispose() {
        t.disposed = true;
      },
    };
    decorationTypes.push(t);
    return t;
  },
  createStatusBarItem: (id: string) => {
    const s = {
      id,
      text: "",
      tooltip: undefined as unknown,
      visible: false,
      name: "",
      command: "",
      show() {
        s.visible = true;
      },
      hide() {
        s.visible = false;
      },
      dispose() {},
    };
    statusBars.push(s);
    return s;
  },
  get activeTextEditor() {
    return editors.active;
  },
  get visibleTextEditors() {
    return editors.visible;
  },
  onDidChangeTextEditorSelection: editorEvents.selection.event,
  onDidChangeActiveTextEditor: editorEvents.active.event,
  onDidChangeTextEditorVisibleRanges: editorEvents.visibleRanges.event,
  showTextDocument: async (doc: unknown) => {
    shownDocuments.push(doc);
    return undefined;
  },
};
function note(kind: Said["kind"], text: string, items: unknown[]): string | undefined {
  const s: Said = { kind, text, items: items.filter((i): i is string => typeof i === "string") };
  said.push(s);
  return notifyAnswer.fn(s);
}

const stub: Record<string, unknown> = {
  ...base,
  window: windowStub,
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      ran.push({ command, args });
      return undefined;
    },
    registerCommand: (id: string, fn: (...a: any[]) => unknown) => {
      registeredCommands.set(id, fn);
      return { dispose: () => registeredCommands.delete(id) };
    },
  },
  env: {
    clipboard: {
      writeText: async (t: string) => {
        clip.text = t;
      },
    },
    openExternal: async (u: { toString(): string }) => {
      opened.push(u.toString());
      return true;
    },
    isTelemetryEnabled: false,
    appName: "Test",
  },
  workspace: {
    getConfiguration: configuration,
    onDidChangeConfiguration: configChanged.event,
    onDidChangeTextDocument: editorEvents.docChanged.event,
    onDidCloseTextDocument: editorEvents.docClosed.event,
    openTextDocument: async (u: FakeUri) => {
      openedDocuments.push(u);
      return { uri: u };
    },
    textDocuments: [],
    workspaceFolders: [],
  },
  languages: {
    registerHoverProvider: (_sel: unknown, provider: unknown) => {
      hoverProviders.push(provider);
      return { dispose() {} };
    },
  },
  Uri,
  Range,
  Position,
  Selection,
  ThemeColor,
  MarkdownString,
  Hover,
  CancellationTokenSource,
  EventEmitter: Emitter,
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
};
const vscodeStub = new Proxy(stub, { get: (t, p) => (p in t ? t[p as string] : base[p]) });

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as {
  _resolveFilename: Resolve;
  _cache: Record<string, unknown>;
  _extensions: Record<string, (m: { exports: unknown }, f: string) => void>;
};
const STUB_VSCODE = join(tmpdir(), `__gs_graphkit_vscode_${process.pid}__.js`);
const STUB_DIALOGS = join(tmpdir(), `__gs_graphkit_dialogs_${process.pid}__.js`);
M._cache[STUB_VSCODE] = { id: STUB_VSCODE, filename: STUB_VSCODE, loaded: true, exports: vscodeStub };
M._cache[STUB_DIALOGS] = { id: STUB_DIALOGS, filename: STUB_DIALOGS, loaded: true, exports: dialogsStub };
const origResolve = M._resolveFilename;
M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  if (request === "vscode") return STUB_VSCODE;
  const r = origResolve.call(this, request, parent, ...rest);
  return /[\\/]src[\\/]ui[\\/]dialogs\.ts$/.test(r) ? STUB_DIALOGS : r;
};
// comparePanel.ts (imported by graphPanel.ts) imports tokens.css as text.
M._extensions[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};

/** Forget everything recorded, and put the dialogs back to "yes". */
export function resetRecords(): void {
  said.length = 0;
  ran.length = 0;
  opened.length = 0;
  asked.length = 0;
  clip.text = "";
  dialog.confirm = true;
  dialog.pick = undefined;
  dialog.input = undefined;
  notifyAnswer.fn = () => undefined;
}

// ── Real repositories ────────────────────────────────────────────────────────

export interface Repo {
  dir: string;
  git: (...a: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  write: (file: string, body: string) => void;
  ctx: GitContext;
  dispose: () => void;
}

export function mkRepo(opts: { empty?: boolean } = {}): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gs-graphkit-")));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir]);
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "Test Person");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  const write = (file: string, body: string) => writeFileSync(join(dir, file), body);
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    write(file, body);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  void opts;
  const ctx = new GitContext({ root: dir });
  return {
    dir,
    git,
    commit,
    write,
    ctx,
    dispose: () => {
      ctx.dispose();
      removeScratch(dir);
    },
  };
}

/**
 * Remove a scratch repository without ever failing the test that used it. On
 * Windows a git the host started (a graph load, the context's batch reader) can
 * still be exiting when the test ends, and its directory is then EBUSY: retry
 * for a while, then leave the rest to a later sweep instead of throwing — a
 * throw here skipped resetRecords() and every later test read stale records.
 */
export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    const again = setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        /* the OS temp dir is cleaned eventually; a leftover never fails a test */
      }
    }, 2_000);
    again.unref();
  }
}

/** Wait until `check` holds (polling), failing with `what` after a generous cap. */
export async function until<T>(check: () => T | undefined | false, what: string, capMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
