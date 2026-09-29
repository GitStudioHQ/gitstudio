import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { GitRunResult } from "../src/GitProcess";
import type { PrGitRunner } from "../src/prCheckout";
import {
  fetchPrBranch,
  freeBranchName,
  moveLocalBranch,
  newRemoteName,
  planPrBranch,
  prBranchElsewhere,
  remoteUrlLike,
  trackPrBranch,
  type PrBranchTarget,
} from "../src/prBranch";
import { makeRepo, type Repo } from "./opRepo";

// The pull-request branch plumbing at the edges prBranch.test.ts's real-git
// state table can't reach: git's answers that are malformed or refused, names
// refused before git runs, and the URL / remote-name words.

const repos: Repo[] = [];
after(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

const OK: GitRunResult = { code: 0, stdout: "", stderr: "" };

/** A runner answering by the first matching argv prefix; records every call. */
function runner(answers: Array<[string[], GitRunResult]>, calls: string[][] = []): PrGitRunner {
  return {
    cwd: tmpdir(),
    run: async (args) => {
      calls.push(args);
      const hit = answers.find(([prefix]) => prefix.every((p, i) => args[i] === p));
      return hit ? hit[1] : { code: 1, stdout: "", stderr: "" };
    },
  };
}

const target: PrBranchTarget = {
  n: 7,
  headRef: "feature",
  headOwner: "alice",
  remote: "origin",
  sameRepo: true,
};

test("fetchPrBranch: a refusal with no words names git's exit code; a missing branch is 'gone'", async () => {
  const silent = runner([[["fetch"], { code: 128, stdout: "", stderr: "" }]]);
  assert.deepEqual(await fetchPrBranch(silent, target), { error: "git fetch exited with 128" });

  const gone = runner([[["fetch"], { code: 128, stdout: "", stderr: "\nfatal: couldn't find remote ref refs/heads/feature\n" }]]);
  assert.deepEqual(await fetchPrBranch(gone, target), { error: "fatal: couldn't find remote ref refs/heads/feature", gone: true });

  const other = runner([[["fetch"], { code: 128, stdout: "", stderr: "fatal: unable to access 'x': timeout\nmore" }]]);
  assert.deepEqual(await fetchPrBranch(other, target), { error: "fatal: unable to access 'x': timeout" }, "not gone: the repo never answered");
});

test("fetchPrBranch: a fetch that worked but whose ref can't be read back is an error, not a sha", async () => {
  const unreadable = runner([
    [["fetch"], OK],
    [["rev-parse"], { code: 0, stdout: "not-a-sha\n", stderr: "" }],
  ]);
  assert.deepEqual(await fetchPrBranch(unreadable, target), { error: "Couldn't read origin/feature after fetching it." });
});

test("names git would misread are refused before git runs", async () => {
  const calls: string[][] = [];
  const spy = runner([], calls);
  assert.deepEqual(await fetchPrBranch(spy, { ...target, remote: "--upload-pack=x" }), { error: `"--upload-pack=x" isn't a remote name.` });
  assert.deepEqual(await fetchPrBranch(spy, { ...target, headRef: "a..b" }), { error: `"a..b" isn't a branch name git takes.` });
  assert.equal(await prBranchElsewhere(spy, { ...target, headRef: "-x" }), undefined);
  await assert.rejects(planPrBranch(spy, target, "a".repeat(40), "bad name"), /"bad name" isn't a branch name git takes\./);
  assert.deepEqual(await trackPrBranch(spy, target, "x.lock"), { code: 1, stdout: "", stderr: `"x.lock" isn't a branch name git takes.` });
  assert.deepEqual(calls, [], "git never ran");
});

test("moveLocalBranch refuses a branch that doesn't exist yet", async () => {
  const calls: string[][] = [];
  const r = await moveLocalBranch(runner([], calls), { local: "feature", ref: "refs/heads/feature", sha: "a".repeat(40) }, "why");
  assert.deepEqual(r, { code: 1, stdout: "", stderr: "feature doesn't exist yet." });
  assert.deepEqual(calls, []);
});

test("trackPrBranch stops at the first config write git refuses and hands that refusal back", async () => {
  const calls: string[][] = [];
  const refusing = runner(
    [
      [["config", "branch.feature.remote"], OK],
      [["config", "branch.feature.merge"], { code: 4, stdout: "", stderr: "error: could not lock config file" }],
    ],
    calls,
  );
  assert.deepEqual(await trackPrBranch(refusing, target, "feature"), { code: 4, stdout: "", stderr: "error: could not lock config file" });
  assert.equal(calls.length, 2, "pushRemote was never written");
});

test("planPrBranch reads a branch tracking a LOCAL branch as taken, and says which", async () => {
  const r = makeRepo("prbr-edges-local");
  repos.push(r);
  r.write("a.txt", "a\n");
  const base = r.commitAll("base");
  r.git("branch", "feature");
  r.git("branch", "--set-upstream-to=master", "feature");
  const ctx = r.ctx();
  const plan = await planPrBranch(ctx.process, target, base);
  assert.equal(plan.kind, "taken");
  assert.equal(plan.tracks, "other");
  assert.equal(plan.tracksName, "the local branch master");
  assert.equal(plan.relation, "same");
});

test("planPrBranch with counts git didn't give reads as diverged, without numbers", async () => {
  const local = "b".repeat(40);
  const odd = runner([
    [["rev-parse", "--verify", "--quiet", "refs/heads/feature^{commit}"], { code: 0, stdout: `${local}\n`, stderr: "" }],
    [["symbolic-ref"], { code: 1, stdout: "", stderr: "" }],
    [["worktree"], OK],
    [["rev-list"], { code: 128, stdout: "", stderr: "fatal" }],
  ]);
  const plan = await planPrBranch(odd, target, "a".repeat(40));
  assert.equal(plan.kind, "diverged");
  assert.equal(plan.relation, "diverged");
  assert.equal(plan.ahead, undefined);
  assert.equal(plan.behind, undefined);
  assert.equal(plan.setUpstream, true, "a same-repo branch tracking nothing is the PR's, and gets its upstream");
});

test("freeBranchName skips an unusable owner, a name that is a folder of a branch, and one a branch is a folder of", async () => {
  const listing = (refs: string[]) => runner([[["for-each-ref"], { code: 0, stdout: refs.join("\n") + "\n", stderr: "" }]]);
  // Owner with an underscore is not a GitHub login: straight to pr/<n>.
  assert.equal(await freeBranchName(listing([]), { n: 7, headRef: "main", headOwner: "bad_owner" }), "pr/7");
  // "pr/7" is taken as a folder ("pr/7/x" exists), and "pr" is a branch so "pr/7-2" can't be made either.
  assert.equal(await freeBranchName(listing(["refs/heads/alice-main", "refs/heads/pr/7/x"]), { n: 7, headRef: "main", headOwner: "Alice" }), "pr/7-2");
  assert.equal(await freeBranchName(listing(["refs/heads/pr"]), { n: 7, headRef: "main", headOwner: "bad_owner" }), undefined, "every pr/… name sits under the branch pr");
  // A remote-tracking branch of the same short name is ambiguous, so not free.
  assert.equal(await freeBranchName(listing(["refs/remotes/alice-main"]), { n: 7, headRef: "main", headOwner: "alice" }), "pr/7");
});

test("remoteUrlLike keeps the clone's way of talking to GitHub, filling in the defaults", () => {
  assert.equal(remoteUrlLike("ssh://gh-alias/me/x.git", "bob", "repo"), "ssh://git@gh-alias/bob/repo.git");
  assert.equal(remoteUrlLike("ssh://me@host:2222/me/x.git", "bob", "repo"), "ssh://me@host:2222/bob/repo.git");
  assert.equal(remoteUrlLike("gh-alias:me/x.git", "bob", "repo"), "git@gh-alias:bob/repo.git");
  assert.equal(remoteUrlLike("git@github.com:me/x.git", "bob", "repo"), "git@github.com:bob/repo.git");
  assert.equal(remoteUrlLike(undefined, "bob", "repo"), "https://github.com/bob/repo.git");
  assert.equal(remoteUrlLike("https://github.com/me/x", "bob", "repo"), "https://github.com/bob/repo.git");
  assert.equal(remoteUrlLike("x", "-bob", "repo"), undefined);
  assert.equal(remoteUrlLike("x", "bob", "re po"), undefined);
});

test("newRemoteName lowercases and cleans the login, numbers past taken names, and gives up when nothing is left", () => {
  assert.equal(newRemoteName("Alice", []), "alice");
  assert.equal(newRemoteName("Alice Smith", ["ALICE-SMITH"]), "alice-smith-2");
  assert.equal(newRemoteName("--", []), undefined, "nothing usable is left of the name");
  const all = ["bob", ...Array.from({ length: 8 }, (_, i) => `bob-${i + 2}`)];
  assert.equal(newRemoteName("bob", all), undefined);
});
