// The desktop's GitHub layer (main/githubBridge.ts) end to end, over a fake
// api.github.com and a stubbed Electron `app.getPath`: signing in (a pasted
// token, the device flow) and out, where the token lives and what a fresh
// launch makes of it, which repository the calls are about (origin, then
// upstream, then any other remote), and the thin data calls — including the
// rule that "not signed in" is empty while a FAILED read is not.

import { electron } from "./ghFakeElectron"; // first: seeds `electron` for the bridge
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, page, reply, type FakeReply } from "./ghFakeApi";
import { GitHubBridge } from "../src/main/githubBridge";
import { isExpectedError } from "../src/main/expectedError";
import type { RepoStore } from "../src/main/repoStore";
import { SecretStore } from "@gitstudio/secret-store/secretStore";

const DEVICE = "POST https://github.com/login/device/code";
const TOKEN = "POST https://github.com/login/oauth/access_token";

type Remotes = Record<string, string>;

/** A RepoStore whose one repository has these remotes (name → URL). */
/** `null`: no repository open. */
function repoWith(remotes: Remotes | null, root = "/work/repo"): { store: RepoStore; runs: string[][]; remotes: Remotes } {
  const runs: string[][] = [];
  const live: Remotes = { ...(remotes ?? {}) };
  const ctx = {
    root,
    process: {
      run: async (args: string[]) => {
        runs.push(args);
        if (args[0] === "remote" && args[1] === "get-url") {
          const url = live[args[2]];
          return url === undefined
            ? { code: 2, stdout: "", stderr: `error: No such remote '${args[2]}'` }
            : { code: 0, stdout: `${url}\n`, stderr: "" };
        }
        if (args.length === 1 && args[0] === "remote") {
          return { code: 0, stdout: Object.keys(live).map((n) => `${n}\n`).join(""), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    },
  };
  const store = { getContext: () => (remotes === null ? undefined : ctx) } as unknown as RepoStore;
  return { store, runs, remotes: live };
}

/** A fresh userData folder for this test (the token store lives under it). */
function userData(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "gs-ghbridge-"));
  electron.paths.userData = dir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t: TestContext, routes: Record<string, FakeReply> = {}, remotes: Remotes | null = { origin: "https://github.com/acme/app.git" }) {
  const dir = userData(t);
  const gh = fakeGitHub(t, routes);
  const repo = repoWith(remotes);
  return { dir, gh, repo, bridge: new GitHubBridge(repo.store) };
}

/** Sign `bridge` in as `login` with a pasted token. */
async function signIn(bridge: GitHubBridge, gh: ReturnType<typeof fakeGitHub>, login = "ann"): Promise<void> {
  gh.route("GET /user", { login });
  const r = await bridge.connect("ghp_pasted");
  assert.equal(r.ok, true, r.message);
}

// ── Status and which repository ──

test("with no repository open and no token, the status is signed out with no repo", async (t) => {
  const { bridge, gh } = setup(t, {}, null);
  assert.deepEqual(await bridge.status(), { connected: false, repo: undefined });
  assert.equal(gh.calls.length, 0, "nothing asked of GitHub without a token");
});

test("the repository is read from origin", async (t) => {
  const { bridge } = setup(t);
  assert.deepEqual(await bridge.status(), { connected: false, repo: { owner: "acme", repo: "app" } });
});

test("a fork with only an upstream remote is still recognised", async (t) => {
  const { bridge, repo } = setup(t, {}, { upstream: "git@github.com:acme/app.git" });
  assert.deepEqual((await bridge.status()).repo, { owner: "acme", repo: "app" });
  assert.deepEqual(repo.runs.map((a) => a.join(" ")), ["remote get-url origin", "remote get-url upstream"]);
});

test("with neither origin nor upstream, any other GitHub remote is used", async (t) => {
  const { bridge } = setup(t, {}, { mirror: "https://github.com/acme/mirror.git" });
  assert.deepEqual((await bridge.status()).repo, { owner: "acme", repo: "mirror" });
});

test("a repository found once is not asked about again; a miss is asked again next time", async (t) => {
  const { bridge, repo } = setup(t, {}, {});
  assert.equal((await bridge.status()).repo, undefined);
  repo.remotes.origin = "https://github.com/acme/late.git";
  assert.deepEqual((await bridge.status()).repo, { owner: "acme", repo: "late" }, "a remote added later works at once");
  const before = repo.runs.length;
  await bridge.status();
  assert.equal(repo.runs.length, before, "the hit is cached for this root");
});

test("a pre-1.4 keyring token file is deleted unread when no token is stored", async (t) => {
  const { bridge, dir } = setup(t);
  const legacy = join(dir, "github-token.bin");
  writeFileSync(legacy, "opaque keyring blob");
  const s = await bridge.status();
  assert.equal(s.connected, false, "the blob is not a connection");
  assert.equal(existsSync(legacy), false);
});

// ── Signing in with a token ──

test("a pasted token GitHub accepts signs in, is stored, and is used for every call", async (t) => {
  const { bridge, gh, dir } = setup(t, { "GET /user": { login: "ann" } });
  assert.deepEqual(await bridge.connect("  ghp_pasted \n"), { ok: true, login: "ann" });
  assert.equal(gh.calls[0].headers.Authorization, "Bearer ghp_pasted", "trimmed before use");
  assert.equal(bridge.peekToken(), "ghp_pasted");
  assert.deepEqual(await bridge.status(), { connected: true, login: "ann", repo: { owner: "acme", repo: "app" } });

  const store = new SecretStore(join(dir, "secrets"));
  assert.equal(await store.get("github.token"), "ghp_pasted", "encrypted at rest under userData");
  assert.equal(await store.get("github.login"), "ann", "the name is kept beside it");
});

test("a token GitHub rejects is refused as expected and nothing is stored", async (t) => {
  const { bridge, dir } = setup(t, { "GET /user": () => reply(401, { message: "Bad credentials" }) });
  const r = await bridge.connect("ghp_typo");
  assert.deepEqual(r, { ok: false, expected: true, message: "That token didn't work — make sure it has 'repo' scope." });
  assert.equal(bridge.peekToken(), undefined);
  assert.equal(new SecretStore(join(dir, "secrets")).has("github.token"), false);
});

test("a later launch reads the stored token and remembered name, then confirms with GitHub", async (t) => {
  const { bridge, gh, repo } = setup(t, { "GET /user": { login: "ann" } });
  await bridge.connect("ghp_pasted");

  gh.route("GET /user", { login: "ann-renamed" });
  const relaunch = new GitHubBridge(repo.store);
  const s = await relaunch.status();
  assert.equal(s.connected, true);
  assert.equal(s.login, "ann", "the remembered name answers at once");
  assert.equal(relaunch.peekToken(), "ghp_pasted");
  // GitHub's answer lands behind it; the next status carries the rename.
  for (let i = 0; i < 50 && (await relaunch.status()).login !== "ann-renamed"; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal((await relaunch.status()).login, "ann-renamed");
});

test("a stored token with no remembered name asks GitHub for it and remembers the answer", async (t) => {
  const { dir, repo } = setup(t, { "GET /user": { login: "bob" } });
  await new SecretStore(join(dir, "secrets")).set("github.token", "ghp_stored");
  const s = await new GitHubBridge(repo.store).status();
  assert.deepEqual(s, { connected: true, login: "bob", repo: { owner: "acme", repo: "app" } });
  assert.equal(await new SecretStore(join(dir, "secrets")).get("github.login"), "bob");
});

test("a failed ask for the name leaves a stored token signed in, just nameless", async (t) => {
  const { dir, repo } = setup(t, { "GET /user": () => reply(502, {}) });
  await new SecretStore(join(dir, "secrets")).set("github.token", "ghp_stored");
  const s = await new GitHubBridge(repo.store).status();
  assert.equal(s.connected, true);
  assert.equal(s.login, undefined);
});

test("signing out forgets the token everywhere", async (t) => {
  const { bridge, gh, dir } = setup(t);
  await signIn(bridge, gh);
  writeFileSync(join(dir, "github-token.bin"), "legacy");
  await bridge.disconnect();
  assert.equal(bridge.peekToken(), undefined);
  assert.equal((await bridge.status()).connected, false);
  const store = new SecretStore(join(dir, "secrets"));
  assert.equal(store.has("github.token"), false);
  assert.equal(store.has("github.login"), false);
  assert.equal(existsSync(join(dir, "github-token.bin")), false);
  assert.equal(await bridge.withClientIfUnlocked(async () => "ran"), undefined);
});

// ── The device flow ──

test("device sign-in step 1 hands the renderer GitHub's code", async (t) => {
  const { bridge, gh } = setup(t, {
    [DEVICE]: {
      device_code: "dev-123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
      expires_in: 600,
      interval: 7,
    },
  });
  assert.deepEqual(await bridge.deviceStart(), {
    ok: true,
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    verificationUriComplete: "https://github.com/login/device?user_code=ABCD-1234",
    deviceCode: "dev-123",
    interval: 7,
    expiresIn: 600,
  });
  assert.equal((gh.calls[0].body as { client_id?: string }).client_id !== undefined, true);
});

test("a device code GitHub won't issue is an expected failure with its reason", async (t) => {
  const { bridge } = setup(t, { [DEVICE]: () => reply(400, { error: "unauthorized_client", error_description: "Device flow disabled" }) });
  assert.deepEqual(await bridge.deviceStart(), { ok: false, expected: true, message: "Device flow disabled" });
});

test("polling before the user has authorized says pending, and a cancel says so", async (t) => {
  const { bridge, gh } = setup(t, { [TOKEN]: { error: "authorization_pending" } });
  assert.deepEqual(await bridge.devicePoll({ deviceCode: "dev-123" }), { state: "pending", message: undefined });
  assert.equal((gh.calls[0].body as { device_code: string }).device_code, "dev-123");
  gh.route(TOKEN, { error: "access_denied" });
  assert.deepEqual(await bridge.devicePoll({ deviceCode: "dev-123" }), { state: "denied", message: "Sign-in was cancelled." });
  assert.equal(bridge.peekToken(), undefined);
});

test("an authorized poll signs in with the issued token and stores it", async (t) => {
  const { bridge, gh, dir } = setup(t, {
    [TOKEN]: { access_token: "gho_device", scope: "repo" },
    "GET /user": { login: "dee" },
  });
  assert.deepEqual(await bridge.devicePoll({ deviceCode: "dev-123" }), { state: "authorized", login: "dee" });
  assert.equal(gh.sent("GET", "/user")[0].headers.Authorization, "Bearer gho_device");
  assert.equal(await new SecretStore(join(dir, "secrets")).get("github.token"), "gho_device");
  assert.equal((await bridge.status()).login, "dee");
});

test("an authorized poll whose user read fails is an error and leaves you signed out", async (t) => {
  const { bridge } = setup(t, {
    [TOKEN]: { access_token: "gho_device" },
    "GET /user": () => reply(500, {}),
  });
  assert.deepEqual(await bridge.devicePoll({ deviceCode: "d" }), {
    state: "error",
    message: "Signed in, but GitHub didn't return a user.",
  });
  assert.equal(bridge.peekToken(), undefined);
});

test("a poll that can't reach GitHub is an error result, not a throw", async (t) => {
  const { bridge } = setup(t, { [TOKEN]: new TypeError("fetch failed") });
  const r = await bridge.devicePoll({ deviceCode: "d" });
  assert.equal(r.state, "error");
  assert.match(r.message ?? "", /Couldn't reach GitHub/);
});

// ── Gates for the per-section modules ──

test("withRepo refuses as expected when signed out, and when the repo isn't on GitHub", async (t) => {
  const { bridge, gh } = setup(t, {}, { origin: "" });
  await assert.rejects(bridge.withRepo(async () => 1), (e: Error) => e.message === "Not connected to GitHub." && isExpectedError(e));
  await assert.rejects(bridge.withClient(async () => 1), /Not connected to GitHub/);
  await signIn(bridge, gh);
  await assert.rejects(
    bridge.withRepo(async () => 1),
    (e: Error) => e.message === "This repository isn't on github.com." && isExpectedError(e),
  );
});

test("withRepo hands the section the signed-in client and the resolved owner/repo", async (t) => {
  const { bridge, gh } = setup(t, { "GET /repos/acme/app": { default_branch: "main" } });
  await signIn(bridge, gh);
  const got = await bridge.withRepo(async (client, owner, repo) => {
    const meta = await client.request<{ default_branch: string }>("GET", `/repos/${owner}/${repo}`);
    return `${owner}/${repo}@${meta.default_branch}`;
  });
  assert.equal(got, "acme/app@main");
  assert.equal(await bridge.withClient(async (c) => c.currentLogin()), "ann");
  assert.equal(await bridge.withClientIfUnlocked(async (c) => c.currentLogin()), "ann");
});

test("an ambient read never unlocks the token: before sign-in it yields undefined", async (t) => {
  const { bridge, gh } = setup(t);
  let ran = false;
  assert.equal(await bridge.withClientIfUnlocked(async () => (ran = true)), undefined);
  assert.equal(ran, false);
  assert.equal(gh.calls.length, 0);
});

// ── Data calls ──

const rawPull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  body: "desc",
  state: "open",
  html_url: `https://github.com/acme/app/pull/${n}`,
  user: { login: "ann" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  head: { ref: "feat", sha: "h1" },
  base: { ref: "main", sha: "b1" },
  ...extra,
});
const rawIssue = (n: number) => ({
  number: n,
  title: `Issue ${n}`,
  body: "ib",
  state: "open",
  html_url: `https://github.com/acme/app/issues/${n}`,
  user: null,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  comments: 1,
});

test("signed out, every list is empty and every detail absent — nothing went wrong", async (t) => {
  const { bridge, gh } = setup(t);
  assert.deepEqual(await bridge.prList(), []);
  assert.deepEqual(await bridge.prCommits(1), []);
  assert.deepEqual(await bridge.prConversation(1), []);
  assert.deepEqual(await bridge.prChecks(1), []);
  assert.deepEqual(await bridge.issueList(), []);
  assert.equal(await bridge.issueDetail(1), undefined);
  assert.equal(await bridge.prDetail(1), undefined);
  assert.equal(await bridge.externalItem({ owner: "x", repo: "y", number: 1, kind: "issue" }), undefined);
  assert.deepEqual(await bridge.prMerge({ number: 1, method: "merge" }), {
    ok: false,
    changed: false,
    message: "Not connected to GitHub.",
    expected: true,
  });
  assert.deepEqual(await bridge.prApprove(1), { ok: false, changed: false, message: "Not connected to GitHub.", expected: true });
  assert.equal(gh.calls.length, 0);
});

test("the PR list is the resolved repo's, in the state asked for", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/pulls?state=all&sort=updated&direction=desc&per_page=100": () => page([rawPull(4), rawPull(3)]),
  });
  await signIn(bridge, gh);
  assert.deepEqual((await bridge.prList("all")).map((p) => p.number), [4, 3]);
});

