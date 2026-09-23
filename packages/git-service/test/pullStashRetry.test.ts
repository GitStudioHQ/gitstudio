// A pull the user's uncommitted work is in the way of, answered with Stash &
// Retry — the same answer every other command that applies commits has
// (changesInTheWay.ts), and the one a pull lacked: SyncOps.pull recognised the
// refusal as `dirty` and could only say "commit or stash them, then pull
// again", leaving the user to do by hand what the app does for a revert.
//
// Pinned against real git: the paths in the way (untracked ones too) go into a
// stash of their own, the pull runs again, and they come back — staging and
// all — or, when they cannot simply come back, the outcome says where they are.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { pullInTheWayMessage, stashAndRetryPull, stashRetryNote } from "../src/changesInTheWay";
import type { PullMode } from "../src/SyncOps";

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

const SHARED = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

/**
 * A tracking clone of a remote that has moved on by one commit — changing
 * line 2 of shared.txt, or adding `theirs` when given. With `mine`, the clone
 * has a commit of its own too (touching mine.txt), so the branch has diverged.
 */
function behind(opts: { theirs?: string; mine?: boolean } = {}): { clone: string; ctx: GitContext } {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-psr-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "gitstudio-psr-seed-"));
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "ignore" });
  identify(seed);
  writeFileSync(join(seed, "shared.txt"), SHARED);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "base"]);
  git(seed, ["push", "-q", "origin", "main"]);
  const clone = mkdtempSync(join(tmpdir(), "gitstudio-psr-clone-"));
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "ignore" });
  identify(clone);
  if (opts.theirs) {
    writeFileSync(join(seed, opts.theirs), "theirs\n");
    git(seed, ["add", opts.theirs]);
  } else {
    writeFileSync(join(seed, "shared.txt"), SHARED.replace("two\n", "THEIRS\n"));
    git(seed, ["add", "shared.txt"]);
  }
  git(seed, ["commit", "-q", "-m", "theirs"]);
  git(seed, ["push", "-q", "origin", "main"]);
  if (opts.mine) {
    writeFileSync(join(clone, "mine.txt"), "mine\n");
    git(clone, ["add", "mine.txt"]);
    git(clone, ["commit", "-q", "-m", "mine"]);
  }
  trash.push(bare, seed, clone);
  const ctx = new GitContext({ root: clone });
  contexts.push(ctx);
  return { clone, ctx };
}

const status = (dir: string): string => git(dir, ["status", "--porcelain"]).trimEnd();
const stashes = (dir: string): string => git(dir, ["stash", "list"]).trim();
const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
const pullWith = (ctx: GitContext, mode?: PullMode) => () => ctx.sync.pull(mode ? { mode } : undefined);

test("a fast-forward over an edit to a file it changes: stashed, pulled, and the edit comes back merged in", async () => {
  const { clone, ctx } = behind();
  writeFileSync(join(clone, "shared.txt"), SHARED.replace("six\n", "MINE\n"));
  const refused = await ctx.sync.pull();
  assert.deepEqual(refused.dirty, { paths: ["shared.txt"] }, "precondition: the pull is refused over it");

  const out = await stashAndRetryPull(ctx.process, pullWith(ctx));
  assert.equal(out.pulled.ok, true, out.pulled.stderr);
  assert.equal(out.result.code, 0);
  assert.deepEqual(out.stashed, { kind: "pull", message: "GitStudio: before pulling", paths: ["shared.txt"] });
  assert.equal(out.fate, "restored");
  assert.equal(read(clone, "shared.txt"), SHARED.replace("two\n", "THEIRS\n").replace("six\n", "MINE\n"));
  assert.equal(status(clone), " M shared.txt", "uncommitted, exactly as it was");
  assert.equal(stashes(clone), "", "and no stash left behind");
  assert.equal(stashRetryNote(out), undefined, "nothing more to say");
});

test("a rebasing pull over a STAGED change: it comes back staged", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt", mine: true });
  writeFileSync(join(clone, "shared.txt"), SHARED.replace("six\n", "STAGED\n"));
  git(clone, ["add", "shared.txt"]);
  const refused = await ctx.sync.pull({ mode: "rebase" });
  assert.deepEqual(refused.dirty, { paths: ["shared.txt"], rebase: true }, "precondition");

  const out = await stashAndRetryPull(ctx.process, pullWith(ctx, "rebase"));
  assert.equal(out.pulled.ok, true, out.pulled.stderr);
  assert.equal(out.fate, "restored");
  assert.equal(status(clone), "M  shared.txt", "staged, as it was");
  assert.equal(git(clone, ["log", "--format=%s", "-3"]).trim(), "mine\ntheirs\nbase", "rebased onto theirs");
  assert.equal(stashes(clone), "");
});

