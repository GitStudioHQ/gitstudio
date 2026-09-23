// Three states a Pull meets that are the user's, not ours — each of which came
// back as git's text, and on the desktop as a crash report, until now.
//
//   · `pull.ff=only` in the user's config. It is one of the three lines git's
//     own divergence advice suggests, and it makes a mode-less pull exactly the
//     `--ff-only` the auto path runs — so a diverged branch meets the same
//     refusal. The auto path turns that refusal into the merge-or-rebase
//     question; with the config set it went out as git's hint wall ("Diverging
//     branches can't be fast-forwarded, you need to either: … git merge
//     --no-ff … git rebase") — report #12, for everyone who had taken git's
//     advice.
//   · Uncommitted work in the way. A pull that REBASES refuses any change to a
//     tracked file; a merge or fast-forward refuses a changed (or untracked)
//     file its incoming commits touch. Work in progress, and nothing changed —
//     `dirty`, read from porcelain status and the upstream's diff, never from
//     git's English.
//   · A paused operation, asked about BEFORE a door's question
//     (`pausedOperation`): a paused rebase leaves HEAD detached, and the
//     extension's Pull, which looked only at the HEAD, told a user in the middle
//     of a rebase to go and check out a branch.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { pullDirtyMessage, pullPauseMessage } from "../src/SyncOps";

const trash: string[] = [];
const contexts: GitContext[] = [];

afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  for (const d of trash.splice(0)) removeTempRepo(d);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

function identify(dir: string): void {
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Dev"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "gc.auto", "0"]);
}

function commitIn(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", msg]);
}

/**
 * A tracking clone of a remote that has moved on by one commit touching
 * `theirs`. With `mine`, the clone has a commit of its own too (touching a
 * different file), so the branch has diverged. Nothing is fetched: the pull
 * does that.
 */
function behind(opts: { theirs?: string; mine?: boolean } = {}): { clone: string; ctx: GitContext } {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-us-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "gitstudio-us-seed-"));
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "ignore" });
  identify(seed);
  commitIn(seed, "shared.txt", "one\ntwo\nthree\n", "base");
  git(seed, ["push", "-q", "origin", "main"]);
  const clone = mkdtempSync(join(tmpdir(), "gitstudio-us-clone-"));
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "ignore" });
  identify(clone);
  commitIn(seed, opts.theirs ?? "shared.txt", "one\nTHEIRS\nthree\n", "theirs");
  git(seed, ["push", "-q", "origin", "main"]);
  if (opts.mine) commitIn(clone, "mine.txt", "mine\n", "mine");
  trash.push(bare, seed, clone);
  const ctx = new GitContext({ root: clone });
  contexts.push(ctx);
  return { clone, ctx };
}

// ── pull.ff=only ─────────────────────────────────────────────────────────────

test("pull.ff=only on a diverged branch is the divergence question, not git's advice", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt", mine: true });
  git(clone, ["config", "pull.ff", "only"]);
  const head = git(clone, ["rev-parse", "HEAD"]).trim();
  const r = await ctx.sync.pull();
  assert.equal(r.ok, false);
  assert.deepEqual(r.diverged, { branch: "main", upstream: "origin/main", ahead: 1, behind: 1 });
  assert.equal(git(clone, ["rev-parse", "HEAD"]).trim(), head, "nothing was merged");
  // …and the answer, passed as a flag, wins over the config, as the question
  // promises ("this pull only").
  const merged = await ctx.sync.pull({ mode: "merge" });
  assert.equal(merged.ok, true, merged.stderr);
  assert.equal(git(clone, ["config", "--get", "pull.ff"]).trim(), "only", "the user's config is untouched");
});

test("pull.ff=only wins over a configured pull.rebase, so that is the question too", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt", mine: true });
  git(clone, ["config", "pull.ff", "only"]);
  git(clone, ["config", "pull.rebase", "true"]);
  const r = await ctx.sync.pull();
  assert.ok(r.diverged, JSON.stringify(r));
});

test("pull.ff=only on a branch that is only behind just fast-forwards", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt" });
  git(clone, ["config", "pull.ff", "only"]);
  const r = await ctx.sync.pull();
  assert.equal(r.ok, true, r.stderr);
});

// ── Uncommitted work in the way ─────────────────────────────────────────────

test("a pull that rebases over uncommitted changes is `dirty`, and names them", async () => {
  for (const how of ["flag", "pull.rebase", "branch.main.rebase"] as const) {
    const { clone, ctx } = behind({ theirs: "theirs.txt", mine: true });
    if (how !== "flag") git(clone, ["config", how, "true"]);
    writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
    const head = git(clone, ["rev-parse", "HEAD"]).trim();
    const r = await ctx.sync.pull(how === "flag" ? { mode: "rebase" } : undefined);
    assert.equal(r.ok, false, how);
    assert.deepEqual(r.dirty, { paths: ["shared.txt"], rebase: true }, how);
    assert.equal(r.diverged, undefined, `${how}: not the question — it would be refused the same way`);
    assert.equal(r.blocked, undefined, how);
    assert.equal(git(clone, ["rev-parse", "HEAD"]).trim(), head, `${how}: nothing ran`);
    assert.equal(readFileSync(join(clone, "shared.txt"), "utf8"), "one\nEDITING\nthree\n", `${how}: the edit is intact`);
  }
});

