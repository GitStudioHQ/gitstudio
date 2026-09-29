import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess, type GitRunResult } from "../src/GitProcess";
import { divergedMessage, fetchPrHead, fetchRefTip, movePrBranch, planPrHead, prBranchName, type PrGitRunner } from "../src/prCheckout";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// The PR-checkout plumbing's edges: which numbers name a PR branch, what a
// fetch of one ref answers from FETCH_HEAD (and every way that can fail), and
// the diverged sentence.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

/** A clone-like repo with a local bare "server" that has main and refs/pull/7/head. */
function scene(name: string): { r: Repo; proc: GitProcess; server: string; main: string; pr: string } {
  const r = makeRepo(`prco-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("f.txt", "base\n");
  const main = r.commitAll("base");
  r.write("f.txt", "pr\n");
  const pr = r.commitAll("the PR's commit");
  const server = mkdtempSync(join(tmpdir(), `gs-prco-server-${name}-`));
  cleanup.push(() => removeTempRepo(server));
  r.git("init", "-q", "--bare", server);
  r.git("push", "-q", server, `${main}:refs/heads/main`, `${pr}:refs/pull/7/head`);
  r.git("reset", "-q", "--hard", main);
  r.git("remote", "add", "origin", server);
  const proc = new GitProcess({ cwd: r.root });
  cleanup.push(() => proc.dispose());
  return { r, proc, server, main, pr };
}

test("prBranchName accepts only a positive whole number", () => {
  assert.equal(prBranchName(7), "pr/7");
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => prBranchName(bad), /^Error: not a pull request number: /);
  }
});

test("fetchPrHead reads the PR head from a remote by name, without writing any branch", async () => {
  const { r, proc, pr } = scene("byname");
  assert.deepEqual(await fetchPrHead(proc, "origin", 7), { sha: pr });
  assert.equal(r.git("for-each-ref", "refs/heads/pr").trim(), "", "no pr/ branch was written");
  await assert.rejects(fetchPrHead(proc, "origin", 0), /not a pull request number/);
});

test("fetchRefTip finds a branch by its FETCH_HEAD line, from a remote named by URL too", async () => {
  const { proc, server, main } = scene("branch");
  assert.deepEqual(await fetchRefTip(proc, "origin", "refs/heads/main"), { sha: main });
  assert.deepEqual(await fetchRefTip(proc, server, "refs/heads/main"), { sha: main });
});

test("fetchRefTip refuses an option-like remote or an unfetchable ref before git runs", async () => {
  const calls: string[][] = [];
  const spy: PrGitRunner = { cwd: tmpdir(), run: async (args) => (calls.push(args), { code: 0, stdout: "", stderr: "" }) };
  assert.deepEqual(await fetchRefTip(spy, "--upload-pack=x", "refs/heads/main"), { error: `"--upload-pack=x" isn't a remote name.` });
  assert.deepEqual(await fetchRefTip(spy, "", "refs/heads/main"), { error: `"" isn't a remote name.` });
  for (const ref of ["main", "refs/heads/a..b", "refs//x", "refs/heads/x y"]) {
    assert.deepEqual(await fetchRefTip(spy, "origin", ref), { error: `"${ref}" isn't a ref git can fetch.` });
  }
  assert.deepEqual(calls, [], "git never ran");
});

test("fetchRefTip passes git's first line of refusal for a ref the remote lacks", async () => {
  const { proc } = scene("missing");
  const res = await fetchRefTip(proc, "origin", "refs/pull/99/head");
  assert.ok("error" in res);
  assert.match(res.error, /refs\/pull\/99\/head/);
  assert.equal(res.error.includes("\n"), false, "one line");
});

/** A runner whose fetch succeeds and whose FETCH_HEAD answers are canned. */
function canned(cwd: string, where: GitRunResult): PrGitRunner {
  return {
    cwd,
    run: async (args) => (args[0] === "fetch" ? { code: 0, stdout: "", stderr: "" } : where),
  };
}

