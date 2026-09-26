// The Changes view's HOST half (CommitViewProvider), loaded for real under the
// vscode stand-in and driven by the messages its webview posts — against a real
// git repository. Not a test itself.
//
// The page half is rendered in a browser by changesPage.ts; this is the other
// side of the same wire: what a message makes the host ASK (the dialog host is
// the test's), what it runs in git, what it posts back to the page, and what
// it tells the user (vscodeStub.cjs records every toast in __said).

import Module from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
// commitView.ts imports the shared tokens.css as text (esbuild's "text" loader).
const loaders = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions;
loaders[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
export const vscode = require("vscode") as { __said: { kind: string; message: string }[] };
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { CommitViewProvider } = require("../src/changes/commitView") as typeof import("../src/changes/commitView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

// Hermetic git: an empty global config, no system one.
const cfg = join(mkdtempSync(join(tmpdir(), "gs-ext-changes-host-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

/** Every question the host asked, and the scripted answer it got. */
export const asked: DialogSpec[] = [];
let answer: (spec: DialogSpec) => string | undefined = () => "ok";
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const value = answer(spec);
    return value === undefined ? undefined : { value };
  },
});

/** How the next questions are answered ("ok" confirms; undefined dismisses). */
export function answerWith(fn: (spec: DialogSpec) => string | undefined): void {
  answer = fn;
}

/** A throwaway repository; `git` runs in it. */
export function scratchRepo(prefix: string): { dir: string; git: (...a: string[]) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `gs-ext-${prefix}-`));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

type Provider = InstanceType<typeof CommitViewProvider>;

/** The host, over `root`, with a view whose posts are recorded. */
export function changesHost(root: string): {
  provider: Provider;
  posted: Record<string, unknown>[];
  /** Deliver a message as the page would. */
  send: (msg: Record<string, unknown>) => Promise<void>;
  /** Resolves once no state push is running or queued. */
  idle: () => Promise<void>;
  dispose: () => void;
} {
  const ctx = new GitContext({ root });
  const entry = { root, ctx, repo: undefined };
  const noop = { dispose() {} };
  const repos = {
    onDidChange: () => noop,
    getActive: () => entry,
    getAll: () => [entry],
    getUndoLedger: () => undefined,
  };
  const memento = { get: () => undefined, update: async () => {} };
  const provider = new CommitViewProvider(
    {} as never,
    {} as never,
    repos as never,
    () => {},
    memento as never,
  );
  const posted: Record<string, unknown>[] = [];
  const view = {
    visible: true,
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
    onDidChangeVisibility: () => noop,
    onDidDispose: () => noop,
  };
  provider.resolveWebviewView(view as never);
  const onMessage = (provider as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage.bind(provider);
  return {
    provider,
    posted,
    send: (msg) => onMessage(msg),
    idle: async () => {
      const p = provider as unknown as { pushing: boolean; pushQueued: boolean };
      for (let i = 0; i < 200 && (p.pushing || p.pushQueued); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    dispose: () => {
      provider.dispose();
      ctx.dispose();
    },
  };
}