test("a failed PR list read propagates instead of reading as 'no pull requests'", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=100": () => reply(403, { message: "API rate limit exceeded" }),
  });
  await signIn(bridge, gh);
  await assert.rejects(bridge.prList(), /rate limit/);
});

test("a PR's detail carries its files and the combined check state", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/pulls/5": rawPull(5),
    "GET /repos/acme/app/pulls/5/files?per_page=100": () => page([{ filename: "a.ts", status: "added", additions: 2, deletions: 0 }]),
    "GET /repos/acme/app/commits/h1/status": { state: "failure", total_count: 2 },
  });
  await signIn(bridge, gh);
  const d = await bridge.prDetail(5);
  assert.equal(d?.pr.number, 5);
  assert.deepEqual(d?.files, [{ filename: "a.ts", status: "added", additions: 2, deletions: 0 }]);
  assert.equal(d?.checks, "failure");
});

test("a PR detail whose files can't be read is absent, not an empty Files tab", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/pulls/5": rawPull(5),
    "GET /repos/acme/app/pulls/5/files?per_page=100": () => reply(500, {}),
    "GET /repos/acme/app/commits/h1/status": { state: "success" },
  });
  await signIn(bridge, gh);
  assert.equal(await bridge.prDetail(5), undefined);
});

test("commits, conversation and checks read the resolved repo's PR", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/pulls/6/commits?per_page=100": () =>
      page([{ sha: "abcdef1234", commit: { message: "one\n\nbody", author: { name: "A", date: "d" } } }]),
    "GET /repos/acme/app/issues/6/comments?per_page=100": () =>
      page([{ id: 1, user: { login: "ann" }, body: "hi", created_at: "2026-01-01" }]),
    "GET /repos/acme/app/pulls/6/reviews?per_page=100": () => page([]),
    "GET /repos/acme/app/pulls/6": rawPull(6),
    "GET /repos/acme/app/commits/h1/check-runs?per_page=100": { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
  });
  await signIn(bridge, gh);
  const commits = await bridge.prCommits(6);
  assert.deepEqual([commits[0].shortSha, commits[0].message, commits[0].body], ["abcdef1", "one", "body"]);
  assert.deepEqual((await bridge.prConversation(6)).map((c) => c.body), ["hi"]);
  assert.deepEqual(await bridge.prChecks(6), [{ name: "ci", status: "completed", conclusion: "success", detailsUrl: undefined }]);
});

