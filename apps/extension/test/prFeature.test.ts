// The pull request feature, end to end in node: registerPrFeature's REAL tree,
// panel, review controller and content provider, driven through a vscode
// stand-in (prVscodeStub.cjs) against a fake api.github.com (fakeGitHub.ts)
// that answers in GitHub's own shapes — and counts what each event costs.
//
// Each test is one defect from the Pull Requests audit, asserted the way the
// user meets it: what the row says, what the page shows, what GitHub is sent.

import Module from "node:module";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeGitHub, linkHeader, rawPull, type FakeGitHub, type Route } from "./fakeGitHub";

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
const HOME = mkdtempSync(join(tmpdir(), "gs-pr-home-"));
process.env.HOME = HOME;

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- loaded after the stand-in */
const vscode = require("vscode") as any;
const { registerPrFeature } = require("../src/pr/prFeature") as typeof import("../src/pr/prFeature");
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { GitHubApi } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi");
const { GitHubAuth } = require("../src/pr/githubAuth") as typeof import("../src/pr/githubAuth");
const { PullRequestsTreeProvider } = require("../src/pr/pullRequestsView") as typeof import("../src/pr/pullRequestsView");
/* eslint-enable @typescript-eslint/no-require-imports */

const pr = vscode.__pr;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, what = "condition", ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── The dialogs: every question recorded, answered by the test ───────────────
let asked: any[] = [];
let answer: (spec: any) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec: any) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});

// ── A repository manager with one active repository ────────────────────────
interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}
function entryFor(root: string, remotes: Remote[]) {
  return {
    root,
    ctx: {
      root,
      remotes: { list: async () => remotes },
      process: { cwd: root, run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    },
  };
}
function fakeRepos(remotes: Remote[], root = "/work/app") {
  const changed = new vscode.EventEmitter();
  let active: any = entryFor(root, remotes);
  return {
    onDidChange: changed.event,
    getActive: () => active,
    fire: () => changed.fire(),
    switchTo: (e: any) => {
      active = e;
    },
  };
}
const ORIGIN: Remote[] = [{ name: "origin", fetchUrl: "git@github.com:acme/app.git", pushUrl: "git@github.com:acme/app.git" }];

let mounted: { dispose(): void }[] = [];
let fakes: FakeGitHub[] = [];
function mount(repos: ReturnType<typeof fakeRepos>) {
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext") };
  registerPrFeature(context as any, repos as any, { isEnabled: async () => false } as any);
  const view = pr.views.at(-1);
  let gone = false;
  const m = {
    view,
    tree: view.opts.treeDataProvider,
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
function github(routes: Route[]): FakeGitHub {
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
  for (const f of fakes) f.restore();
  mounted = [];
  fakes = [];
  asked = [];
  answer = () => undefined;
  pr.reset();
});

// ── GitHub, as it answers for acme/app ──────────────────────────────────────
const CI: Record<number, string | null> = { 37: "FAILURE", 36: "PENDING", 3: "SUCCESS" };
const PULLS = () => [
  rawPull(37, { title: "Drop Commit", user: { login: "me" } }),
  rawPull(36, { title: "WIP: keyboard", draft: true }),
  rawPull(3, { title: "Reset to upstream", requested_reviewers: [{ login: "me" }] }),
];
const FILES_37 = [
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

function graphqlCi(req: { body: unknown }) {
  const q = String((req.body as { query: string }).query);
  const repository: Record<string, unknown> = {};
  for (const m of q.matchAll(/pr(\d+):/g)) {
    const state = CI[Number(m[1])] ?? null;
    repository[`pr${m[1]}`] = { commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } };
  }
  return { body: { data: { repository } } };
}

function acmeRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => ({ body: PULLS() })],
    ["GET", /^\/user$/, () => ({ body: { login: "me" } })],
    ["POST", /^\/graphql$/, graphqlCi],
    // What the combined-status endpoint answers for EVERY Actions-only repo.
    ["GET", /\/commits\/[^/]+\/status/, () => ({ body: { state: "pending", total_count: 0, statuses: [] } })],
    ["GET", /\/commits\/[^/]+\/check-runs/, () => ({ body: { total_count: 0, check_runs: [] } })],
    ["GET", /^\/repos\/acme\/app\/pulls\/37\/files/, () => ({ body: FILES_37 })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)\/files/, () => ({ body: [] })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)$/, (_r, m) => ({ body: PULLS().find((p) => p.number === Number(m[1])) ?? rawPull(Number(m[1])) })],
  ];
}

async function rows(tree: any): Promise<{ group: string; node: any }[]> {
  const out: { group: string; node: any }[] = [];
  for (const g of await tree.getChildren()) {
    if (g.kind === "group") for (const r of await tree.getChildren(g)) out.push({ group: g.group, node: r });
    else out.push({ group: "-", node: g });
  }
  return out;
}
async function row(tree: any, n: number): Promise<any> {
  return (await rows(tree)).find((x) => x.group === "open" && x.node.pr?.number === n)?.node;
}

// ── The list ───────────────────────────────────────────────────────────────

