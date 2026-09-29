// The Changes view's host (CommitViewProvider) under the vscode stand-in, with
// the parts changesHost.ts leaves out wired to recorders a test can read: the
// commands it runs, the settings it reads and writes, its memento, an optional
// AI generator, the merge experience's hooks, an Undo ledger, and a
// vscode.git Repository whose state the test sets. Not a test itself.
//
// Loads changesHost.ts first, which puts the stand-in in place and answers the
// view's own dialogs (answerWith / asked).

import { answerWith, asked, scratchRepo, vscode } from "./changesHost";
import type { RepoEntry } from "../src/git/repoManager";

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { CommitViewProvider } = require("../src/changes/commitView") as typeof import("../src/changes/commitView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

export { answerWith, asked, scratchRepo };

type AnyFn = (...a: unknown[]) => unknown;
/** The stand-in, loosely typed: the members a test replaces or reads. */
export const vs = vscode as unknown as {
  __said: { kind: string; message: string }[];
  commands: { executeCommand: AnyFn; getCommands?: AnyFn };
  workspace: Record<string, unknown>;
  window: Record<string, unknown>;
  env: Record<string, unknown>;
  Uri: Record<string, unknown>;
};

/** Every command the host ran, with its arguments. */
export const commandsRun: { id: string; args: unknown[] }[] = [];
/** What a command answers (by id); anything else answers undefined. */
export const commandAnswers = new Map<string, (...args: unknown[]) => unknown>();
vs.commands.executeCommand = async (id: unknown, ...args: unknown[]) => {
  commandsRun.push({ id: String(id), args });
  const answer = commandAnswers.get(String(id));
  return answer ? answer(...args) : undefined;
};
vs.commands.getCommands = async () => [...commandAnswers.keys()];

/** Settings the host reads (section.key → value); unset keys give the default. */
export const settings = new Map<string, unknown>();
/** Every settings write: section, key, value. */
export const settingsWritten: { section: string; key: string; value: unknown }[] = [];
vs.workspace.getConfiguration = (section?: string) => ({
  get: (key: string, fallback?: unknown) => {
    const full = section ? `${section}.${key}` : key;
    return settings.has(full) ? settings.get(full) : fallback;
  },
  update: async (key: string, value: unknown) => {
    settingsWritten.push({ section: section ?? "", key, value });
  },
});

/** The clipboard's last write. */
export const clipboard: { text?: string } = {};
vs.env.clipboard = {
  writeText: async (t: string) => {
    clipboard.text = t;
  },
};

/** Files the host opened in an editor (showTextDocument). */
export const opened: unknown[] = [];
vs.window.showTextDocument = async (uri: unknown) => {
  opened.push(uri);
  return undefined;
};

/** The window and workspace events the host subscribed to (the latest host's). */
export const events: {
  save?: (doc: { uri: { scheme: string; fsPath: string } }) => void;
  focus?: (state: { focused: boolean }) => void;
  config?: (e: { affectsConfiguration: (key: string) => boolean }) => void;
} = {};
vs.workspace.onDidSaveTextDocument = (cb: typeof events.save) => {
  events.save = cb;
  return { dispose() {} };
};
vs.workspace.onDidChangeConfiguration = (cb: typeof events.config) => {
  events.config = cb;
  return { dispose() {} };
};
vs.window.onDidChangeWindowState = (cb: typeof events.focus) => {
  events.focus = cb;
  return { dispose() {} };
};

/** A Uri as the host builds and reads them: scheme, path, query, fsPath. */
export type U = { scheme: string; path: string; query: string; fsPath: string };
/**
 * Real-enough Uris (file, from, joinPath) and a workspace.fs over the disk, for
 * the doors that read a file or build a diff's sides. Opt-in: the stand-in's
 * own Uri answers anything and names nothing.
 */
export function installUris(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const path = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const uri = (c: { scheme: string; path: string; query?: string }): U => ({
    scheme: c.scheme,
    path: c.path,
    query: c.query ?? "",
    fsPath: c.path,
  });
  Object.assign(vs.Uri, {
    from: uri,
    file: (p: string) => uri({ scheme: "file", path: p }),
    joinPath: (base: U, ...segs: string[]) => uri({ scheme: "file", path: path.join(base.fsPath ?? "/", ...segs) }),
  });
  vs.workspace.fs = {
    stat: async (u: U) => {
      if (!fs.existsSync(u.fsPath)) throw new Error("ENOENT");
      return {};
    },
    readFile: async (u: U) => new Uint8Array(fs.readFileSync(u.fsPath)),
  };
}

/** The warnings and errors said so far, as their messages. */
export const said = (kind: string): string[] => vs.__said.filter((s) => s.kind === kind).map((s) => s.message);

/** Forget everything recorded so far. */
export function resetRecorders(): void {
  vs.__said.length = 0;
  commandsRun.length = 0;
  settingsWritten.length = 0;
  asked.length = 0;
  opened.length = 0;
  delete clipboard.text;
}

/** vscode.git's numeric Status values the host maps to letters. */
export const Status = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  MODIFIED: 5,
  UNTRACKED: 7,
  BOTH_MODIFIED: 16,
} as const;

/** A vscode.git Change for `rel` under `root`. */
export function change(root: string, rel: string, status: number): { uri: { fsPath: string; scheme: string }; status: number } {
  const fsPath = require("node:path").join(root, ...rel.split("/")) as string; // eslint-disable-line @typescript-eslint/no-require-imports
  return { uri: { fsPath, scheme: "file" }, status };
}