test("fetchRefTip says so when FETCH_HEAD can't be found, can't be read, or doesn't name the ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-prco-fetchhead-"));
  cleanup.push(() => removeTempRepo(dir));
  assert.deepEqual(await fetchRefTip(canned(dir, { code: 128, stdout: "", stderr: "fatal" }), "origin", "refs/pull/7/head"), {
    error: "Couldn't find what was fetched (FETCH_HEAD).",
  });
  assert.deepEqual(await fetchRefTip(canned(dir, { code: 0, stdout: "\n", stderr: "" }), "origin", "refs/pull/7/head"), {
    error: "Couldn't find what was fetched (FETCH_HEAD).",
  });
  assert.deepEqual(await fetchRefTip(canned(dir, { code: 0, stdout: "no-such-file\n", stderr: "" }), "origin", "refs/pull/7/head"), {
    error: "Couldn't read what was fetched (FETCH_HEAD).",
  });
  const sha = "a".repeat(40);
  writeFileSync(join(dir, "FETCH_HEAD"), `${sha}\t\t'refs/pull/8/head' of /srv/x\n${sha}\t\tbranch 'other' of /srv/x\n`);
  const found = canned(dir, { code: 0, stdout: "FETCH_HEAD\n", stderr: "" });
  assert.deepEqual(await fetchRefTip(found, "origin", "refs/pull/7/head"), {
    error: "Couldn't find the pull request's head in what was fetched.",
  });
  assert.deepEqual(await fetchRefTip(found, "origin", "refs/heads/main"), { error: "Couldn't find refs/heads/main in what was fetched." });
  assert.deepEqual(await fetchRefTip(found, "origin", "refs/tags/v1"), { error: "Couldn't find refs/tags/v1 in what was fetched." });
  // An absolute FETCH_HEAD path (a linked worktree's answer) is read as is.
  const abs = canned(dir, { code: 0, stdout: `${join(dir, "FETCH_HEAD")}\n`, stderr: "" });
  assert.deepEqual(await fetchRefTip(abs, "origin", "refs/pull/8/head"), { sha });
  assert.deepEqual(await fetchRefTip(abs, "origin", "refs/heads/other"), { sha });
});

test("movePrBranch refuses a branch that doesn't exist yet, and otherwise moves it only from where it was", async () => {
  const { r, proc, main, pr } = scene("move");
  const create = await planPrHead(proc, 7, pr);
  assert.equal(create.kind, "create");
  assert.deepEqual(await movePrBranch(proc, create), { code: 1, stdout: "", stderr: "pr/7 doesn't exist yet." });
  assert.equal(r.git("for-each-ref", "refs/heads/pr/7").trim(), "");

  r.git("branch", "pr/7", main);
  const ff = await planPrHead(proc, 7, pr);
  assert.equal(ff.kind, "fast-forward");
  assert.equal((await movePrBranch(proc, ff)).code, 0);
  assert.equal(r.sha("refs/heads/pr/7"), pr);
  assert.match(r.git("reflog", "-1", "--format=%gs", "refs/heads/pr/7"), /GitStudio: update pr\/7 to pull request head/);

  // Moved meanwhile: the compare-and-swap leaves it alone.
  const stale = { ...ff, localSha: main, sha: main };
  assert.notEqual((await movePrBranch(proc, stale)).code, 0);
  assert.equal(r.sha("refs/heads/pr/7"), pr);
});

test("divergedMessage counts the local-only commits, or says 'commits' when the count is unknown", () => {
  const plan = { local: "pr/7", ref: "refs/heads/pr/7", sha: "s", kind: "diverged" as const, checkedOut: false };
  const tail = "that pull request #7 doesn't — made here, or from before the PR was force-pushed.";
  assert.equal(divergedMessage(7, { ...plan, localOnly: 1 }), `pr/7 has 1 commit ${tail}`);
  assert.equal(divergedMessage(7, { ...plan, localOnly: 3 }), `pr/7 has 3 commits ${tail}`);
  assert.equal(divergedMessage(7, plan), `pr/7 has commits ${tail}`);
});
