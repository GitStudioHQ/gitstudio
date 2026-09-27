// The Pull Requests list (src/pr/pullRequestsView.ts), end to end in node:
// the REAL webview view provider, fed by a fake api.github.com (GraphQL and
// REST, fakeGitHub.ts) and read back through what it sends the page — the
// same PrListViewState the shared list component paints (its own headless
// checks are packages/webview-ui/test/prList*.test.ts).
//
// THE STATE TABLE these tests walk, a cell each (memory: state tables beat
// sweeps):
//   repository: discovering · none · no remotes · not on GitHub · one GitHub
//               remote · a fork (origin) with its parent · an SSH alias
//   sign-in:    signed out · signed in · expired (401) · refused (403, SSO)
//   load:       first load · loaded · refreshing · refresh failed · first load
//               failed · next page · next page failed
//   question:   Open · Merged · Closed · All × no filter · search · facets
//   rows:       checks failed / running / passed / none · review decision ·
//               draft · checked out here
//   events:     file save · view hidden/shown · stale in sight · repository
//               switched mid-answer · merge · create
// and count what GitHub is asked for each event.

import {
  acmeRoutes,
  dialogs,
  entryFor,
  fakeRepos,
  gql,
  github,
  HOME,
  LIST_QUERY,
  memento,
  mount,
  numbers,
  onTeardown,
  ORIGIN,
  pr,
  PULLS,
  settled,
  sleep,
  state,
  until,
  vscode,
  world,
  type GitAnswer,
  type Remote,
} from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graphqlWorld, rawPull } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects */
const { PullRequestsViewProvider } = require("../src/pr/pullRequestsView") as typeof import("../src/pr/pullRequestsView");
const { GitHubAuth } = require("../src/pr/githubAuth") as typeof import("../src/pr/githubAuth");
const { registerPrFeature } = require("../src/pr/prFeature") as typeof import("../src/pr/prFeature");

const OTHER = () => entryFor("/work/other", [{ name: "origin", fetchUrl: "https://github.com/acme/other.git", pushUrl: "" }]);
const rowOf = (m: any, n: number) => state(m).rows.find((r: any) => r.number === n);

// ── What a row says ─────────────────────────────────────────────────────────

test("one request paints the list: every row's checks from check runs AND statuses, its draft-ness, the counts and who is signed in", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const s = await settled(m);
  assert.deepEqual(numbers(m), [37, 36, 3], "newest update first");
  assert.equal(gql(gh, LIST_QUERY).length, 1, "the rows, their checks, the counts and the account: one request");
  assert.equal(gh.count(/\/status|check-runs|^GET \/user/), 0, "no request per row, no /user");
  // GitHub's combined status said "pending" for all three; the rollup says
  // what happened.
  assert.equal(rowOf(m, 37).ci.state, "failure", "#37's run failed");
  assert.equal(rowOf(m, 36).ci.state, "pending", "a draft's running checks are shown too");
  assert.equal(rowOf(m, 3).ci.state, "success");
  assert.equal(rowOf(m, 36).kind, "draft");
  assert.deepEqual(s.counts, { open: 3, merged: 0, closed: 0 });
  assert.equal(s.viewer.login, "me");
  assert.equal(m.view.description, "acme/app", "the view names the repository it lists");
  assert.equal(m.view.webview.html.includes("pr-list.js"), true, "the page is the shared list");
});

// ── When it asks GitHub ─────────────────────────────────────────────────────

test("a file save costs GitHub nothing, hidden or shown; another repository clears the rows and loads its own", async () => {
  const gh = github(
    acmeRoutes([], world({ "acme/other": { pulls: () => [rawPull(9, { title: "Other repo PR", html_url: "https://github.com/acme/other/pull/9" })] } })),
  );
  const repos = fakeRepos(ORIGIN);
  const m = mount(repos);
  await settled(m);
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

  repos.switchTo(OTHER());
  repos.fire();
  await until(() => numbers(m).join() === "9", "the other repository's rows");
  assert.equal(m.view.description, "acme/other");
});

test("a list in sight is read again once it is stale — and nothing is asked while it is hidden", async () => {
  const gh = github(acmeRoutes());
  const auth = new GitHubAuth();
  await auth.isConnected(); // the first sign-in event, out of the way
  const list = new PullRequestsViewProvider(fakeRepos(ORIGIN) as any, auth, vscode.Uri.file("/ext"), undefined, 160);
  vscode.window.registerWebviewViewProvider("gitstudio.pullRequests", list);
  const view = pr.webviewViews.at(-1);
  onTeardown(() => (list.dispose(), auth.dispose()));
  view.receive({ type: "ready" });
  const loads = () => gql(gh, LIST_QUERY).length;
  await until(() => loads() === 1 && !!view.state()?.rows?.length, "the first load");
  await until(() => loads() >= 2, "the stale list in sight to be read again", 2000);
  view.setVisible(false);
  await sleep(100);
  const hidden = loads();
  await sleep(600);
  assert.equal(loads(), hidden, "hidden, it asks GitHub nothing");
});

// ── Pages ──────────────────────────────────────────────────────────────────

test("pages: 30 rows at a time with the total, the next page by its cursor, until all 130 are there", async () => {
  const all = Array.from({ length: 130 }, (_, i) => rawPull(1000 - i, { updated_at: new Date(Date.now() - i * 60e3).toISOString() }));
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls: () => all } })));
  const m = mount(fakeRepos(ORIGIN));
  const s = await settled(m);
  assert.equal(s.rows.length, 30);
  assert.equal(s.total, 130);
  assert.equal(s.hasMore, true);
  for (let i = 0; i < 4; i++) {
    const before = state(m).rows.length;
    m.view.receive({ type: "loadMore" });
    await until(() => state(m).rows.length > before && !state(m).loadingMore, `page ${i + 2}`);
  }
  assert.equal(state(m).rows.length, 130);
  assert.equal(new Set(numbers(m)).size, 130, "no row twice");
  assert.equal(state(m).hasMore, false);
  const cursors = gql(gh, LIST_QUERY).map((r: any) => r.body.variables.after);
  assert.deepEqual(cursors, [null, "30", "60", "90", "120"], "each page from where the last one ended");
});

