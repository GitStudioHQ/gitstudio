// Every desktop door that applies commits, refused over the user's uncommitted
// work, driven through the REAL bridge methods against real git.
//
// Crash report #18: a revert over an edit to a file the revert touches. git
// refused — "Your local changes to the following files would be overwritten by
// merge … fatal: revert failed" — and the desktop answered that as git's text,
// in red, and main.ts's handle() filed it as a crash. Nothing was broken and
// nothing had changed.
//
// Each door now answers such a refusal with `inTheWay` (the files, and the
// repository), `expected` so nothing is filed, and the engine's sentence; the
// renderer asks Stash & Retry or Cancel (bridge.ts) and a Stash & Retry sends
// the same request again with `stashFirst`, which stashes just those files,
// runs it, and puts them back. `filed()` is main.ts's decision line for line
// (see reportingVerdicts.test.ts).

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { GitHubBridge } from "../src/main/githubBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import type { CommitActionResult } from "../src/shared/ipc";

const scratch = mkdtempSync(join(tmpdir(), "gs-intheway-"));
after(() => removeTempRepo(scratch));

const at =
  (cwd: string) =>
  (...a: string[]): string =>
    execFileSync("git", a, { cwd, encoding: "utf8" });

function identify(g: (...a: string[]) => string): void {
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "t"],
    ["commit.gpgsign", "false"],
    ["gc.auto", "0"],
  ]) {
    g("config", k, v);
  }
}

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");

/**
 * main:    base (a.txt, b.txt nine lines each) → "main changes b" (line 0)
 * feature: base → "feature changes a" (line 0) → "feature adds c"
 * HEAD on main.
 */
function repo(): { dir: string; root: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(scratch, "repo-"));
  const git = at(dir);
  git("init", "-q", "-b", "main");
  identify(git);
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0));
  writeFileSync(join(dir, "b.txt"), LINES("line 0", 0));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("feature", 0));
  git("commit", "-q", "-am", "feature changes a");
  writeFileSync(join(dir, "c.txt"), "new\n");
  git("add", "c.txt");
  git("commit", "-q", "-m", "feature adds c");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), LINES("main", 0));
  git("commit", "-q", "-am", "main changes b");
  return { dir, root: realpathSync(dir), git };
}

async function bridgeOn(dir: string): Promise<{ bridge: GitBridge; github: GitHubBridge }> {
  const repos = new RepoStore([]);
  await repos.open(dir);
  return { bridge: new GitBridge(repos), github: new GitHubBridge(repos) };
}

/** What main.ts's handle() files for this answer — undefined for nothing. */
const filed = (r: unknown): string | undefined => reportableResultMessage(r);

const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
const stashes = (git: (...a: string[]) => string): string => git("stash", "list").trim();

/** The refusal every door answers: said, not filed, and answerable. */
function assertAsked(r: CommitActionResult, kind: string, files: string[], root: string, what: string): void {
  assert.equal(r.ok, false, what);
  assert.equal(r.changed, false, `${what}: nothing ran`);
  assert.equal(r.expected, true, `${what}: the user's state, not a defect`);
  assert.deepEqual(r.inTheWay, { kind, files, root }, `${what}: which files, and where`);
  assert.equal(filed(r), undefined, `${what}: nothing is filed`);
  assert.doesNotMatch(r.message ?? "", /overwritten by|Aborting|fatal:|error:/, `${what}: not git's text`);
  assert.match(r.message ?? "", new RegExp(files[0].replace(/\./g, "\\.")), `${what}: the sentence names the file`);
}

// ── report #18's own door, and the other commit actions ──────────────────────

