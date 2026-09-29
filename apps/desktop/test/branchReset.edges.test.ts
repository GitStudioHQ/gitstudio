import "./hermeticGit";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import type { BranchResetPlan } from "../src/shared/ipc";
import { removeTempRepo } from "./tmpRepo";

// "Reset to 'origin/feature'…" (#32), the edges branchReset.test.ts's state
// table leaves: an upstream deleted on the remote, a stopped operation of each
// kind named in its own words, an untracked file that appears between the
// question and the answer, a request whose shas are not shas, and the undo
// when you have switched away, when git refuses to move back, and when the
// kept copy of your changes will not apply. Same fixture as that file: a bare
// "remote" on disk and a clone of it.

let base: string;
let remote: string;
let repo: string;
let bridge: GitBridge;
let ctx: GitContext;

const run = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (...a: string[]): string => run(repo, ...a);
const gitTry = (...a: string[]): number => {
  try {
    git(...a);
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
};
const sha = (ref: string, cwd = repo): string => run(cwd, "rev-parse", ref).trim();
const write = (rel: string, text: string): void => writeFileSync(join(repo, rel), text);
const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gitstudio-reset-edges-"));
  remote = join(base, "remote.git");
  repo = join(base, "repo");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", remote]);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  for (const [k, v] of [
    ["user.email", "dev@example.com"],
    ["user.name", "Dev"],
    ["gc.auto", "0"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
  ]) git("config", k, v);
  git("remote", "add", "origin", remote);
  write("a.txt", "one\n");
  git("add", ".");
  git("commit", "-qm", "first");
  git("push", "-qu", "origin", "main");
  git("checkout", "-qb", "feature/x");
  write("a.txt", "two\n");
  git("commit", "-qam", "on the remote");
  git("push", "-qu", "origin", "feature/x");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => removeTempRepo(base));

const FULL = "refs/heads/feature/x";
const plan = (fullName = FULL): Promise<BranchResetPlan> => bridge.branchResetPlan({ fullName });

test("an upstream deleted on the remote is said as that, not as a failed fetch", async () => {
  run(remote, "update-ref", "-d", "refs/heads/feature/x");
  const p = await plan();
  assert.equal(p.ok, false);
  assert.equal(p.expected, true);
  assert.equal(p.message, "origin/feature/x no longer exists on origin, so there is nothing to reset 'feature/x' to.");
});

test("each stopped operation on the branch is named in its own words and blocks the plan", async () => {
  // A second line of history that conflicts with feature/x on a.txt.
  git("checkout", "-qb", "clash", "main");
  write("a.txt", "clash\n");
  git("commit", "-qam", "clash");
  const clash = sha("HEAD");
  git("checkout", "-q", "feature/x");
  // The commit that set a.txt to "two"; reverting it under "local" conflicts.
  const onRemote = sha("HEAD");
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  const local = sha("HEAD");

  const cases: Array<[string, () => void, string[]]> = [
    ["A cherry-pick is in progress.", () => void gitTry("cherry-pick", clash), ["cherry-pick", "--abort"]],
    ["A revert is in progress.", () => void gitTry("revert", "--no-edit", onRemote), ["revert", "--abort"]],
    [
      "A stash with conflicts is in progress.",
      () => {
        write("a.txt", "stashed edit\n");
        git("stash", "push", "-q");
        write("a.txt", "committed edit\n");
        git("commit", "-qam", "committed edit");
        gitTry("stash", "apply");
      },
      ["reset", "-q", "--hard", local],
    ],
  ];
  for (const [said, stop, abort] of cases) {
    stop();
    const p = await plan();
    assert.equal(p.ok, false, said);
    assert.equal(p.expected, true);
    assert.equal(p.message, `${said} Finish or abort it in Changes before resetting 'feature/x'.`);
    git(...abort);
    assert.equal(sha("HEAD"), local, "aborted cleanly before the next case");
  }
});

test("a reset whose from or to is not a sha is refused before anything is read", async () => {
  const before = sha("HEAD");
  const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: "HEAD", to: sha("origin/feature/x") });
  assert.deepEqual(r, { ok: false, changed: false, message: "That value isn't a valid git reference." });
  assert.equal(sha("HEAD"), before);
});

test("an untracked file the upstream also has, created after the question, stops the reset", async () => {
  // Somebody else adds new.txt on the remote; the plan fetches it.
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", "-b", "feature/x", remote, other]);
  run(other, "config", "user.email", "o@example.com");
  run(other, "config", "user.name", "Other");
  writeFileSync(join(other, "new.txt"), "theirs\n");
  run(other, "add", "new.txt");
  run(other, "commit", "-qm", "add new.txt");
  run(other, "push", "-q", "origin", "feature/x");

  const p = await plan();
  assert.equal(p.ok, true, p.message);
  assert.equal(p.gained, 1);
  // Between the question and the answer, an untracked file of the same name.
  write("new.txt", "mine, not tracked\n");
  const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: p.from!, to: p.to! });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.match(r.message ?? "", /^Resetting would overwrite a file git isn't tracking, which origin\/feature\/x has too: new\.txt\./);
  assert.equal(read("new.txt"), "mine, not tracked\n", "the file nobody could bring back is untouched");
  assert.equal(sha("HEAD"), p.from);
});