test("a rebasing pull over a STAGED RENAME: in the way under both names, and it comes back a staged rename", async () => {
  const { clone, ctx } = behind({ theirs: "theirs.txt", mine: true });
  git(clone, ["mv", "shared.txt", "moved.txt"]);
  const refused = await ctx.sync.pull({ mode: "rebase" });
  assert.deepEqual(refused.dirty, { paths: ["moved.txt", "shared.txt"], rebase: true }, "the old name's deletion is staged too");

  const out = await stashAndRetryPull(ctx.process, pullWith(ctx, "rebase"));
  assert.equal(out.pulled.ok, true, out.pulled.stderr);
  assert.equal(out.fate, "restored");
  assert.equal(status(clone), "R  shared.txt -> moved.txt", "the rename, staged, as it was");
  assert.equal(git(clone, ["log", "--format=%s", "-3"]).trim(), "mine\ntheirs\nbase", "rebased onto theirs");
  assert.equal(stashes(clone), "");
});

test("an untracked file the pull would create is stashed with -u; it cannot come back over theirs, and is kept", async () => {
  const { clone, ctx } = behind({ theirs: "new.txt" });
  writeFileSync(join(clone, "new.txt"), "my own, untracked\n");
  const out = await stashAndRetryPull(ctx.process, pullWith(ctx));
  assert.equal(out.pulled.ok, true, out.pulled.stderr);
  assert.equal(read(clone, "new.txt"), "theirs\n", "the pull brought its own new.txt");
  assert.equal(out.fate, "kept");
  assert.match(stashes(clone), /GitStudio: before pulling/, "mine is safe in its stash");
  assert.equal(
    git(clone, ["show", "stash@{0}^3:new.txt"]),
    "my own, untracked\n",
    "…with the untracked file in it",
  );
  assert.match(stashRetryNote(out) ?? "", /new\.txt are kept in the stash "GitStudio: before pulling"/);
});

test("an edit to the very line the pull changes comes back as a conflict, and is kept", async () => {
  const { clone, ctx } = behind();
  writeFileSync(join(clone, "shared.txt"), SHARED.replace("two\n", "MINE\n"));
  const out = await stashAndRetryPull(ctx.process, pullWith(ctx));
  assert.equal(out.pulled.ok, true, "the pull itself went through");
  assert.equal(out.fate, "conflicted");
  assert.match(status(clone), /^UU shared\.txt/m);
  assert.match(stashes(clone), /GitStudio: before pulling/);
  assert.match(stashRetryNote(out) ?? "", /conflict with what came in — resolve them in Changes/);
});

test("a pull that stops on conflicts of its own leaves the changes waiting in the stash", async () => {
  const { clone, ctx } = behind({ mine: true });
  // The clone's own commit changes the line the remote changed: a merge stops.
  writeFileSync(join(clone, "shared.txt"), SHARED.replace("two\n", "OURS\n"));
  git(clone, ["commit", "-q", "-am", "ours on line two"]);
  writeFileSync(join(clone, "shared.txt"), SHARED.replace("two\n", "OURS\n").replace("six\n", "EDITING\n"));
  const out = await stashAndRetryPull(ctx.process, pullWith(ctx, "merge"));
  assert.ok(out.pulled.stopped, JSON.stringify(out.pulled));
  assert.equal(out.fate, "waiting");
  assert.match(stashes(clone), /GitStudio: before pulling/);
  assert.match(
    stashRetryNote(out) ?? "",
    /waiting in the stash "GitStudio: before pulling" — apply it once the conflicts are resolved/,
  );
  git(clone, ["merge", "--abort"]);
});

test("with nothing in the way any more it just pulls, and stashes nothing", async () => {
  const { clone, ctx } = behind();
  const out = await stashAndRetryPull(ctx.process, pullWith(ctx));
  assert.equal(out.pulled.ok, true, out.pulled.stderr);
  assert.equal(out.stashed, undefined);
  assert.equal(stashes(clone), "");
});

test("a pull that fails for another reason is handed back as it is, and nothing is stashed", async () => {
  const { clone, ctx } = behind();
  git(clone, ["remote", "set-url", "origin", join(tmpdir(), `gitstudio-psr-gone-${process.pid}-${Date.now()}.git`)]);
  writeFileSync(join(clone, "mine.txt"), "untouched by anything incoming\n");
  const out = await stashAndRetryPull(ctx.process, pullWith(ctx));
  assert.equal(out.pulled.ok, false);
  assert.equal(out.pulled.dirty, undefined);
  assert.equal(out.stashed, undefined);
  assert.equal(stashes(clone), "");
});

test("the pull's sentence names the files, and what they are in the way of", () => {
  assert.match(
    pullInTheWayMessage({ paths: ["a.txt", "b.txt"] }),
    /^Your uncommitted changes to a\.txt and b\.txt are in the way of the pull — git won't overwrite them\. Stash them and try again, or commit them first\.$/,
  );
  assert.match(
    pullInTheWayMessage({ paths: ["a.txt"], rebase: true }),
    /^Pulling with rebase needs a clean working tree, and your uncommitted changes to a\.txt are in the way\. Stash it and try again, or commit it first\.$/,
  );
});