test("report #18: a Revert over an edit it touches is asked about, filed nowhere, and Stash & Retry reverts and puts the edit back", async () => {
  const { dir, root, git } = repo();
  const edited = LINES("main", 0).replace("line 6\n", "mine\n");
  writeFileSync(join(dir, "b.txt"), edited);
  const head = git("rev-parse", "HEAD").trim();
  const { bridge } = await bridgeOn(dir);
  const req = { action: "revert" as const, sha: head };

  const r = await bridge.commitAction(req);
  assertAsked(r, "revert", ["b.txt"], root, "revert");
  assert.match(r.message ?? "", /^Your uncommitted changes to b\.txt are in the way of the revert/);
  assert.equal(git("rev-parse", "HEAD").trim(), head, "nothing ran");
  assert.equal(read(dir, "b.txt"), edited, "the edit is untouched");

  const again = await bridge.commitAction({ ...req, stashFirst: r.inTheWay!.root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("log", "-1", "--format=%s").trim(), 'Revert "main changes b"');
  assert.equal(read(dir, "b.txt"), LINES("line 0", 0).replace("line 6\n", "mine\n"), "the edit is back, on the reverted file");
  assert.equal(git("status", "--porcelain").trim(), "M b.txt", "uncommitted, as it was");
  assert.equal(stashes(git), "", "no stash left behind");
  assert.equal(again.stashNote, undefined, "nothing more to say");
});

test("Cherry-Pick over a staged change: Stash & Retry picks it, and the change comes back STAGED", async () => {
  const { dir, root, git } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("staged", 5));
  git("add", "b.txt");
  const sha = git("rev-parse", "feature~1").trim();
  const { bridge } = await bridgeOn(dir);
  const r = await bridge.commitAction({ action: "cherry-pick", sha });
  assertAsked(r, "cherry-pick", ["b.txt"], root, "cherry-pick");
  const again = await bridge.commitAction({ action: "cherry-pick", sha, stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("log", "-1", "--format=%s").trim(), "feature changes a");
  assert.equal(git("status", "--porcelain").trim(), "M  b.txt", "staged, as it was");
  assert.equal(stashes(git), "");
});

test("Check out a commit (detached) over an edit: the edit travels with the switch", async () => {
  const { dir, root, git } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0).replace("line 7\n", "mine\n"));
  const sha = git("rev-parse", "feature").trim();
  const { bridge } = await bridgeOn(dir);
  const r = await bridge.commitAction({ action: "checkout", sha });
  assertAsked(r, "checkout", ["a.txt"], root, "checkout");
  const again = await bridge.commitAction({ action: "checkout", sha, stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("rev-parse", "HEAD").trim(), sha);
  assert.equal(read(dir, "a.txt"), LINES("feature", 0).replace("line 7\n", "mine\n"));
});

test("a branch checkout — even of a branch that shares its name with a tag — asks, and Stash & Retry lands on the BRANCH", async () => {
  const { dir, root, git } = repo();
  git("tag", "feature", "main~1"); // git's checkout reads the branch; a revision would read the tag
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const { bridge } = await bridgeOn(dir);
  for (const req of [
    { action: "checkout-ref" as const, sha: "feature", name: "feature", refKind: "head" as const },
    { action: "checkout-ref" as const, sha: "feature", name: "heads/feature", fullName: "refs/heads/feature", refKind: "head" as const },
  ]) {
    const r = await bridge.commitAction(req);
    assertAsked(r, "checkout", ["a.txt"], root, `checkout-ref ${req.name}`);
  }
  const again = await bridge.commitAction({
    action: "checkout-ref",
    sha: "feature",
    name: "heads/feature",
    fullName: "refs/heads/feature",
    refKind: "head",
    stashFirst: root,
  });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("symbolic-ref", "HEAD").trim(), "refs/heads/feature");
  assert.equal(read(dir, "a.txt"), LINES("feature", 0).replace("line 4\n", "mine\n"));
});

// ── the Branches view's doors ─────────────────────────────────────────────────