test("a fast-forward over an edit to a file it changes is `dirty` — the old guard's case", async () => {
  // test/pullStopped.test.ts pins that this is neither a stop nor a block; it
  // is the user's work in the way, and now says so.
  const { clone, ctx } = behind();
  writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
  for (const mode of [undefined, "merge"] as const) {
    const r = await ctx.sync.pull(mode ? { mode } : undefined);
    assert.equal(r.ok, false, `mode ${mode}`);
    assert.deepEqual(r.dirty, { paths: ["shared.txt"] }, `mode ${mode}`);
    assert.equal(r.stopped, undefined);
    assert.equal(r.blocked, undefined);
  }
});

test("a merge of a diverged branch over an edit to a file it brings in is `dirty` too", async () => {
  const { clone, ctx } = behind({ mine: true });
  writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
  const r = await ctx.sync.pull({ mode: "merge" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.dirty, { paths: ["shared.txt"] });
  assert.equal(existsSync(join(clone, ".git", "MERGE_HEAD")), false, "no merge was started");
});

test("an untracked file the pull would create is in the way", async () => {
  const { clone, ctx } = behind({ theirs: "new.txt" });
  writeFileSync(join(clone, "new.txt"), "my own, untracked\n");
  const r = await ctx.sync.pull();
  assert.equal(r.ok, false);
  assert.deepEqual(r.dirty, { paths: ["new.txt"] });
});

test("an edit the pull does not touch is not in the way — the pull just runs", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt" });
  writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
  const r = await ctx.sync.pull();
  assert.equal(r.ok, true, r.stderr);
  assert.equal(readFileSync(join(clone, "shared.txt"), "utf8"), "one\nEDITING\nthree\n");
});

test("with autoStash configured git stashes around the pull, and nothing is refused", async () => {
  for (const [key, mode] of [["rebase.autoStash", "rebase"], ["merge.autoStash", undefined]] as const) {
    const { clone, ctx } = behind();
    git(clone, ["config", key, "true"]);
    writeFileSync(join(clone, "shared.txt"), "one\nTHEIRS\nthree\nEDITING\n");
    const r = await ctx.sync.pull(mode ? { mode } : undefined);
    assert.equal(r.dirty, undefined, key);
    assert.equal(r.ok, true, `${key}: ${r.stderr}`);
  }
});

test("a diverged branch with an edit in the way still asks first — the refusal was the divergence", async () => {
  // `--ff-only` refuses the divergence (128) before anything looks at the
  // working tree; the edit only matters once an answer is being carried out.
  const { clone, ctx } = behind({ mine: true });
  writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
  const r = await ctx.sync.pull();
  assert.ok(r.diverged, JSON.stringify(r));
  assert.equal(r.dirty, undefined);
});

test("a remote that cannot be reached is not blamed on an edit nothing incoming touches", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt" });
  git(clone, ["remote", "set-url", "origin", join(tmpdir(), `gitstudio-us-gone-${process.pid}-${Date.now()}.git`)]);
  writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
  const r = await ctx.sync.pull();
  assert.equal(r.ok, false);
  assert.equal(r.dirty, undefined, "the failure is the remote's, and keeps its own message");
});

test("uncommitted work in the way is said in the app's words, with the way on", () => {
  const one = pullDirtyMessage({ paths: ["src/app.ts"] });
  assert.match(one, /overwrite your uncommitted changes to src\/app\.ts/);
  assert.match(one, /commit or stash it, then pull again/i);
  const many = pullDirtyMessage({ paths: ["a", "b", "c"], rebase: true });
  assert.match(many, /rebase needs a clean working tree/i);
  assert.match(many, /3 files/);
  for (const said of [one, many]) {
    assert.doesNotMatch(said, /^(error|fatal|hint):|git stash|git add/im, "not git's terminal lines");
  }
  assert.equal(pullPauseMessage({ dirty: { paths: ["a"] } }), one.replace("src/app.ts", "a"), "the extension settles it too");
});

// ── The paused operation, asked about before a question ──────────────────────

test("pausedOperation names a paused rebase — whose HEAD is detached — and nothing on a clean branch", async () => {
  const { clone, ctx } = behind({ mine: true });
  assert.equal(await ctx.sync.pausedOperation(), null, "nothing paused");
  // Make the replay collide, then stop in it.
  commitIn(clone, "shared.txt", "one\nMINE\nthree\n", "mine, colliding");
  assert.ok((await ctx.sync.pull({ mode: "rebase" })).stopped, "precondition: the rebase stopped");
  assert.throws(() => git(clone, ["symbolic-ref", "-q", "HEAD"]), "precondition: HEAD is detached mid-rebase");
  assert.deepEqual(await ctx.sync.pausedOperation(), { operation: "rebase", conflicted: 1 });
});