test("a next page that fails says so over the rows it kept, and trying again asks for that page", async () => {
  let down = false;
  const repos = world({ "acme/app": { pulls: () => Array.from({ length: 45 }, (_, i) => rawPull(100 - i)) } });
  const answer = graphqlWorld(repos);
  github([["POST", /^\/graphql$/, (req) => (down && (req.body as any).variables.after ? { status: 502, body: { message: "Server Error" } } : answer(req))]]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  down = true;
  m.view.receive({ type: "loadMore" });
  await until(() => !!state(m).notice, "the failure to be said");
  assert.equal(state(m).rows.length, 30, "the rows stay");
  assert.match(state(m).notice.title, /^Couldn't load more: Server Error/);
  assert.deepEqual(state(m).notice.buttons.map((b: any) => b.action.kind), ["loadMore"]);
  assert.deepEqual(state(m).notice.buttons.map((b: any) => b.label), ["Retry"], "the word every other failed read uses");
  down = false;
  m.view.receive({ type: "action", action: { kind: "loadMore" } });
  await until(() => state(m).rows.length === 45, "the next page");
  assert.equal(state(m).notice, undefined);
});

// ── Segments, search and filters ───────────────────────────────────────────

test("segments: Merged, Closed and All ask GitHub for those states; a segment seen before shows at once and is read again", async () => {
  const pulls = () => [
    ...PULLS(),
    rawPull(30, { state: "closed", merged_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" }),
    rawPull(29, { state: "closed", merged_at: null, updated_at: "2026-09-19T00:00:00Z" }),
  ];
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls } })));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  assert.deepEqual(state(m).counts, { open: 3, merged: 1, closed: 1 });
  const states = () => gql(gh, LIST_QUERY).map((r: any) => r.body.variables.states);
  for (const [segment, want, rows] of [
    ["merged", ["MERGED"], [30]],
    ["closed", ["CLOSED"], [29]],
    ["all", null, [37, 36, 3, 30, 29]],
  ] as const) {
    m.view.receive({ type: "segment", segment });
    await until(() => state(m).segment === segment && state(m).status === "list" && !state(m).refreshing, segment);
    assert.deepEqual(states().at(-1), want, segment);
    assert.deepEqual(numbers(m), rows, `${segment}'s rows`);
  }
  // Back to Open: its rows are there at once — no skeleton — while GitHub is asked again.
  const asked = gql(gh, LIST_QUERY).length;
  m.view.receive({ type: "segment", segment: "open" });
  const first = m.view.posted.filter((p: any) => p.type === "state").at(-1).state;
  assert.equal(first.status, "list");
  assert.deepEqual(first.rows.map((r: any) => r.number), [37, 36, 3]);
  assert.equal(first.refreshing, true);
  await until(() => gql(gh, LIST_QUERY).length === asked + 1 && !state(m).refreshing, "Open read again");
});

test("search and facets ask GitHub's search — scoped to the repository, the counts under the same filters — and clearing them is GitHub's own list again", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  m.view.receive({ type: "filters", filters: { text: "keyboard repo:facebook/react", author: "alice" } });
  await until(() => numbers(m).join() === "36" && !state(m).refreshing, "the search's rows");
  const q = gql(gh, /list: search/).at(-1) as any;
  assert.equal(q.body.variables.q, "repo:acme/app is:pr is:open author:alice keyboard sort:updated-desc", "another repository's qualifier never reaches the search");
  assert.deepEqual(state(m).counts, { open: 1, merged: 0, closed: 0 }, "the counts answer the same question");
  m.view.receive({ type: "filters", filters: { reviewRequested: "@me" } });
  await until(() => numbers(m).join() === "3" && !state(m).refreshing, "asked to review");
  m.view.receive({ type: "action", action: { kind: "clearFilters" } });
  await until(() => numbers(m).join() === "37,36,3" && !state(m).refreshing, "the whole list again");
  assert.match(String((gql(gh, LIST_QUERY).at(-1) as any).body.query), /list: pullRequests/, "no filter: GitHub's own list");
  assert.deepEqual(state(m).filters, {});
});

test("an answer to an older search paints nothing: typing outruns GitHub", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  const slow = gh.hold(/^\/graphql$/);
  m.view.receive({ type: "filters", filters: { text: "drop" } });
  await until(() => slow.held() === 1, "the first search in flight");
  slow.release();
  // …but the user typed on before it answered.
  m.view.receive({ type: "filters", filters: { text: "reset" } });
  await until(() => state(m).filters.text === "reset" && numbers(m).join() === "3" && !state(m).refreshing, "the latest search");
  await sleep(50);
  assert.deepEqual(numbers(m), [3], "never the rows of \"drop\"");
});

test("the filter menus' labels and people: one request, asked once", async () => {
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls: PULLS, labels: [{ name: "bug", color: "d73a4a" }], people: ["alice", "bob"] } })));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  m.view.receive({ type: "facetOptions" });
  await until(() => !!state(m).facetOptions, "the options");
  m.view.receive({ type: "facetOptions" });
  await sleep(50);
  assert.equal(gql(gh, /assignableUsers/).length, 1);
  assert.deepEqual(state(m).facetOptions.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(state(m).facetOptions.people.map((p: any) => p.login), ["alice", "bob"]);
});

// ── Which repository ───────────────────────────────────────────────────────

