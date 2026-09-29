// The New pull request form's host (src/pr/prCreatePage.ts), shown directly
// with its own deps — no Pull Requests list, so it resolves where it opens
// itself — against real git (bare repositories standing in for GitHub,
// reached by their github.com URLs through insteadOf) and the fake
// api.github.com. prCreateForm.test.ts drives the form through the command;
// this file covers what that one does not: every way the first read fails
// and its way out, a clone with no branches, a detached HEAD, a base that
// couldn't be fetched, choosing another repository or template, the AI
// draft, and a follow-up GitHub refuses after the pull request exists.

import { github, pr, until, vscode } from "./prTestKit";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { graphqlWorld, rawPull, type FakeRepo, type FakeRequest, type Route } from "./fakeGitHub";
import { configuredRemotes } from "./prGitWorld";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { PrCreatePage } = require("../src/pr/prCreatePage") as typeof import("../src/pr/prCreatePage");
const { GitHubApi } = require("../src/pr/githubApi") as typeof import("../src/pr/githubApi");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const scratch = mkdtempSync(join(tmpdir(), "gs-prcp-cov-"));
const contexts: { dispose(): void }[] = [];
after(() => {
  for (const c of contexts.splice(0)) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const TEMPLATE = "## What\n\n## Why\n";

/**
 * acme/app (bare `hub`) with main; your fork me/app (bare `fork`) as origin,
 * upstream = acme/app; `feature` with one commit "Add b" on main, not pushed.
 */
function world(opts: { commits?: boolean } = {}) {
  const base = mkdtempSync(join(scratch, "w-"));
  const hub = join(base, "hub.git");
  const fork = join(base, "fork.git");
  const work = join(base, "work");
  for (const bare of [hub, fork]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const git = at(work);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "Tess"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git("config", k, v);
  git("config", `url.${hub}.insteadOf`, "https://github.com/acme/app.git");
  git("config", `url.${fork}.insteadOf`, "https://github.com/me/app.git");
  git("remote", "add", "origin", "https://github.com/me/app.git");
  git("remote", "add", "upstream", "https://github.com/acme/app.git");
  if (opts.commits !== false) {
    writeFileSync(join(work, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("push", "-q", "upstream", "main");
    git("push", "-q", "origin", "main");
    git("fetch", "-q", "--all");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(work, "b.txt"), "b\n");
    git("add", ".");
    git("commit", "-qm", "Add b", "-m", "Because b was missing.");
  }
  const ctx = new GitContext({ root: work });
  configuredRemotes(ctx, work);
  contexts.push({ dispose: () => ctx.dispose() });
  const tip = (bare: string, branch: string): string | undefined => {
    try {
      return execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  };
  return { base, hub, fork, work, git, tip, entry: { root: work, ctx } as any };
}
type W = ReturnType<typeof world>;

function repos(over: Partial<FakeRepo> = {}): Record<string, FakeRepo> {
  return {
    "acme/app": {
      pulls: () => [],
      templates: [
        { filename: ".github/pull_request_template.md", body: TEMPLATE },
        { filename: ".github/PULL_REQUEST_TEMPLATE/bugfix.md", body: "## Bug\n" },
      ],
      branches: ["develop", "main"],
      labels: [{ name: "bug", color: "d73a4a" }],
      people: ["alice", "me"],
      ...over,
    },
    "me/app": { pulls: () => [], isFork: true, parent: "acme/app" },
  };
}

const isCreateQuery = (req: FakeRequest) => req.path === "/graphql" && /pullRequestTemplates/.test(String((req.body as any)?.query ?? ""));

function routes(opts: { repos?: Record<string, FakeRepo>; create?: (req: FakeRequest) => { status?: number; body: unknown }; graphql?: (req: FakeRequest) => any; extra?: Route[] } = {}): Route[] {
  const answer = graphqlWorld(opts.repos ?? repos());
  return [
    ...(opts.extra ?? []),
    ["POST", /^\/graphql$/, (req) => opts.graphql?.(req) ?? answer(req)],
    ["GET", /^\/repos\/[^/]+\/app\/pulls\?state=open&head=/, () => ({ body: [] })],
    ["POST", /^\/repos\/acme\/app\/pulls$/, (req) => (opts.create ? opts.create(req) : { status: 201, body: rawPull(50, { title: (req.body as any).title }) })],
    ["POST", /^\/repos\/acme\/app\/pulls\/\d+\/requested_reviewers$/, () => ({ status: 201, body: {} })],
    ["POST", /^\/repos\/acme\/app\/issues\/\d+\/(labels|assignees)$/, () => ({ status: 201, body: {} })],
  ];
}

interface Form {
  page: any;
  panel: any;
  opened: unknown[][];
  gh: any;
}

/** The form for `w`'s clone, shown with no list, loaded and in sight. */
async function openForm(w: W, opts: { routes?: Route[]; brain?: any } = {}): Promise<Form> {
  const gh = github(opts.routes ?? routes());
  const api = new GitHubApi({ getToken: async () => "tok" });
  const opened: unknown[][] = [];
  const deps: any = {
    api,
    graphql: (q: string, v: Record<string, unknown>) => api.graphqlRaw(q, v),
    extensionUri: vscode.Uri.file("/ext"),
    openPr: async (p: unknown, ctx: unknown) => void opened.push([p, ctx]),
    ...(opts.brain ? { brain: opts.brain } : {}),
  };
  const page = PrCreatePage.show(deps, w.entry);
  const panel = pr.panels.filter((p: any) => p.viewType === "gitstudio.newPullRequest").at(-1);
  panel.receive({ type: "ready" });
  await page.loaded();
  await settled(panel);
  return { page, panel, opened, gh };
}

async function settled(panel: any): Promise<any> {
  await until(() => {
    const s = panel.state();
    return !!s && (s.status === "message" || (s.status === "ready" && !s.refreshing && s.compare.status !== "loading"));
  }, "the form to settle", 15000);
  return panel.state();
}

function closeForms(): void {
  for (const p of pr.panels.splice(0)) p.dispose();
}

// One clone for the tests that change nothing in it.
let shared: W | undefined;
const sharedWorld = () => (shared ??= world());

// ── Where it opens, with no list to ask ──────────────────────────────────────

test("with no list, the form resolves where it opens itself: the fork's parent, into its default branch", async () => {
  const w = sharedWorld();
  const { page, panel } = await openForm(w);
  const s = panel.state();
  assert.equal(s.status, "ready");
  assert.deepEqual(s.targets.map((t: any) => t.id), ["acme/app", "me/app"]);
  assert.equal(s.target, "acme/app");
  assert.equal(panel.title, "New pull request · acme/app");
  assert.equal(s.base, "main");
  assert.deepEqual([s.head.branch, s.head.remote, s.head.owner, s.head.ref, s.head.push], ["feature", "origin", "me", "me:feature", "new"]);
  assert.deepEqual(s.compare.commits.map((c: any) => c.subject), ["Add b"]);
  assert.equal(s.template, ".github/pull_request_template.md");
  assert.equal(PrCreatePage.get(w.work), page, "one form per clone");
  closeForms();
  assert.equal(PrCreatePage.get(w.work), undefined, "a closed form is forgotten");
});

test("a template is chosen only from the repository's own; any other name means none", async () => {
  const { panel } = await openForm(sharedWorld());
  panel.receive({ type: "template", filename: ".github/PULL_REQUEST_TEMPLATE/bugfix.md" });
  await until(() => panel.state().template === ".github/PULL_REQUEST_TEMPLATE/bugfix.md", "the bugfix template");
  assert.equal(panel.state().proposed.body, "## Bug\n");
  panel.receive({ type: "template", filename: "../../etc/passwd" });
  await until(() => panel.state().template === undefined, "no template");
  panel.receive({ type: "template" });
  await until(() => panel.state().template === undefined && panel.posted.length > 0, "still none");
});

test("Refresh asks GitHub about the repository again; choosing where it opens reads that one", async () => {
  const { panel, gh } = await openForm(sharedWorld());
  const asked = () => gh.requests.filter(isCreateQuery).map((r: any) => `${r.body.variables.owner}/${r.body.variables.name}`);
  assert.deepEqual(asked(), ["acme/app"]);
  panel.receive({ type: "refresh" });
  await until(() => asked().length === 2, "asked again");
  await settled(panel);

  panel.receive({ type: "target", id: "ACME/app" }); // the one it already opens on: nothing
  panel.receive({ type: "target", id: "nobody/else" }); // not the clone's: nothing
  panel.receive({ type: "target", id: "me/app" });
  await until(() => panel.state().target === "me/app", "me/app");
  await settled(panel);
  assert.deepEqual(asked(), ["acme/app", "acme/app", "me/app"]);
  assert.equal(panel.title, "New pull request · me/app");
  assert.equal(panel.state().template, undefined, "me/app has no template");
  assert.equal(panel.state().head.ref, "feature", "into your own fork: the branch by its own name");
});

// ── The first read fails ─────────────────────────────────────────────────────

const failures: [string, (req: FakeRequest) => any, string, string][] = [
  [
    "SAML SSO (403)",
    () => ({ status: 403, body: { message: "Resource protected by organization SAML enforcement." }, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?x=1" } }),
    "GitHub refused to show acme/app",
    "Authorize on GitHub",
  ],
  ["a refusal (403)", () => ({ status: 403, body: { message: "Must have push access" } }), "GitHub refused to show acme/app", "Open on GitHub"],
  [
    "no such repository",
    () => ({ body: { data: { viewer: { login: "me" }, repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] } }),
    "GitHub has no repository acme/app",
    "Retry",
  ],
  ["the rate limit", () => ({ body: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } }), "GitHub's rate limit was reached", "Retry"],
  [
    "the network",
    () => {
      throw new TypeError("fetch failed");
    },
    "Couldn't reach GitHub",
    "Retry",
  ],
  ["a server error", () => ({ status: 502, body: { message: "Bad gateway" } }), "Couldn't read acme/app", "Retry"],
];

for (const [what, reply, title, button] of failures) {
  test(`a first read that fails for ${what} says so, with the one thing that helps`, async () => {
    const { panel } = await openForm(sharedWorld(), { routes: routes({ graphql: (req) => (isCreateQuery(req) ? reply(req) : undefined) }) });
    const s = panel.state();
    assert.equal(s.status, "message");
    assert.equal(s.message.title, title);
    assert.equal(s.message.buttons[0].label, button);
    closeForms();
  });
}

test("the way out of a refusal: Authorize opens GitHub's page; Retry and Sign in read again", async () => {
  let down = true;
  const { panel, gh } = await openForm(sharedWorld(), {
    routes: routes({ graphql: (req) => (down && isCreateQuery(req) ? failures[0][1](req) : undefined) }),
  });
  const button = panel.state().message.buttons[0];
  assert.deepEqual(button.action, { kind: "openUrl", url: "https://github.com/orgs/acme/sso?x=1" });
  panel.receive({ type: "action", action: button.action });
  panel.receive({ type: "action", action: { kind: "openUrl", url: "https://evil.example/phish" } });
  await until(() => pr.opened.length === 1, "GitHub's page");
  assert.deepEqual(pr.opened, ["https://github.com/orgs/acme/sso?x=1"]);

  const reads = () => gh.requests.filter(isCreateQuery).length;
  const before = reads();
  panel.receive({ type: "action", action: { kind: "signIn", again: true } });
  await until(() => reads() === before + 1, "read again after signing in");
  assert.deepEqual(pr.executed.find((e: any) => e.id === "gitstudio.pr.signIn").args, [{ again: true }]);
  assert.equal(panel.state().status, "message", "still refused");

  down = false;
  panel.receive({ type: "action", action: { kind: "retry" } });
  await until(() => panel.state().status === "ready", "the form after Retry");
  assert.equal(panel.state().message, undefined);
});

// ── Clones the form can't open from ──────────────────────────────────────────

test("a clone with no commits yet says it has no branches, and asks GitHub nothing about it", async () => {
  const w = world({ commits: false });
  const { panel, gh } = await openForm(w);
  const s = panel.state();
  assert.equal(s.status, "message");
  assert.equal(s.message.title, "This repository has no branches yet");
  assert.equal(gh.requests.filter(isCreateQuery).length, 0);
});

test("a detached HEAD opens with no head chosen and nothing compared", async () => {
  const w = world();
  w.git("checkout", "-q", "--detach");
  const { panel } = await openForm(w);
  const s = panel.state();
  assert.equal(s.status, "ready");
  assert.equal(s.head, undefined);
  assert.equal(s.compare.status, "idle");
  assert.deepEqual(s.compare.commits, []);
  assert.ok(s.branches.some((b: any) => b.name === "feature" && !b.current));
});

test("a base that can't be fetched is compared as last fetched, and said to be", async () => {
  const w = world();
  rmSync(w.hub, { recursive: true, force: true }); // GitHub, unreachable: upstream/main is as last fetched
  const { panel } = await openForm(w);
  const s = panel.state();
  assert.equal(s.compare.status, "ready");
  assert.equal(s.compare.stale, true);
  assert.deepEqual(s.compare.commits.map((c: any) => c.subject), ["Add b"]);
});

// ── The AI draft ─────────────────────────────────────────────────────────────

test("Draft with AI hands the model the commits and the diff, and fills the description with its answer", async () => {
  const asked: [string[], string][] = [];
  let answer: () => Promise<string | null> = async () => "  Adds b, because it was missing.  ";
  const brain = {
    isEnabled: async () => true,
    generatePrDescription: async (subjects: string[], diff: string) => (asked.push([subjects, diff]), answer()),
  };
  const { panel } = await openForm(sharedWorld(), { brain });
  await until(() => panel.state().ai === true, "the AI offered");

  panel.receive({ type: "aiDraft" });
  await until(() => !!panel.state().aiBody, "the draft");
  assert.equal(panel.state().aiBody.body, "Adds b, because it was missing.");
  assert.deepEqual(asked[0][0], ["Add b"]);
  assert.match(asked[0][1], /b\.txt/);
  assert.equal(panel.state().busy, undefined);

  answer = async () => "   ";
  panel.receive({ type: "aiDraft" });
  await until(() => panel.state().notice?.title === "The AI had nothing to say about this change", "said it had nothing");

  answer = async () => {
    throw new Error("model offline");
  };
  panel.receive({ type: "aiDraft" });
  await until(() => panel.state().notice?.title === "Couldn't draft the description: model offline", "the failure");
  assert.equal(asked.length, 3);
  assert.equal(panel.state().busy, undefined);
});

test("Cancel closes the form, and it is forgotten", async () => {
  const w = sharedWorld();
  const { panel } = await openForm(w);
  let closed = false;
  panel.onDidDispose(() => (closed = true));
  panel.receive({ type: "cancel" });
  await until(() => closed, "the tab closed");
  assert.equal(PrCreatePage.get(w.work), undefined);
});

// ── Create: a follow-up GitHub refuses ───────────────────────────────────────

test("created, but a reviewer GitHub refuses: the PR opens and the warning says what didn't happen", async () => {
  const w = world();
  const sent: any[] = [];
  const { panel, opened } = await openForm(w, {
    routes: routes({
      create: (req) => (sent.push(req.body), { status: 201, body: rawPull(50, { title: (req.body as any).title }) }),
      extra: [["POST", /requested_reviewers$/, () => ({ status: 422, body: { message: "Reviews may only be requested from collaborators" } })]],
    }),
  });
  panel.receive({ type: "create", title: " Add b ", body: "Body", draft: true, reviewers: ["stranger"], assignees: ["me"], labels: ["bug"] });
  await until(() => opened.length === 1, "the new PR's page", 15000);
  assert.deepEqual(sent, [{ title: "Add b", head: "me:feature", base: "main", body: "Body", draft: true }]);
  assert.equal(w.tip(w.fork, "feature"), w.git("rev-parse", "feature"), "pushed to the fork first");
  const [p, ctx] = opened[0] as [any, any];
  assert.equal(p.number, 50);
  assert.deepEqual([ctx.owner, ctx.repo, ctx.remoteName], ["acme", "app", "upstream"]);
  await until(() => pr.said.some((s: any) => s.kind === "warning"), "the warning");
  assert.equal(
    pr.said.find((s: any) => s.kind === "warning").message,
    "Created draft pull request #50. But GitStudio couldn't request its reviewers (Reviews may only be requested from collaborators.).",
  );
  assert.equal(PrCreatePage.get(w.work), undefined, "the form gives way to the PR's page");
});
