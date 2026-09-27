// Checkout a pull request, through the REAL command against real git: onto
// its real head branch, tracking it where it lives (gh pr checkout), so a
// push from here reaches the pull request. A bare "GitHub" for acme/app (the
// pull request's repository) and one for alice's fork, reached by their
// github.com URLs through git's url.<path>.insteadOf — the remote a checkout
// adds for a fork is the URL a real clone would get.
//
// THE STATE TABLE — the local branch of the head's name, and the tree:
//
//   same repository · no such branch              → created, tracking origin/<head>
//   same repository · checked out, behind         → fast-forwarded, working tree moved
//   same repository · checked out, ahead          → nothing moved; says what isn't pushed
//   same repository · diverged (force-push)       → asked; Cancel and Keep move nothing
//   same repository · your own, tracking nothing  → "already on it", now tracking
//   fork · no remote for it · your main in the way → remote added, asked; Checkout as alice-main,
//                                                    which says how a push reaches the PR (real git:
//                                                    GitStudio's Push and `git push alice HEAD:main`
//                                                    do; a plain `git push` is refused, names differ)
//   fork · asked, Cancel                           → nothing changes: the added remote goes too
//   fork · no edits from maintainers               → says a push will be refused
//   dirty tree in the way                          → Stash & Retry, and the change comes back
//   head branch gone                               → pr/<n> at its last commit, said
//   checked out in another worktree               → said where, before any fetch; nothing moves
//   a fork's name on your branch held elsewhere   → asked, with a free name; never Use
//
// The old command made pr/<n> from refs/pull/<n>/head with no upstream: every
// row below that asserts an upstream fails on it.

import Module from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeGitHub, rawPull, type FakeGitHub } from "./fakeGitHub";
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

// Hermetic git, and no ~/.ssh/config of the machine's.
const cfgDir = mkdtempSync(join(tmpdir(), "gs-prco-cfg-"));
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
const scratch = mkdtempSync(join(tmpdir(), "gs-prco-git-"));
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
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext"), workspaceState: undefined };
  registerPrFeature(context as any, { onDidChange: changed.event, getActive: () => active } as any, { isEnabled: async () => false } as any);
  contexts.push({ dispose: () => context.subscriptions.forEach((d) => d.dispose()) });
}

/**
 * acme/app (a bare hub) with main and PR #7's branch feature-7; alice's fork
 * (a bare) with a PR from ITS main; a clone of acme/app. Both are reached by
 * their github.com URLs: the clone's config names them as a real one would.
 */