test("Create and switch from elsewhere asks; creating WITHOUT switching changes no file and never asks", async () => {
  const { dir, root, git } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const { bridge } = await bridgeOn(dir);
  const stay = await bridge.branchCreate({ name: "kept", startPoint: "feature" });
  assert.equal(stay.ok, true, stay.message);
  assert.equal(stay.inTheWay, undefined);
  const r = await bridge.branchCreate({ name: "topic", checkout: true, startPoint: "feature" });
  assertAsked(r, "checkout", ["a.txt"], root, "create and switch");
  assert.throws(() => git("rev-parse", "--verify", "--quiet", "refs/heads/topic"), "no branch was made");
  const again = await bridge.branchCreate({ name: "topic", checkout: true, startPoint: "feature", stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "topic");
  assert.equal(read(dir, "a.txt"), LINES("feature", 0).replace("line 4\n", "mine\n"));
});

test("Merge over an edit to a file the incoming side changes: asked, then merged with the edit put back", async () => {
  const { dir, root, git } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const { bridge } = await bridgeOn(dir);
  const r = await bridge.branchMerge({ name: "feature" });
  assertAsked(r, "merge", ["a.txt"], root, "merge");
  const again = await bridge.branchMerge({ name: "feature", stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length, 3, "a merge commit");
  assert.equal(read(dir, "a.txt"), LINES("feature", 0).replace("line 4\n", "mine\n"));
  assert.equal(stashes(git), "");
});

test("Rebase onto, over ANY tracked change, says so in the rebase's own words — and Stash & Retry rebases", async () => {
  const { dir, root, git } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("main", 0).replace("line 5\n", "staged\n"));
  git("add", "b.txt");
  const { bridge } = await bridgeOn(dir);
  const r = await bridge.branchRebase({ onto: "feature" });
  assertAsked(r, "rebase", ["b.txt"], root, "rebase");
  assert.match(r.message ?? "", /^A rebase needs a clean working tree/);
  const again = await bridge.branchRebase({ onto: "feature", stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("log", "--format=%s", "-4").trim(), "main changes b\nfeature adds c\nfeature changes a\nbase");
  assert.equal(git("status", "--porcelain").trim(), "M  b.txt", "staged, as it was");
});

test("a stash applied or popped over changes in its way: the right stash, found by sha — and where the edits went is said", async () => {
  for (const pop of [false, true]) {
    const { dir, root, git } = repo();
    writeFileSync(join(dir, "a.txt"), LINES("stashed", 2));
    git("stash", "-q", "-m", "the one I asked for");
    writeFileSync(join(dir, "a.txt"), LINES("line 0", 0).replace("line 7\n", "mine\n"));
    const { bridge } = await bridgeOn(dir);
    const run = pop ? (req: Parameters<GitBridge["stashPop"]>[0]) => bridge.stashPop(req) : (req: Parameters<GitBridge["stashApply"]>[0]) => bridge.stashApply(req);
    const r = await run("stash@{0}");
    assertAsked(r, "stash", ["a.txt"], root, pop ? "pop" : "apply");
    const again = await run({ ref: "stash@{0}", stashFirst: root });
    assert.equal(again.ok, true, again.message);
    assert.equal(read(dir, "a.txt"), LINES("stashed", 2), "the stash asked for is the one applied");
    const list = stashes(git);
    assert.equal(/the one I asked for/.test(list), !pop, pop ? "popped: dropped" : "applied: kept");
    assert.match(list, /GitStudio: before applying a stash/, "the edits in its way are safe in their own stash");
    assert.match(again.stashNote ?? "", /a\.txt are kept in the stash "GitStudio: before applying a stash"/, "…and that is said");
    assert.equal(filed(again), undefined);
  }
});

// ── a pull request, and a pull ────────────────────────────────────────────────

test("a pull request checked out over an edit asks, and Stash & Retry checks it out", async () => {
  const { dir, root, git } = repo();
  const remote = mkdtempSync(join(scratch, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main", "feature");
  execFileSync("git", ["update-ref", "refs/pull/7/head", git("rev-parse", "feature").trim()], { cwd: remote });
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4));
  const { github } = await bridgeOn(dir);
  const r = await github.prCheckout(7);
  assertAsked(r, "checkout", ["a.txt"], root, "pull request checkout");
  const again = await github.prCheckout({ number: 7, stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "pr/7");
  assert.equal(read(dir, "a.txt"), LINES("feature", 0).replace("line 4\n", "mine\n"));
  const junk = await github.prCheckout({ number: "7; rm" as never });
  assert.ok(filed(junk), "a request that is not a pull request number is our defect, and files");
});

test("Pull over an edit to a file it changes: asked (with `dirty` still set), and Stash & Retry pulls and puts it back", async () => {
  const base = mkdtempSync(join(scratch, "pull-"));
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const work = join(base, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, seed]);
  const s = at(seed);
  identify(s);
  writeFileSync(join(seed, "a.txt"), LINES("line 0", 0));
  s("add", ".");
  s("commit", "-qm", "base");
  s("push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, work]);
  const git = at(work);
  identify(git);
  writeFileSync(join(seed, "a.txt"), LINES("theirs", 0));
  s("commit", "-qam", "theirs");
  s("push", "-q", "origin", "main");
  writeFileSync(join(work, "a.txt"), LINES("line 0", 0).replace("line 6\n", "mine\n"));
  const root = realpathSync(work);
  const { bridge } = await bridgeOn(work);

  const r = await bridge.syncPull();
  assertAsked(r, "pull", ["a.txt"], root, "pull");
  assert.equal(r.dirty?.files, 1, "the pull's own fact is kept for the verdict");
  assert.match(r.message ?? "", /^Your uncommitted changes to a\.txt are in the way of the pull/);
  const again = await bridge.syncPull({ stashFirst: root });
  assert.equal(again.ok, true, again.message);
  assert.equal(read(work, "a.txt"), LINES("theirs", 0).replace("line 6\n", "mine\n"), "pulled, with the edit back on top");
  assert.equal(git("status", "--porcelain").trim(), "M a.txt");
  assert.equal(stashes(git), "");
  assert.equal(filed(again), undefined);
});

// ── the retry's own guards ────────────────────────────────────────────────────

test("a Stash & Retry is refused in any other repository — nothing is stashed or run, and nothing is filed", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4));
  const head = git("rev-parse", "HEAD").trim();
  const { bridge } = await bridgeOn(dir);
  for (const r of [
    await bridge.commitAction({ action: "revert", sha: head, stashFirst: "/somewhere/else" }),
    await bridge.branchMerge({ name: "feature", stashFirst: "/somewhere/else" }),
    await bridge.syncPull({ stashFirst: "/somewhere/else" }),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.expected, true);
    assert.match(r.message ?? "", /Another repository is open now, so nothing was stashed or run\./);
    assert.equal(filed(r), undefined);
  }
  assert.equal(git("rev-parse", "HEAD").trim(), head, "nothing ran");
  assert.equal(stashes(git), "", "nothing was stashed");
  assert.equal(read(dir, "b.txt"), LINES("mine", 4));
});

