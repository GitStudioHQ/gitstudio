import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess } from "../src/GitProcess";
import {
  addRemote,
  fetchPrBranch,
  freeBranchName,
  isSafeBranchName,
  moveLocalBranch,
  newRemoteName,
  planPrBranch,
  prBranchElsewhere,
  remoteUrlLike,
  trackPrBranch,
  type PrBranchTarget,
} from "../src/prBranch";
import { removeTempRepo } from "./tmpRepo";

// Checking out a pull request onto its REAL head branch, tracking it where it
// lives (gh pr checkout), against real git: a bare "GitHub" for the pull
// request's repository, a bare fork, and a clone. The state table is the
// local branch of the head's name as the user can have it —
//
//   absent · the PR's branch (tracking it) at / behind / ahead of / diverged
//   from its head · your own same-repository branch tracking nothing · a
//   fork's head name on a branch of yours · a same-named branch tracking
//   something else · checked out in another worktree · tracked through
//   another name for the same repository
//
// — and each cell pins what the plan says AND that planning moved nothing.
// The old checkout made `pr/<n>` with no upstream: a push from it reached
// nothing.

const scratch = mkdtempSync(join(tmpdir(), "gs-prbr-"));
after(() => removeTempRepo(scratch));

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
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", hub);
  git("push", "-q", "origin", "main");
  git("fetch", "-q", "origin");
  git("branch", "--set-upstream-to", "origin/main", "main");
  /** Someone pushes to `branch` on `bare` (a force-push when `from` isn't its tip). */
  const push = (bare: string, branch: string, from: string, msg: string): string => {
    git("checkout", "-q", "--detach", from);
    git("commit", "-q", "--allow-empty", "-m", msg);
    const sha = git("rev-parse", "HEAD");
    execFileSync("git", ["push", "-q", bare, `+${sha}:refs/heads/${branch}`], { cwd: work });
    git("checkout", "-q", "main");
    return sha;
  };
  const tip1 = push(hub, "feature", "main", "pr: first");
  const proc = new GitProcess({ cwd: work });
  const same: PrBranchTarget = { n: 7, headRef: "feature", remote: "origin", sameRepo: true, headOwner: "acme" };
  return { base, hub, fork, work, git, push, tip1, proc, same };
}

const refOf = (git: (...a: string[]) => string, ref: string): string | undefined => {
  try {
    return git("rev-parse", "--verify", "--quiet", ref);
  } catch {
    return undefined;
  }
};

test("fetch: the head branch lands in its remote-tracking ref, and no local branch is written", async () => {
  const w = world();
  const f = await fetchPrBranch(w.proc, w.same);
  assert.deepEqual(f, { sha: w.tip1 });
  assert.equal(refOf(w.git, "refs/remotes/origin/feature"), w.tip1);
  assert.equal(refOf(w.git, "refs/heads/feature"), undefined, "no branch was written");

  const gone = await fetchPrBranch(w.proc, { ...w.same, headRef: "deleted-after-merge" });
  assert.ok("error" in gone && gone.gone === true, JSON.stringify(gone));

  const optionRemote = await fetchPrBranch(w.proc, { ...w.same, remote: "--upload-pack=touch /tmp/x" });
  assert.ok("error" in optionRemote && !("gone" in optionRemote), "an option-like remote never reaches git");
  const optionBranch = await fetchPrBranch(w.proc, { ...w.same, headRef: "-x" });
  assert.ok("error" in optionBranch, "nor an option-like branch");
  w.proc.dispose();
});

test("plan: absent → create, and it will track the pull request's branch", async () => {
  const w = world();
  const p = await planPrBranch(w.proc, w.same, w.tip1);
  assert.equal(p.kind, "create");
  assert.equal(p.local, "feature");
  assert.equal(p.trackingName, "origin/feature");
  assert.equal(p.setUpstream, true);
  w.proc.dispose();
});

test("plan: the PR's branch — at its head, behind it, ahead of it, diverged from it (planning moves nothing)", async () => {
  const w = world();
  await fetchPrBranch(w.proc, w.same);
  w.git("branch", "--track", "feature", "origin/feature");

  const current = await planPrBranch(w.proc, w.same, w.tip1);
  assert.equal(current.kind, "current");
  assert.equal(current.tracks, "pr");
  assert.equal(current.setUpstream, false);

  const tip2 = w.push(w.hub, "feature", w.tip1, "pr: second");
  await fetchPrBranch(w.proc, w.same);
  const behind = await planPrBranch(w.proc, w.same, tip2);
  assert.equal(behind.kind, "fast-forward");
  assert.equal(behind.behind, 1);
  assert.equal(refOf(w.git, "refs/heads/feature"), w.tip1, "planning moves nothing");
  assert.equal((await moveLocalBranch(w.proc, behind, "update feature")).code, 0);
  assert.equal(refOf(w.git, "refs/heads/feature"), tip2);

  // Your own commit on top, not pushed yet: a normal state of a PR branch.
  w.git("checkout", "-q", "feature");
  w.git("commit", "-q", "--allow-empty", "-m", "my fix");
  const mine = w.git("rev-parse", "HEAD");
  const ahead = await planPrBranch(w.proc, w.same, tip2);
  assert.equal(ahead.kind, "ahead");
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.checkedOut, true);

  // The contributor force-pushes a rewrite that doesn't have your fix.
  const rewrite = w.push(w.hub, "feature", "main", "pr: rewritten");
  w.git("checkout", "-q", "feature");
  await fetchPrBranch(w.proc, w.same);
  const diverged = await planPrBranch(w.proc, w.same, rewrite);
  assert.equal(diverged.kind, "diverged");
  assert.equal(diverged.ahead, 3, "tip1, tip2 and the fix");
  assert.equal(diverged.behind, 1);
  assert.equal(refOf(w.git, "refs/heads/feature"), mine, "nothing moved over the fix");
  w.proc.dispose();
});

