// The New pull request form's host (src/pr/prCreatePage.ts), through the
// REAL command against real git and a fake api.github.com: a clone of
// acme/app whose `origin` is YOUR FORK (me/app) — the usual layout — with a
// feature branch, and bare repositories standing in for both GitHub
// repositories (reached by their github.com URLs through insteadOf).
//
// THE STATE TABLE, one test per row:
//
//   opens                → on the fork's parent, into its default branch, from
//                          the branch checked out (sent as me:feature), with
//                          GitHub's title, the repository's template, and the
//                          commits and files of main...feature from real git
//   create, not pushed   → pushed to the fork first, then created with every
//                          field, reviewers/assignees/labels added, its page
//                          opened in the form's place
//   one exists already   → said on opening, with Open; Create refused
//   GitHub: it exists    → the one that exists opens
//   GitHub refuses       → said on the form, which keeps everything
//   push refused         → said; nothing is created
//   another base         → compared again; one GitHub doesn't have is said
//   nothing to compare   → Create refused, in words
//   no triage access     → reviewers/labels/assignees off, and never sent
//   a file               → opens its diff, merge base against the branch
//   signed out / not GitHub → the form says why and what helps
//   twice                → one form per clone, revealed
//
// The wizard this replaces asked six questions in the sidebar, proposed the
// newest commit's subject, never read the template, and requested no one.

import Module from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { graphqlWorld, installFakeGitHub, rawPull, type FakeGitHub, type FakeRepo, type Route } from "./fakeGitHub";
import { configuredRemotes } from "./prGitWorld";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "prVscodeStub.cjs") : resolve.call(this, request, ...rest);
};
(Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions[".css"] = (
  m,
  f,
) => {
  m.exports = readFileSync(f, "utf8");
};

const cfgDir = mkdtempSync(join(tmpdir(), "gs-prcf-cfg-"));
writeFileSync(join(cfgDir, "config"), "");
process.env.GIT_CONFIG_GLOBAL = join(cfgDir, "config");
process.env.GIT_CONFIG_SYSTEM = join(cfgDir, "config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.HOME = cfgDir;

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- loaded after the stand-in */
const vscode = require("vscode") as any;
const { registerPrFeature } = require("../src/pr/prFeature") as typeof import("../src/pr/prFeature");
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const pr = vscode.__pr;
const scratch = mkdtempSync(join(tmpdir(), "gs-prcf-git-"));
after(() => {
  try {
    execFileSync("rm", ["-rf", scratch]);
  } catch {
    /* swept by the OS */
  }
});
registerDialogHost({ show: async () => undefined });

const contexts: { dispose(): void }[] = [];
let fake: FakeGitHub | undefined;
afterEach(() => {
  for (const p of pr.panels.splice(0)) p.dispose();
  pr.webviewViews.splice(0);
  for (const c of contexts.splice(0)) c.dispose();
  fake?.restore();
  fake = undefined;
  pr.session = { accessToken: "tok", account: { label: "me", id: "1" }, scopes: ["repo"] };
  pr.reset();
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const TEMPLATE = "## What\n\n## Why\n";

/**
 * acme/app (bare `hub`) with main; your fork me/app (bare `fork`) as origin,
 * upstream = acme/app; `feature` with one commit "Add b" on main, not pushed.
 */
function world() {
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
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", "https://github.com/me/app.git");
  git("remote", "add", "upstream", "https://github.com/acme/app.git");
  git("push", "-q", "upstream", "main");
  git("push", "-q", "origin", "main");
  git("fetch", "-q", "--all");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "b.txt"), "b\n");
  writeFileSync(join(work, "a.txt"), "a, changed\n");
  git("add", ".");
  git("commit", "-qm", "Add b", "-m", "Because b was missing.");
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
  return { base, hub, fork, work, git, tip, entry: { root: work, ctx } };
}

type W = ReturnType<typeof world>;

function repos(over: Partial<FakeRepo> = {}): Record<string, FakeRepo> {
  return {
    "acme/app": {
      pulls: () => [],
      templates: [{ filename: ".github/pull_request_template.md", body: TEMPLATE }],
      branches: ["develop", "main"],
      labels: [{ name: "bug", color: "d73a4a" }],
      people: ["alice", "me"],
      ...over,
    },
    "me/app": { pulls: () => [], isFork: true, parent: "acme/app" },
  };
}

function routes(opts: { repos?: Record<string, FakeRepo>; onCreate?: (body: any) => { status?: number; body: unknown }; existing?: unknown[]; extra?: Route[] } = {}): Route[] {
  return [
    ...(opts.extra ?? []),
    ["POST", /^\/graphql$/, graphqlWorld(opts.repos ?? repos())],
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open&head=/, () => ({ body: opts.existing ?? [] })],
    ["POST", /^\/repos\/acme\/app\/pulls$/, (req) => (opts.onCreate ? opts.onCreate(req.body) : { status: 201, body: rawPull(50, { title: (req.body as any).title }) })],
    ["POST", /^\/repos\/acme\/app\/pulls\/\d+\/requested_reviewers$/, () => ({ status: 201, body: {} })],
    ["POST", /^\/repos\/acme\/app\/issues\/\d+\/(labels|assignees)$/, () => ({ status: 201, body: {} })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)\/files/, () => ({ body: [] })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)$/, (_r, m) => ({ body: rawPull(Number(m[1])) })],
    ["GET", /\/compare\//, () => ({ body: { merge_base_commit: { sha: "basesha" }, files: [] } })],
  ];
}