test("every row's checks show as its icon — a glyph AND a colour, drafts too — from check runs AND statuses, and no row reads `$(…)`", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const first = await row(m.tree, 36);
  assert.equal(first.iconPath.id, "git-pull-request-draft", "before the checks are known: the PR's own icon");
  await until(async () => (await row(m.tree, 3))?.iconPath?.color !== undefined, "the checks to colour the rows");
  const r37 = await row(m.tree, 37);
  const r36 = await row(m.tree, 36);
  const r3 = await row(m.tree, 3);
  for (const r of [r37, r36, r3]) {
    assert.doesNotMatch(String(r.description), /\$\(/, "a TreeItem description is plain text");
  }
  // GitHub's combined status said "pending" for all three; the runs say what
  // happened. Each state is its own glyph: red and green alone are one colour
  // to a red-green colour-blind eye.
  assert.deepEqual([r37.iconPath.id, r37.iconPath.color?.id], ["error", "charts.red"], "#37's run failed");
  assert.deepEqual([r3.iconPath.id, r3.iconPath.color?.id], ["pass", "charts.green"], "#3's checks passed");
  assert.deepEqual([r36.iconPath.id, r36.iconPath.color?.id], ["clock", "charts.yellow"], "a draft's running checks are shown too");
  assert.match(String(r36.description), /^Draft · /, "…and the row still says it is a draft");
  assert.match(r37.tooltip.value, /Checks failed/);
  assert.match(r37.accessibilityInformation.label, /checks failed/);
  // Sorted by last update, so the age shown is the update's — and says so.
  assert.equal(r37.description, "me · updated 3h ago");
  assert.equal(r36.contextValue, "gitstudio.pr.draft", "Merge… is not offered on a draft");
});

test("a file save costs GitHub nothing, hidden or shown; another repository clears the rows and loads its own", async () => {
  const gh = github([
    ["GET", /^\/repos\/acme\/other\/pulls\?state=open/, () => ({ body: [rawPull(9, { title: "Other repo PR" })] })],
    ...acmeRoutes(),
  ]);
  const repos = fakeRepos(ORIGIN);
  const m = mount(repos);
  await until(async () => (await row(m.tree, 3))?.iconPath?.color !== undefined, "the first load");
  await sleep(50);
  const before = gh.requests.length;
  // vscode.git re-runs status after every change on disk: RepoManager fires.
  for (let i = 0; i < 3; i++) repos.fire();
  await sleep(700);
  assert.deepEqual(gh.requests.slice(before).map((r) => r.path), [], "working-tree churn is not a reason to ask GitHub");
  m.view.setVisible(false);
  repos.fire();
  await sleep(700);
  m.view.setVisible(true);
  await sleep(100);
  assert.deepEqual(gh.requests.slice(before).map((r) => r.path), [], "nor is the view being hidden and shown");
  assert.equal(m.view.description, "acme/app", "the view names the repository it lists");

  // The user switches to another repository.
  repos.switchTo(entryFor("/work/other", [{ name: "origin", fetchUrl: "https://github.com/acme/other.git", pushUrl: "" }]));
  repos.fire();
  await sleep(600);
  const after = await rows(m.tree);
  assert.deepEqual(
    after.filter((x) => x.group === "open").map((x) => x.node.pr.number),
    [9],
    "the other repository's rows — none of the first one's",
  );
  assert.equal(m.view.description, "acme/other");
});

/** 130 open PRs, over two of GitHub's pages. */
function github130(): FakeGitHub {
  const all = Array.from({ length: 130 }, (_, i) => rawPull(1000 - i));
  const path = "/repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=100";
  return github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\?state=open/,
      (req) => {
        const page = Number(/[?&]page=(\d+)/.exec(req.path)?.[1] ?? 1);
        return { body: all.slice((page - 1) * 100, page * 100), headers: linkHeader(path, page, 2) };
      },
    ],
    ...acmeRoutes(),
  ]);
}

test("the list follows GitHub's pages: 130 open PRs are 130 rows, not 100", async () => {
  const gh = github130();
  const m = mount(fakeRepos(ORIGIN));
  const open = (await rows(m.tree)).filter((x) => x.group === "open");
  assert.equal(open.length, 130);
  // Their checks come after the rows, 50 PRs a request — and this test ends
  // only when they have. Ended before, the last two requests went out after
  // afterEach had put the machine's own fetch back: a real POST to
  // api.github.com/graphql, from a test.
  await until(() => gh.count(/^POST \/graphql$/) === 3, "the checks of all 130 rows, three requests");
  await sleep(50);
  assert.equal(gh.count(/^POST \/graphql$/), 3, "and no more");
});

test("a list closed while its checks are still paging asks GitHub for nothing more", async () => {
  const gh = github130();
  const slow = gh.hold(/^\/graphql$/);
  const m = mount(fakeRepos(ORIGIN));
  assert.equal((await rows(m.tree)).filter((x) => x.group === "open").length, 130);
  await until(() => slow.held() === 1, "the first of the three checks requests");
  m.dispose(); // the window closes, the extension with it
  slow.release();
  await sleep(150);
  assert.equal(gh.count(/^POST \/graphql$/), 1, "the request in flight is the last one");
});

test("a list closed while its own pages are still loading asks GitHub for nothing more", async () => {
  // 250 open PRs: three of GitHub's pages, read one after another.
  const all = Array.from({ length: 250 }, (_, i) => rawPull(1000 - i));
  const path = "/repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=100";
  const gh = github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\?state=open/,
      (req) => {
        const page = Number(/[?&]page=(\d+)/.exec(req.path)?.[1] ?? 1);
        return { body: all.slice((page - 1) * 100, page * 100), headers: linkHeader(path, page, 3) };
      },
    ],
    ...acmeRoutes(),
  ]);
  const slow = gh.hold(/^\/repos\/acme\/app\/pulls\?state=open/);
  const m = mount(fakeRepos(ORIGIN));
  const drawn = m.tree.getChildren(); // the view asks for its rows; the first page goes out
  await until(() => slow.held() === 1, "the first of the three pages");
  m.dispose(); // the window closes, the extension with it
  slow.release();
  await drawn.catch(() => undefined);
  await sleep(150);
  assert.equal(gh.count(/^GET \/repos\/acme\/app\/pulls\?state=open/), 1, "the page in flight is the last one");
  assert.equal(gh.count(/^POST \/graphql$/), 0, "and no rows' checks are asked for");
});

