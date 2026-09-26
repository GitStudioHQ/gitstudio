import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { withFavorites, type BranchesPayload } from "../src/changes/branchMenuData";

// The Changes view's host side of the branch menu — the real
// CommitViewProvider, with `vscode` swapped for a stand-in, over a real
// repository — for what the menu is SENT:
//   · a star: the host answers it with a state post, and the first (instant)
//     one re-sends the list it built before the star. That post carried the
//     old star, so the row the menu had already moved went back. Every post
//     after the star now carries it;
//   · a failed branch action is named by what the user did ("Pull into
//     'merged-pr'"), not by the message's action id ("pullFf").

const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-bmh-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

/** What the user was told. */
const said: { kind: string; text: string }[] = [];
/** A stand-in for any part of the vscode API this path touches but the test does not look at. */
function inert(): unknown {
  const fn = function () {
    return inert();
  };
  return new Proxy(fn, {
    get: (_t, k) => (k === "dispose" ? () => {} : k === "then" ? undefined : inert()),
    apply: () => inert(),
    construct: () => inert() as object,
  });
}
const vscodeStub = new Proxy(
  {
    window: new Proxy(
      {
        showErrorMessage: async (text: string) => {
          said.push({ kind: "error", text });
          return undefined;
        },
        showWarningMessage: async (text: string) => {
          said.push({ kind: "warning", text });
          return undefined;
        },
        showInformationMessage: async (text: string) => {
          said.push({ kind: "info", text });
          return undefined;
        },
        setStatusBarMessage: (text: string) => {
          said.push({ kind: "status", text });
          return { dispose() {} };
        },
      } as Record<string | symbol, unknown>,
      { get: (t, k) => (k in t ? t[k] : inert()) },
    ),
    workspace: new Proxy(
      { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) } as Record<string | symbol, unknown>,
      { get: (t, k) => (k in t ? t[k] : inert()) },
    ),
    Disposable: class {
      constructor(private readonly fn: () => void) {}
      dispose(): void {
        this.fn();
      }
    },
  } as Record<string | symbol, unknown>,
  { get: (t, k) => (k in t ? t[k] : k === "__esModule" ? false : inert()) },
);

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
type Loader = (m: { exports: unknown }, filename: string) => void;
const M = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown>; _extensions: Record<string, Loader> };
const STUB = join(tmpdir(), "__gs_bmh_vscode_stub__.js");
const origResolve = M._resolveFilename;

/* eslint-disable @typescript-eslint/no-explicit-any */
let CommitViewProvider: any;

let up: string;
let repo: string;
let ctx: GitContext;
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  M._cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: vscodeStub };
  M._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
    if (request === "vscode") return STUB;
    return origResolve.call(this, request, parent, ...rest);
  };
  // The view embeds tokens.css as text (esbuild's text loader does it in the build).
  M._extensions[".css"] = (m, filename) => {
    m.exports = { __esModule: true, default: readFileSync(filename, "utf8") };
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ CommitViewProvider } = require("../src/changes/commitView"));

  // main and topic, both pushed; merged-pr pushed, then deleted on the remote.
  up = mkdtempSync(join(tmpdir(), "gs-ext-bmh-up-"));
  git(up, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "gs-ext-bmh-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "gc.auto", "0");
  git(repo, "remote", "add", "origin", up);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  for (const b of ["main", "topic", "merged-pr"]) {
    if (b !== "main") git(repo, "branch", b);
    git(repo, "push", "-q", "-u", "origin", `refs/heads/${b}:refs/heads/${b}`);
  }
  git(repo, "push", "-q", "origin", "--delete", "refs/heads/merged-pr");
  git(repo, "fetch", "-q", "--prune", "origin");
  ctx = new GitContext({ root: repo });
});

after(() => {
  M._resolveFilename = origResolve;
  delete M._cache[STUB];
  delete M._extensions[".css"];
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(up, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The provider over the test repository, with a view that records what it is posted. */
function provider(): { p: any; posts: any[] } {
  const store = new Map<string, unknown>();
  const memento = {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => {
      store.set(k, v);
    },
    keys: () => [...store.keys()],
  };
  const entry = { root: repo, ctx, repo: undefined };
  const repos = {
    getActive: () => entry,
    getAll: () => [entry],
    onDidChange: () => ({ dispose() {} }),
  };
  const p = new CommitViewProvider(inert(), inert(), repos, () => {}, memento);
  const posts: any[] = [];
  p.view = { webview: { postMessage: async (m: unknown) => posts.push(m) }, visible: true };
  return { p, posts };
}
const starOf = (post: any, name: string): boolean | undefined =>
  post.branches?.local.find((b: { name: string }) => b.name === name)?.favorite;
/* eslint-enable @typescript-eslint/no-explicit-any */

test("withFavorites: each star as the favorites have it, the same object when none differs", () => {
  const payload: BranchesPayload = {
    local: [
      { name: "main", current: true, favorite: false },
      { name: "topic", current: false, favorite: true, upstream: "origin/topic" },
    ],
    remote: ["origin/main"],
    recent: [],
    tags: [],
  };
  assert.equal(withFavorites(payload, ["topic"]), payload, "nothing to change: the same object");
  const flipped = withFavorites(payload, ["main"]);
  assert.deepEqual(flipped.local.map((b) => [b.name, b.favorite]), [["main", true], ["topic", false]]);
  assert.deepEqual(Object.keys(flipped.local[1]), Object.keys(payload.local[1]), "the same fields, in the same order");
  assert.equal(payload.local[0].favorite, false, "the list it was given is left as it was");
  assert.equal(flipped.remote, payload.remote);
});

test("every post after a star carries it, the instant first one too", async () => {
  const { p, posts } = provider();
  await p.pushState(); // the list the host holds: nothing starred
  assert.equal(starOf(posts[posts.length - 1], "topic"), false);
  posts.length = 0;

  await p.handleBranchAction({ type: "branchAction", action: "favorite", ref: "topic" });
  const states = posts.filter((m) => m.type === "state");
  assert.ok(states.length >= 1, "the star is answered with a state post");
  assert.deepEqual(states.map((m) => starOf(m, "topic")), states.map(() => true), "starred in every post, the first included");
  assert.equal(states.length, 1, "and the instant post already agrees, so no second post follows");

  posts.length = 0;
  await p.handleBranchAction({ type: "branchAction", action: "favorite", ref: "topic" });
  const again = posts.filter((m) => m.type === "state");
  assert.deepEqual(again.map((m) => starOf(m, "topic")), again.map(() => false), "un-starred the same way");
});

test("a failed branch action is named by what the user did, not by its action id", async () => {
  const { p } = provider();
  said.length = 0;
  await p.handleBranchAction({ type: "branchAction", action: "pullFf", ref: "merged-pr" });
  const errors = said.filter((s) => s.kind === "error");
  assert.equal(errors.length, 1, JSON.stringify(said));
  assert.match(errors[0].text, /^GitStudio: Pull into 'merged-pr' failed/);
  assert.doesNotMatch(errors[0].text, /pullFf/);
});
