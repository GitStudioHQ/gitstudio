// checkoutPullRequest (src/pr/checkoutPr.ts), called directly, against real
// git: acme/app (a bare "GitHub") with PR #7's branch feature-7 and its
// refs/pull/7/head, and alice's fork, both reached by their github.com URLs
// through insteadOf. prCheckoutBranch.test.ts covers the first checkout of
// each kind through the command; this file covers the SECOND one — a branch
// already here, not checked out: at the PR's tip, behind, diverged (Reset),
// your own `main` used for a fork's `main` — and every row of the old pr/<n>
// copy that a pull request whose repository is gone falls back to.

import { dialogs, pr, vscode } from "./prTestKit";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { configuredRemotes } from "./prGitWorld";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { checkoutPullRequest } = require("../src/pr/checkoutPr") as typeof import("../src/pr/checkoutPr");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

void vscode;
const scratch = mkdtempSync(join(tmpdir(), "gs-prco-cov-"));
const contexts: { dispose(): void }[] = [];
after(() => {
  for (const c of contexts.splice(0)) c.dispose();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
  /** Someone pushes a commit `msg` on `from` to `refs` of `bare` (forced). */
  const push = (bare: string, refs: string[], from: string, msg: string): string => {
    const back = git("symbolic-ref", "--quiet", "--short", "HEAD");
    git("checkout", "-q", "--detach", from);
    writeFileSync(join(work, "pr.txt"), `${msg}\n`);
    git("add", "pr.txt");
    git("commit", "-q", "-m", msg);
    const sha = git("rev-parse", "HEAD");
    for (const ref of refs) execFileSync("git", ["push", "-q", bare, `+${sha}:${ref}`], { cwd: work });
    git("checkout", "-q", back);
    return sha;
  };
  const tip1 = push(hub, ["refs/heads/feature-7", "refs/pull/7/head"], "main", "pr: first");
  const ctx = new GitContext({ root: work });
  configuredRemotes(ctx, work);
  contexts.push({ dispose: () => ctx.dispose() });
  const entry = { root: work, ctx };
  const ghCtx = { owner: "acme", repo: "app", remoteName: "origin", entry } as any;
  const pull = (over: Partial<{ head: string; sha: string; repo: string | null; canModify: boolean }> = {}): any => {
    const repo = over.repo === undefined ? "acme/app" : over.repo;
    const head = over.head ?? "feature-7";
    return {
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
      head: { ref: head, sha: over.sha ?? tip1, label: `${repo?.split("/")[0] ?? "ghost"}:${head}`, repoFullName: repo, cloneUrl: null },
      base: { ref: "main", sha: "x", label: "acme:main", repoFullName: "acme/app", cloneUrl: null },
      labels: [],
      requestedReviewers: [],
      maintainerCanModify: over.canModify ?? false,
    };
  };
  const head = () => git("symbolic-ref", "--short", "HEAD");
  const upstream = (b: string): string => {
    try {
      return git("rev-parse", "--abbrev-ref", `${b}@{upstream}`);
    } catch {
      return "";
    }
  };
  const exists = (b: string): boolean => {
    try {
      git("rev-parse", "--verify", "--quiet", `refs/heads/${b}`);
      return true;
    } catch {
      return false;
    }
  };
  return { base, hub, fork, work, git, push, tip1, entry, ghCtx, pull, head, upstream, exists };
}
type W = ReturnType<typeof world>;

const said = (kind: string): string[] => pr.said.filter((s: any) => s.kind === kind).map((s: any) => s.message);
const lastInfo = () => said("info").at(-1) ?? "";
const run = async (w: W, over?: Parameters<W["pull"]>[0], opts?: Parameters<typeof checkoutPullRequest>[2]) => {
  pr.said.length = 0;
  await checkoutPullRequest(w.ghCtx, w.pull(over), opts);
};

// ── Its real branch, already here ────────────────────────────────────────────

test("the PR's branch already here at its tip, another branch checked out: switched to, nothing moved", async () => {
  const w = world();
  await run(w);
  w.git("checkout", "-q", "main");
  await run(w);
  assert.deepEqual(said("error"), []);
  assert.equal(w.head(), "feature-7");
  assert.equal(w.git("rev-parse", "HEAD"), w.tip1);
  assert.equal(lastInfo(), "Checked out PR #7 as feature-7, tracking origin/feature-7.");
});

test("the PR's branch here and behind, not checked out: moved to the PR's latest, then switched to", async () => {
  const w = world();
  await run(w);
  w.git("checkout", "-q", "main");
  const tip2 = w.push(w.hub, ["refs/heads/feature-7"], w.tip1, "pr: second");
  await run(w, { sha: tip2 });
  assert.deepEqual(said("error"), []);
  assert.equal(w.head(), "feature-7");
  assert.equal(w.git("rev-parse", "HEAD"), tip2);
  assert.equal(lastInfo(), "Checked out PR #7 as feature-7, updated to its latest and tracking origin/feature-7.");
  assert.match(w.git("reflog", "-1", "--format=%gs", "refs/heads/feature-7"), /update feature-7 to pull request #7/);
});

test("diverged, not checked out, Reset chosen: the branch is the PR's again, your commit only in the reflog", async () => {
  const w = world();
  await run(w);
  w.git("commit", "-q", "--allow-empty", "-m", "mine");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  const rewritten = w.push(w.hub, ["refs/heads/feature-7"], "main", "pr: rewritten");
  dialogs.answer = (spec) => (spec.kind === "pick" && /^feature-7 has commits that PR #7 doesn't$/.test(spec.title) ? "replace" : undefined);
  await run(w, { sha: rewritten });
  const q = dialogs.asked.find((a) => /has commits that PR #7/.test(a.title));
  assert.deepEqual(q.choices.map((c: any) => c.id), ["keep", "replace", "cancel"]);
  assert.match(q.hint, /feature-7 has 2 commits that origin\/feature-7 doesn't, and origin\/feature-7 has 1 commit that feature-7 doesn't/);
  assert.equal(w.head(), "feature-7");
  assert.equal(w.git("rev-parse", "HEAD"), rewritten);
  assert.equal(lastInfo(), "Checked out PR #7 as feature-7, tracking origin/feature-7.");
  assert.ok(w.git("reflog", "--format=%H", "refs/heads/feature-7").split("\n").includes(mine), "yours, in the reflog");
});

test("diverged while checked out: Reset isn't offered, and Stay leaves everything as it is", async () => {
  const w = world();
  await run(w);
  w.git("commit", "-q", "--allow-empty", "-m", "mine");
  const mine = w.git("rev-parse", "HEAD");
  const rewritten = w.push(w.hub, ["refs/heads/feature-7"], "main", "pr: rewritten");
  dialogs.answer = (spec) => (spec.kind === "pick" ? "keep" : undefined);
  await run(w, { sha: rewritten });
  const q = dialogs.asked.find((a) => /has commits that PR #7/.test(a.title));
  assert.deepEqual(q.choices.map((c: any) => c.id), ["keep", "cancel"], "resetting the branch you are on is not offered");
  assert.equal(q.choices[0].label, "Stay on feature-7 as it is");
  assert.equal(w.git("rev-parse", "HEAD"), mine);
  assert.deepEqual(said("info"), [], "nothing to say: nothing happened");
});

test("a fork's main, Use main chosen: your main is brought up to theirs and tracks it", async () => {
  const w = world();
  const theirs = w.push(w.fork, ["refs/heads/main"], "main", "alice: on main");
  dialogs.answer = (spec) => (spec.kind === "pick" && /already a branch named main/.test(spec.title) ? "use" : undefined);
  await run(w, { head: "main", repo: "alice/app", sha: theirs, canModify: true });
  const q = dialogs.asked.find((a) => /already a branch named main/.test(a.title));
  assert.ok(q, JSON.stringify(dialogs.asked.map((a) => a.title)));
  const use = q.choices.find((c: any) => c.id === "use");
  assert.equal(use.label, "Use main");
  assert.match(use.description, /Brings in the pull request's 1 commit \(a fast-forward\)\. It will track alice\/main\./);
  assert.equal(w.head(), "main");
  assert.equal(w.git("rev-parse", "HEAD"), theirs);
  assert.equal(w.upstream("main"), "alice/main");
  assert.match(lastInfo(), /^Updated main to the latest of PR #7 \(1 commit brought in\)\. \(Added the remote alice for alice\/app\.\)$/);
});

// ── Failures ─────────────────────────────────────────────────────────────────

test("a head GitHub can't be asked for (not gone, unreachable) is an error that names the repository", async () => {
  const w = world();
  rmSync(w.hub, { recursive: true, force: true });
  await run(w);
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Couldn't fetch PR #7's branch from acme\/app: /);
  assert.equal(w.head(), "main");
  assert.equal(w.exists("feature-7"), false);
});

test("untracked files in the way and the question cancelled: no branch, no toast", async () => {
  const w = world();
  writeFileSync(join(w.work, "pr.txt"), "mine, untracked\n");
  await run(w);
  assert.equal(w.head(), "main");
  assert.equal(w.exists("feature-7"), false);
  assert.deepEqual(said("info"), []);
  assert.deepEqual(
    dialogs.asked.map((a) => [a.title, a.choices.map((c: any) => c.id)]),
    [["Your uncommitted changes are in the way", ["stash", "cancel"]]],
    "asked once, and answered Cancel",
  );
  assert.deepEqual([...said("warning"), ...said("error")], [], "nothing more to say");
});

// ── The old way: pr/<n>, for a PR whose repository is gone ─────────────────────

const GONE = "The repository PR #7's branch came from is gone, so it was checked out as pr/7 at its last commit — a push from there can't reach the pull request.";

test("a PR whose repository is gone: pr/7 from refs/pull/7/head — and each later checkout says where it stands", async () => {
  const w = world();
  // 1. Created.
  await run(w, { repo: null });
  assert.equal(w.head(), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), w.tip1);
  assert.equal(lastInfo(), `${GONE} Checked out PR #7 as pr/7.`);

  // 2. Checked out and current.
  await run(w, { repo: null });
  assert.equal(lastInfo(), `${GONE} pr/7 is checked out and already matches PR #7.`);

  // 3. Current, not checked out.
  w.git("checkout", "-q", "main");
  await run(w, { repo: null });
  assert.equal(w.head(), "pr/7");
  assert.equal(lastInfo(), `${GONE} Checked out PR #7 as pr/7.`);

  // 4. Behind, checked out: fast-forwarded with its working tree.
  const tip2 = w.push(w.hub, ["refs/pull/7/head"], w.tip1, "pr: second");
  await run(w, { repo: null });
  assert.equal(w.git("rev-parse", "HEAD"), tip2);
  assert.equal(lastInfo(), `${GONE} Updated pr/7 to the latest of PR #7.`);

  // 5. Behind, not checked out: moved, then switched to.
  w.git("checkout", "-q", "main");
  const tip3 = w.push(w.hub, ["refs/pull/7/head"], tip2, "pr: third");
  await run(w, { repo: null });
  assert.equal(w.head(), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), tip3);
  assert.equal(lastInfo(), `${GONE} Checked out PR #7 as pr/7, updated to its latest.`);
});

test("pr/7 with commits of yours after a force-push: asked; Keep checks it out as it was, Cancel does nothing", async () => {
  const w = world();
  await run(w, { repo: null });
  w.git("commit", "-q", "--allow-empty", "-m", "mine");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  w.push(w.hub, ["refs/pull/7/head"], "main", "pr: rewritten");

  dialogs.answer = () => "cancel";
  await run(w, { repo: null });
  assert.equal(w.head(), "main");
  assert.deepEqual(said("info"), []);
  const q = dialogs.asked.find((a) => /^pr\/7 has commits that PR #7 doesn't$/.test(a.title));
  assert.deepEqual(q.choices.map((c: any) => c.id), ["keep", "cancel"]);

  dialogs.answer = () => "keep";
  await run(w, { repo: null });
  assert.equal(w.head(), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), mine);
  assert.equal(lastInfo(), `${GONE} Checked out pr/7 as it was (not updated to PR #7).`);
});

test("pr/7 checked out in another worktree: said where, and nothing moves here", async () => {
  const w = world();
  await run(w, { repo: null });
  w.git("checkout", "-q", "main");
  const other = join(w.base, "other");
  w.git("worktree", "add", "-q", other, "pr/7");
  await run(w, { repo: null });
  assert.equal(w.head(), "main");
  assert.deepEqual(said("info"), []);
  assert.match(said("warning").join("\n"), /pr\/7/);
});

test("a PR whose repository is gone and whose last commit can't be fetched either: one error, both reasons", async () => {
  const w = world();
  execFileSync("git", ["--git-dir", w.hub, "update-ref", "-d", "refs/pull/7/head"]);
  await run(w, { repo: null });
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^The repository PR #7's branch came from is gone, and PR #7's last commit couldn't be fetched: /);
  assert.equal(w.exists("pr/7"), false);
});

// ── git refusing a step ────────────────────────────────────────────────────

/** Another git holding `rel` (a lock file under .git) while `fn` runs. */
async function whileLocked(w: W, rel: string, fn: () => Promise<void>): Promise<void> {
  const lock = join(w.work, ".git", ...rel.split("/"));
  writeFileSync(lock, "");
  try {
    await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

test("a checkout git refuses (another git holds the index) says git's first line, and nothing else", async () => {
  const w = world();
  await whileLocked(w, "index.lock", () => run(w));
  const errors = said("error");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Couldn't check out PR #7: .*index\.lock/);
  assert.ok(!errors[0].includes("\n"), "one line");
  assert.equal(w.head(), "main");
  assert.deepEqual(said("info"), []);
});

test("a branch git won't move (its ref is locked) says so, and it stays where it was", async () => {
  const w = world();
  await run(w);
  w.git("checkout", "-q", "main");
  const tip2 = w.push(w.hub, ["refs/heads/feature-7"], w.tip1, "pr: second");
  await whileLocked(w, "refs/heads/feature-7.lock", () => run(w, { sha: tip2 }));
  assert.match(said("error").join("\n"), /^Couldn't update feature-7: /);
  assert.equal(w.git("rev-parse", "refs/heads/feature-7"), w.tip1);
  assert.equal(w.head(), "main");

  // Diverged, and Reset chosen, with the ref still locked.
  w.git("checkout", "-q", "feature-7");
  w.git("commit", "-q", "--allow-empty", "-m", "mine");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  dialogs.answer = (spec) => (spec.kind === "pick" ? "replace" : undefined);
  await whileLocked(w, "refs/heads/feature-7.lock", () => run(w, { sha: tip2 }));
  assert.match(said("error").join("\n"), /^Couldn't move feature-7: /);
  assert.equal(w.git("rev-parse", "refs/heads/feature-7"), mine);
});

test("pr/7 git won't move (its ref is locked) says so, and stays at its old commit", async () => {
  const w = world();
  await run(w, { repo: null });
  w.git("checkout", "-q", "main");
  w.push(w.hub, ["refs/pull/7/head"], w.tip1, "pr: second");
  await whileLocked(w, "refs/heads/pr/7.lock", () => run(w, { repo: null }));
  assert.match(said("error").join("\n"), /^Couldn't update pr\/7: /);
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), w.tip1);
  assert.equal(w.head(), "main");
});