export interface FakeGitRepoState {
  HEAD?: { name?: string; commit?: string; upstream?: { remote: string; name: string }; ahead?: number; behind?: number };
  indexChanges: unknown[];
  workingTreeChanges: unknown[];
  mergeChanges: unknown[];
  untrackedChanges?: unknown[];
}

export interface HostOptions {
  generator?: { isEnabled(): Promise<boolean>; draft(entry: RepoEntry): Promise<string | null> };
  merge?: {
    openConflict(uri: unknown): Promise<void>;
    showConflicts(root: string): Promise<void>;
    operationVerb(verb: "continue" | "skip" | "abort", root: string): Promise<void>;
  };
  ledger?: { runWithUndo<T>(repo: RepoEntry, label: string, fn: () => Promise<T>): Promise<T> };
  /** A vscode.git Repository: its state, and a status() that counts its calls. */
  gitRepo?: { state: FakeGitRepoState; status?: () => Promise<void> };
  /** More repositories besides the active one (for repoCount / repoPath). */
  others?: string[];
  /** No active repository at all. */
  noRepo?: boolean;
}

type Provider = InstanceType<typeof CommitViewProvider>;

export interface Host {
  provider: Provider;
  entry: RepoEntry | undefined;
  posted: Record<string, unknown>[];
  memento: Map<string, unknown>;
  committed: { count: number };
  view: { badge?: { value: number; tooltip: string }; visible: boolean };
  /** Show or hide the view, as VS Code does (fires its visibility event). */
  setVisible: (visible: boolean) => void;
  /** VS Code disposed the view. */
  disposeView: () => void;
  send: (msg: Record<string, unknown>) => Promise<void>;
  idle: () => Promise<void>;
  /** The last message posted of `type`. */
  last: (type: string) => Record<string, unknown> | undefined;
  /** Every message posted of `type`. */
  all: (type: string) => Record<string, unknown>[];
  dispose: () => void;
}

/** The host over `root`, with a view whose posts are recorded. */
export function covHost(root: string, opts: HostOptions = {}): Host {
  const ctx = new GitContext({ root });
  const entry = opts.noRepo
    ? undefined
    : ({ root, ctx, repo: opts.gitRepo as unknown } as unknown as RepoEntry);
  const others = (opts.others ?? []).map((r) => ({ root: r, ctx }) as unknown as RepoEntry);
  const noop = { dispose() {} };
  const repos = {
    onDidChange: () => noop,
    getActive: () => entry,
    getAll: () => (entry ? [entry, ...others] : others),
    getUndoLedger: () => opts.ledger,
    isDiscovering: () => false,
  };
  const memento = new Map<string, unknown>();
  const mem = {
    get: (k: string, d?: unknown) => (memento.has(k) ? memento.get(k) : d),
    update: async (k: string, v: unknown) => {
      memento.set(k, v);
    },
  };
  const committed = { count: 0 };
  const provider = new CommitViewProvider(
    {} as never,
    {} as never,
    repos as never,
    () => {
      committed.count++;
    },
    mem as never,
    opts.generator as never,
    opts.merge as never,
  );
  const posted: Record<string, unknown>[] = [];
  const view = {
    visible: true,
    badge: undefined as { value: number; tooltip: string } | undefined,
    webview: {
      options: {},
      html: "",
      cspSource: "",
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: () => noop,
      postMessage: async (m: Record<string, unknown>) => {
        posted.push(m);
        return true;
      },
    },
    onDidChangeVisibility: (cb: () => void) => {
      visibility = cb;
      return noop;
    },
    onDidDispose: (cb: () => void) => {
      disposed = cb;
      return noop;
    },
  };
  let visibility: () => void = () => {};
  let disposed: () => void = () => {};
  provider.resolveWebviewView(view as never);
  const onMessage = (provider as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage.bind(provider);
  const idle = async () => {
    const p = provider as unknown as { pushing: boolean; pushQueued: boolean };
    const deadline = Date.now() + 30_000;
    while (p.pushing || p.pushQueued) {
      if (Date.now() > deadline) throw new Error("covHost: still pushing state after 30 s");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    provider,
    entry,
    posted,
    memento,
    committed,
    view,
    setVisible: (visible) => {
      view.visible = visible;
      visibility();
    },
    disposeView: () => disposed(),
    send: async (msg) => {
      await onMessage(msg);
      await idle();
    },
    idle,
    last: (type) => [...posted].reverse().find((m) => m.type === type),
    all: (type) => posted.filter((m) => m.type === type),
    dispose: () => {
      provider.dispose();
      ctx.dispose();
    },
  };
}

/** A repository with one commit (a.txt, b.txt), on main. */
export function committedRepo(prefix: string): ReturnType<typeof scratchRepo> & { write: (rel: string, text: string) => void } {
  const repo = scratchRepo(prefix);
  const fs = require("node:fs") as typeof import("node:fs"); // eslint-disable-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path"); // eslint-disable-line @typescript-eslint/no-require-imports
  const write = (rel: string, text: string) => {
    const file = path.join(repo.dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("a.txt", "a\n");
  write("b.txt", "b\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  return { ...repo, write };
}

/** A bare repository to push to, and `repo` cloned-style tracking it on main. */
export function withRemote(repo: ReturnType<typeof scratchRepo>): { bare: string; done: () => void } {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const cp = require("node:child_process") as typeof import("node:child_process");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ext-cov-bare-"));
  cp.execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
  repo.git("remote", "add", "origin", bare);
  repo.git("push", "-q", "-u", "origin", "main");
  const done = () => {
    try {
      fs.rmSync(bare, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* the system's temp cleanup takes it */
    }
  };
  return { bare, done };
}