test("a list in sight is read again once it is stale — and nothing is asked while it is hidden", async () => {
  const gh = github(acmeRoutes());
  const auth = new GitHubAuth();
  await auth.isConnected(); // the first sign-in event, out of the way
  const tree = new PullRequestsTreeProvider(fakeRepos(ORIGIN) as any, auth, 160);
  const view = vscode.window.createTreeView("gitstudio.pullRequests", { treeDataProvider: tree });
  tree.attach(view);
  mounted.push({ dispose: () => (tree.dispose(), auth.dispose()) });
  const loads = () => gh.count(/pulls\?state=open/);
  await rows(tree);
  assert.equal(loads(), 1);
  await until(() => loads() >= 2, "the stale list in sight to be read again", 2000);
  view.setVisible(false);
  await sleep(100);
  const hidden = loads();
  await sleep(600);
  assert.equal(loads(), hidden, "hidden, it asks GitHub nothing");
});

test("a refresh that fails says so above the rows it kept; a first load that fails offers its way out", async () => {
  let down: { status: number; body: unknown } | undefined;
  github([["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => down ?? { body: PULLS() }], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  assert.equal((await rows(m.tree)).filter((x) => x.group === "open").length, 3);
  down = { status: 502, body: { message: "Server Error" } };
  await vscode.commands.executeCommand("gitstudio.pr.refresh");
  await until(() => pr.said.some((s: any) => s.kind === "progress-end"), "the refresh to end");
  assert.equal((await rows(m.tree)).filter((x) => x.group === "open").length, 3, "the last good list stays");
  assert.match(String(m.view.message), /^Couldn't refresh: Server Error Showing the list as it was /);

  // Nothing loaded yet: the row says what to do, and doing it is one click.
  const m2 = mount(fakeRepos(ORIGIN, "/work/app2"));
  const [retry] = await m2.tree.getChildren();
  assert.equal(retry.command?.command, "gitstudio.pr.refresh", retry.label);
  down = { status: 401, body: { message: "Bad credentials" } };
  const m3 = mount(fakeRepos(ORIGIN, "/work/app3"));
  const [signIn] = await m3.tree.getChildren();
  assert.equal(signIn.command?.command, "gitstudio.pr.signIn", signIn.label);
});

const OTHER = () => entryFor("/work/other", [{ name: "origin", fetchUrl: "https://github.com/acme/other.git", pushUrl: "" }]);
const openNumbers = async (tree: any) => (await rows(tree)).filter((x) => x.group === "open").map((x) => x.node.pr.number);

test("a refresh of one repository that answers after a switch to another paints nothing over it", async () => {
  let down = false;
  const gh = github([
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => (down ? { status: 502, body: { message: "Server Error (acme/app)" } } : { body: PULLS() })],
    ["GET", /^\/repos\/acme\/other\/pulls\?state=open/, () => ({ body: [rawPull(9, { title: "Other repo PR" })] })],
    ...acmeRoutes(),
  ]);
  const repos = fakeRepos(ORIGIN);
  const m = mount(repos);
  await rows(m.tree);
  down = true;
  const slow = gh.hold(/^\/repos\/acme\/app\/pulls\?state=open/);
  await vscode.commands.executeCommand("gitstudio.pr.refresh"); // acme/app's refresh, in flight
  await until(() => slow.held() > 0, "acme/app's refresh to be in flight");
  repos.switchTo(OTHER());
  repos.fire();
  await sleep(600);
  assert.deepEqual(await openNumbers(m.tree), [9]);
  slow.release();
  await until(() => pr.said.some((s: any) => s.kind === "progress-end"), "acme/app's refresh to end");
  await sleep(50);
  assert.deepEqual(await openNumbers(m.tree), [9], "acme/other's rows");
  assert.equal(m.view.description, "acme/other");
  assert.equal(m.view.message, undefined, "no \"Couldn't refresh\" of acme/app's over acme/other's list");
});

test("a first load of one repository that answers after a switch to another paints nothing over it", async () => {
  const gh = github([
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => ({ status: 502, body: { message: "Server Error (acme/app)" } })],
    ["GET", /^\/repos\/acme\/other\/pulls\?state=open/, () => ({ body: [rawPull(9, { title: "Other repo PR" })] })],
    ...acmeRoutes(),
  ]);
  const repos = fakeRepos(ORIGIN);
  const m = mount(repos);
  const slow = gh.hold(/^\/repos\/acme\/app\/pulls\?state=open/);
  const first = m.tree.getChildren(); // acme/app's first load, in flight
  await until(() => slow.held() > 0, "acme/app's first load to be in flight");
  repos.switchTo(OTHER());
  repos.fire();
  await sleep(600);
  assert.deepEqual(await openNumbers(m.tree), [9]);
  slow.release();
  await first;
  await sleep(50);
  assert.deepEqual(await openNumbers(m.tree), [9], "acme/other's rows");
  assert.equal(m.view.description, "acme/other");
  assert.equal(m.view.message, undefined, "no \"Couldn't refresh\" of acme/app's over acme/other's list");
});

test("an expired sign-in's row signs in AGAIN — a new session, not the one GitHub just refused", async () => {
  // VS Code keeps the revoked session: getSession with createIfNone hands it
  // straight back, so "Click to sign in" re-sent the token GitHub refused.
  let token = "revoked";
  const asks: any[] = [];
  const original = vscode.authentication.getSession;
  vscode.authentication.getSession = async (_id: string, _scopes: string[], opts: any) => {
    asks.push(opts);
    if (opts?.forceNewSession) token = "fresh";
    return { ...pr.session, accessToken: token };
  };
  mounted.push({ dispose: () => (vscode.authentication.getSession = original) });
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\?state=open/,
      (req) => (req.headers.authorization === "Bearer fresh" ? { body: PULLS() } : { status: 401, body: { message: "Bad credentials" } }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const [row] = await m.tree.getChildren();
  assert.equal(row.command?.command, "gitstudio.pr.signIn", String(row.label));
  await vscode.commands.executeCommand(row.command.command, ...(row.command.arguments ?? []));
  assert.ok(
    asks.some((o) => o?.forceNewSession),
    `a new session is asked for (asked: ${JSON.stringify(asks)})`,
  );
  assert.deepEqual(await openNumbers(m.tree), [37, 36, 3], "and the list loads with it");
});

test("a 403 is not a sign-in problem: its row opens GitHub — its SSO authorization when it names one", async () => {
  let sso = false;
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\?state=open/,
      () =>
        sso
          ? {
              status: 403,
              body: { message: "Resource protected by organization SAML enforcement." },
              headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=abc" },
            }
          : { status: 403, body: { message: "Must have push access to view repository collaborators." } },
    ],
    ...acmeRoutes(),
  ]);
  const [plain] = await mount(fakeRepos(ORIGIN, "/work/app1")).tree.getChildren();
  assert.equal(plain.command?.command, "vscode.open", String(plain.label));
  assert.equal(String(plain.command.arguments[0]), "https://github.com/acme/app/pulls", "the repository's pull requests");
  assert.doesNotMatch(String(plain.label), /sign in/i);
  sso = true;
  const [saml] = await mount(fakeRepos(ORIGIN, "/work/app2")).tree.getChildren();
  assert.equal(saml.command?.command, "vscode.open");
  assert.match(String(saml.command.arguments[0]), /\/orgs\/acme\/sso/, "GitHub's own authorization page");
});