test("a fork shows the repository it was forked from, with origin one click away — and the choice is kept", async () => {
  const repos = world({
    "me/app": { pulls: () => [rawPull(5, { title: "In my fork" })], isFork: true, parent: "acme/app" },
  });
  const gh = github(acmeRoutes([], repos));
  const remotes: Remote[] = [{ name: "origin", fetchUrl: "git@github.com:me/app.git", pushUrl: "" }];
  const store = memento();
  const m = mount(fakeRepos(remotes), store);
  await settled(m);
  assert.equal(m.view.description, "acme/app", "the parent, as github.com's own Pull requests button");
  assert.deepEqual(numbers(m), [37, 36, 3]);
  assert.deepEqual(
    state(m).targets.map((t: any) => [t.id, t.detail]),
    [
      ["acme/app", "origin was forked from it"],
      ["me/app", "remote origin — a fork of acme/app"],
    ],
  );
  // The parent has no remote here: a checkout fetches it by its URL — never
  // origin, which is the fork.
  const row = m.list.pullRequestFor(37);
  assert.equal(row.ctx.owner, "acme");
  assert.equal(row.ctx.remoteName, "https://github.com/acme/app.git");

  m.view.receive({ type: "target", id: "me/app" });
  await until(() => numbers(m).join() === "5", "origin's rows");
  assert.equal(m.view.description, "me/app");
  assert.equal(gql(gh, /isFork/).length, 1, "whether it is a fork is asked once a session");
  // The window reloads: the choice is the workspace's.
  const again = mount(fakeRepos(remotes), store);
  await until(() => numbers(again).join() === "5", "the choice kept");
});

test("a fork cloned with an upstream remote fetches the parent through that remote", async () => {
  github(acmeRoutes([], world({ "me/app": { pulls: () => [], isFork: true, parent: "acme/app" } })));
  const remotes: Remote[] = [
    { name: "origin", fetchUrl: "git@github.com:me/app.git", pushUrl: "" },
    { name: "upstream", fetchUrl: "https://github.com/acme/app.git", pushUrl: "" },
  ];
  const m = mount(fakeRepos(remotes));
  await settled(m);
  assert.equal(state(m).targets[0].detail, "remote upstream — origin was forked from it");
  assert.equal(m.list.pullRequestFor(37).ctx.remoteName, "upstream");
});

test("the view says which repository it shows — or why there is none — never a blank", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos([{ name: "origin", fetchUrl: "git@gitlab.com:acme/app.git", pushUrl: "" }]));
  const s = await settled(m);
  assert.equal(s.status, "message");
  assert.equal(s.message.title, "This repository isn't on GitHub");
  assert.match(s.message.detail, /None of this repository's remotes is on github\.com: origin \(gitlab\.com\)/);
  assert.equal(gh.requests.length, 0, "GitHub isn't asked about a GitLab repository");
  const none = mount(fakeRepos([], "/work/bare"));
  assert.equal((await settled(none)).message.title, "This repository has no remotes");
});

test("while repositories are still being found, the view says it is looking — as Changes and the graph do — then what it found", async () => {
  github(acmeRoutes());
  let discovering = true;
  const repos = { ...fakeRepos(ORIGIN), isDiscovering: () => discovering };
  repos.switchTo(undefined);
  const m = mount(repos);
  assert.equal((await settled(m)).message.title, "Looking for a repository…", "not 'Open a Git repository' while one may still turn up");
  discovering = false;
  repos.fire();
  await until(() => state(m).message?.title === "Open a Git repository to see its pull requests.", "nothing found");
  repos.switchTo(entryFor("/work/app", ORIGIN));
  repos.fire();
  await until(() => numbers(m).length === 3, "its pull requests");
});

test("a GitHub remote added, or a switch away from an error or a repo with none: the view draws the repository now active", async () => {
  github(acmeRoutes([], world({ "acme/broken": { pulls: () => [] } })));
  const remotes: Remote[] = [{ name: "origin", fetchUrl: "git@gitlab.com:acme/app.git", pushUrl: "" }];
  const repos = fakeRepos(remotes, "/work/app");
  const m = mount(repos);
  assert.equal((await settled(m)).status, "message");
  remotes.push({ name: "github", fetchUrl: "git@github.com:acme/app.git", pushUrl: "" });
  repos.fire();
  await until(() => numbers(m).length === 3, "the view to notice the new remote");
  repos.switchTo(entryFor("/work/gone", [{ name: "origin", fetchUrl: "https://github.com/acme/gone", pushUrl: "" }]));
  repos.fire();
  await until(() => state(m).status === "message" && /acme\/gone/.test(state(m).message.title), "the repository GitHub doesn't know");
  assert.equal(state(m).message.title, "GitHub has no repository acme/gone");
  repos.switchTo(entryFor("/work/app", ORIGIN));
  repos.fire();
  await until(() => numbers(m).length === 3, "back to /work/app");
  assert.equal(m.view.description, "acme/app");
});

test("github.com under another name is github.com: SSH aliases, ssh.github.com, www.github.com, ~/.ssh/config", async () => {
  mkdirSync(join(HOME, ".ssh"), { recursive: true });
  writeFileSync(join(HOME, ".ssh", "config"), "Host work\n  HostName github.com\n  User git\n");
  github(acmeRoutes());
  for (const url of ["git@github.com-work:acme/app.git", "ssh://git@ssh.github.com:443/acme/app.git", "https://www.github.com/acme/app", "git@work:acme/app.git"]) {
    const m = mount(fakeRepos([{ name: "origin", fetchUrl: url, pushUrl: "" }], `/work/${url.length}`));
    await settled(m);
    assert.equal(numbers(m).length, 3, url);
    assert.equal(m.view.description, "acme/app", url);
  }
});

// ── Sign-in and failures ───────────────────────────────────────────────────

test("signed out: the view says so and signs in from its button — GitHub isn't asked until then", async () => {
  const gh = github(acmeRoutes());
  const original = vscode.authentication.getSession;
  let session: any;
  vscode.authentication.getSession = async (_id: string, _s: string[], opts: any) => {
    if (opts?.createIfNone || opts?.forceNewSession) session = pr.session;
    return session;
  };
  onTeardown(() => (vscode.authentication.getSession = original));
  const m = mount(fakeRepos(ORIGIN));
  const s = await settled(m);
  assert.equal(s.message.title, "Sign in to GitHub to see pull requests");
  assert.deepEqual(s.message.buttons.map((b: any) => [b.label, b.action.kind]), [["Sign in to GitHub", "signIn"]]);
  assert.equal(gh.requests.length, 0);
  m.view.receive({ type: "action", action: s.message.buttons[0].action });
  await until(() => numbers(m).length === 3, "the list, once signed in");
});

