import "./hermeticGit";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import { parseDirty } from "../src/main/branchReset";
import type { RepoStore } from "../src/main/repoStore";
import type { BranchResetPlan } from "../src/shared/ipc";
import { removeTempRepo } from "./tmpRepo";

// "Reset to 'origin/feature'…" (#32) — make a local branch 1:1 with its
// upstream. The whole state table, against real git: the checked-out branch
// (dirty and clean) and any other; ahead, behind, diverged and equal; no
// upstream; an upstream deleted on the remote; a branch another worktree has
// checked out or is rebasing; a plan gone stale; an untracked file in the
// way; an operation in progress; the undo, and when the undo must refuse.
//
// A fixture cannot tell you what `git reset --hard` does to an untracked file
// the target also has (it overwrites it, silently), or that %(worktreepath)
// does not see a branch being rebased in another worktree while `git branch
// -f` does. Both are pinned here.

let base: string;
let remote: string;
let repo: string;
let other: string;
let bridge: GitBridge;

const run = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (...a: string[]): string => run(repo, ...a);
const inOther = (...a: string[]): string => run(other, ...a);
const sha = (ref: string, cwd = repo): string => run(cwd, "rev-parse", ref).trim();
const write = (rel: string, text: string, cwd = repo): void => writeFileSync(join(cwd, rel), text);
const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");

function configure(dir: string): void {
  run(dir, "config", "user.email", "dev@example.com");
  run(dir, "config", "user.name", "Dev");
  run(dir, "config", "gc.auto", "0");
  run(dir, "config", "core.autocrlf", "false");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gitstudio-reset-"));
  remote = join(base, "remote.git");
  repo = join(base, "repo");
  other = join(base, "other");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", remote]);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  configure(repo);
  git("remote", "add", "origin", remote);
  write("a.txt", "one\n");
  git("add", ".");
  git("commit", "-qm", "first");
  git("push", "-qu", "origin", "main");
  git("checkout", "-qb", "feature/x");
  write("a.txt", "two\n");
  git("commit", "-qam", "on the remote");
  git("push", "-qu", "origin", "feature/x");
  // A second clone, for "somebody else pushed".
  execFileSync("git", ["clone", "-q", remote, other]);
  configure(other);
  const ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  removeTempRepo(base);
});

const FULL = "refs/heads/feature/x";

async function plan(fullName = FULL): Promise<BranchResetPlan> {
  return bridge.branchResetPlan({ fullName });
}

async function resetFrom(p: BranchResetPlan, fullName = FULL) {
  assert.equal(p.ok, true, p.message);
  return bridge.branchResetToUpstream({ root: repo, fullName, from: p.from!, to: p.to! });
}

test("the checked-out branch: the plan names what goes, the reset matches origin, and undo brings all of it back", async () => {
  write("a.txt", "local one\n");
  git("commit", "-qam", "local one");
  write("a.txt", "local two\n");
  git("commit", "-qam", "local two");
  const before = sha("HEAD");
  // Uncommitted work of every tracked kind, and one file git is not tracking.
  write("a.txt", "edited, not staged\n");
  write("b.txt", "new and staged\n");
  git("add", "b.txt");
  write("u.txt", "untracked\n");

  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.equal(p.current, true);
  assert.equal(p.upstream, "origin/feature/x");
  assert.equal(p.lost, 2, "two commits are only here");
  assert.deepEqual(p.lostSubjects, ["local two", "local one"], "named newest first");
  assert.equal(p.gained, 0);
  assert.equal(p.dirty, 2, "a.txt (unstaged) and b.txt (staged new) — never the untracked u.txt");
  assert.equal(p.from, before);
  assert.equal(p.to, sha("refs/remotes/origin/feature/x"));

  const r = await resetFrom(p);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.was, before);
  assert.ok(r.snapshot, "the discarded changes were kept for the undo");
  assert.equal(sha("HEAD"), sha("refs/remotes/origin/feature/x"), "1:1 with origin");
  assert.equal(read("a.txt"), "two\n");
  assert.equal(existsSync(join(repo, "b.txt")), false, "the staged new file went with the reset");
  assert.equal(read("u.txt"), "untracked\n", "untracked files are kept");
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "nothing tracked is left changed");

  const back = await bridge.branchResetUndo({
    root: repo,
    fullName: FULL,
    was: r.was!,
    now: p.to!,
    snapshot: r.snapshot,
    current: true,
  });
  assert.equal(back.ok, true, back.message);
  assert.equal(sha("HEAD"), before, "the commits are back on the branch");
  assert.equal(read("a.txt"), "edited, not staged\n", "the unstaged edit is back");
  assert.equal(git("diff", "--cached", "--name-only").trim(), "b.txt", "…and b.txt is staged again, and only it");
  assert.equal(read("u.txt"), "untracked\n");
});