test("a failed commits read propagates; a PR that can't be read has no checks", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/pulls/6/commits?per_page=100": () => reply(502, {}),
    "GET /repos/acme/app/pulls/6": () => reply(404, { message: "Not Found" }),
  });
  await signIn(bridge, gh);
  await assert.rejects(bridge.prCommits(6), /HTTP 502/);
  assert.deepEqual(await bridge.prChecks(6), []);
});

test("merging sends the method and reports the working tree may have changed", async (t) => {
  const { bridge, gh } = setup(t, { "PUT /repos/acme/app/pulls/7/merge": { merged: true } });
  await signIn(bridge, gh);
  assert.deepEqual(await bridge.prMerge({ number: 7, method: "rebase" }), { ok: true, changed: true });
  assert.deepEqual(gh.sent("PUT", "/repos/acme/app/pulls/7/merge")[0].body, { merge_method: "rebase" });
  gh.route("PUT /repos/acme/app/pulls/7/merge", () => reply(405, { message: "Pull Request is not mergeable" }));
  assert.deepEqual(await bridge.prMerge({ number: 7, method: "merge" }), {
    ok: false,
    changed: false,
    message: "Pull Request is not mergeable",
  });
});

test("approving posts an APPROVE review; a refusal is a result", async (t) => {
  const { bridge, gh } = setup(t, { "POST /repos/acme/app/pulls/7/reviews": { id: 1 } });
  await signIn(bridge, gh);
  assert.deepEqual(await bridge.prApprove(7), { ok: true, changed: false });
  gh.route("POST /repos/acme/app/pulls/7/reviews", () => reply(422, { message: "Can not approve your own pull request" }));
  assert.deepEqual(await bridge.prApprove(7), {
    ok: false,
    changed: false,
    message: "Can not approve your own pull request",
  });
});