test("a refresh that fails says so above the rows it kept; a first load that fails offers its way out", async () => {
  let down: { status: number; body: unknown } | undefined;
  const answer = graphqlWorld(world());
  github([["POST", /^\/graphql$/, (req) => down ?? answer(req)]]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  down = { status: 502, body: { message: "Server Error" } };
  await vscode.commands.executeCommand("gitstudio.pr.refresh");
  await until(() => !!state(m).notice, "the refresh to fail");
  assert.deepEqual(numbers(m), [37, 36, 3], "the last good list stays");
  assert.match(state(m).notice.title, /^Couldn't refresh: Server Error/);
  assert.match(state(m).notice.detail, /^Showing the list as it was /);

  // Nothing loaded yet: the view says what to do, and doing it is one click.
  const m2 = mount(fakeRepos(ORIGIN, "/work/app2"));
  const s2 = await settled(m2);
  assert.equal(s2.message.title, "Couldn't load pull requests");
  assert.deepEqual(s2.message.buttons.map((b: any) => b.action.kind), ["retry"]);
  down = undefined;
  m2.view.receive({ type: "action", action: { kind: "retry" } });
  await until(() => numbers(m2).length === 3, "the retry to load");
});

test("an expired sign-in's button signs in AGAIN — a new session, not the one GitHub just refused", async () => {
  let token = "revoked";
  const asks: any[] = [];
  const original = vscode.authentication.getSession;
  vscode.authentication.getSession = async (_id: string, _scopes: string[], opts: any) => {
    asks.push(opts);
    if (opts?.forceNewSession) token = "fresh";
    return { ...pr.session, accessToken: token };
  };
  onTeardown(() => (vscode.authentication.getSession = original));
  const answer = graphqlWorld(world());
  github([
    ["POST", /^\/graphql$/, (req) => (req.headers.authorization === "Bearer fresh" ? answer(req) : { status: 401, body: { message: "Bad credentials" } })],
  ]);
  const m = mount(fakeRepos(ORIGIN));
  const s = await settled(m);
  assert.equal(s.message.title, "Your GitHub session expired");
  const button = s.message.buttons[0];
  assert.deepEqual(button.action, { kind: "signIn", again: true });
  m.view.receive({ type: "action", action: button.action });
  await until(() => numbers(m).length === 3, "the list, with the new sign-in");
  assert.ok(asks.some((o) => o?.forceNewSession), `a new session is asked for (asked: ${JSON.stringify(asks)})`);
});

test("a 403 is not a sign-in problem: its button opens GitHub — its SSO authorization when it names one", async () => {
  let sso = false;
  const answer = graphqlWorld(world());
  github([
    [
      "POST",
      /^\/graphql$/,
      (req) =>
        /list: /.test((req.body as any).query)
          ? sso
            ? { status: 403, body: { message: "Resource protected by organization SAML enforcement." }, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=abc" } }
            : { status: 403, body: { message: "Must have push access to view repository collaborators." } }
          : answer(req),
    ],
  ]);
  const plain = (await settled(mount(fakeRepos(ORIGIN, "/work/app1")))).message;
  assert.equal(plain.buttons[0].label, "Open on GitHub");
  assert.deepEqual(plain.buttons[0].action, { kind: "openUrl", url: "https://github.com/acme/app/pulls" });
  assert.ok(!plain.buttons.some((b: any) => b.action.kind === "signIn"), "signing in again would not change it");
  sso = true;
  const m = mount(fakeRepos(ORIGIN, "/work/app2"));
  const saml = (await settled(m)).message;
  assert.equal(saml.buttons[0].label, "Authorize on GitHub");
  m.view.receive({ type: "action", action: saml.buttons[0].action });
  await until(() => pr.opened.length === 1, "GitHub's page to open");
  assert.match(pr.opened[0], /\/orgs\/acme\/sso/, "GitHub's own authorization page");
});

// ── An answer belongs to its question ──────────────────────────────────────

test("a refresh of one repository that answers after a switch to another paints nothing over it", async () => {
  let down = false;
  const answer = graphqlWorld(world({ "acme/other": { pulls: () => [rawPull(9, { title: "Other repo PR" })] } }));
  const gh = github([
    ["POST", /^\/graphql$/, (req) => (down && (req.body as any).variables?.owner === "acme" && (req.body as any).variables?.name === "app" ? { status: 502, body: { message: "Server Error (acme/app)" } } : answer(req))],
  ]);
  const repos = fakeRepos(ORIGIN);
  const m = mount(repos);
  await settled(m);
  down = true;
  const slow = gh.hold((req: any) => /list: /.test(req.body?.query ?? "") && req.body?.variables?.name === "app");
  await vscode.commands.executeCommand("gitstudio.pr.refresh"); // acme/app's refresh, in flight
  await until(() => slow.held() > 0, "acme/app's refresh to be in flight");
  // …the user switches before it answers.
  repos.switchTo(OTHER());
  repos.fire();
  await until(() => numbers(m).join() === "9", "acme/other's rows");
  slow.release();
  await sleep(100);
  // Painted again (the view reloaded): what it holds is acme/other's, whole.
  const at = m.view.posted.length;
  m.view.receive({ type: "ready" });
  const repainted = m.view.posted[at].state;
  assert.deepEqual(repainted.rows.map((r: any) => r.number), [9], "what it holds is acme/other's");
  assert.equal(repainted.notice, undefined, "no \"Couldn't refresh\" of acme/app's over acme/other's list");
  assert.deepEqual(numbers(m), [9]);
  assert.equal(m.view.description, "acme/other");
});

test("a first load of one repository that answers after a switch to another paints nothing over it", async () => {
  for (const outcome of ["fails", "answers"] as const) {
    const answer = graphqlWorld(world({ "acme/other": { pulls: () => [rawPull(9, { title: "Other repo PR" })] } }));
    const isAppsList = (req: any) => /list: /.test(req.body?.query ?? "") && req.body?.variables?.name === "app";
    const gh = github([
      ["POST", /^\/graphql$/, (req) => (outcome === "fails" && isAppsList(req) ? { status: 502, body: { message: "Server Error (acme/app)" } } : answer(req))],
    ]);
    const slow = gh.hold(isAppsList);
    const repos = fakeRepos(ORIGIN, `/work/app-${outcome}`);
    const m = mount(repos);
    await until(() => slow.held() === 1, "acme/app's first load in flight");
    repos.switchTo(OTHER());
    repos.fire();
    await until(() => numbers(m).join() === "9", "acme/other's rows");
    slow.release();
    await sleep(100);
    // Painted again (the view reloaded): what it holds is acme/other's, whole.
    const at = m.view.posted.length;
    m.view.receive({ type: "ready" });
    const repainted = m.view.posted[at].state;
    assert.deepEqual(repainted.rows.map((r: any) => r.number), [9], `what it holds is acme/other's (acme/app's load ${outcome})`);
    assert.equal(repainted.status, "list");
    assert.deepEqual(numbers(m), [9], `acme/other's rows (acme/app's load ${outcome})`);
    assert.equal(m.view.description, "acme/other");
    assert.equal(state(m).status, "list", `no ${outcome === "fails" ? "failure" : "rows"} of acme/app's over acme/other's list`);
    gh.restore();
  }
});

// ── Checked out here ───────────────────────────────────────────────────────

test("the PR whose branch is checked out says so — and a branch switch re-reads git, never GitHub", async () => {
  let branch = "feature-36";
  const git: GitAnswer = (args) => {
    if (args[0] === "symbolic-ref") return { code: 0, stdout: `${branch}\n` };
    if (args[0] === "for-each-ref" && args.at(-1) === `refs/heads/${branch}`) return { code: 0, stdout: `origin\0refs/heads/${branch}\n` };
    return undefined;
  };
  const gh = github(acmeRoutes());
  const repos = fakeRepos(ORIGIN, "/work/app", git);
  const m = mount(repos);
  await until(() => rowOf(m, 36)?.checkedOut === true, "#36 marked checked out");
  assert.deepEqual(state(m).rows.filter((r: any) => r.checkedOut).map((r: any) => r.number), [36]);
  const asked = gh.requests.length;
  branch = "feature-37";
  repos.fire();
  await until(() => rowOf(m, 37)?.checkedOut === true, "#37 now");
  assert.equal(rowOf(m, 36).checkedOut, false);
  assert.equal(gh.requests.length, asked, "a branch switch asks GitHub nothing");
  // Option-like branch names never become arguments: the ref read is qualified.
  branch = "-x";
  repos.fire();
  await until(() => !state(m).rows.some((r: any) => r.checkedOut), "nothing checked out");
});

// ── Our own mutations ──────────────────────────────────────────────────────

test("a merge from the page moves the row out of Open and the counts with it; a new PR joins the top — neither reloads the list", async () => {
  let merged = false;
  const pulls = () => PULLS().map((p) => (merged && p.number === 3 ? { ...p, state: "closed", merged_at: "2026-09-26T00:00:00Z" } : p));
  const gh = github([
    ["PUT", /^\/repos\/acme\/app\/pulls\/3\/merge$/, () => ((merged = true), { body: { merged: true } })],
    ...acmeRoutes([], world({ "acme/app": { pulls } })),
  ]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  const loads = gql(gh, LIST_QUERY).length;
  // The row's Merge… opens the page's merge box; the merge happens there.
  await vscode.commands.executeCommand("gitstudio.pr.merge", m.list.pullRequestFor(3));
  const page = pr.panels.find((p: any) => p.title === "acme/app#3");
  page.receive({ type: "ready" });
  await until(() => page.state()?.status === "ready", "the page");
  assert.deepEqual(dialogs.asked, [], "no question in the sidebar");
  page.receive({ type: "merge", method: "squash", deleteBranch: false });
  await until(() => numbers(m).length === 2, "the row to leave Open");
  assert.deepEqual(numbers(m), [37, 36]);
  assert.deepEqual(state(m).counts, { open: 2, merged: 1, closed: 0 });
  m.list.addPr("acme", "app", {
    ...m.list.pullRequestFor(37).pr,
    number: 40,
    title: "A new one",
  });
  assert.deepEqual(numbers(m), [40, 37, 36]);
  assert.deepEqual(state(m).counts, { open: 3, merged: 1, closed: 0 });
  assert.equal(gql(gh, LIST_QUERY).length, loads, "patched, not reloaded");
});

test("closing, reopening and marking ready move the row between the segments on hand — patched, never read again", async () => {
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls: () => [...PULLS(), rawPull(20, { state: "closed", updated_at: "2026-09-01T00:00:00Z" })] } })));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  m.view.receive({ type: "segment", segment: "closed" });
  await until(() => state(m).segment === "closed" && state(m).status === "list" && !state(m).refreshing, "Closed");
  m.view.receive({ type: "segment", segment: "all" });
  await until(() => state(m).segment === "all" && state(m).status === "list" && !state(m).refreshing, "All");
  m.view.receive({ type: "segment", segment: "open" });
  await until(() => state(m).segment === "open" && !state(m).refreshing, "Open");
  // What GitHub would say is held: every row below is the patch's own.
  const held = gh.hold((req) => req.path === "/graphql");
  const loads = gql(gh, LIST_QUERY).length;
  const asksNothing = async (what: string) => {
    const before = held.held();
    await sleep(40);
    assert.equal(held.held(), before, `${what}: GitHub is asked nothing`);
  };
  m.list.markKind("acme", "app", 37, "closed");
  await asksNothing("closed");
  assert.deepEqual(numbers(m), [36, 3], "closed: out of Open");
  assert.deepEqual(state(m).counts, { open: 2, merged: 0, closed: 2 });
  m.view.receive({ type: "segment", segment: "closed" });
  await until(() => state(m).segment === "closed", "Closed again");
  assert.deepEqual(numbers(m).slice(0, 1), [37], "…and at the top of Closed, at once");
  m.list.markKind("acme", "app", 37, "open");
  await asksNothing("reopened");
  assert.ok(!numbers(m).includes(37), "reopened: out of Closed");
  m.view.receive({ type: "segment", segment: "open" });
  await until(() => state(m).segment === "open", "Open again");
  assert.equal(numbers(m)[0], 37, "back in Open");
  m.list.markKind("acme", "app", 36, "open");
  await asksNothing("ready");
  assert.equal(state(m).rows.find((r: any) => r.number === 36).kind, "open", "a draft marked ready reads Open where it is");
  assert.equal(gql(gh, LIST_QUERY).length, loads, "nothing was answered by GitHub meanwhile");
  held.release();
});