test("a stashFirst that is not a path is a request we built wrong — filed", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "b.txt"), LINES("mine", 4));
  const { bridge } = await bridgeOn(dir);
  const r = await bridge.commitAction({ action: "revert", sha: git("rev-parse", "HEAD").trim(), stashFirst: 42 as never });
  assert.equal(r.ok, false);
  assert.ok(filed(r), "our defect is reported");
  assert.equal(stashes(git), "");
});

test("a retry whose stash is gone is the user's state — said, and not filed", async () => {
  const { dir, root, git } = repo();
  const { bridge } = await bridgeOn(dir);
  const r = await bridge.stashApply({ ref: "stash@{0}", stashFirst: root });
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /no longer exists/);
  assert.equal(filed(r), undefined);
  assert.equal(stashes(git), "");
});

test("a failure that is NOT the user's work in the way still reports, and asks nothing", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "a.txt"), LINES("mine", 4)); // dirty, but not why these fail
  const { bridge } = await bridgeOn(dir);
  const missing = await bridge.commitAction({ action: "cherry-pick", sha: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(missing.ok, false);
  assert.equal(missing.inTheWay, undefined, "not blamed on the user's edit");
  assert.ok(filed(missing), "a pick of a commit git cannot read is reported");
  const nowhere = await bridge.branchMerge({ name: "no-such-branch" });
  assert.equal(nowhere.inTheWay, undefined);
  assert.ok(filed(nowhere), "a merge of a branch that does not exist is reported");
  assert.equal(stashes(git), "");
});