test("the plan FETCHES first: a commit somebody else pushed is what the branch resets to", async () => {
  inOther("checkout", "-q", "feature/x");
  write("a.txt", "theirs\n", other);
  inOther("commit", "-qam", "pushed from elsewhere");
  inOther("push", "-q", "origin", "feature/x");
  const theirs = sha("HEAD", other);
  assert.notEqual(sha("refs/remotes/origin/feature/x"), theirs, "precondition: not fetched yet");

  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.equal(p.fetchError, undefined);
  assert.equal(p.to, theirs, "the upstream as it is on the remote now");
  assert.equal(p.gained, 1);
  assert.equal(p.lost, 0);
  assert.equal(p.dirty, 0);
  const r = await resetFrom(p);
  assert.equal(r.ok, true, r.message);
  assert.equal(sha("HEAD"), theirs);
  assert.equal(r.snapshot, undefined, "a clean tree has nothing to keep");
});

test("equal and clean: the plan says nothing would change", async () => {
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.equal(p.lost, 0);
  assert.equal(p.gained, 0);
  assert.equal(p.dirty, 0);
  assert.equal(p.from, p.to);
});

test("diverged: what leaves and what arrives are both counted", async () => {
  inOther("checkout", "-q", "feature/x");
  write("a.txt", "theirs\n", other);
  inOther("commit", "-qam", "theirs");
  inOther("push", "-q", "origin", "feature/x");
  write("c.txt", "mine\n");
  git("add", "c.txt");
  git("commit", "-qm", "mine");
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.equal(p.lost, 1);
  assert.deepEqual(p.lostSubjects, ["mine"]);
  assert.equal(p.gained, 1);
});

test("a long run of local commits names five and counts the rest", async () => {
  for (let i = 1; i <= 7; i++) {
    write("a.txt", `local ${i}\n`);
    git("commit", "-qam", `local ${i}`);
  }
  const p = await plan();
  assert.equal(p.lost, 7);
  assert.deepEqual(p.lostSubjects, ["local 7", "local 6", "local 5", "local 4", "local 3"]);
});

test("a branch that is not checked out moves without touching the working tree", async () => {
  write("a.txt", "local only\n");
  git("commit", "-qam", "local only");
  const before = sha(FULL);
  git("checkout", "-q", "main");
  write("a.txt", "work in progress on main\n");

  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.equal(p.current, false);
  assert.equal(p.dirty, undefined, "no working tree is involved, so none is counted");
  assert.equal(p.lost, 1);

  const mainBefore = sha("HEAD");
  const r = await resetFrom(p);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.current, false);
  assert.equal(sha(FULL), sha("refs/remotes/origin/feature/x"), "the branch moved");
  assert.equal(sha("HEAD"), mainBefore, "HEAD did not");
  assert.equal(read("a.txt"), "work in progress on main\n", "and nothing on disk changed");
  assert.equal(git("config", "--get", "branch.feature/x.merge").trim(), "refs/heads/feature/x", "tracking is kept");

  const back = await bridge.branchResetUndo({ root: repo, fullName: FULL, was: r.was!, now: p.to!, current: false });
  assert.equal(back.ok, true, back.message);
  assert.equal(sha(FULL), before, "undo puts the local commit back");
  assert.equal(read("a.txt"), "work in progress on main\n");
});