function mountWith(w: W) {
  const changed = new vscode.EventEmitter();
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext"), workspaceState: undefined };
  registerPrFeature(context as any, { onDidChange: changed.event, getActive: () => w.entry } as any, { isEnabled: async () => false } as any);
  contexts.push({ dispose: () => context.subscriptions.forEach((d) => d.dispose()) });
}

const formPanel = () => pr.panels.find((p: any) => p.viewType === "gitstudio.newPullRequest" && !p.gone);
async function openForm(w: W): Promise<any> {
  await vscode.commands.executeCommand("gitstudio.pr.create");
  const panel = formPanel();
  if (!panel) throw new Error("no form");
  if (!panel.ready) {
    panel.receive({ type: "ready" });
    panel.ready = true;
    panel.onDidDispose(() => (panel.gone = true));
  }
  await until(() => {
    const s = panel.state();
    return !!s && (s.status === "message" || (s.status === "ready" && s.compare.status !== "loading" && !s.refreshing));
  }, "the form to load");
  return panel;
}
const settledState = async (panel: any, what: string) => {
  await until(() => {
    const s = panel.state();
    return !!s && !s.busy && s.compare.status !== "loading";
  }, what);
  return panel.state();
};
const create = (over: Record<string, unknown> = {}) => ({ type: "create", title: "Add b", body: TEMPLATE, draft: false, reviewers: [], assignees: [], labels: [], ...over });