// A number is not an identity: acme/app#37 and a fork's own me/app#37 are
// two pull requests. A patch touches the lists of ITS repository — shown or
// not — and the counts of the lists known to count it (no filters, or the
// filters of a list that had the row), never another filter's.
test("a merge patches its own repository's lists only — a fork's own #37 stays — and the counts of the lists that count it", async () => {
  const repos = world({
    "me/app": {
      pulls: () => [rawPull(37, { title: "The fork's own 37", html_url: "https://github.com/me/app/pull/37" }), rawPull(8, { title: "Fork 8", html_url: "https://github.com/me/app/pull/8" })],
      isFork: true,
      parent: "acme/app",
    },
  });
  const gh = github(acmeRoutes([], repos));
  const m = mount(fakeRepos([{ name: "origin", fetchUrl: "git@github.com:me/app.git", pushUrl: "" }]));
  await settled(m);
  assert.deepEqual(numbers(m), [37, 36, 3], "the parent");
  m.view.receive({ type: "target", id: "me/app" });
  await until(() => state(m).target === "me/app" && !state(m).refreshing && numbers(m).includes(8), "the fork's rows");
  const fork = { rows: numbers(m), counts: state(m).counts };
  m.view.receive({ type: "target", id: "acme/app" });
  await until(() => state(m).target === "acme/app" && !state(m).refreshing && numbers(m).includes(36), "the parent's rows");
  // What GitHub would say is held: every row below is the patch's own.
  const held = gh.hold((req) => req.path === "/graphql");
  m.list.markKind("acme", "app", 37, "merged");
  assert.deepEqual(numbers(m), [36, 3], "acme/app#37 leaves the parent's Open");
  m.view.receive({ type: "target", id: "me/app" });
  await until(() => state(m).target === "me/app", "the fork again, from what is on hand");
  assert.deepEqual(numbers(m), fork.rows, "me/app#37 is another pull request: it stays");
  assert.deepEqual(state(m).counts, fork.counts, "…and the fork's counts don't move");
  // The parent's lists are patched while the fork is shown — and a new pull
  // request made on the parent joins them, not the fork's.
  m.list.markKind("acme", "app", 36, "closed");
  m.list.addPr("acme", "app", { ...m.list.pullRequestFor(37).pr, number: 40, title: "A new one", htmlUrl: "https://github.com/acme/app/pull/40", base: { ...m.list.pullRequestFor(37).pr.base, repoFullName: "acme/app" } });
  assert.deepEqual(numbers(m), fork.rows, "the fork's list shown is untouched");
  m.view.receive({ type: "target", id: "acme/app" });
  await until(() => state(m).target === "acme/app", "the parent again, from what is on hand");
  assert.deepEqual(numbers(m), [40, 3], "the parent's: the new one on top, #36 closed while it wasn't shown");
  assert.deepEqual(state(m).counts, { open: 2, merged: 1, closed: 1 });
  held.release();
});