test("the issue list and an issue's detail are the resolved repo's", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/acme/app/issues?state=open&sort=updated&direction=desc&per_page=100": () => page([rawIssue(1), { ...rawIssue(2), pull_request: {} }]),
    "GET /repos/acme/app/issues/1": rawIssue(1),
    "GET /repos/acme/app/issues/404": () => reply(404, { message: "Not Found" }),
  });
  await signIn(bridge, gh);
  assert.deepEqual((await bridge.issueList()).map((i) => i.number), [1]);
  assert.equal((await bridge.issueDetail(1))?.title, "Issue 1");
  assert.equal(await bridge.issueDetail(404), undefined);
});

test("an item from ANY repo is read for the assistant, with its comments", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/other/lib/issues/12/comments?per_page=100": () =>
      page([{ id: 1, user: { login: "zed" }, body: "same here", created_at: "2026-01-03" }]),
    "GET /repos/other/lib/pulls/12/reviews?per_page=100": () =>
      page([{ user: { login: "rev" }, body: "lgtm", state: "APPROVED", submitted_at: "2026-01-04" }]),
    "GET /repos/other/lib/pulls/12": rawPull(12, { draft: true, html_url: "https://github.com/other/lib/pull/12" }),
    "GET /repos/other/lib/issues/13/comments?per_page=100": () => reply(500, {}),
    "GET /repos/other/lib/pulls/13/reviews?per_page=100": () => page([]),
    "GET /repos/other/lib/issues/13": rawIssue(13),
  });
  await signIn(bridge, gh);
  assert.deepEqual(await bridge.externalItem({ owner: "other", repo: "lib", number: 12, kind: "pull" }), {
    kind: "pull",
    number: 12,
    repo: "other/lib",
    title: "PR 12",
    state: "draft",
    body: "desc",
    htmlUrl: "https://github.com/other/lib/pull/12",
    author: "ann",
    createdAt: "2026-01-01T00:00:00Z",
    comments: [{ author: "zed", body: "same here", createdAt: "2026-01-03" }],
  });
  const issue = await bridge.externalItem({ owner: "other", repo: "lib", number: 13, kind: "issue" });
  assert.equal(issue?.kind, "issue");
  assert.equal(issue?.state, "open");
  assert.equal(issue?.author, null);
  assert.deepEqual(issue?.comments, [], "a failed comment read thins the summary, it does not drop the item");
});