function world() {
  const base = mkdtempSync(join(scratch, "w-"));
  const hub = join(base, "hub.git");
  const fork = join(base, "fork.git");
  const work = join(base, "work");
  for (const bare of [hub, fork]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const git = at(work);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git("config", k, v);
  git("config", `url.${hub}.insteadOf`, "https://github.com/acme/app.git");
  git("config", `url.${fork}.insteadOf`, "https://github.com/alice/app.git");
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  git("push", "-q", "origin", "main");
  git("fetch", "-q", "origin");
  git("branch", "--set-upstream-to", "origin/main", "main");
  /** Someone pushes `file` = `msg` onto `branch` of `bare`, from `from` (a force-push when it isn't the tip). */
  const push = (bare: string, branch: string, from: string, msg: string, extra: string[] = []): string => {
    const back = git("symbolic-ref", "--quiet", "--short", "HEAD");
    git("checkout", "-q", "--detach", from);
    writeFileSync(join(work, "pr.txt"), `${msg}\n`);
    git("add", "pr.txt");
    git("commit", "-q", "-m", msg);
    const sha = git("rev-parse", "HEAD");
    for (const ref of [`refs/heads/${branch}`, ...extra]) execFileSync("git", ["push", "-q", bare, `+${sha}:${ref}`], { cwd: work });
    git("checkout", "-q", back);
    return sha;
  };
  const tip1 = push(hub, "feature-7", "main", "pr: first", ["refs/pull/7/head"]);
  const ctx = new GitContext({ root: work });
  configuredRemotes(ctx, work);
  contexts.push({ dispose: () => ctx.dispose() });
  const entry = { root: work, ctx };
  const ghCtx = { owner: "acme", repo: "app", remoteName: "origin", entry };
  const pull = (over: Partial<{ head: string; sha: string; repo: string | null; canModify: boolean; n: number }> = {}) => {
    const repo = over.repo === undefined ? "acme/app" : over.repo;
    const head = over.head ?? "feature-7";
    return {
      number: over.n ?? 7,
      title: "The PR",
      body: "",
      state: "open",
      draft: false,
      htmlUrl: `https://github.com/acme/app/pull/${over.n ?? 7}`,
      user: { login: "alice", avatarUrl: null, htmlUrl: null },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      mergedAt: null,
      head: { ref: head, sha: over.sha ?? tip1, label: `${repo?.split("/")[0] ?? "ghost"}:${head}`, repoFullName: repo, cloneUrl: null },
      base: { ref: "main", sha: "x", label: "acme:main", repoFullName: "acme/app", cloneUrl: null },
      labels: [],
      requestedReviewers: [],
      maintainerCanModify: over.canModify ?? false,
    };
  };
  return { base, hub, fork, work, git, push, tip1, entry, ghCtx, pull };
}

const checkout = (w: ReturnType<typeof world>, over?: Parameters<ReturnType<typeof world>["pull"]>[0]) =>
  vscode.commands.executeCommand("gitstudio.pr.checkout", { pr: w.pull(over), ctx: w.ghCtx });
const said = (kind: string) => pr.said.filter((s: any) => s.kind === kind).map((s: any) => s.message);
const upstream = (w: ReturnType<typeof world>, b: string): string => {
  try {
    return w.git("rev-parse", "--abbrev-ref", `${b}@{upstream}`);
  } catch {
    return "";
  }
};
const branchExists = (w: ReturnType<typeof world>, b: string): boolean => {
  try {
    w.git("rev-parse", "--verify", "--quiet", `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};

test("same repository, no branch yet: its real branch, tracking it — and the toast after the spinner", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7", "the real branch, not pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), w.tip1);
  assert.equal(upstream(w, "feature-7"), "origin/feature-7", "it tracks the pull request's branch");
  assert.equal(w.git("config", "--get", "branch.feature-7.pushRemote"), "origin", "and pushes there");
  assert.equal(branchExists(w, "pr/7"), false, "no pr/7 copy");
  const info = pr.said.findIndex((s: any) => s.kind === "info" && /Checked out PR #7 as feature-7, tracking origin\/feature-7\./.test(s.message));
  assert.ok(info >= 0, JSON.stringify(pr.said));
  assert.ok(pr.said.map((s: any) => s.kind).indexOf("progress-end") < info, "the spinner stops before the toast is shown");

  // A fix made here reaches the pull request with a plain push.
  writeFileSync(join(w.work, "fix.txt"), "fix\n");
  w.git("add", "fix.txt");
  w.git("commit", "-qm", "fix");
  w.git("push", "-q");
  assert.equal(execFileSync("git", ["--git-dir", w.hub, "rev-parse", "refs/heads/feature-7"], { encoding: "utf8" }).trim(), w.git("rev-parse", "HEAD"));
});

test("same repository, checked out and behind: brought up to date, the working tree with it", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  const tip2 = w.push(w.hub, "feature-7", w.tip1, "pr: second");
  await checkout(w);
  assert.deepEqual(said("error"), []);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7");
  assert.equal(w.git("rev-parse", "HEAD"), tip2);
  assert.equal(readFileSync(join(w.work, "pr.txt"), "utf8"), "pr: second\n", "the working tree moved with it");
  assert.match(said("info").join("\n"), /Updated feature-7 to the latest of PR #7 \(1 commit brought in\)/);
});

test("same repository, your commits on top: nothing moves, and it says they aren't pushed yet", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  w.git("commit", "-q", "--allow-empty", "-m", "mine");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7");
  assert.equal(w.git("rev-parse", "HEAD"), mine);
  assert.match(said("info").at(-1) ?? "", /1 commit of yours isn't pushed to it yet/);
});

test("same repository, diverged by a force-push: asked — Cancel and Keep move nothing of yours", async () => {
  const w = world();
  mountWith(w.entry);
  await checkout(w);
  writeFileSync(join(w.work, "fix.txt"), "my fix\n");
  w.git("add", "fix.txt");
  w.git("commit", "-qm", "my fix on the PR");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  w.push(w.hub, "feature-7", "main", "pr: rewritten");

  answer = (spec) => (spec.kind === "pick" && /^feature-7 has commits that PR #7 doesn't$/.test(spec.title) ? "cancel" : undefined);
  await checkout(w);
  assert.equal(asked.length, 1, "asked");
  assert.ok(asked[0].choices.some((c: any) => c.id === "replace"), "not checked out: resetting it is offered, and marked dangerous");
  assert.equal(w.git("rev-parse", "refs/heads/feature-7"), mine, "cancelled: the fix is still there");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");

  answer = (spec) => (spec.kind === "pick" ? "keep" : undefined);
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7");
  assert.equal(w.git("rev-parse", "HEAD"), mine, "checked out as it was");
});

test("same repository, your own branch that tracks nothing: 'already on it', and it now tracks the PR's", async () => {
  const w = world();
  mountWith(w.entry);
  w.git("checkout", "-q", "-b", "feature-7", w.tip1);
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7");
  assert.match(said("info").join("\n"), /You're already on feature-7, the branch of PR #7; it now tracks origin\/feature-7\./);
  assert.equal(upstream(w, "feature-7"), "origin/feature-7");
});

test("a fork, with no remote for it, from its main: the remote is added, and your main is never taken over", async () => {
  const w = world();
  const theirs = w.push(w.fork, "main", "main", "alice: fix", []);
  w.git("push", "-q", w.hub, `+${theirs}:refs/pull/9/head`);
  mountWith(w.entry);
  const mainBefore = w.git("rev-parse", "refs/heads/main");
  answer = (spec) => (spec.kind === "pick" && /^There's already a branch named main$/.test(spec.title) ? "alt" : undefined);
  await checkout(w, { n: 9, head: "main", repo: "alice/app", sha: theirs, canModify: true });
  const q = asked.find((a) => /already a branch named main/.test(a.title));
  assert.ok(q, `asked (${asked.map((a) => a.title).join(" / ")})`);
  assert.match(q.hint, /main tracks origin\/main — it isn't alice\/main, the branch of PR #9/);
  assert.deepEqual(
    q.choices.map((c: any) => c.id),
    ["alt", "use", "cancel"],
  );
  assert.equal(q.choices[0].label, "Checkout as alice-main");
  assert.equal(
    q.choices[0].description,
    "A new branch, tracking alice/main. GitStudio's Push reaches the pull request; from a terminal, git push alice HEAD:main.",
    "what a push from it takes, said before it is chosen",
  );
  assert.equal(w.git("remote", "get-url", "alice"), w.fork, "the fork's remote, by its github.com URL");
  assert.equal(w.git("config", "--get", "remote.alice.url"), "https://github.com/alice/app.git");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "alice-main");
  assert.equal(w.git("rev-parse", "HEAD"), theirs);
  assert.equal(upstream(w, "alice-main"), "alice/main");
  assert.equal(w.git("rev-parse", "refs/heads/main"), mainBefore, "your main is untouched");
  assert.equal(upstream(w, "main"), "origin/main", "and still yours");
  assert.equal(
    said("info").at(-1),
    "Checked out PR #9 as alice-main, tracking alice/main. GitStudio's Push reaches the pull request; from a terminal, git push alice HEAD:main. (Added the remote alice for alice/app.)",
  );
  // What the words say, in real git (push.default unset: git's own "simple").
  writeFileSync(join(w.work, "fix.txt"), "one\n");
  w.git("add", "fix.txt");
  w.git("commit", "-qm", "fix: one");
  assert.throws(() => w.git("push", "-q"), /does not match\s+the name of your current branch/, "a plain git push is refused: the names differ");
  const pushed = await w.entry.ctx.sync.push();
  assert.ok(pushed.ok, `GitStudio's Push: ${pushed.stderr}`);
  assert.equal(execFileSync("git", ["--git-dir", w.fork, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), w.git("rev-parse", "HEAD"), "…reaches alice's main");
  writeFileSync(join(w.work, "fix.txt"), "two\n");
  w.git("commit", "-qam", "fix: two");
  w.git("push", "-q", "alice", "HEAD:main");
  assert.equal(execFileSync("git", ["--git-dir", w.fork, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(), w.git("rev-parse", "HEAD"), "…and so does the command it names");
  assert.equal(w.git("rev-parse", "refs/heads/main"), mainBefore, "your main is still untouched");
});

test("a fork, asked and cancelled: nothing changes — the remote added for it goes too", async () => {
  const w = world();
  const theirs = w.push(w.fork, "main", "main", "alice: fix", []);
  mountWith(w.entry);
  answer = (spec) => (spec.kind === "pick" ? "cancel" : undefined);
  await checkout(w, { n: 9, head: "main", repo: "alice/app", sha: theirs });
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(branchExists(w, "alice-main"), false);
  assert.deepEqual(w.git("remote").split("\n"), ["origin"], "the remote it added is removed again");
  assert.deepEqual(said("info"), []);
});

test("a fork whose author doesn't allow edits from maintainers: checked out, and it says a push will be refused", async () => {
  const w = world();
  const theirs = w.push(w.fork, "topic", "main", "alice: topic", []);
  mountWith(w.entry);
  fake = installFakeGitHub([["GET", /^\/user$/, () => ({ body: { login: "me" } })]]);
  await checkout(w, { n: 9, head: "topic", repo: "alice/app", sha: theirs, canModify: false });
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "topic");
  assert.equal(upstream(w, "topic"), "alice/topic");
  assert.match(said("info").at(-1) ?? "", /doesn't let maintainers edit it, so a push to it will be refused/);
});

test("uncommitted changes in the way: Stash & Retry, and they come back", async () => {
  const w = world();
  mountWith(w.entry);
  // pr.txt differs on the PR's branch: an edit to it here is in the way.
  writeFileSync(join(w.work, "pr.txt"), "my edit\n");
  w.git("add", "pr.txt");
  w.git("commit", "-qm", "pr.txt on main");
  writeFileSync(join(w.work, "pr.txt"), "uncommitted\n");
  answer = (spec) => (spec.kind === "pick" && spec.title === "Your uncommitted changes are in the way" ? "stash" : undefined);
  await checkout(w);
  assert.ok(asked.some((a) => a.title === "Your uncommitted changes are in the way"), "asked Stash & Retry");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "feature-7");
  assert.equal(upstream(w, "feature-7"), "origin/feature-7");
});

test("the branch is gone from GitHub: its last commit as pr/7, and it says a push can't reach it", async () => {
  const w = world();
  mountWith(w.entry);
  execFileSync("git", ["--git-dir", w.hub, "update-ref", "-d", "refs/heads/feature-7"]);
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), w.tip1);
  assert.match(said("info").at(-1) ?? "", /feature-7 is gone from acme\/app, so it was checked out as pr\/7 at its last commit — a push from there can't reach the pull request/);
});

test("checked out in another worktree: said where, and nothing moves here", async () => {
  const w = world();
  mountWith(w.entry);
  w.git("fetch", "-q", "origin");
  w.git("branch", "--track", "feature-7", "origin/feature-7");
  const other = join(w.base, "other");
  w.git("worktree", "add", "-q", other, "feature-7");
  await checkout(w);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
  assert.match(said("warning").join("\n"), /feature-7/);
});

test("a fork's branch named like one of yours that another worktree holds: asked, with a free name — never Use, never refused", async () => {
  const w = world();
  const theirs = w.push(w.fork, "topic", "main", "alice: topic", []);
  w.git("worktree", "add", "-q", "-b", "topic", join(w.base, "mine"), "main");
  mountWith(w.entry);
  answer = (spec) => (spec.kind === "pick" && /already a branch named topic/.test(spec.title) ? "alt" : undefined);
  await checkout(w, { n: 9, head: "topic", repo: "alice/app", sha: theirs, canModify: true });
  const q = asked.find((a) => /already a branch named topic/.test(a.title));
  assert.ok(q, `asked (${asked.map((a) => a.title).join(" / ")})`);
  assert.deepEqual(q.choices.map((c: any) => c.id), ["alt", "cancel"], "Use can't work while another worktree holds it");
  assert.match(q.hint, /It is checked out in the worktree at .*mine/);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "alice-topic");
  assert.equal(upstream(w, "alice-topic"), "alice/topic");
});

test("the toast's Open Pull Request opens THAT pull request — not the same number in the repository active when it is clicked", async () => {
  const w = world();
  let active: any = w.entry;
  const changed = new vscode.EventEmitter();
  const context = { subscriptions: [] as { dispose(): void }[], extensionUri: vscode.Uri.file("/ext") };
  registerPrFeature(context as any, { onDidChange: changed.event, getActive: () => active } as any, { isEnabled: async () => false } as any);
  contexts.push({ dispose: () => context.subscriptions.forEach((d) => d.dispose()) });
  const other = mkdtempSync(join(scratch, "o-"));
  execFileSync("git", ["init", "-q", "-b", "main", other]);
  at(other)("remote", "add", "origin", "https://github.com/acme/other.git");
  const otherCtx = new GitContext({ root: other });
  contexts.push({ dispose: () => otherCtx.dispose() });
  fake = installFakeGitHub([
    ["GET", /^\/repos\/[^/]+\/[^/]+\/pulls\/7$/, () => ({ body: rawPull(7) })],
    ["GET", /\/files/, () => ({ body: [] })],
    ["GET", /\/check-runs|\/status/, () => ({ body: { check_runs: [], statuses: [] } })],
  ]);
  pr.answer = (_kind: string, _message: string, items: string[]) => {
    if (items.includes("Open Pull Request")) {
      active = { root: other, ctx: otherCtx };
      return "Open Pull Request";
    }
    return undefined;
  };
  await checkout(w);
  await new Promise((r) => setTimeout(r, 200));
  const titles = pr.panels.map((p: any) => p.title);
  assert.ok(titles.includes("acme/app#7"), `acme/app#7 opens (tabs: ${titles.join(", ")})`);
  assert.ok(!titles.includes("acme/other#7"), "never acme/other#7");
  assert.deepEqual(fake.requests.map((r) => r.path).filter((p) => p.startsWith("/repos/acme/other/")), []);
});