test("a merge moves the counts of the lists that count the row — never another author's", async () => {
  const pulls = () => PULLS().map((p: any) => ({ ...p, user: { login: p.number === 37 ? "bob" : "alice", avatar_url: null } }));
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls } })));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  const visit = async (filters: Record<string, string>, segment = "open") => {
    m.view.receive({ type: "segment", segment });
    m.view.receive({ type: "filters", filters });
    await until(
      () => state(m).segment === segment && JSON.stringify(state(m).filters) === JSON.stringify(filters) && state(m).status === "list" && !state(m).refreshing,
      `${segment} ${JSON.stringify(filters)}`,
    );
    return { rows: numbers(m), counts: state(m).counts };
  };
  const alice = await visit({ author: "alice" });
  assert.deepEqual(alice.rows, [36, 3]);
  const bob = await visit({ author: "bob" });
  assert.deepEqual(bob.rows, [37]);
  assert.deepEqual((await visit({ author: "bob" }, "merged")).rows, []);
  await visit({});
  const held = gh.hold((req) => req.path === "/graphql");
  m.list.markKind("acme", "app", 37, "merged"); // bob's
  assert.deepEqual(numbers(m), [36, 3]);
  assert.deepEqual(state(m).counts, { open: 2, merged: 1, closed: 0 }, "no filters: counted");
  const look = async (filters: Record<string, string>, segment = "open") => {
    m.view.receive({ type: "segment", segment });
    m.view.receive({ type: "filters", filters });
    await until(() => state(m).segment === segment && JSON.stringify(state(m).filters) === JSON.stringify(filters), "from what is on hand");
    return { rows: numbers(m), counts: state(m).counts };
  };
  assert.deepEqual(await look({ author: "alice" }), alice, "alice's list never had bob's pull request: rows and counts stay");
  assert.deepEqual((await look({ author: "bob" })).counts, { ...bob.counts, open: bob.counts.open - 1, merged: bob.counts.merged + 1 }, "bob's: counted");
  assert.deepEqual((await look({ author: "bob" }, "merged")).rows, [37], "…and it joins bob's Merged, which it now belongs to");
  held.release();
});