test("a GitHub remote added, or a switch away from an error or a repo with none: the view draws the repository now active", async () => {
  github([
    ["GET", /^\/repos\/acme\/broken\/pulls\?state=open/, () => ({ status: 502, body: { message: "Server Error" } })],
    ...acmeRoutes(),
  ]);
  const remotes: Remote[] = [{ name: "origin", fetchUrl: "git@gitlab.com:acme/app.git", pushUrl: "" }];
  const repos = fakeRepos(remotes, "/work/app");
  const m = mount(repos);
  let redraws = 0;
  m.tree.onDidChangeTreeData(() => redraws++);
  const open = async () => (await rows(m.tree)).filter((x) => x.group === "open").length;
  const change = async (what: string) => {
    const before = redraws;
    repos.fire();
    await until(() => redraws > before, what, 2000);
  };

  assert.equal(await open(), 0);
  assert.match(String(m.view.message), /gitlab\.com/);
  // The same repository gains a github.com remote.
  remotes.push({ name: "github", fetchUrl: "git@github.com:acme/app.git", pushUrl: "" });
  await change("the view to notice the new remote");
  assert.equal(await open(), 3);
  assert.equal(m.view.message, undefined);

  // A repository whose list fails to load, then one whose list loads.
  repos.switchTo(entryFor("/work/broken", [{ name: "origin", fetchUrl: "https://github.com/acme/broken", pushUrl: "" }]));
  await change("the view to leave /work/app");
  assert.match(String((await m.tree.getChildren())[0].label), /Server Error/);
  repos.switchTo(entryFor("/work/app", ORIGIN));
  await change("the view to leave the error of /work/broken");
  assert.equal(await open(), 3);
  assert.equal(m.view.description, "acme/app");
});

test("the view says which repository it shows — or why there is none — never a blank", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos([{ name: "origin", fetchUrl: "git@gitlab.com:acme/app.git", pushUrl: "" }]));
  assert.deepEqual(await m.tree.getChildren(), []);
  assert.match(String(m.view.message), /None of this repository's remotes is on github\.com: origin \(gitlab\.com\)/);
});

test("while repositories are still being found, the view says it is looking — as Changes and the graph do — then what it found", async () => {
  github(acmeRoutes());
  // Discovery under way: no active repository YET.
  let discovering = true;
  const repos = { ...fakeRepos(ORIGIN), isDiscovering: () => discovering };
  repos.switchTo(undefined);
  const m = mount(repos);
  let redraws = 0;
  m.tree.onDidChangeTreeData(() => redraws++);
  assert.deepEqual(await m.tree.getChildren(), []);
  assert.equal(m.view.message, "Looking for a repository…", "not 'Open a Git repository' while one may still turn up");

  // Discovery settles with nothing found: now there is none, and it says so.
  discovering = false;
  let before = redraws;
  repos.fire();
  await until(() => redraws > before, "the view to redraw once discovery settled", 2000);
  assert.deepEqual(await m.tree.getChildren(), []);
  assert.equal(m.view.message, "Open a Git repository to see its pull requests.");

  // …or with a repository: its pull requests. (A window whose folders
  // changed discovers again: drawn then, it is looking again.)
  discovering = true;
  await m.tree.getChildren();
  assert.equal(m.view.message, "Looking for a repository…");
  discovering = false;
  repos.switchTo(entryFor("/work/app", ORIGIN));
  before = redraws;
  repos.fire();
  await until(() => redraws > before, "the view to leave 'looking'", 2000);
  assert.equal((await rows(m.tree)).filter((x) => x.group === "open").length, 3);
  assert.equal(m.view.message, undefined);
});