test("an external item that can't be read is absent", async (t) => {
  const { bridge, gh } = setup(t, {
    "GET /repos/other/lib/issues/9/comments?per_page=100": () => page([]),
    "GET /repos/other/lib/pulls/9/reviews?per_page=100": () => page([]),
    "GET /repos/other/lib/pulls/9": () => reply(404, { message: "Not Found" }),
  });
  await signIn(bridge, gh);
  assert.equal(await bridge.externalItem({ owner: "other", repo: "lib", number: 9, kind: "pull" }), undefined);
});

// ── PR checkout's refusals before git runs ──

test("checking out a PR with no repository open, or with a bad number, runs nothing", async (t) => {
  const closed = setup(t, {}, null);
  assert.deepEqual(await closed.bridge.prCheckout(3), {
    ok: false,
    changed: false,
    expected: true,
    message: "No repository open.",
  });
  const open = setup(t);
  for (const bad of [0, -2, 1.5, Number.NaN]) {
    assert.deepEqual(await open.bridge.prCheckout(bad), {
      ok: false,
      changed: false,
      message: "That isn't a pull request number.",
    });
  }
  assert.deepEqual(await open.bridge.prCheckout({ number: 0, stashFirst: "x" }), {
    ok: false,
    changed: false,
    message: "That isn't a pull request number.",
  });
  assert.deepEqual(open.repo.runs, [], "no git ran");
});
