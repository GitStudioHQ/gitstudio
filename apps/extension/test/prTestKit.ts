// The pull request feature's test bench, shared by prListView.test.ts (the
// Pull Requests list) and prFeature.test.ts (the PR page, the diff panes,
// review): registerPrFeature's REAL list provider, panel, review controller
// and content provider, driven through a vscode stand-in (prVscodeStub.cjs)
// against a fake api.github.com (fakeGitHub.ts) that answers in GitHub's own
// shapes — REST and GraphQL — and counts what each event costs.
//
// Importing this module points `vscode` at the stand-in, so it must be the
// first import of a test file that uses it.

import Module from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";
import { graphqlWorld, installFakeGitHub, rawPull, type FakeGitHub, type FakeRepo, type FakeRequest, type Route } from "./fakeGitHub";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "prVscodeStub.cjs") : resolve.call(this, request, ...rest);
};
// esbuild's text loader, as the real build imports the shared tokens.css.
(Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions[".css"] = (
  m,
  f,
) => {
  m.exports = readFileSync(f, "utf8");
};

// Nothing of the machine's own ~/.ssh/config may decide a test.
export const HOME = mkdtempSync(join(tmpdir(), "gs-pr-home-"));
process.env.HOME = HOME;

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- loaded after the stand-in */
export const vscode = require("vscode") as any;
const { registerPrFeature } = require("../src/pr/prFeature") as typeof import("../src/pr/prFeature");
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
/* eslint-enable @typescript-eslint/no-require-imports */

export const pr = vscode.__pr;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(check: () => boolean | Promise<boolean>, what = "condition", ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── The dialogs: every question recorded, answered by the test ───────────────
export const dialogs: { asked: any[]; answer: (spec: any) => string | undefined } = { asked: [], answer: () => undefined };
registerDialogHost({
  show: async (spec: any) => {
    dialogs.asked.push(spec);
    const v = dialogs.answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});

// ── A repository manager with one active repository ────────────────────────
export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}
/** git, as a repository answers it: `run` gets the argv; default "no" to everything. */
export type GitAnswer = (args: string[]) => { code: number; stdout: string; stderr?: string } | undefined;
export function entryFor(root: string, remotes: Remote[], git?: GitAnswer) {
  return {
    root,
    ctx: {
      root,
      remotes: { list: async () => remotes },
      process: {
        cwd: root,
        run: async (args: string[]) => ({ stderr: "", ...(git?.(args) ?? { code: 1, stdout: "" }) }),
      },
    },
  };
}
export function fakeRepos(remotes: Remote[], root = "/work/app", git?: GitAnswer) {
  const changed = new vscode.EventEmitter();
  let active: any = entryFor(root, remotes, git);
  return {
    onDidChange: changed.event,
    getActive: () => active,
    fire: () => changed.fire(),
    switchTo: (e: any) => {
      active = e;
    },
  };
}
export const ORIGIN: Remote[] = [{ name: "origin", fetchUrl: "git@github.com:acme/app.git", pushUrl: "git@github.com:acme/app.git" }];

/** A workspace memento, as VS Code keeps one. */
export function memento(): { get(k: string): any; update(k: string, v: any): Promise<void>; data: Map<string, any> } {
  const data = new Map<string, any>();
  return { data, get: (k) => data.get(k), update: async (k, v) => void data.set(k, v) };
}

export interface Mounted {
  /** The Pull Requests view, as the stand-in holds it. */
  view: any;
  list: any;
  review: any;
  controller: any;
  dispose(): void;
}
let mounted: { dispose(): void }[] = [];
let fakes: FakeGitHub[] = [];
export function mount(repos: ReturnType<typeof fakeRepos>, workspaceState = memento()): Mounted {
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext"), workspaceState };
  const { list, review } = registerPrFeature(context as any, repos as any, { isEnabled: async () => false } as any);
  const view = pr.webviewViews.at(-1);
  // The page, loaded: it announces itself and the host answers.
  view.receive({ type: "ready" });
  let gone = false;
  const m = {
    view,
    list,
    review,
    controller: pr.controllers.at(-1),
    // Once: a test that closes the feature itself is not closed again after it.
    dispose: () => {
      if (gone) return;
      gone = true;
      context.subscriptions.forEach((d) => d.dispose());
    },
  };
  mounted.push(m);
  return m;
}
export function onTeardown(fn: () => void): void {
  mounted.push({ dispose: fn });
}
export function github(routes: Route[]): FakeGitHub {
  const f = installFakeGitHub(routes);
  fakes.push(f);
  return f;
}
afterEach(() => {
  for (const m of mounted) m.dispose();
  // A PR page outlives nothing: closed with its test, as VS Code closes every
  // webview with the extension. Kept, the next test's page of the same PR was
  // this one — wired to this test's review and API.
  for (const p of pr.panels.splice(0)) p.dispose();
  pr.webviewViews.splice(0);
  for (const f of fakes) f.restore();
  mounted = [];
  fakes = [];
  dialogs.asked = [];
  dialogs.answer = () => undefined;
  pr.reset();
});

// ── The list, as the page is sent it ─────────────────────────────────────────

/** The last state the list was sent. */
export function state(m: Mounted): any {
  return m.view.state();
}
/** The numbers of the rows on screen. */
export function numbers(m: Mounted): number[] {
  return (state(m)?.rows ?? []).map((r: any) => r.number);
}
/** The list has painted rows (or a message). */
export async function settled(m: Mounted, what = "the list to paint"): Promise<any> {
  await until(() => {
    const s = state(m);
    return !!s && (s.status === "message" || (s.status === "list" && !s.refreshing));
  }, what);
  return state(m);
}
/** GraphQL requests whose query matches `re` (the list: /list: pullRequests|list: search/). */
export function gql(gh: FakeGitHub, re: RegExp): FakeRequest[] {
  return gh.requests.filter((r) => r.method === "POST" && r.path === "/graphql" && re.test(String((r.body as any)?.query ?? "")));
}
export const LIST_QUERY = /list: (pullRequests|search)/;

// ── GitHub, as it answers for acme/app ──────────────────────────────────────
export const CI: Record<number, string> = { 37: "FAILURE", 36: "PENDING", 3: "SUCCESS" };
export const PULLS = () => [
  rawPull(37, { title: "Drop Commit", user: { login: "me" } }),
  rawPull(36, { title: "WIP: keyboard", draft: true, updated_at: new Date(Date.now() - 4 * 3600e3).toISOString() }),
  rawPull(3, { title: "Reset to upstream", requested_reviewers: [{ login: "me" }], updated_at: new Date(Date.now() - 5 * 3600e3).toISOString() }),
];
export const FILES_37 = [
  {
    filename: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 3,
    changes: 4,
    patch: "@@ -1,3 +1,4 @@\n one\n+new\n two\n three\n@@ -40,5 +41,2 @@\n a\n-b\n-c\n-d\n e",
  },
  { filename: "docs/gone.md", status: "removed", additions: 0, deletions: 3, changes: 3, patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c" },
  { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 1, deletions: 1, changes: 2, patch: "@@ -1,2 +1,2 @@\n-x\n+y\n z" },
];

/** The repositories the fake GraphQL endpoint knows, acme/app first. */
export function world(extra: Record<string, FakeRepo> = {}): Record<string, FakeRepo> {
  return { "acme/app": { pulls: PULLS, ci: CI }, ...extra };
}

export function acmeRoutes(extra: Route[] = [], repos: Record<string, FakeRepo> = world()): Route[] {
  return [
    ...extra,
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => ({ body: PULLS() })],
    ["GET", /^\/user$/, () => ({ body: { login: "me" } })],
    ["POST", /^\/graphql$/, graphqlWorld(repos)],
    // What the combined-status endpoint answers for EVERY Actions-only repo.
    ["GET", /\/commits\/[^/]+\/status/, () => ({ body: { state: "pending", total_count: 0, statuses: [] } })],
    ["GET", /\/commits\/[^/]+\/check-runs/, () => ({ body: { total_count: 0, check_runs: [] } })],
    ["GET", /^\/repos\/acme\/app\/pulls\/37\/files/, () => ({ body: FILES_37 })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)\/files/, () => ({ body: [] })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)$/, (_r, m) => ({ body: PULLS().find((p) => p.number === Number(m[1])) ?? rawPull(Number(m[1])) })],
  ];
}