test("github.com under another name is github.com: SSH aliases, ssh.github.com, www.github.com, ~/.ssh/config", async () => {
  mkdirSync(join(HOME, ".ssh"), { recursive: true });
  writeFileSync(join(HOME, ".ssh", "config"), "Host work\n  HostName github.com\n  User git\n");
  github(acmeRoutes());
  for (const url of [
    "git@github.com-work:acme/app.git",
    "ssh://git@ssh.github.com:443/acme/app.git",
    "https://www.github.com/acme/app",
    "git@work:acme/app.git",
  ]) {
    const m = mount(fakeRepos([{ name: "origin", fetchUrl: url, pushUrl: "" }]));
    const open = (await rows(m.tree)).filter((x) => x.group === "open");
    assert.equal(open.length, 3, url);
    assert.equal(m.view.description, "acme/app", url);
  }
});

// ── The PR page ────────────────────────────────────────────────────────────

async function openPage(m: any, n: number, over: Record<string, unknown> = {}): Promise<any> {
  const node = await row(m.tree, 37);
  const prObj = { ...node.pr, number: n, ...over };
  await vscode.commands.executeCommand("gitstudio.pr.openDescription", { pr: prObj, ctx: node.ctx });
  return pr.panels.find((p: any) => p.title === `PR #${n}`);
}

test("a merged PR reads Merged, and one closed without merging reads Closed — never the same badge", async () => {
  const MERGED_AT = "2026-09-20T10:00:00Z";
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/39$/, () => ({ body: rawPull(39, { state: "closed", merged_at: MERGED_AT }) })],
    ["GET", /^\/repos\/acme\/app\/pulls\/38$/, () => ({ body: rawPull(38, { state: "closed", merged_at: null }) })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const merged = await openPage(m, 39, { state: "closed" });
  const closed = await openPage(m, 38, { state: "closed" });
  const badge = (html: string) => /<span id="badge" class="badge badge-(\w+)">[\s\S]*?<span class="badge-word">(\w+)<\/span>/.exec(html)?.slice(1);
  assert.deepEqual(badge(merged.webview.html), ["merged", "Merged"]);
  assert.deepEqual(badge(closed.webview.html), ["closed", "Closed"]);
});

test("the page's label colours survive its own CSP: classes in the nonce'd <style>, no style attributes", async () => {
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: { ...PULLS()[0], labels: [{ name: "bug", color: "d73a4a" }, { name: "enhancement", color: "a2eeef" }] } }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const html: string = page.webview.html;
  const body = html.slice(html.indexOf("<body>"));
  assert.doesNotMatch(body, /\sstyle="/, "a style attribute can't carry the nonce; the CSP drops it");
  const nonce = /<script nonce="([^"]+)"/.exec(html)![1];
  const styles = [...html.matchAll(/<style nonce="([^"]+)">([\s\S]*?)<\/style>/g)];
  assert.ok(styles.every((s) => s[1] === nonce));
  const css = styles.map((s) => s[2]).join("\n");
  for (const [name, hex] of [["bug", "d73a4a"], ["enhancement", "a2eeef"]]) {
    const cls = new RegExp(`<span class="gs-chip label (label-\\d+)">${name}</span>`).exec(body)?.[1];
    assert.ok(cls, `${name} carries a label class`);
    assert.match(css, new RegExp(`\\.${cls} \\{ --label: #${hex}; \\}`), `${name}'s colour is in the nonce'd style`);
  }
});