test("opens on the fork's parent, into its default branch, from the branch checked out — with GitHub's title, the template, and what it will have", async () => {
  const w = world();
  fake = installFakeGitHub(routes());
  mountWith(w);
  const panel = await openForm(w);
  const s = panel.state();
  assert.equal(s.status, "ready", JSON.stringify(s.message));
  assert.equal(s.target, "acme/app", "the parent, not your fork");
  assert.deepEqual(s.targets.map((t: any) => t.id), ["acme/app", "me/app"]);
  assert.equal(panel.title, "New pull request · acme/app");
  assert.equal(s.base, "main");
  assert.deepEqual(s.bases[0], { name: "main", isDefault: true });
  assert.equal(s.head.branch, "feature");
  assert.equal(s.head.remote, "origin");
  assert.equal(s.head.ref, "me:feature", "a branch in your fork is owner:branch");
  assert.equal(s.head.push, "new");
  assert.equal(s.proposed.title, "Add b", "the only commit's subject");
  assert.equal(s.proposed.body, TEMPLATE, "the repository's template");
  assert.equal(s.template, ".github/pull_request_template.md");
  assert.equal(s.compare.status, "ready");
  assert.deepEqual(s.compare.commits.map((c: any) => c.subject), ["Add b"]);
  assert.deepEqual(
    s.compare.files.map((f: any) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`),
    ["modified a.txt +1 -1", "added b.txt +1 -0"],
  );
  assert.equal(s.problem, undefined);
  assert.equal(s.canSetMetadata, true);
  assert.deepEqual(s.options.people.map((p: any) => p.login), ["alice", "me"]);
  assert.equal(fake.count(/POST \/graphql/), 2, "one question for the repository, one for the fork's parent");
  assert.equal(pr.said.length, 0, "nothing asked, nothing toasted");
});

test("create: pushed to your fork first, created with every field, reviewers/assignees/labels added — and its page opens in the form's place", async () => {
  const w = world();
  let sent: any;
  fake = installFakeGitHub(routes({ onCreate: (body) => ((sent = body), { status: 201, body: rawPull(50, { title: body.title, draft: body.draft }) }) }));
  mountWith(w);
  const panel = await openForm(w);
  panel.receive(create({ title: "Add b, finally", body: "Why: b.", draft: true, reviewers: ["alice"], assignees: ["me"], labels: ["bug"] }));
  await until(() => !!panel.gone, "the form to close");
  assert.equal(w.tip(w.fork, "feature"), w.git("rev-parse", "refs/heads/feature"), "pushed to your fork");
  assert.equal(w.tip(w.hub, "feature"), undefined, "never to acme/app");
  assert.equal(w.git("rev-parse", "--abbrev-ref", "feature@{upstream}"), "origin/feature", "and it tracks where it went");
  assert.deepEqual(sent, { title: "Add b, finally", head: "me:feature", base: "main", body: "Why: b.", draft: true });
  assert.deepEqual((fake.requests.find((r) => /requested_reviewers$/.test(r.path))?.body as any)?.reviewers, ["alice"]);
  assert.deepEqual((fake.requests.find((r) => /\/assignees$/.test(r.path))?.body as any)?.assignees, ["me"]);
  assert.deepEqual((fake.requests.find((r) => /\/labels$/.test(r.path))?.body as any)?.labels, ["bug"]);
  assert.ok(pr.panels.some((p: any) => p.title === "acme/app#50"), `its page opens (${pr.panels.map((p: any) => p.title).join(", ")})`);
  assert.deepEqual(pr.said.filter((x: any) => x.kind === "info").map((x: any) => x.message), ["Created draft pull request #50."]);
});

test("a pull request for the branch is open already: said on opening, with Open — and Create is refused", async () => {
  const w = world();
  fake = installFakeGitHub(routes({ existing: [rawPull(44, { title: "Already here", head: { ref: "feature", sha: "x", label: "me:feature", repo: { full_name: "me/app" } } })] }));
  mountWith(w);
  const panel = await openForm(w);
  await until(() => !!panel.state().existing, "the lookup");
  const s = panel.state();
  assert.deepEqual(s.existing, { number: 44, title: "Already here", url: "https://github.com/acme/app/pull/44", draft: false });
  assert.equal(s.problem, "feature already has an open pull request, #44.");
  assert.match(fake.requests.find((r) => /head=/.test(r.path))!.path, /head=me%3Afeature/, "asked for YOUR feature, not acme's");
  panel.receive(create());
  await sleep(100);
  assert.equal(fake.count(/POST \/repos\/acme\/app\/pulls$/), 0, "nothing created");
  assert.equal(w.tip(w.fork, "feature"), undefined, "nothing pushed");
  panel.receive({ type: "openExisting" });
  await until(() => pr.panels.some((p: any) => p.title === "acme/app#44"), "#44 to open");
});

test("GitHub answers 'already exists': the one that exists opens", async () => {
  const w = world();
  let lookups = 0;
  fake = installFakeGitHub([
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open&head=/, () => ({ body: lookups++ === 0 ? [] : [rawPull(45)] })],
    ...routes({ onCreate: () => ({ status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for me:feature." }] } }) }),
  ]);
  mountWith(w);
  const panel = await openForm(w);
  panel.receive(create());
  await until(() => pr.panels.some((p: any) => p.title === "acme/app#45"), "#45 to open");
  assert.match(pr.said.map((x: any) => x.message).join("\n"), /feature already has an open pull request: #45\./);
});

test("GitHub refuses: said on the form, which keeps everything; the push stays done", async () => {
  const w = world();
  fake = installFakeGitHub(routes({ onCreate: () => ({ status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] } }) }));
  mountWith(w);
  const panel = await openForm(w);
  panel.receive(create());
  const s = await settledState(panel, "the refusal");
  assert.ok(!panel.gone, "the form stays");
  assert.match(s.notice?.title ?? "", /^Couldn't create the pull request: Validation Failed: PullRequest base invalid/);
  assert.equal(s.notice?.detail, "Everything you wrote is still here.");
  assert.equal(s.head.push, "pushed", "pushed, and it knows");
  assert.equal(s.busy, undefined);
});

test("the push is refused: said, and nothing is created", async () => {
  const w = world();
  // Your fork refuses every push.
  writeFileSync(join(w.fork, "hooks", "pre-receive"), "#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n", { mode: 0o755 });
  fake = installFakeGitHub(routes());
  mountWith(w);
  const panel = await openForm(w);
  panel.receive(create());
  const s = await settledState(panel, "the push to fail");
  assert.equal(s.notice?.title, "Couldn't push feature to origin");
  assert.equal(fake.count(/POST \/repos\/acme\/app\/pulls$/), 0);
});

test("another base is compared again; one GitHub doesn't have is said; one with nothing new refuses Create in words", async () => {
  const w = world();
  // develop on acme/app: main plus the same change as feature, and more.
  w.git("checkout", "-q", "-b", "develop", "feature");
  w.git("commit", "-q", "--allow-empty", "-m", "develop's own");
  w.git("push", "-q", "upstream", "develop");
  w.git("checkout", "-q", "feature");
  fake = installFakeGitHub(routes());
  mountWith(w);
  const panel = await openForm(w);
  panel.receive({ type: "base", branch: "develop" });
  await until(() => panel.state().base === "develop" && panel.state().compare.status === "ready", "develop compared");
  assert.equal(panel.state().compare.commitsTotal, 0);
  assert.equal(panel.state().problem, "Nothing to compare: feature has no commits that develop doesn't.");
  panel.receive({ type: "base", branch: "nope" });
  await until(() => panel.state().base === "nope" && panel.state().compare.status === "failed", "nope failed");
  assert.match(panel.state().compare.error, /^nope couldn't be fetched from acme\/app: /);
  panel.receive({ type: "base", branch: "--upload-pack=x" });
  await sleep(50);
  assert.equal(panel.state().base, "nope", "an option-like base never gets anywhere");
  panel.receive({ type: "head", branch: "main" });
  await until(() => panel.state().head?.branch === "main", "head main");
  panel.receive({ type: "base", branch: "main" });
  await until(() => panel.state().base === "main" && panel.state().compare.status !== "loading", "main into main");
  assert.equal(panel.state().head.ref, "me:main");
  assert.equal(panel.state().problem, "Nothing to compare: main has no commits that main doesn't.", "a fork's main into the parent's main is allowed — when it has something");
});

test("no triage access: reviewers, labels and assignees are off, said, and never sent — even when asked", async () => {
  const w = world();
  fake = installFakeGitHub(routes({ repos: repos({ permission: "READ" }) }));
  mountWith(w);
  const panel = await openForm(w);
  const s = panel.state();
  assert.equal(s.canSetMetadata, false);
  assert.equal(s.metadataNote, "Reviewers, labels and assignees take triage access to acme/app. Its maintainers can add them.");
  panel.receive(create({ reviewers: ["alice"], labels: ["bug"], assignees: ["me"] }));
  await until(() => !!panel.gone, "created");
  assert.equal(fake.count(/requested_reviewers|\/labels$|\/assignees$/), 0, "nothing GitHub would refuse is sent");
});

test("a file opens its diff: the merge base against the branch, by the names each side has", async () => {
  const w = world();
  fake = installFakeGitHub(routes());
  mountWith(w);
  const panel = await openForm(w);
  panel.receive({ type: "openFile", path: "a.txt" });
  await until(() => pr.executed.some((e: any) => e.id === "vscode.diff"), "the diff");
  const [left, right, title] = pr.executed.find((e: any) => e.id === "vscode.diff").args;
  const mb = w.git("merge-base", "main", "feature");
  assert.match(String(left), new RegExp(`rev=${mb}`));
  assert.match(decodeURIComponent(String(right)), /rev=refs\/heads\/feature/);
  assert.equal(title, "a.txt (main ↔ feature)");
});

test("signed out, and not on GitHub: the form says why, and what helps", async () => {
  const w = world();
  fake = installFakeGitHub(routes());
  pr.session = undefined;
  mountWith(w);
  const panel = await openForm(w);
  assert.equal(panel.state().status, "message");
  assert.equal(panel.state().message.title, "Sign in to GitHub to open a pull request");
  assert.equal(panel.state().message.buttons[0].label, "Sign in to GitHub");
  for (const p of pr.panels.splice(0)) p.dispose();
  pr.session = { accessToken: "tok", account: { label: "me", id: "1" }, scopes: ["repo"] };

  const other = world();
  other.git("remote", "remove", "origin");
  other.git("remote", "remove", "upstream");
  other.git("remote", "add", "origin", "https://gitlab.com/acme/app.git");
  mountWith(other);
  const p2 = await openForm(other);
  assert.equal(p2.state().message.title, "This repository has no GitHub remote");
});

test("one form per clone: asked again, it is revealed — not opened twice", async () => {
  const w = world();
  fake = installFakeGitHub(routes());
  mountWith(w);
  const panel = await openForm(w);
  await vscode.commands.executeCommand("gitstudio.pr.create");
  assert.equal(pr.panels.filter((p: any) => p.viewType === "gitstudio.newPullRequest").length, 1);
  assert.equal(panel.reveals, 1);
  panel.receive({ type: "cancel" });
  await until(() => !!panel.gone, "Cancel closes it");
});

// ── Where the branch goes: git's own push-remote rule, and its own name ─────

test("a push remote configured as an option-like word is no remote — it never decides where the branch goes", async () => {
  const w = world();
  w.git("config", "branch.feature.pushRemote", "--receive-pack=touch pwned");
  fake = installFakeGitHub(routes());
  mountWith(w);
  const panel = await openForm(w);
  assert.equal(panel.state().head.remote, "origin", "the branch's own remote, as if nothing were configured");
  assert.equal(panel.state().head.ref, "me:feature");
});

test("a branch started from upstream/main (tracking the base) is pushed under its own name — never into main", async () => {
  const w = world();
  w.git("branch", "--set-upstream-to", "upstream/main", "feature");
  const mainBefore = w.tip(w.hub, "main");
  let sent: any;
  fake = installFakeGitHub(routes({ onCreate: (body) => ((sent = body), { status: 201, body: rawPull(60) }) }));
  mountWith(w);
  const panel = await openForm(w);
  assert.equal(panel.state().head.remote, "upstream", "git's rule: where it tracks, lacking a push remote");
  assert.equal(panel.state().head.push, "new", "new there — not 1 commit ahead of upstream/main");
  panel.receive(create());
  await until(() => !!panel.gone, "created");
  assert.equal(w.tip(w.hub, "main"), mainBefore, "acme's main is untouched");
  assert.equal(w.tip(w.hub, "feature"), w.git("rev-parse", "refs/heads/feature"), "the branch was published under its own name");
  assert.equal(sent?.head, "feature", "in acme/app itself: a bare name");
  assert.equal(w.git("config", "--get", "branch.feature.merge"), "refs/heads/main", "what it tracks is the user's, and stays");
});

test("a triangular branch (pull from upstream, push to your fork) reaches the fork, and the head is there", async () => {
  const w = world();
  w.git("branch", "--set-upstream-to", "upstream/main", "feature");
  w.git("config", "branch.feature.pushRemote", "origin");
  let sent: any;
  fake = installFakeGitHub(routes({ onCreate: (body) => ((sent = body), { status: 201, body: rawPull(61) }) }));
  mountWith(w);
  const panel = await openForm(w);
  assert.equal(panel.state().head.remote, "origin");
  panel.receive(create());
  await until(() => !!panel.gone, "created");
  assert.equal(w.tip(w.hub, "feature"), undefined, "nothing went to acme/app");
  assert.equal(w.tip(w.fork, "feature"), w.git("rev-parse", "refs/heads/feature"), "the fork received the branch");
  assert.equal(sent?.head, "me:feature");
});