// ── A pull request's page ──────────────────────────────────────────────────

/** The page of acme/app#n, as the stand-in holds it (its editor tab). */
export function pagePanel(n: number, repo = "acme/app"): any {
  return pr.panels.find((p: any) => p.title === `${repo}#${n}` && p.viewType === "gitstudio.pullRequest");
}

/** Open #n's page from its row, as the list does; the page loads and says so. */
export async function openPage(m: Mounted, n: number, open: Record<string, unknown> = {}): Promise<any> {
  const row = await rowArg(m, n);
  await vscode.commands.executeCommand(open.merge ? "gitstudio.pr.merge" : "gitstudio.pr.openDescription", row);
  const page = pagePanel(n);
  if (!page) throw new Error(`no page for #${n}`);
  if (!page.ready) {
    page.receive({ type: "ready" });
    page.ready = true;
  }
  await until(() => page.state()?.status === "ready" || page.state()?.status === "message", `#${n}'s page to load`);
  await until(() => !page.state()?.refreshing, `#${n}'s page to settle`);
  return page;
}

/** The last state a page was sent. */
export function pageState(page: any): any {
  return page.state();
}

/** A row of the list, as the PR commands take it: `{ pr, ctx }`. */
export async function rowArg(m: Mounted, n: number): Promise<any> {
  await until(() => numbers(m).includes(n), `row #${n} on the list`);
  return m.list.pullRequestFor(n);
}