test("the page counts the PR's files from GitHub's total, names a rename's old path, and diffs it from there", async () => {
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/37$/, () => ({ body: { ...PULLS()[0], changed_files: 61, additions: 1840, deletions: 212 } })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const html: string = page.webview.html;
  assert.match(html, /Changed files \(61\)/, "not the count of the files fetched");
  assert.match(html, /Showing 3 of 61 files/);
  assert.match(html, /<span class="ffrom">src\/old\.ts → <\/span>/);
  // A side with no lines isn't drawn: a deleted file's "+0", a new line's red "−0".
  assert.doesNotMatch(html, /[+−]0</, "no zero counts");
  assert.match(html, /data-path="docs\/gone\.md"[\s\S]*?<span class="fstat gs-mono"><span class="del">−3<\/span><\/span>/);
  // A same-repository head reads as its branch, without the owner.
  assert.match(html, /branch--head">[^<]*<i class="codicon codicon-git-branch"[^>]*><\/i>feature-37</);
  page.receive({ type: "openFile", path: "src/new.ts" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the diff to open");
  const [left, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.equal(left.path, "/src/old.ts", "the base side is the file as it was — under its old name");
  assert.equal(right.path, "/src/new.ts");
});

test("Merge from the page flips it to Merged in place, drops the row, and offers only the methods the repo allows", async () => {
  let merged = false;
  const gh = github([
    ["GET", /^\/repos\/acme\/app$/, () => ({ body: { default_branch: "main", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true } })],
    [
      "PUT",
      /^\/repos\/acme\/app\/pulls\/37\/merge$/,
      () => {
        merged = true;
        return { body: { merged: true } };
      },
    ],
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: merged ? { ...PULLS()[0], state: "closed", merged_at: "2026-09-25T10:00:00Z" } : PULLS()[0] }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const writes = page.htmlWrites;
  const listLoads = gh.count(/pulls\?state=open/);
  answer = (spec) => (spec.kind === "pick" && /^Merge PR #37/.test(spec.title) ? "squash" : undefined);
  page.receive({ type: "merge" });
  await until(() => page.posted.some((p: any) => p.type === "state"), "the page to be told");
  assert.deepEqual(page.posted[0], { type: "state", kind: "merged" });
  const offered = asked.find((s) => /^Merge PR #37/.test(s.title)).choices.map((c: any) => c.id);
  assert.deepEqual(offered.sort(), ["rebase", "squash"], "the repository turned merge commits off");
  await sleep(50);
  assert.equal(page.htmlWrites, writes, "patched, not reloaded");
  const open = (await rows(m.tree)).filter((x) => x.group === "open").map((x) => x.node.pr.number);
  assert.deepEqual(open, [36, 3], "the merged PR left the open list");
  assert.equal(gh.count(/pulls\?state=open/), listLoads, "…without reloading it");
});

test("a page update still in flight when the merge lands never paints Open over Merged", async () => {
  let merged = false;
  const gh = github([
    ["GET", /^\/repos\/acme\/app$/, () => ({ body: { default_branch: "main" } })],
    [
      "PUT",
      /^\/repos\/acme\/app\/pulls\/37\/merge$/,
      () => {
        merged = true;
        return { body: { merged: true } };
      },
    ],
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: merged ? { ...PULLS()[0], state: "closed", merged_at: "2026-09-25T10:00:00Z" } : PULLS()[0] }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  // Refresh; its files (a big PR: page after page) are slow to come.
  const slow = gh.hold(/^\/repos\/acme\/app\/pulls\/37\/files/);
  page.receive({ type: "refresh" });
  await until(() => slow.held() > 0, "the refresh to be in flight");
  answer = (spec) => (spec.kind === "pick" && /^Merge PR #37/.test(spec.title) ? "squash" : undefined);
  page.receive({ type: "merge" });
  await until(() => page.posted.some((p: any) => p.type === "state" && p.kind === "merged"), "the page to be told Merged");
  await sleep(50);
  slow.release();
  await sleep(100);
  const html: string = page.webview.html;
  assert.equal(/id="badge" class="badge badge-(\w+)"/.exec(html)?.[1], "merged", "the page still reads Merged");
  assert.match(html, /id="btn-merge"[^>]*disabled/, "and Merge… stays off");
});

test("a PR's files follow GitHub's pages: all 130 are listed, and the 130th takes a review comment", async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({
    filename: `src/f${i}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1,1 +1,2 @@\n a\n+b",
  }));
  const path = "/repos/acme/app/pulls/37/files?per_page=100";
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37\/files/,
      (req) => {
        const page = Number(/[?&]page=(\d+)/.exec(req.path)?.[1] ?? 1);
        return { body: many.slice((page - 1) * 100, page * 100), headers: linkHeader(path, page, 2) };
      },
    ],
    ["GET", /^\/repos\/acme\/app\/pulls\/37$/, () => ({ body: { ...PULLS()[0], changed_files: 130 } })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  const html: string = page.webview.html;
  assert.match(html, /Changed files \(130\)/);
  assert.doesNotMatch(html, /Showing \d+ of/, "nothing is missing, so nothing says so");
  assert.equal((html.match(/class="filerow"/g) ?? []).length, 130);
  await startReview(m, 37);
  assert.deepEqual(ranges(m, "src/f129.ts", HEAD_37, 5), [[0, 1]], "a file past the first 100 is commentable");
});

test("files that couldn't be loaded are said to be so — not \"Showing 0 of 61\"", async () => {
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/41\/files/, () => ({ status: 502, body: { message: "Server Error" } })],
    ["GET", /^\/repos\/acme\/app\/pulls\/41$/, () => ({ body: rawPull(41, { changed_files: 61 }) })],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const html: string = (await openPage(m, 41)).webview.html;
  assert.match(html, /Couldn't load the changed files\. Server Error/);
  assert.doesNotMatch(html, /Showing 0 of|at most 3,000/, "no limit was hit");
});

// ── The diff panes ─────────────────────────────────────────────────────────

test("a diff pane that can't be loaded says why — only a missing path is an empty pane", async () => {
  github([
    ["GET", /\/contents\/limited\.ts/, () => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" } })],
    ["GET", /\/contents\/gone\.ts/, () => ({ status: 404, body: { message: "Not Found" } })],
    ["GET", /\/contents\/logo\.png/, () => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) })],
    ["GET", /\/contents\/ok\.ts/, () => ({ bytes: new TextEncoder().encode("export const ok = 1;\n") })],
    ...acmeRoutes(),
  ]);
  mount(fakeRepos(ORIGIN));
  const provider = pr.providers.get("gitstudio-pr");
  const uri = (p: string) => vscode.Uri.from({ scheme: "gitstudio-pr", path: `/${p}`, query: "owner=acme&repo=app&sha=abc1234" });
  const token = new vscode.CancellationTokenSource().token;
  await assert.rejects(provider.provideTextDocumentContent(uri("limited.ts"), token), /rate limit/i);
  assert.equal(await provider.provideTextDocumentContent(uri("gone.ts"), token), "");
  assert.match(await provider.provideTextDocumentContent(uri("logo.png"), token), /^Binary file \(8 bytes\) at abc1234/);
  assert.equal(await provider.provideTextDocumentContent(uri("ok.ts"), token), "export const ok = 1;\n");
});

// ── Review ─────────────────────────────────────────────────────────────────

const HEAD_37 = "037head";
const prUri = (path: string, sha: string) =>
  vscode.Uri.from({ scheme: "gitstudio-pr", path: `/${path}`, query: `owner=acme&repo=app&sha=${sha}` });
const ranges = (m: any, path: string, sha: string, lineCount: number) =>
  (m.controller.commentingRangeProvider.provideCommentingRanges({ uri: prUri(path, sha), lineCount }) ?? undefined)?.map(
    (r: any) => [r.start.line, r.end.line],
  );

async function startReview(m: any, n: number): Promise<void> {
  const node = (await rows(m.tree)).find((x) => x.node.pr?.number === n)!.node;
  await vscode.commands.executeCommand("gitstudio.pr.startReview", node);
}

test("review: only lines inside the diff's hunks take a comment — the head's, and the base's for removed lines", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  assert.deepEqual(ranges(m, "src/a.ts", HEAD_37, 120), [[0, 3], [40, 41]], "the head side: its two hunks, not every line");
  assert.deepEqual(ranges(m, "src/a.ts", "basesha", 120), [[0, 2], [39, 43]], "the base side: the lines being removed");
  assert.deepEqual(ranges(m, "docs/gone.md", "basesha", 3), [[0, 2]], "a deleted file is commented on its LEFT side");
  assert.deepEqual(ranges(m, "docs/gone.md", HEAD_37, 0), [], "…and has no right side to comment on");
  assert.deepEqual(ranges(m, "src/old.ts", "basesha", 2), [[0, 1]], "a rename's base side is its old path");
  const opened = pr.executed.filter((e: any) => e.id === "vscode.diff");
  assert.equal(opened.length, 1, "one diff opens: a preview replaced by the next left only the last of five");
});

test("review: Delete on a pending comment deletes that comment", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(40, 0, 40, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "first" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "second" });
  assert.equal(thread.comments.length, 2);
  // VS Code hands a comment/title action the COMMENT itself.
  await vscode.commands.executeCommand("gitstudio.pr.deleteReviewComment", thread.comments[0]);
  assert.deepEqual(thread.comments.map((c: any) => c.body.value), ["second"], "that comment, not its thread");
  assert.equal(thread.disposed, false);
  await vscode.commands.executeCommand("gitstudio.pr.deleteReviewComment", thread.comments[0]);
  assert.equal(thread.disposed, true, "the thread goes with its last comment");
});

test("review: \"pending\" counts pending comments — a posted one is neither counted nor discarded", async () => {
  github([["POST", /\/reviews$/, () => ({ body: { id: 1 } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addSingleComment", { thread, text: "posted now" });
  await until(() => thread.comments.length === 1, "the single comment to post");
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "pending" });
  await vscode.commands.executeCommand("gitstudio.pr.deleteReviewComment", thread.comments.find((c: any) => c.body.value === "pending"));
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.deepEqual(asked.map((a) => a.title), [], "nothing is pending, so nothing to discard");
  assert.equal(thread.disposed, false, "the posted comment stays in the editor");
  assert.deepEqual(thread.comments.map((c: any) => c.body.value), ["posted now"]);

  // Two pending replies on one line are two pending comments.
  await startReview(m, 37);
  const two = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(2, 0, 2, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: two, text: "one" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: two, text: "two" });
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.match(asked.at(-1)?.title ?? "", /^Discard 2 pending comments on #37\?$/);

  // Discarding keeps what is already on GitHub.
  await vscode.commands.executeCommand("gitstudio.pr.addSingleComment", { thread: two, text: "posted too" });
  await until(() => two.comments.length === 3, "the single comment to post");
  answer = (spec) => (spec.kind === "confirm" ? "ok" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.equal(two.disposed, false);
  assert.deepEqual(two.comments.map((c: any) => c.body.value), ["posted too"], "the pending ones go, the posted one stays");
});

test("review: the submitted review is pinned to the head the diffs showed, with multi-line and LEFT comments as GitHub names them", async () => {
  let sent: any;
  github([
    [
      "POST",
      /^\/repos\/acme\/app\/pulls\/37\/reviews$/,
      (req) => {
        sent = req.body;
        return { body: { id: 1 } };
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const multi = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(1, 0, 3, 0));
  const removed = vscode.__makeThread(prUri("docs/gone.md", "basesha"), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: multi, text: "these lines" });
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: removed, text: "why remove this?" });
  answer = (spec) => (spec.kind === "pick" ? "COMMENT" : spec.kind === "input" ? "Looks close." : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  assert.ok(sent, "the review was posted");
  assert.equal(sent.commit_id, HEAD_37, "a push during the review must not move the comments");
  assert.deepEqual(sent.comments, [
    { path: "src/a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "these lines" },
    { path: "docs/gone.md", line: 2, side: "LEFT", body: "why remove this?" },
  ]);
  assert.equal(sent.body, "Looks close.");
});

test("review: the left side is the MERGE BASE — the file GitHub's hunks count its lines in — not the base branch's tip", async () => {
  // main moved on since #37 branched: GitHub's patch (a three-dot diff) counts
  // its left lines in the merge base, which is not base.sha any more.
  let sent: any;
  const gh = github([
    ["GET", /^\/repos\/acme\/app\/compare\/basesha\.\.\.037head/, () => ({ body: { merge_base_commit: { sha: "mergebase" } } })],
    [
      "POST",
      /^\/repos\/acme\/app\/pulls\/37\/reviews$/,
      (req) => {
        sent = req.body;
        return { body: { id: 1 } };
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));

  // The page, outside a review: its diffs are drawn from the merge base too.
  const page = await openPage(m, 37);
  page.receive({ type: "openFile", path: "src/new.ts" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the page's diff to open");
  const [pageLeft] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(pageLeft.query, /sha=mergebase/, "the page's diff: base side at the merge base");
  assert.equal(pageLeft.path, "/src/old.ts");

  pr.executed.length = 0;
  await startReview(m, 37);
  const [left] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(left.query, /sha=mergebase/, "the review's diff: base side at the merge base");
  assert.deepEqual(ranges(m, "src/a.ts", "mergebase", 120), [[0, 2], [39, 43]], "the removed lines, where they are in that file");
  assert.equal(ranges(m, "src/a.ts", "basesha", 120), undefined, "the base branch's tip is not the diff's left side");
  const removed = vscode.__makeThread(prUri("docs/gone.md", "mergebase"), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread: removed, text: "why?" });
  answer = (spec) => (spec.kind === "pick" ? "COMMENT" : spec.kind === "input" ? "" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  assert.deepEqual(sent?.comments, [{ path: "docs/gone.md", line: 2, side: "LEFT", body: "why?" }]);
  assert.equal(gh.count(/\/compare\//), 2, "asked once for the page, once for the review");
});

test("review: a row loaded before a push reviews the PR's head NOW — the diffs, the hunks and commit_id agree", async () => {
  // The list was read at 037head; the contributor has pushed since. The files
  // GitHub lists (and their hunks) are the new head's.
  const NEW_HEAD = "037new";
  let sent: any;
  github([
    ["GET", /^\/repos\/acme\/app\/pulls\/37$/, () => ({ body: { ...PULLS()[0], head: { ...(PULLS()[0].head as object), sha: NEW_HEAD } } })],
    [
      "POST",
      /^\/repos\/acme\/app\/pulls\/37\/reviews$/,
      (req) => {
        sent = req.body;
        return { body: { id: 1 } };
      },
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  assert.equal((await row(m.tree, 37)).pr.head.sha, HEAD_37, "the row is the old head");
  await startReview(m, 37);
  const [, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  assert.match(right.query, /sha=037new/, "the diff shows the code the hunks describe");
  assert.deepEqual(ranges(m, "src/a.ts", NEW_HEAD, 120), [[0, 3], [40, 41]]);
  assert.equal(ranges(m, "src/a.ts", HEAD_37, 120), undefined, "the old head isn't this review's");
  const thread = vscode.__makeThread(prUri("src/a.ts", NEW_HEAD), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "hm" });
  answer = (spec) => (spec.kind === "pick" ? "COMMENT" : spec.kind === "input" ? "" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  assert.equal(sent?.commit_id, NEW_HEAD, "pinned to the commit the diffs showed");
});

test("review: a page loaded before a push opens its files as the review sees them — each one takes comments", async () => {
  const NEW_HEAD = "037new";
  let pushed = false;
  github([
    [
      "GET",
      /^\/repos\/acme\/app\/pulls\/37$/,
      () => ({ body: pushed ? { ...PULLS()[0], head: { ...(PULLS()[0].head as object), sha: NEW_HEAD } } : PULLS()[0] }),
    ],
    ...acmeRoutes(),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const page = await openPage(m, 37);
  assert.match(page.webview.html, /src\/new\.ts/, "the page has its files");
  pushed = true; // the contributor pushes; the page still shows 037head
  page.receive({ type: "startReview" });
  await until(() => pr.contexts["gitstudio.pr.reviewing"] === true, "the review to start");
  pr.executed.length = 0;
  // As the review's own toast says: "Open other files from the PR's page."
  for (const path of ["src/a.ts", "src/new.ts"]) {
    pr.executed.length = 0;
    page.receive({ type: "openFile", path });
    await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), `${path} to open`);
    const [, right] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
    assert.match(right.query, /sha=037new/, `${path} opens at the head under review`);
    const r = m.controller.commentingRangeProvider.provideCommentingRanges({ uri: right, lineCount: 120 });
    assert.ok(r && r.length > 0, `${path}, opened from the page during the review, takes comments`);
  }
});

test("review: queued comments are never thrown away without asking — keyed to their PR", async () => {
  github([["GET", /^\/repos\/acme\/app\/pulls\/36\/files/, () => ({ status: 502, body: { message: "Bad Gateway" } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  await startReview(m, 37);
  const thread = vscode.__makeThread(prUri("src/a.ts", HEAD_37), new vscode.Range(1, 0, 1, 0));
  await vscode.commands.executeCommand("gitstudio.pr.addReviewComment", { thread, text: "keep me" });

  // Another PR whose files can't load: nothing of #37's review is touched.
  await startReview(m, 36);
  assert.equal(thread.disposed, false, "a failed load leaves the queue alone");

  // Another PR: asked — and "keep" keeps #37's review.
  answer = (spec) => (spec.kind === "pick" && /^Discard 1 pending comment on #37\?$/.test(spec.title) ? "keep" : undefined);
  await startReview(m, 3);
  assert.equal(asked.length, 1, "asked before discarding");
  assert.equal(thread.disposed, false);
  assert.deepEqual(ranges(m, "src/a.ts", HEAD_37, 120), [[0, 3], [40, 41]], "still reviewing #37");

  // The same PR again: its queue stays, nothing asked.
  asked = [];
  await startReview(m, 37);
  assert.equal(asked.length, 0);
  assert.equal(thread.disposed, false);

  // Cancel Review asks too; dismissing it keeps them.
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.match(asked.at(-1).title, /^Discard 1 pending comment on #37\?$/);
  assert.equal(thread.disposed, false);

  // Discard is an answer, not a default.
  answer = (spec) => (spec.kind === "pick" ? "discard" : undefined);
  await startReview(m, 3);
  assert.equal(thread.disposed, true);
});

test("a 422 says what GitHub refused, not just \"Unprocessable Entity\"", async () => {
  github([
    [
      "POST",
      /\/reviews$/,
      () => ({
        status: 422,
        body: { message: "Unprocessable Entity", errors: ["Pull request review thread line must be part of the diff"] },
      }),
    ],
  ]);
  const api = new GitHubApi({ getToken: async () => "tok" });
  await assert.rejects(
    api.submitReview("acme", "app", 37, { event: "COMMENT", body: "", comments: [{ path: "a.ts", line: 9, side: "RIGHT", body: "x" }] } as never),
    /line must be part of the diff/,
  );
});