// A Checkout of a fork's pull request adds the fork's remote (and a failed
// one removes it again): the repository shown is still there, so the list
// keeps its rows, its filters and every list on hand — the switcher learns
// of the new repository, and GitHub is asked nothing. Only the repository
// shown going away (a remote removed or re-pointed) starts the view over.
test("a remote added or removed (a fork's, for a checkout) keeps the rows, the filters and every list on hand — GitHub isn't asked", async () => {
  const gh = github(acmeRoutes([], world({ "alice/app": { pulls: () => [], isFork: true, parent: "acme/app" }, "acme/other": { pulls: () => [rawPull(9)] } })));
  const remotes: Remote[] = [{ name: "origin", fetchUrl: "git@github.com:acme/app.git", pushUrl: "" }];
  const repos = fakeRepos(remotes, "/work/app");
  const m = mount(repos);
  await settled(m);
  m.view.receive({ type: "filters", filters: { author: "me" } });
  await until(() => state(m).filters.author === "me" && state(m).status === "list" && !state(m).refreshing, "a filter");
  const rows = numbers(m);
  const lists = gql(gh, LIST_QUERY).length;
  const asked = gh.requests.length;
  const posted = m.view.posted.length;
  // `git remote add alice …`, as checkoutPr.ts does; RepoManager fires.
  remotes.push({ name: "alice", fetchUrl: "git@github.com:alice/app.git", pushUrl: "" });
  repos.fire();
  await until(() => state(m).targets.length === 2, "the switcher to learn of alice/app");
  assert.deepEqual(state(m).targets.map((t: any) => [t.id, t.detail]), [["acme/app", "remote origin"], ["alice/app", "remote alice"]]);
  assert.deepEqual(state(m).filters, { author: "me" }, "the filter stays");
  assert.deepEqual(numbers(m), rows, "the rows stay");
  const states = m.view.posted.slice(posted).filter((p: any) => p.type === "state").map((p: any) => p.state.status);
  assert.ok(states.every((x: string) => x === "list"), `never a placeholder: ${states}`);
  assert.equal(gh.requests.length, asked, "GitHub is asked nothing");
  // The remote goes again (a Checkout that failed): the same.
  remotes.pop();
  repos.fire();
  await until(() => state(m).targets.length === 1, "the switcher to forget alice/app");
  assert.deepEqual(state(m).filters, { author: "me" });
  assert.deepEqual(numbers(m), rows);
  // Back to no filter: the list on hand, at once.
  m.view.receive({ type: "filters", filters: {} });
  assert.deepEqual(numbers(m), [37, 36, 3], "the unfiltered list was kept too");
  await until(() => !state(m).refreshing, "its refresh");
  assert.equal(gql(gh, LIST_QUERY).length, lists + 1, "one read: the refresh a list on hand gets when shown again, as before");
  // The repository shown goes away (origin re-pointed): the view starts over, on the new one.
  remotes[0] = { name: "origin", fetchUrl: "git@github.com:acme/other.git", pushUrl: "" };
  repos.fire();
  await until(() => state(m).target === "acme/other" && numbers(m).join() === "9", "the new repository");
});

test("an upstream remote added for a fork's parent: checkouts fetch through it from then on — nothing re-read", async () => {
  const gh = github(acmeRoutes([], world({ "me/app": { pulls: () => [], isFork: true, parent: "acme/app" } })));
  const remotes: Remote[] = [{ name: "origin", fetchUrl: "git@github.com:me/app.git", pushUrl: "" }];
  const repos = fakeRepos(remotes);
  const m = mount(repos);
  await settled(m);
  assert.equal(m.list.pullRequestFor(37).ctx.remoteName, "https://github.com/acme/app.git", "no remote names the parent: its URL");
  const asked = gh.requests.length;
  remotes.push({ name: "upstream", fetchUrl: "https://github.com/acme/app.git", pushUrl: "" });
  repos.fire();
  await until(() => m.list.pullRequestFor(37)?.ctx.remoteName === "upstream", "the parent's remote");
  assert.equal(state(m).targets[0].detail, "remote upstream — origin was forked from it");
  assert.deepEqual(numbers(m), [37, 36, 3]);
  assert.equal(gh.requests.length, asked, "GitHub is asked nothing: whether origin is a fork is known");
});

test("a refresh re-reads every row on screen — 130 paged in stay 130, read 100 then 30 — and so does the stale poll", async () => {
  const all = Array.from({ length: 130 }, (_, i) => rawPull(1000 - i, { updated_at: new Date(Date.now() - i * 60e3).toISOString() }));
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls: () => all } })));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  for (let i = 0; i < 4; i++) {
    const before = state(m).rows.length;
    m.view.receive({ type: "loadMore" });
    await until(() => state(m).rows.length > before && !state(m).loadingMore, `page ${i + 2}`);
  }
  assert.equal(state(m).rows.length, 130);
  const before = gql(gh, LIST_QUERY).length;
  m.view.receive({ type: "refresh" });
  await until(() => !state(m).refreshing, "the refresh");
  assert.equal(state(m).rows.length, 130, "every row paged in stays");
  assert.equal(new Set(numbers(m)).size, 130, "no row twice");
  assert.equal(state(m).hasMore, false);
  const pages = gql(gh, LIST_QUERY).slice(before).map((r: any) => [r.body.variables.first, r.body.variables.after]);
  assert.deepEqual(pages, [[100, null], [30, "100"]], "a page of 100, then the rest");
  // 45 on screen: one read of 45.
  const m2 = mount(fakeRepos(ORIGIN, "/work/two"));
  await until(() => state(m2).rows.length === 30, "the second list");
  m2.view.receive({ type: "loadMore" });
  await until(() => state(m2).rows.length === 60 && !state(m2).loadingMore, "60 rows");
  const b2 = gql(gh, LIST_QUERY).length;
  m2.view.receive({ type: "refresh" });
  await until(() => !state(m2).refreshing, "its refresh");
  assert.deepEqual(gql(gh, LIST_QUERY).slice(b2).map((r: any) => r.body.variables.first), [60], "what is on screen, in one read");
  assert.equal(state(m2).rows.length, 60);
  assert.equal(state(m2).hasMore, true, "and the rest still a page away");
  // The stale poll, every few minutes while the list is in sight: the same read.
  const auth = new GitHubAuth();
  await auth.isConnected();
  const list = new PullRequestsViewProvider(fakeRepos(ORIGIN, "/work/three") as any, auth, vscode.Uri.file("/ext"), undefined, 600);
  vscode.window.registerWebviewViewProvider("gitstudio.pullRequests", list);
  const view = pr.webviewViews.at(-1);
  onTeardown(() => (list.dispose(), auth.dispose()));
  view.receive({ type: "ready" });
  await until(() => view.state()?.rows?.length === 30, "the third list");
  for (let i = 0; i < 4; i++) {
    const n = view.state().rows.length;
    view.receive({ type: "loadMore" });
    await until(() => view.state().rows.length > n && !view.state().loadingMore, `its page ${i + 2}`);
  }
  const b3 = gql(gh, LIST_QUERY).length;
  await until(() => gql(gh, LIST_QUERY).length >= b3 + 2 && !view.state().refreshing, "the stale list in sight to be read again", 3000);
  assert.equal(view.state().rows.length, 130, "the poll keeps every row paged in: no list shrinking under the reader");
});

