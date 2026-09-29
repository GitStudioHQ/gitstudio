// The Pull Requests list's host (src/pr/pullRequestsView.ts) through the
// feature's REAL provider (prTestKit): the rows of its state table that
// prListView.test.ts leaves out — a first load stopped by the rate limit or
// the network, a refresh GitHub refuses with 401 minutes after the list was
// read, the filter menus when GitHub won't list them, the list's own
// buttons, a merge patched in from elsewhere, and reading the local head.

import { acmeRoutes, fakeRepos, github, memento, mount, numbers, ORIGIN, onTeardown, pr, settled, state, until, vscode, world } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { graphqlWorld } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { readLocalHead } = require("../src/pr/pullRequestsView") as typeof import("../src/pr/pullRequestsView");
/* eslint-enable @typescript-eslint/no-require-imports */

const isList = (req: any) => /list: /.test(String(req.body?.query ?? ""));

test("a first load stopped by GitHub's rate limit says so, with Retry", async () => {
  const answer = graphqlWorld(world());
  github([["POST", /^\/graphql$/, (req) => (isList(req) ? { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } } : answer(req))]]);
  const s = await settled(mount(fakeRepos(ORIGIN)));
  assert.equal(s.status, "message");
  assert.equal(s.message.title, "GitHub's rate limit was reached");
  assert.match(s.message.detail, /^GitHub rate limit reached\. Try again after /);
  assert.deepEqual(s.message.buttons.map((b: any) => b.action.kind), ["retry"]);
});

test("a first load that can't reach GitHub says to check the network, Retry first", async () => {
  const answer = graphqlWorld(world());
  github([
    [
      "POST",
      /^\/graphql$/,
      (req) => {
        if (isList(req)) throw new TypeError("fetch failed");
        return answer(req);
      },
    ],
  ]);
  const s = await settled(mount(fakeRepos(ORIGIN)));
  assert.equal(s.message.title, "Couldn't reach GitHub");
  assert.equal(s.message.detail, "Check your network connection.");
  assert.deepEqual(s.message.buttons.map((b: any) => [b.label, b.primary]), [["Retry", true]]);
});

test("a refresh refused with 401 keeps the rows, says how long ago they were read, and offers Sign in again", async () => {
  let expired = false;
  const answer = graphqlWorld(world());
  github([["POST", /^\/graphql$/, (req) => (expired && isList(req) ? { status: 401, body: { message: "Bad credentials" } } : answer(req))]]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  // Three minutes on.
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60_000;
  onTeardown(() => (Date.now = realNow));
  expired = true;
  await vscode.commands.executeCommand("gitstudio.pr.refresh");
  await until(() => !!state(m).notice, "the refresh to fail");
  Date.now = realNow;
  const n = state(m).notice;
  assert.deepEqual(numbers(m), [37, 36, 3], "the rows stay");
  assert.equal(n.title, "Couldn't refresh: Your GitHub session expired. Sign in again to continue.");
  assert.equal(n.detail, "Showing the list as it was 3 minutes ago.");
  assert.deepEqual(n.buttons, [{ label: "Sign in again", icon: "sign-in", action: { kind: "signIn", again: true } }]);
});

test("filter menus GitHub won't list offer nothing, rather than spinning", async () => {
  const answer = graphqlWorld(world());
  github([["POST", /^\/graphql$/, (req) => (/assignableUsers/.test(String((req.body as any).query)) ? { status: 502, body: { message: "Bad gateway" } } : answer(req))]]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  m.view.receive({ type: "facetOptions" });
  await until(() => !!state(m).facetOptions, "the options");
  assert.deepEqual(state(m).facetOptions, { labels: [], people: [], truncated: false });
  assert.equal(state(m).facetOptionsLoading, undefined);
});

test("the list's own buttons: New pull request and Switch repository run their commands", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  // The form itself is prCreateForm's: here, only that the list asks for it.
  const create = pr.commands.get("gitstudio.pr.create");
  const asked: unknown[] = [];
  pr.commands.set("gitstudio.pr.create", (...a: unknown[]) => void asked.push(a));
  onTeardown(() => pr.commands.set("gitstudio.pr.create", create));
  m.view.receive({ type: "action", action: { kind: "createPr" } });
  m.view.receive({ type: "action", action: { kind: "switchRepository" } });
  await until(() => pr.executed.some((e: any) => e.id === "gitstudio.switchRepository"), "Switch repository");
  assert.equal(asked.length, 1);
});

test("a merge made elsewhere (markMerged) moves the row out of Open without reading the list again", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN), memento());
  await settled(m);
  const lists = gh.requests.filter(isList).length;
  m.list.markMerged("acme", "app", 36);
  await until(() => !numbers(m).includes(36), "the row to leave Open");
  assert.deepEqual(numbers(m), [37, 3]);
  assert.equal(gh.requests.filter(isList).length, lists);
});

test("a closed view is sent nothing more", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  m.view.dispose();
  const posts = m.view.posted.length;
  await m.list.refresh();
  m.list.markMerged("acme", "app", 37);
  assert.equal(m.view.posted.length, posts);
});

// ── The branch checked out ─────────────────────────────────────────────────

test("readLocalHead: the branch, what it tracks and in which GitHub repository — nothing when git can't say", async () => {
  const git = (answers: Record<string, { code: number; stdout: string }>) => ({
    ctx: { process: { run: async (args: string[]) => answers[args[0]] ?? { code: 1, stdout: "" } } },
  });
  const remotes = [{ name: "upstream", owner: "acme", repo: "app" }];
  assert.deepEqual(
    await readLocalHead(git({ "symbolic-ref": { code: 0, stdout: "feature\n" }, "for-each-ref": { code: 0, stdout: "upstream\0refs/heads/feature-7\n" } }) as any, remotes),
    { branch: "feature", upstream: { branch: "feature-7", repo: "acme/app" } },
  );
  assert.deepEqual(
    await readLocalHead(git({ "symbolic-ref": { code: 0, stdout: "feature\n" }, "for-each-ref": { code: 0, stdout: "elsewhere\0refs/heads/x\n" } }) as any, remotes),
    { branch: "feature", upstream: { branch: "x" } },
    "tracked on a remote that isn't GitHub's",
  );
  assert.deepEqual(await readLocalHead(git({ "symbolic-ref": { code: 0, stdout: "feature\n" } }) as any, remotes), { branch: "feature" });
  assert.deepEqual(await readLocalHead(git({}) as any, remotes), {}, "detached");
  assert.deepEqual(await readLocalHead(git({ "symbolic-ref": { code: 0, stdout: "  \n" } }) as any, remotes), {});
  const throwing: any = { ctx: { process: { run: async () => Promise.reject(new Error("spawn git ENOENT")) } } };
  assert.equal(await readLocalHead(throwing, remotes), undefined);
});
