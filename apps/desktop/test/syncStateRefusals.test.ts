// Push, Pull and Set upstream over states the user is simply in — each one a
// crash report that arrived from desktop 2.7, rebuilt here with invented names.
//
//   · "Push" with HEAD detached: SyncOps.push found no branch to resolve and
//     fell through to a bare `git push`, whose answer is terminal advice
//     ("fatal: You are not currently on a branch. To push the history leading
//     to the current (detached HEAD) state now, use …").
//   · "Pull" on a branch that tracks nothing: "There is no tracking
//     information for the current branch." — twice.
//   · "Branch setUpstream" to a remote branch that exists on the remote but has
//     not been fetched: "fatal: the requested upstream branch '…' does not
//     exist", with git's own hint to fetch first.
//
// Each is checked the way the shipped app would judge it: `filed()` is
// main.ts's handle() decision (reportingVerdicts.test.ts pins the mirror), and
// each case also checks that git did not do the thing behind the user's back.

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { isExpectedError, reportableResultMessage } from "../src/main/expectedError";

async function filed(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    return reportableResultMessage(await run());
  } catch (err) {
    return isExpectedError(err) ? undefined : err instanceof Error ? err.message : String(err);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "gs-sync-states-"));
after(() => removeTempRepo(scratch));

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A clone of a bare remote with one commit on main, pushed and tracked. */
function clone(): { remote: string; work: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(scratch, "repo-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
  const git = at(work);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "t"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
    ["core.autocrlf", "false"],
  ]) {
    git("config", k, v);
  }
  writeFileSync(join(work, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "a");
  git("push", "-q", "-u", "origin", "main");
  return { remote, work, git };
}

async function bridgeOn(work: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(work);
  return new GitBridge(repos);
}

/** Every ref the remote has, as `<sha> <ref>` lines — to prove nothing landed. */
const remoteRefs = (remote: string): string => at(remote)("for-each-ref", "--format=%(objectname) %(refname)");

// ── Push with HEAD detached ──────────────────────────────────────────────────

