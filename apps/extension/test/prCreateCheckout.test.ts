// Check out and Create pull request, through the REAL commands against real
// git: a bare "GitHub" whose refs/pull/7/head the test moves the way a
// contributor's pushes do, and a fake api.github.com for the REST half.
//
// Checkout used to be `git fetch <remote> --force pull/7/head:pr/7`: refused
// while pr/7 was checked out, and silently throwing away commits made on it.
// Create PR sent every PR as ready (it compared the dialog's answer to the
// LABEL "Draft"; the dialog answers with the id), and a branch living in your
// fork as a bare name, which GitHub reads as a branch of the target repo.

import Module from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeGitHub, rawPull, type FakeGitHub, type Route } from "./fakeGitHub";

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

// Hermetic git, and no ~/.ssh/config of the machine's.
const cfgDir = mkdtempSync(join(tmpdir(), "gs-pr-cfg-"));
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
const scratch = mkdtempSync(join(tmpdir(), "gs-pr-git-"));
after(() => {
  try {
    execFileSync("rm", ["-rf", scratch]);
  } catch {
    /* swept by the OS */
  }
});

let asked: any[] = [];
let answer: (spec: any) => string | undefined = () => undefined;
registerDialogHost({
  show: async (spec: any) => {
    asked.push(spec);
    const v = answer(spec);
    return v === undefined ? undefined : { value: v };
  },
});

const contexts: { dispose(): void }[] = [];
let fake: FakeGitHub | undefined;
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  fake?.restore();
  fake = undefined;
  asked = [];
  answer = () => undefined;
  pr.reset();
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function mountWith(active: any) {
  const changed = new vscode.EventEmitter();
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext") };
  registerPrFeature(context as any, { onDidChange: changed.event, getActive: () => active } as any, { isEnabled: async () => false } as any);
  contexts.push({ dispose: () => context.subscriptions.forEach((d) => d.dispose()) });
}

/** A bare hub with main, a clone, and PR #7 = one commit on main. */
function world() {
  const base = mkdtempSync(join(scratch, "w-"));
  const hub = join(base, "hub.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", hub]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const git = at(work);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git("config", k, v);
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", hub);
  git("push", "-q", "origin", "main");
  const prAdvance = (from: string, msg: string): string => {
    const back = git("symbolic-ref", "--quiet", "--short", "HEAD");
    git("checkout", "-q", "--detach", from);
    writeFileSync(join(work, "pr.txt"), `${msg}\n`);
    git("add", "pr.txt");
    git("commit", "-q", "-m", msg);
    const sha = git("rev-parse", "HEAD");
    git("push", "-q", "origin", `+${sha}:refs/pull/7/head`);
    git("checkout", "-q", back);
    return sha;
  };
  const tip1 = prAdvance("main", "pr: first");
  const ctx = new GitContext({ root: work });
  contexts.push({ dispose: () => ctx.dispose() });
  const entry = { root: work, ctx };
  const ghCtx = { owner: "acme", repo: "app", remoteName: "origin", entry };
  const pull = (head = "feature-7") => ({
    number: 7,
    title: "The PR",
    body: "",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/acme/app/pull/7",
    user: { login: "alice", avatarUrl: null, htmlUrl: null },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    mergedAt: null,
    head: { ref: head, sha: tip1, label: `acme:${head}`, repoFullName: "acme/app", cloneUrl: null },
    base: { ref: "main", sha: "x", label: "acme:main", repoFullName: "acme/app", cloneUrl: null },
    labels: [],
    requestedReviewers: [],
  });
  return { work, git, prAdvance, tip1, entry, ghCtx, pull };
}

const checkout = (w: ReturnType<typeof world>, head?: string) =>
  vscode.commands.executeCommand("gitstudio.pr.checkout", { pr: w.pull(head), ctx: w.ghCtx });
const said = (kind: string) => pr.said.filter((s: any) => s.kind === kind).map((s: any) => s.message);

test("checkout: pr/7 is created; the toast comes after the progress has ended", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), w.tip1);
  const kinds = pr.said.map((s: any) => s.kind);
  const info = pr.said.findIndex((s: any) => s.kind === "info" && /Checked out PR #7 as pr\/7/.test(s.message));
  assert.ok(info >= 0, JSON.stringify(pr.said));
  assert.ok(kinds.indexOf("progress-end") < info, "the spinner stops before the toast is shown");
});

test("checkout: a checked-out pr/7 is brought up to date — git's fetch refused to write it", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  const tip2 = w.prAdvance(w.tip1, "pr: second");
  await checkout(w);
  assert.deepEqual(said("error"), [], "no \"Couldn't fetch\"");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), tip2);
  assert.equal(readFileSync(join(w.work, "pr.txt"), "utf8"), "pr: second\n", "the working tree moved with it");
});

