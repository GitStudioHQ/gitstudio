import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess } from "../src/GitProcess";
import { fetchPrHead, movePrBranch, planPrHead } from "../src/prCheckout";
import { removeTempRepo } from "./tmpRepo";

// Checking out a pull request as pr/<n>, against real git: a bare "GitHub"
// with a refs/pull/<n>/head, and a clone. The state table is pr/<n> as the
// user can have it — absent, current, behind, checked out and behind, with
// commits of its own, checked out in another worktree — and each cell pins
// what the plan says AND that planning moved nothing. The old single command,
// `git fetch <remote> --force pull/<n>/head:pr/<n>`, failed on the checked-out
// cells and threw away the commits of the diverged one.

const scratch = mkdtempSync(join(tmpdir(), "gs-prco-"));
after(() => removeTempRepo(scratch));

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function world() {
  const base = mkdtempSync(join(scratch, "w-"));
  const hub = join(base, "hub.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", hub]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const git = at(work);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git("config", k, v);
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", hub);
  git("push", "-q", "origin", "main");
  /** The contributor pushes to the PR (a force-push when `from` isn't its head). */
  const prAdvance = (from: string, msg: string): string => {
    git("checkout", "-q", "--detach", from);
    git("commit", "-q", "--allow-empty", "-m", msg);
    const sha = git("rev-parse", "HEAD");
    git("push", "-q", "origin", `+${sha}:refs/pull/7/head`);
    return sha;
  };
  const tip1 = prAdvance("main", "pr: first");
  git("checkout", "-q", "main");
  const proc = new GitProcess({ cwd: work });
  return { base, hub, work, git, prAdvance, tip1, proc };
}

test("the PR head is fetched without writing any branch, and read back as exactly that ref", async () => {
  const w = world();
  const f = await fetchPrHead(w.proc, "origin", 7);
  assert.deepEqual(f, { sha: w.tip1 });
  assert.throws(() => w.git("rev-parse", "--verify", "--quiet", "refs/heads/pr/7"), "no branch was written");
  const missing = await fetchPrHead(w.proc, "origin", 9);
  assert.ok("error" in missing && /refs\/pull\/9\/head/.test(missing.error), JSON.stringify(missing));
  const optionLike = await fetchPrHead(w.proc, "--upload-pack=touch /tmp/x", 7);
  assert.ok("error" in optionLike, "an option-like remote never reaches git");
  w.proc.dispose();
});

test("plan: absent → create; there → current; behind → fast-forward (and move it, checked out or not)", async () => {
  const w = world();
  assert.equal((await planPrHead(w.proc, 7, w.tip1)).kind, "create");
  w.git("branch", "pr/7", w.tip1);
  assert.equal((await planPrHead(w.proc, 7, w.tip1)).kind, "current");

  const tip2 = w.prAdvance(w.tip1, "pr: second");
  w.git("checkout", "-q", "main");
  const behind = await planPrHead(w.proc, 7, tip2);
  assert.equal(behind.kind, "fast-forward");
  assert.equal(behind.checkedOut, false);
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), w.tip1, "planning moves nothing");
  assert.equal((await movePrBranch(w.proc, behind)).code, 0);
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), tip2);

  // Checked out and behind: what git's fetch refused ("refusing to fetch into
  // branch … checked out"). The plan says so, and a ff-only merge moves it.
  w.git("checkout", "-q", "pr/7");
  const tip3 = w.prAdvance(tip2, "pr: third");
  w.git("checkout", "-q", "pr/7");
  const f = await fetchPrHead(w.proc, "origin", 7);
  assert.deepEqual(f, { sha: tip3 }, "fetching works while pr/7 is checked out");
  const current = await planPrHead(w.proc, 7, tip3);
  assert.equal(current.kind, "fast-forward");
  assert.equal(current.checkedOut, true);
  w.proc.dispose();
});

test("plan: commits of its own → diverged, counted, and NOTHING is moved; a stale compare-and-swap is refused", async () => {
  const w = world();
  w.git("branch", "pr/7", w.tip1);
  w.git("checkout", "-q", "pr/7");
  w.git("commit", "-q", "--allow-empty", "-m", "my fix on the PR");
  const mine = w.git("rev-parse", "HEAD");
  w.git("checkout", "-q", "main");
  // The contributor force-pushed: the PR head no longer contains the fix.
  const rewritten = w.prAdvance("main", "pr: rewritten");
  w.git("checkout", "-q", "main");
  const plan = await planPrHead(w.proc, 7, rewritten);
  assert.equal(plan.kind, "diverged");
  assert.equal(plan.localOnly, 2, "the fix and the PR's old commit");
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), mine, "the user's commit is where it was");
  // pr/7 moves while the user decides: the swap names where it WAS, and fails.
  w.git("update-ref", "refs/heads/pr/7", w.tip1);
  assert.notEqual((await movePrBranch(w.proc, plan)).code, 0);
  assert.equal(w.git("rev-parse", "refs/heads/pr/7"), w.tip1);
  w.proc.dispose();
});

test("plan: checked out in another worktree → elsewhere, named", async () => {
  const w = world();
  w.git("branch", "pr/7", w.tip1);
  const other = join(w.base, "other-wt");
  w.git("worktree", "add", "-q", other, "pr/7");
  const tip2 = w.prAdvance(w.tip1, "pr: second");
  w.git("checkout", "-q", "main");
  const plan = await planPrHead(w.proc, 7, tip2);
  assert.equal(plan.kind, "elsewhere");
  assert.match(String(plan.worktree), /other-wt$/);
  w.proc.dispose();
});