async function resetWithLocalWork(): Promise<{ p: BranchResetPlan; was: string; snapshot?: string }> {
  write("local.txt", "committed only here\n");
  git("add", "local.txt");
  git("commit", "-qm", "local work");
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: p.from!, to: p.to! });
  assert.equal(r.ok, true, r.message);
  return { p, was: r.was!, snapshot: r.snapshot };
}

test("undoing a reset refuses shas that are not shas, and a branch you have since left", async () => {
  const { p, was } = await resetWithLocalWork();
  const bad = await bridge.branchResetUndo({ root: repo, fullName: FULL, was: "HEAD@{1}", now: p.to!, current: true });
  assert.deepEqual(bad, { ok: false, changed: false, message: "That value isn't a valid git reference." });

  git("checkout", "-q", "main");
  const away = await bridge.branchResetUndo({ root: repo, fullName: FULL, was, now: p.to!, current: true });
  assert.equal(away.ok, false);
  assert.equal(away.expected, true);
  assert.equal(away.message, "You're no longer on 'feature/x'. Switch back to it to undo the reset.");
  assert.equal(sha(FULL), p.to, "the branch was not moved from somewhere else");
});

test("undoing a reset that git refuses to move back over an untracked file changes nothing", async () => {
  const { p, was } = await resetWithLocalWork();
  // local.txt left with the reset; a new untracked local.txt is now in the way
  // of bringing the old commit back.
  assert.equal(existsSync(join(repo, "local.txt")), false);
  write("local.txt", "a different, untracked file\n");
  const res = await bridge.branchResetUndo({ root: repo, fullName: FULL, was, now: p.to!, current: true });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /^Couldn't put 'feature\/x' back: .+\. Nothing was changed\.$/);
  assert.equal(sha("HEAD"), p.to);
  assert.equal(read("local.txt"), "a different, untracked file\n");
});

test("undoing a reset whose kept changes will not apply puts the branch back and says where they are", async () => {
  const { p, was } = await resetWithLocalWork();
  // A restore point that is a sha but not a stash: git refuses to apply it.
  const notAStash = sha("main");
  const res = await bridge.branchResetUndo({
    root: repo,
    fullName: FULL,
    was,
    now: p.to!,
    current: true,
    snapshot: notAStash,
  });
  assert.equal(res.ok, false);
  assert.equal(res.changed, true, "the branch DID move back");
  assert.match(res.message ?? "", /^'feature\/x' is back where it was, but your uncommitted changes couldn't be put back/);
  assert.match(res.message ?? "", new RegExp(`git stash apply ${notAStash}`));
  assert.equal(sha("HEAD"), was);
  assert.equal(read("local.txt"), "committed only here\n");
});

test("a branch whose upstream stopped being a remote branch after the question is left alone", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  git("branch", "-q", "--set-upstream-to=main");
  const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: p.from!, to: p.to! });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
  assert.equal(r.message, "'feature/x' doesn't track a branch on a remote any more — nothing was changed.");
  assert.equal(sha("HEAD"), p.from);
});

/** Make one git command fail as git would, leaving every other one real. */
function failing(match: (args: string[]) => boolean, stderr: string): () => void {
  const real = ctx.process.run.bind(ctx.process);
  ctx.process.run = async (args, opts) =>
    match(args) ? { code: 128, stdout: "", stderr } : real(args, opts);
  return () => {
    ctx.process.run = real;
  };
}

test("when git cannot keep a copy of the uncommitted changes, nothing is reset", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  write("a.txt", "uncommitted\n");
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  // git's "fatal: " prefix and any lines after the first are not the reason.
  const restore = failing((a) => a[0] === "stash" && a[1] === "create", "fatal: unable to write new index file\nmore");
  try {
    const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: p.from!, to: p.to! });
    assert.deepEqual(r, {
      ok: false,
      changed: false,
      message: "Couldn't keep a copy of your uncommitted changes, so nothing was reset: unable to write new index file",
    });
  } finally {
    restore();
  }
  assert.equal(sha("HEAD"), p.from, "the branch did not move");
  assert.equal(read("a.txt"), "uncommitted\n", "and the work is still there");
});

test("a reset git refuses part-way says so, and that something may have changed", async () => {
  write("a.txt", "local\n");
  git("commit", "-qam", "local");
  const p = await plan();
  assert.equal(p.ok, true, p.message);
  const restore = failing((a) => a[0] === "reset" && a[1] === "--hard", "");
  try {
    const r = await bridge.branchResetToUpstream({ root: repo, fullName: FULL, from: p.from!, to: p.to! });
    assert.deepEqual(r, { ok: false, changed: true, message: "Couldn't reset 'feature/x'." });
  } finally {
    restore();
  }
});
