// A pull request checked out again, through the REAL GitHubBridge.prCheckout
// against real git: a bare "GitHub" whose refs/pull/7/head moves the way a
// contributor's pushes move it.
//
// It ran `git fetch origin pull/7/head:pr/7`, which git refuses while pr/7 is
// checked out ("refusing to fetch into branch … checked out") — so the PR you
// were on could never be brought up to date — and refuses as a non-fast-
// forward after a force-push, in git's words, filed as a crash. The decision
// is git-service's planPrHead now, shared with the extension: fast-forward
// what can be, and leave a pr/7 with commits of its own exactly as it is.

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { serveOwnSsh } from "../../../scripts/test/no-network-git.mjs";
import { RepoStore } from "../src/main/repoStore";
import { GitHubBridge } from "../src/main/githubBridge";
import { reportableResultMessage } from "../src/main/expectedError";

const scratch = mkdtempSync(join(tmpdir(), "gs-prco-desk-"));
after(() => removeTempRepo(scratch));

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function world() {
  const base = mkdtempSync(join(scratch, "w-"));
  const hub = join(base, "hub.git");
  const dir = join(base, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", hub]);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = at(dir);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git("config", k, v);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", hub);
  git("push", "-q", "origin", "main");
  const prAdvance = (from: string, msg: string): string => {
    const back = git("symbolic-ref", "--quiet", "--short", "HEAD");
    git("checkout", "-q", "--detach", from);
    writeFileSync(join(dir, "pr.txt"), `${msg}\n`);
    git("add", "pr.txt");
    git("commit", "-q", "-m", msg);
    const sha = git("rev-parse", "HEAD");
    git("push", "-q", "origin", `+${sha}:refs/pull/7/head`);
    git("checkout", "-q", back);
    return sha;
  };
  const tip1 = prAdvance("main", "pr: first");
  const repos = new RepoStore([]);
  await repos.open(dir);
  return { dir, git, prAdvance, tip1, github: new GitHubBridge(repos) };
}

test("a checked-out pr/7 is brought up to date when checked out again", async () => {
  const w = await world();
  const first = await w.github.prCheckout(7);
  assert.equal(first.ok, true, first.message);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "pr/7");
  const tip2 = w.prAdvance(w.tip1, "pr: second");
  const again = await w.github.prCheckout(7);
  assert.equal(again.ok, true, again.message);
  assert.equal(w.git("rev-parse", "HEAD"), tip2);
  assert.equal(readFileSync(join(w.dir, "pr.txt"), "utf8"), "pr: second\n");
});

test("pr/7 with commits the PR doesn't have is left exactly as it is — said, not filed", async () => {
  const w = await world();
  await w.github.prCheckout(7);
  writeFileSync(join(w.dir, "fix.txt"), "fix\n");
  w.git("add", "fix.txt");
  w.git("commit", "-qm", "my fix");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  w.prAdvance("main", "pr: rewritten"); // force-pushed without the fix
  const r = await w.github.prCheckout(7);
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "the user's state, not a defect");
  assert.equal(reportableResultMessage(r), undefined, "nothing is filed");
  assert.match(r.message ?? "", /^pr\/7 has 2 commits that pull request #7 doesn't/);
  // Renaming alone gets nothing: the PR's version comes with the next Check Out.
  assert.match(r.message ?? "", /rename or delete pr\/7, then Check Out again to get the pull request's version\.$/);
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), mine, "the fix is where it was");
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "main");
});

// The list reads the pull requests of the first GitHub remote (origin, then
// upstream, then the rest); Check Out fetched from "origin" by name. With a
// non-GitHub mirror as origin and github.com as upstream, the list showed
// upstream's PRs and Check Out asked the mirror for pull/7/head.
test("the PR's head comes from the GitHub remote the list reads — upstream, when origin isn't GitHub", async () => {
  const w = await world();
  const mirror = join(w.dir, "..", "mirror.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", mirror]);
  w.git("push", "-q", mirror, "main");
  // origin: the mirror (no refs/pull). upstream: github.com — reached, for
  // this test, through an ssh command that serves the "hub" the PR lives in.
  const hub = w.git("remote", "get-url", "origin");
  w.git("remote", "set-url", "origin", mirror);
  w.git("remote", "add", "upstream", "git@github.com:acme/app.git");
  // A node script, named with forward slashes: git runs an ssh command
  // through `sh -c`, which ate a Windows path's backslashes
  // ("C:UsersRUNNER~1…fake-ssh.sh: command not found").
  const ssh = join(w.dir, "..", "fake-ssh.cjs");
  writeFileSync(
    ssh,
    `const r = require("child_process").spawnSync("git", ["upload-pack", ${JSON.stringify(hub)}], { stdio: "inherit" });\n` +
      `process.exit(r.status ?? 1);\n`,
  );
  // Said to the network guard in so many words: its GIT_SSH_COMMAND outranks
  // any core.sshCommand (the machine's too), so a repository's own is not
  // enough — and never serves a test by accident.
  const undo = serveOwnSsh(`node "${ssh.replace(/\\/g, "/")}"`);
  let r: Awaited<ReturnType<typeof w.github.prCheckout>>;
  try {
    r = await w.github.prCheckout(7);
  } finally {
    undo();
  }
  assert.equal(r.ok, true, r.message);
  assert.equal(w.git("symbolic-ref", "--short", "HEAD"), "pr/7");
  assert.equal(w.git("rev-parse", "HEAD"), w.tip1, "the pull request's head, from upstream");
});