test("a list closed while it re-reads its rows asks GitHub for nothing more", async () => {
  // 130 rows on screen: a refresh reads them 100 then 30. Closed while the
  // first is in flight, it asks for no second (the old tree went on paging
  // GitHub, up to ten pages, for rows nobody would see).
  const all = Array.from({ length: 130 }, (_, i) => rawPull(1000 - i, { updated_at: new Date(Date.now() - i * 60e3).toISOString() }));
  const gh = github(acmeRoutes([], world({ "acme/app": { pulls: () => all } })));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  for (let i = 0; i < 4; i++) {
    const n = state(m).rows.length;
    m.view.receive({ type: "loadMore" });
    await until(() => state(m).rows.length > n && !state(m).loadingMore, `page ${i + 2}`);
  }
  assert.equal(state(m).rows.length, 130);
  const before = gql(gh, LIST_QUERY).length;
  const slow = gh.hold((req: any) => req.path === "/graphql" && LIST_QUERY.test(String(req.body?.query ?? "")));
  m.view.receive({ type: "refresh" });
  await until(() => slow.held() === 1, "the first of the refresh's two pages");
  m.dispose(); // the window closes, the extension with it
  slow.release();
  await sleep(150);
  assert.equal(gql(gh, LIST_QUERY).length - before, 1, "the page in flight is the last one");
});

// The Pull Requests view is collapsed until opened: its page never says
// "ready", and the list never resolves. The palette's commands and the New
// pull request form act where the list WOULD — a fork's parent, or the
// repository chosen in it before — not origin, the fork.
test("the palette acts where the list would, before the view has ever been opened: a fork's parent — or the one chosen before", async () => {
  const gh = github([
    ["GET", /^\/repos\/me\/app\/pulls\?state=open/, () => ({ body: [rawPull(8, { title: "In my fork" })] })],
    ...acmeRoutes([], world({ "me/app": { pulls: () => [], isFork: true, parent: "acme/app" } })),
  ]);
  const register = (store: any) => {
    const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext"), workspaceState: store };
    registerPrFeature(context as any, fakeRepos([{ name: "origin", fetchUrl: "git@github.com:me/app.git", pushUrl: "" }]) as any, { isEnabled: async () => false } as any);
    onTeardown(() => context.subscriptions.forEach((d) => d.dispose()));
  };
  const lists = () => gh.requests.filter((r) => /\/pulls\?state=open/.test(r.path)).map((r) => r.path.split("/pulls")[0]);
  const store = memento();
  register(store);
  dialogs.answer = (spec: any) => spec.choices?.[0]?.id;
  await vscode.commands.executeCommand("gitstudio.pr.copyUrl");
  assert.deepEqual(lists(), ["/repos/acme/app"], "the parent's open pull requests are offered");
  assert.equal(dialogs.asked[0].choices[0].detail, "#37");
  assert.equal(pr.clipboard, "https://github.com/acme/app/pull/37");
  // Chosen in the list before (a window ago): the fork.
  const chosen = memento();
  await chosen.update("gitstudio.pr.target:/work/app", "me/app");
  register(chosen);
  await vscode.commands.executeCommand("gitstudio.pr.copyUrl");
  assert.deepEqual(lists().slice(1), ["/repos/me/app"], "the repository chosen in the list");
});

test("a row's actions act on THAT pull request, in the repository the list shows", async () => {
  github(acmeRoutes([], world({ "me/app": { pulls: () => [], isFork: true, parent: "acme/app" } })));
  const m = mount(fakeRepos([{ name: "origin", fetchUrl: "git@github.com:me/app.git", pushUrl: "" }]));
  await settled(m);
  for (const type of ["open", "checkout", "startReview", "copyLink"]) {
    pr.executed.length = 0;
    const original = pr.commands.get(`gitstudio.pr.${type === "open" ? "openDescription" : type === "copyLink" ? "copyUrl" : type}`);
    let got: any;
    pr.commands.set(`gitstudio.pr.${type === "open" ? "openDescription" : type === "copyLink" ? "copyUrl" : type}`, (arg: any) => {
      got = arg;
    });
    m.view.receive({ type, number: 36 });
    await until(() => got !== undefined, `${type} to run`);
    pr.commands.set(`gitstudio.pr.${type === "open" ? "openDescription" : type === "copyLink" ? "copyUrl" : type}`, original);
    assert.equal(got.pr.number, 36, type);
    assert.deepEqual([got.ctx.owner, got.ctx.repo], ["acme", "app"], `${type}: the parent the list shows, not origin`);
  }
  m.view.receive({ type: "openOnGitHub", number: 36 });
  await until(() => pr.opened.length === 1, "GitHub to open");
  assert.equal(pr.opened[0], "https://github.com/acme/app/pull/36");
});

// ── The manifest ───────────────────────────────────────────────────────────

test("the manifest: the view is a webview, with nothing left of the tree that no longer draws", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const view = pkg.contributes.views.gitstudio.find((v: any) => v.id === "gitstudio.pullRequests");
  assert.equal(view.type, "webview");
  // VS Code shows viewsWelcome only in a tree: a connect prompt there would
  // never appear. The list says it itself.
  assert.ok(!(pkg.contributes.viewsWelcome ?? []).some((w: any) => w.view === "gitstudio.pullRequests"));
  const menus = Object.values(pkg.contributes.menus).flat() as any[];
  const stale = menus.filter((m) => /view == gitstudio\.pullRequests/.test(m.when ?? "") && /viewItem/.test(m.when ?? ""));
  assert.deepEqual(stale, [], "no menu on a tree row that no longer exists");
});