test("Push with HEAD detached is refused as the user's state, before git runs, and says so plainly", async () => {
  const { remote, work, git } = clone();
  git("checkout", "-q", "--detach");
  writeFileSync(join(work, "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-qm", "b");
  const before = remoteRefs(remote);
  const bridge = await bridgeOn(work);

  // Both doors: the top bar's Push (no options) and Commit & Push, which asks
  // for setUpstream because a detached HEAD has no upstream either.
  for (const opts of [undefined, { setUpstream: true }, { force: true }]) {
    const r = await bridge.syncPush(opts);
    assert.equal(r.ok, false, `${JSON.stringify(opts)}: nothing to push`);
    assert.equal(r.expected, true, `${JSON.stringify(opts)}: a state, not a defect`);
    assert.equal(r.detached, true, `${JSON.stringify(opts)}: so the renderer can offer a branch here`);
    assert.match(r.message ?? "", /not on a branch/i);
    assert.doesNotMatch(r.message ?? "", /git push|HEAD:</, "the app's words, not git's terminal advice");
    assert.equal(await filed(() => bridge.syncPush(opts)), undefined, "and it is not filed as a crash");
  }
  assert.equal(remoteRefs(remote), before, "nothing reached the remote");
});

test("Push with HEAD detached by a stopped rebase says to finish the rebase, not to make a branch", async () => {
  const { work, git } = clone();
  git("checkout", "-q", "-b", "feature/x");
  writeFileSync(join(work, "a.txt"), "mine\n");
  git("commit", "-qam", "mine");
  git("checkout", "-q", "main");
  writeFileSync(join(work, "a.txt"), "theirs\n");
  git("commit", "-qam", "theirs");
  git("checkout", "-q", "feature/x");
  assert.throws(() => git("rebase", "main"), "the fixture's rebase stops on a conflict");
  const bridge = await bridgeOn(work);

  const r = await bridge.syncPush(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.equal(r.detached, undefined, "no New branch… in the middle of a rebase");
  assert.match(r.message ?? "", /rebase is still in progress/i);
});

test("Push on a branch still pushes — the guard is for a detached HEAD only", async () => {
  const { remote, work, git } = clone();
  writeFileSync(join(work, "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-qm", "b");
  const bridge = await bridgeOn(work);
  const r = await bridge.syncPush(undefined);
  assert.equal(r.ok, true, r.message);
  assert.equal(at(remote)("rev-parse", "main").trim(), git("rev-parse", "HEAD").trim());
});

// ── Pull on a branch with no upstream ────────────────────────────────────────

test("Pull on a branch that tracks nothing is refused as the user's state, with the way on", async () => {
  const { work, git } = clone();
  git("checkout", "-q", "-b", "feature/x");
  const bridge = await bridgeOn(work);

  const r = await bridge.syncPull();
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "a state, not a defect");
  assert.equal(r.noUpstream, true, "so the renderer can offer Publish");
  assert.match(r.message ?? "", /'feature\/x' has no upstream branch/);
  assert.doesNotMatch(r.message ?? "", /tracking information|git pull </, "the app's words, not git's");
  assert.equal(await filed(() => bridge.syncPull()), undefined, "and it is not filed as a crash");
});

test("Pull on a branch whose remote branch was deleted is NOT said as 'no upstream'", async () => {
  // The tracking config outlives the remote branch: a different state, with a
  // different answer — this guard reads the config, not @{u}, to stay off it.
  const { work, git } = clone();
  git("checkout", "-q", "-b", "feature/x");
  git("push", "-q", "-u", "origin", "feature/x");
  git("push", "-q", "origin", "--delete", "feature/x");
  const bridge = await bridgeOn(work);
  const r = await bridge.syncPull();
  assert.equal(r.ok, false);
  assert.equal(r.noUpstream, undefined);
});

test("Pull on a tracked branch still pulls", async () => {
  const { remote, work } = clone();
  const other = join(scratch, `other-${Date.now()}`);
  execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
  const o = at(other);
  o("config", "user.email", "t@example.com");
  o("config", "user.name", "t");
  writeFileSync(join(other, "c.txt"), "c\n");
  o("add", ".");
  o("commit", "-qm", "c");
  o("push", "-q", "origin", "main");
  const bridge = await bridgeOn(work);
  const r = await bridge.syncPull();
  assert.equal(r.ok, true, r.message);
});

// ── Set upstream to a branch not fetched yet ─────────────────────────────────

test("Set upstream to a remote branch that is not fetched yet fetches it, then sets it", async () => {
  const { work, git } = clone();
  git("checkout", "-q", "-b", "feature/x");
  // On the remote, but not in this clone's remote-tracking refs: exactly the
  // state a colleague's fresh push leaves you in until the next fetch.
  git("push", "-q", "origin", "HEAD:refs/heads/feature/y");
  git("update-ref", "-d", "refs/remotes/origin/feature/y");
  const bridge = await bridgeOn(work);

  const r = await bridge.branchSetUpstream({ fullName: "refs/heads/feature/x", upstream: "origin/feature/y" });
  assert.equal(r.ok, true, r.message);
  assert.equal(git("rev-parse", "--abbrev-ref", "feature/x@{upstream}").trim(), "origin/feature/y");
});

test("Set upstream to a branch the remote does not have either is refused as the user's input", async () => {
  const { work, git } = clone();
  git("checkout", "-q", "-b", "feature/x");
  const bridge = await bridgeOn(work);

  for (const upstream of ["origin/feature/missing", "refs/remotes/origin/feature/missing", "missing"]) {
    const r = await bridge.branchSetUpstream({ fullName: "refs/heads/feature/x", upstream });
    assert.equal(r.ok, false, upstream);
    assert.equal(r.expected, true, `${upstream}: a name the user typed, not a defect`);
    assert.doesNotMatch(r.message ?? "", /^fatal:|hint:/m, `${upstream}: the app's words, not git's`);
    assert.equal(
      await filed(() => bridge.branchSetUpstream({ fullName: "refs/heads/feature/x", upstream })),
      undefined,
      `${upstream}: not filed`,
    );
  }
  assert.throws(() => git("rev-parse", "--abbrev-ref", "feature/x@{upstream}"), "and nothing was set");
});