test("checkout: commits made on pr/7 are never thrown away without asking", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  writeFileSync(join(w.work, "fix.txt"), "my fix\n");
  w.git("add", "fix.txt");
  w.git("commit", "-qm", "my fix on the PR");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  // The contributor force-pushes a rewrite that doesn't have the fix.
  w.prAdvance("main", "pr: rewritten");

  answer = (spec) => (spec.kind === "pick" && /^pr\/7 has commits that PR #7 doesn't$/.test(spec.title) ? "cancel" : undefined);
  await checkout(w);
  assert.equal(asked.length, 1, "asked");
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), mine, "cancelled: pr/7 still has the fix");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");

  answer = (spec) => (spec.kind === "pick" ? "keep" : undefined);
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), mine, "checked out as it was");
});

test("checkout: on the PR's own branch already, it says so instead of moving you to a pr/7 copy", async () => {
  const w = world();
  mountWith(w.entry);
  w.git("checkout", "-q", "-b", "feature-7", w.tip1);
  await checkout(w, "feature-7");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7");
  assert.match(said("info").join("\n"), /already on feature-7, the branch of PR #7/);
});

// ── Create pull request ─────────────────────────────────────────────────────

/** A clone of acme/app with a `mine` fork remote the feature branch is pushed to. */
function forkWorld() {
  const base = mkdtempSync(join(scratch, "c-"));
  const work = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const git = at(work);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git("config", k, v);
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  git("remote", "add", "mine", "git@github.com:me/app.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-qm", "Add b");
  // Published to the fork, and up to date there: nothing to push.
  git("update-ref", "refs/remotes/mine/feature", "HEAD");
  git("config", "branch.feature.remote", "mine");
  git("config", "branch.feature.merge", "refs/heads/feature");
  const ctx = new GitContext({ root: work });
  contexts.push({ dispose: () => ctx.dispose() });
  return { work, git, entry: { root: work, ctx } };
}

function createRoutes(onCreate: (body: any) => { status?: number; body: unknown }): Route[] {
  return [
    ["GET", /^\/repos\/acme\/app$/, () => ({ body: { default_branch: "main" } })],
    ["POST", /^\/repos\/acme\/app\/pulls$/, (req) => onCreate(req.body)],
    ["GET", /^\/repos\/acme\/app\/pulls\?state=open&head=me%3Afeature/, () => ({ body: [rawPull(44, { title: "Already here" })] })],
    ["GET", /^\/repos\/acme\/app\/pulls\/(\d+)$/, (_r, m) => ({ body: rawPull(Number(m[1])) })],
    ["GET", /^\/repos\/acme\/app\/pulls\/\d+\/files/, () => ({ body: [] })],
    ["GET", /\/check-runs|\/status/, () => ({ body: { check_runs: [], statuses: [] } })],
  ];
}

const wizard = (draft: "draft" | "ready") => (spec: any) => {
  if (spec.kind === "pick" && /^Base branch/.test(spec.title)) return "main";
  if (spec.kind === "input" && spec.title === "Pull request title") return "Add b";
  if (spec.kind === "input" && spec.title === "Pull request description") return "";
  if (spec.kind === "pick" && spec.title === "Open as a draft?") return draft;
  return undefined;
};

test("create: Draft creates a draft; a branch in your fork is sent as owner:branch", async () => {
  const w = forkWorld();
  let sent: any;
  fake = installFakeGitHub(
    createRoutes((body) => {
      sent = body;
      return { status: 201, body: rawPull(50, { draft: body.draft }) };
    }),
  );
  mountWith(w.entry);
  answer = wizard("draft");
  await vscode.commands.executeCommand("gitstudio.pr.create");
  assert.ok(sent, `the PR was created (asked: ${asked.map((a) => a.title).join(" / ")})`);
  assert.equal(sent.draft, true, "the Draft choice");
  assert.equal(sent.head, "me:feature", "GitHub reads a bare name as a branch of acme/app");
  assert.equal(sent.base, "main");
  assert.ok(pr.panels.some((p: any) => p.title === "PR #50"), "the new PR's page opens");

  sent = undefined;
  asked = [];
  answer = wizard("ready");
  await vscode.commands.executeCommand("gitstudio.pr.create");
  assert.equal(sent.draft, false);
});

test("create: 'already exists' opens the PR that exists", async () => {
  const w = forkWorld();
  fake = installFakeGitHub(
    createRoutes(() => ({
      status: 422,
      body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for me:feature." }] },
    })),
  );
  mountWith(w.entry);
  answer = wizard("ready");
  await vscode.commands.executeCommand("gitstudio.pr.create");
  assert.ok(pr.panels.some((p: any) => p.title === "PR #44"), `the existing PR opens (said: ${JSON.stringify(pr.said)})`);
});

test("create: the base question offers only branches the remote has", async () => {
  const w = forkWorld();
  fake = installFakeGitHub(createRoutes(() => ({ status: 201, body: rawPull(51) })));
  mountWith(w.entry);
  answer = wizard("ready");
  await vscode.commands.executeCommand("gitstudio.pr.create");
  const base = asked.find((a) => /^Base branch/.test(a.title));
  assert.deepEqual(
    base.choices.map((c: any) => c.id).filter((id: string) => id !== "gitstudio:other"),
    ["main"],
    "no master or develop that origin doesn't have",
  );
});