test("checked out in another worktree: refused before anything is asked, naming where", async () => {
  git("checkout", "-q", "main");
  const wt = join(base, "wt");
  git("worktree", "add", "-q", wt, "feature/x");
  const before = sha(FULL);
  const p = await plan();
  assert.equal(p.ok, false);
  assert.equal(p.expected, true, "a state the user is in, not a crash");
  assert.match(p.message ?? "", new RegExp(`checked out in the worktree at ${realpathSync(wt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // …and the reset itself refuses too, whatever it is sent.
  const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: before, to: sha("refs/remotes/origin/feature/x") });
  assert.equal(r.ok, false);
  assert.equal(sha(FULL), before, "nothing moved");
});

test("being rebased in another worktree: %(worktreepath) misses it, git branch -f refuses, and the refusal says where", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  git("checkout", "-q", "main");
  write("a.txt", "conflicting on main\n");
  git("commit", "-qam", "main moves");
  const wt = join(base, "wt");
  git("worktree", "add", "-q", wt, "feature/x");
  try {
    run(wt, "rebase", "main");
  } catch {
    /* stops on the conflict — that is the state under test */
  }
  const before = sha(FULL);
  const p = await plan();
  assert.equal(p.ok, true, "precondition: the plan cannot see a rebase in another worktree");
  const r = await resetFrom(p);
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.match(r.message ?? "", /in use in the worktree at .*being rebased/);
  assert.equal(sha(FULL), before, "the branch under the rebase was not moved");
});

test("no upstream: refused, and nothing is fetched", async () => {
  git("checkout", "-q", "-b", "local-only");
  const p = await plan("refs/heads/local-only");
  assert.equal(p.ok, false);
  assert.equal(p.expected, true);
  assert.match(p.message ?? "", /doesn't track a branch on a remote/);
});

test("an upstream deleted on the remote: refused rather than reset to a stale copy", async () => {
  inOther("push", "-q", "origin", "--delete", "feature/x");
  const p = await plan();
  assert.equal(p.ok, false);
  assert.equal(p.expected, true);
  assert.match(p.message ?? "", /origin\/feature\/x no longer exists on origin/);
});

test("a plan gone stale resets nothing", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  const p = await plan();
  write("a.txt", "one more\n");
  git("commit", "-qam", "committed after the question was asked");
  const now = sha("HEAD");
  const r = await resetFrom(p);
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.match(r.message ?? "", /moved after you were asked/);
  assert.equal(sha("HEAD"), now, "the commit the confirm never mentioned is still there");
});

test("a file git isn't tracking that origin also has: refused, named, and left alone", async () => {
  write("n.txt", "theirs\n", other);
  inOther("checkout", "-q", "feature/x");
  inOther("add", "n.txt");
  mkdirSync(join(other, "d"));
  write("d/x.txt", "theirs\n", other);
  inOther("add", "d/x.txt");
  inOther("commit", "-qm", "adds n.txt and d/x.txt");
  inOther("push", "-q", "origin", "feature/x");
  write("n.txt", "my own, never committed\n");
  write("d", "a FILE where origin has a directory\n");
  const p = await plan();
  assert.equal(p.ok, false);
  assert.equal(p.expected, true);
  assert.match(p.message ?? "", /n\.txt/);
  assert.match(p.message ?? "", /\bd\b/);
  assert.equal(read("n.txt"), "my own, never committed\n", "and it is untouched");

  // Moved out of the way, the reset goes ahead.
  execFileSync("rm", [join(repo, "n.txt"), join(repo, "d")]);
  const again = await plan();
  assert.equal(again.ok, true, again.message);
});

test("an operation in progress: refused, pointing at Changes", async () => {
  git("checkout", "-q", "main");
  write("a.txt", "main side\n");
  git("commit", "-qam", "main side");
  git("checkout", "-q", "feature/x");
  try {
    git("merge", "main");
  } catch {
    /* a conflict — the state under test */
  }
  const p = await plan();
  assert.equal(p.ok, false);
  assert.equal(p.expected, true);
  assert.match(p.message ?? "", /A merge is in progress/);
});

test("undo refuses rather than throw away what happened after the reset", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  write("a.txt", "dirty\n");
  const p = await plan();
  const r = await resetFrom(p);
  assert.equal(r.ok, true, r.message);

  // Files changed since: refused, nothing moves.
  write("a.txt", "changed after the reset\n");
  const dirty = await bridge.branchResetUndo({ root: repo, fullName: FULL, was: r.was!, now: p.to!, snapshot: r.snapshot, current: true });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.expected, true);
  assert.match(dirty.message ?? "", /changed files since the reset/);
  assert.equal(read("a.txt"), "changed after the reset\n");

  // A commit since: refused, the commit stays.
  git("commit", "-qam", "after the reset");
  const moved = sha("HEAD");
  const later = await bridge.branchResetUndo({ root: repo, fullName: FULL, was: r.was!, now: p.to!, snapshot: r.snapshot, current: true });
  assert.equal(later.ok, false);
  assert.match(later.message ?? "", /has moved since the reset/);
  assert.equal(sha("HEAD"), moved);
});

test("a request built in another repository is refused, reset and undo alike", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  const p = await plan();
  const before = sha("HEAD");
  const r = await bridge.branchResetToUpstream({ root: join(base, "elsewhere"), fullName: FULL, from: p.from!, to: p.to! });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.equal(sha("HEAD"), before);
  const u = await bridge.branchResetUndo({ root: join(base, "elsewhere"), fullName: FULL, was: p.to!, now: p.from!, current: true });
  assert.equal(u.ok, false);
  assert.equal(sha("HEAD"), before);
});

test("a branch named like an option never reaches git as one", async () => {
  git("checkout", "-q", "main");
  git("update-ref", "refs/heads/-x", "HEAD");
  git("config", "branch.-x.remote", "origin");
  git("config", "branch.-x.merge", "refs/heads/main");
  const p = await plan("refs/heads/-x");
  assert.equal(p.ok, false);
  assert.equal(p.expected, true);
  assert.match(p.message ?? "", /starts with "-"/);
  // A short name is not a full one, and is refused as a request built wrong.
  const bare = await bridge.branchResetPlan({ fullName: "-x" });
  assert.equal(bare.ok, false);
  assert.notEqual(bare.expected, true, "only our own code can send that");
  const bad = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: "--hard", to: "HEAD" });
  assert.equal(bad.ok, false, "a revision that is not a sha is refused before git sees it");
});

test("offline: the plan says the fetch failed and uses what was fetched last", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  git("remote", "set-url", "origin", join(base, "gone.git"));
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.ok(p.fetchError, "the fetch failure is carried to the confirm");
  assert.equal(p.to, sha("refs/remotes/origin/feature/x"));
  assert.equal(p.lost, 1);
});

test("porcelain v2: a rename counts once, and its second path is not a record", () => {
  const z = ["1 .M N... 100644 100644 100644 a a a.txt", "2 R. N... 100644 100644 100644 a a R100 new.txt", "old.txt", "u UU N... 1 2 3 4 a b c d c.txt", ""].join("\0");
  assert.equal(parseDirty(z), 3);
  assert.equal(parseDirty(""), 0);
});