test("plan: your own same-repository branch that tracks nothing IS the PR's — it gets the upstream", async () => {
  const w = world();
  w.git("branch", "feature", w.tip1); // pushed without -u
  await fetchPrBranch(w.proc, w.same);
  const p = await planPrBranch(w.proc, w.same, w.tip1);
  assert.equal(p.kind, "current");
  assert.equal(p.tracks, "none");
  assert.equal(p.setUpstream, true);
  w.proc.dispose();
});

test("plan: a fork's head name on a branch of yours is taken — your main is not their main", async () => {
  const w = world();
  // alice's fork has a PR from ITS main.
  const theirs = w.push(w.fork, "main", "main", "alice: fix");
  w.git("remote", "add", "alice", w.fork);
  const fork: PrBranchTarget = { n: 9, headRef: "main", remote: "alice", sameRepo: false, headOwner: "alice" };
  assert.deepEqual(await fetchPrBranch(w.proc, fork), { sha: theirs });
  const p = await planPrBranch(w.proc, fork, theirs);
  assert.equal(p.kind, "taken");
  assert.equal(p.tracks, "other");
  assert.equal(p.tracksName, "origin/main");
  assert.equal(p.relation, "behind", "yours is behind theirs");
  assert.equal(await freeBranchName(w.proc, fork), "alice-main", "never alice/main: the remote alice has one by that name");

  // A fork's head that matches a branch of yours tracking NOTHING: not the PR's either.
  w.git("branch", "topic", "main");
  const t2: PrBranchTarget = { ...fork, headRef: "topic" };
  w.push(w.fork, "topic", "main", "alice: topic");
  const f2 = await fetchPrBranch(w.proc, t2);
  assert.ok("sha" in f2);
  assert.equal((await planPrBranch(w.proc, t2, f2.sha)).kind, "taken");
  w.proc.dispose();
});

test("plan: a same-named branch that tracks something else is taken, and says what it tracks", async () => {
  const w = world();
  w.git("branch", "--track", "feature", "origin/main");
  await fetchPrBranch(w.proc, w.same);
  const p = await planPrBranch(w.proc, w.same, w.tip1);
  assert.equal(p.kind, "taken");
  assert.equal(p.tracksName, "origin/main");
  assert.equal(p.relation, "behind");
  w.proc.dispose();
});

test("plan: checked out in another worktree → elsewhere, and named", async () => {
  const w = world();
  await fetchPrBranch(w.proc, w.same);
  w.git("branch", "--track", "feature", "origin/feature");
  const other = join(w.base, "other");
  w.git("worktree", "add", "-q", other, "feature");
  const p = await planPrBranch(w.proc, w.same, w.tip1);
  assert.equal(p.kind, "elsewhere");
  assert.ok(p.worktree && p.worktree.endsWith("other"), p.worktree);
  w.proc.dispose();
});

test("elsewhere is known before any fetch — for the PR's own branch only; another branch of that name elsewhere is still asked about", async () => {
  const w = world();
  await fetchPrBranch(w.proc, w.same);
  w.git("branch", "--track", "feature", "origin/feature");
  w.git("worktree", "add", "-q", join(w.base, "held"), "feature");
  assert.ok((await prBranchElsewhere(w.proc, w.same))?.endsWith("held"), "the PR's branch, held by another worktree");
  // A fork's PR from a branch named like yours, which another worktree holds.
  const fork: PrBranchTarget = { n: 9, headRef: "feature", remote: "alice", sameRepo: false, headOwner: "alice" };
  w.git("remote", "add", "alice", w.fork);
  const theirs = w.push(w.fork, "feature", "main", "alice: feature");
  assert.equal(await prBranchElsewhere(w.proc, fork), undefined, "yours, not theirs: nothing to say before the fetch");
  const p = await planPrBranch(w.proc, fork, theirs);
  assert.equal(p.kind, "taken", "asked about — with a free name — not refused");
  assert.ok(p.worktree?.endsWith("held"), "…knowing it can't be used here");
  w.proc.dispose();
});

test("plan: a branch set up by gh (tracking the repository by URL) is the PR's too", async () => {
  const w = world();
  await fetchPrBranch(w.proc, w.same);
  w.git("branch", "feature", w.tip1);
  w.git("config", "branch.feature.remote", "https://github.com/acme/app.git");
  w.git("config", "branch.feature.merge", "refs/heads/feature");
  const p = await planPrBranch(w.proc, { ...w.same, remoteAliases: ["https://github.com/acme/app.git"] }, w.tip1);
  assert.equal(p.kind, "current");
  assert.equal(p.tracks, "pr");
  w.proc.dispose();
});

test("track: the upstream and the push remote are the PR's — a push reaches it, whatever remote.pushDefault says", async () => {
  const w = world();
  await fetchPrBranch(w.proc, w.same);
  w.git("checkout", "-q", "-b", "feature", w.tip1);
  w.git("remote", "add", "mine", w.fork);
  w.git("config", "remote.pushDefault", "mine");
  assert.equal((await trackPrBranch(w.proc, w.same, "feature")).code, 0);
  assert.equal(w.git("rev-parse", "--abbrev-ref", "feature@{upstream}"), "origin/feature");
  assert.equal(w.git("rev-parse", "--abbrev-ref", "feature@{push}"), "origin/feature");
  w.git("commit", "-q", "--allow-empty", "-m", "my fix");
  w.git("push", "-q");
  assert.equal(execFileSync("git", ["--git-dir", w.hub, "rev-parse", "refs/heads/feature"], { encoding: "utf8" }).trim(), w.git("rev-parse", "HEAD"));
  assert.equal((await trackPrBranch(w.proc, w.same, "-bad")).code, 1, "an option-like name never reaches git");
  w.proc.dispose();
});

test("free name: owner-head, else pr/<n>, else pr/<n>-2 — never a folder of a branch, nor a remote branch's short name", async () => {
  const w = world();
  const t = { n: 7, headRef: "fix/login", headOwner: "Alice" };
  assert.equal(await freeBranchName(w.proc, t), "alice-fix-login");
  w.git("branch", "alice-fix-login/old", "main"); // alice-fix-login would be a folder of it
  assert.equal(await freeBranchName(w.proc, t), "pr/7");
  w.git("branch", "pr/7", "main");
  assert.equal(await freeBranchName(w.proc, t), "pr/7-2");
  w.git("update-ref", "refs/remotes/pr/7-2", "main"); // a remote named "pr" has a 7-2
  assert.equal(await freeBranchName(w.proc, t), "pr/7-3", "pr/7-2 would be ambiguous");
  assert.equal(await freeBranchName(w.proc, { ...t, headOwner: "-rm" }), "pr/7-3", "an option-like owner names nothing");
  w.proc.dispose();
});

test("the head repository's remote: named after its owner, in the clone's own way of talking to GitHub", async () => {
  assert.equal(remoteUrlLike("git@github.com:acme/app.git", "alice", "app"), "git@github.com:alice/app.git");
  assert.equal(remoteUrlLike("git@github.com-work:acme/app.git", "alice", "app"), "git@github.com-work:alice/app.git", "an SSH alias stays");
  assert.equal(remoteUrlLike("ssh://git@ssh.github.com:443/acme/app.git", "alice", "app"), "ssh://git@ssh.github.com:443/alice/app.git");
  assert.equal(remoteUrlLike("https://github.com/acme/app.git", "alice", "app"), "https://github.com/alice/app.git");
  assert.equal(remoteUrlLike(undefined, "alice", "app"), "https://github.com/alice/app.git");
  assert.equal(remoteUrlLike("https://github.com/acme/app.git", "-x", "app"), undefined);

  assert.equal(newRemoteName("Alice", ["origin"]), "alice");
  assert.equal(newRemoteName("alice", ["origin", "alice"]), "alice-2");
  assert.equal(newRemoteName("--upload-pack", []), "upload-pack", "never option-like");

  const w = world();
  assert.equal((await addRemote(w.proc, "-x", "https://github.com/a/b.git")).code, 1);
  assert.equal((await addRemote(w.proc, "alice", "--upload-pack=x")).code, 1);
  assert.equal((await addRemote(w.proc, "alice", "https://github.com/alice/app.git")).code, 0);
  assert.equal(w.git("remote", "get-url", "alice"), "https://github.com/alice/app.git");
  w.proc.dispose();

  for (const bad of ["-b", "a..b", "a b", "a:b", "a/", "/a", "a.lock", "@", "a//b", "a@{1}", "HEAD", ".a"]) {
    assert.equal(isSafeBranchName(bad), false, bad);
  }
  for (const good of ["feature", "fix/login-page", "alice/main", "release-1.2", "a.b"]) assert.equal(isSafeBranchName(good), true, good);
});
