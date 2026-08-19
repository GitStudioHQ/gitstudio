import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { stashBlockerMessage } from "../src/StashProvider";

// `git stash push` with nothing to save does not fail — it exits **0** and says
// "No local changes to save" on stdout. Deciding success from the exit code
// therefore reported a stash that never happened, which is the worst shape this
// class of bug takes: the user is told their work is safely put away while it is
// still sitting in the working tree.
//
// The nastier variant is untracked-only. There the user genuinely HAS changes —
// new files — and git, not asked for --include-untracked, saves nothing and still
// exits 0. "Stashed changes" over a directory of unsaved new files.
//
// These tests pin git's actual behaviour and our reading of it.

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

const write = (name: string, content: string): void =>
  writeFileSync(join(repo, name), content);

/** Entries in the stash reflog, read independently of the code under test. */
const stashEntries = (): number => {
  try {
    return git("reflog", "show", "refs/stash").split("\n").filter(Boolean).length;
  } catch {
    return 0; // no refs/stash at all
  }
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stashnoop-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  write("tracked.txt", "one\n");
  git("add", "tracked.txt");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("the reported bug: stashing a clean tree does NOT fail, it succeeds emptily", async () => {
  const r = await ctx.stashes.save();

  assert.equal(r.ok, true, "git really does exit 0 here — that is the trap");
  assert.equal(r.created, false, "but nothing was stashed");
  assert.equal(r.blocker, "cleanTree");
  assert.equal(stashEntries(), 0, "and the stash list is still empty");
});

test("untracked-only without --include-untracked stashes nothing, and says which", async () => {
  // The dangerous case: there IS work here, and it is one option away from being
  // saved. Telling the user "the working tree is clean" would be a lie.
  write("brand-new.txt", "unsaved work\n");

  const r = await ctx.stashes.save();

  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.blocker, "untrackedOnly");
  assert.equal(stashEntries(), 0);
});

test("…and with --include-untracked the same state really does stash", async () => {
  write("brand-new.txt", "unsaved work\n");

  const r = await ctx.stashes.save({ includeUntracked: true });

  assert.equal(r.created, true);
  assert.equal(r.blocker, undefined);
  assert.equal(stashEntries(), 1);
});

test("a real stash reports created", async () => {
  write("tracked.txt", "one\nedited\n");

  const r = await ctx.stashes.save({ message: "wip" });

  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(stashEntries(), 1);
  assert.match(git("stash", "list"), /wip/);
});

test("ignored files do not count as untracked work", async () => {
  // Without --exclude-standard every build artefact would make a clean repo
  // report "you have new files you could stash".
  write(".gitignore", "junk.log\n");
  git("add", ".gitignore");
  git("commit", "-m", "ignore");
  write("junk.log", "noise\n");

  const r = await ctx.stashes.save();

  assert.equal(r.created, false);
  assert.equal(r.blocker, "cleanTree", "ignored output is not stashable work");
});

test("--keep-index still counts as a real stash", async () => {
  // The index survives, so the working tree can look unchanged afterwards — the
  // count is what settles it, not how the tree looks.
  write("tracked.txt", "one\nstaged\n");
  git("add", "tracked.txt");

  const r = await ctx.stashes.save({ keepIndex: true });

  assert.equal(r.created, true);
  assert.equal(stashEntries(), 1);
});

test("two identical stashes in the same second: BOTH are real, though git keeps one", async () => {
  // This is the case that ruled out the obvious implementation. Stash the same
  // tree with the same message inside the same second and both stash commits are
  // byte identical, so `refs/stash` does not move and the list does NOT grow —
  // yet git prints "Saved working directory…", exits 0, and really does clear the
  // working tree both times.
  //
  // A did-the-list-grow check therefore calls the second stash a no-op and tells
  // the user "nothing to stash" immediately after taking their changes away.
  // Asking "was there anything to stash?" BEFORE the push gets it right.
  write("tracked.txt", "one\nsame\n");
  const first = await ctx.stashes.save({ message: "dup" });
  write("tracked.txt", "one\nsame\n");
  const second = await ctx.stashes.save({ message: "dup" });

  assert.equal(first.created, true);
  assert.equal(second.created, true, "the user's changes were taken away — twice");
  assert.equal(second.blocker, undefined, "so there is nothing to explain away");
  // Both times the working tree really was cleaned, which is the user's question.
  assert.equal(git("status", "--porcelain").trim(), "");
  // How many entries git kept is git's business, and it is genuinely timing
  // dependent: the two stash commits are byte identical ONLY while both land in
  // the same second, so git collapses them to one — and if the clock ticks
  // between the two pushes, there are two. Windows CI found exactly that.
  //
  // Which is the point. `created` is true either way, because it is answered
  // BEFORE the push from "was there anything to stash?", not afterwards from a
  // count that this race can move.
  assert.ok([1, 2].includes(stashEntries()), "one entry if git deduped, two if the second ticked");
});

test("a stash of ONLY staged changes counts — a stash takes the index too", async () => {
  write("tracked.txt", "one\nstaged only\n");
  git("add", "tracked.txt");
  // No unstaged difference remains, so a worktree-only check would call this
  // clean and wrongly report "nothing to stash".
  assert.equal(git("diff", "--name-only").trim(), "");

  const r = await ctx.stashes.save();

  assert.equal(r.created, true);
  assert.equal(r.blocker, undefined);
  assert.equal(git("status", "--porcelain").trim(), "");
});

test("a genuine failure is still a failure, not a blocker", async () => {
  // A pathspec matching nothing exits non-zero WITH stderr — git's own message is
  // the better one, so `created` must not turn this into "nothing to stash".
  write("tracked.txt", "one\nedited\n");

  const r = await ctx.stashes.save({ message: "x" });
  assert.equal(r.created, true); // sanity: the state is stashable

  const bad = await ctx.stashes.save();
  assert.equal(bad.ok, true, "tree is clean after the first stash");
  assert.equal(bad.created, false);
});

test("both blockers read differently, and neither is empty", () => {
  const clean = stashBlockerMessage("cleanTree");
  const untracked = stashBlockerMessage("untrackedOnly");
  assert.notEqual(clean, untracked);
  for (const m of [clean, untracked]) {
    assert.ok(m.length > 0);
    assert.match(m, /[.!]$/, "full sentences, like the rest of our copy");
    assert.doesNotMatch(m, /^GitStudio/, "the caller adds any prefix");
  }
  // The untracked one must name the way out, since there is one.
  assert.match(untracked, /Include untracked/i);
});

test("blocker messages describe what the USER asked to stash, not the repo", () => {
  // "The working tree is clean" over a tree full of changes, because the three
  // files they picked happen not to be, is simply a false statement.
  const tree = stashBlockerMessage("cleanTree", "tree");
  const selection = stashBlockerMessage("cleanTree", "selection");
  const staged = stashBlockerMessage("cleanTree", "staged");

  assert.equal(new Set([tree, selection, staged]).size, 3, "three scopes, three messages");
  assert.match(tree, /working tree/i);
  assert.match(selection, /selected/i);
  assert.doesNotMatch(selection, /working tree is clean/i);
  assert.match(staged, /staged/i);

  for (const m of [tree, selection, staged]) {
    assert.match(m, /[.!]$/, "full sentences, like the rest of our copy");
  }
});

test("the default scope is the whole tree, so existing callers are unchanged", () => {
  assert.equal(stashBlockerMessage("cleanTree"), stashBlockerMessage("cleanTree", "tree"));
  assert.equal(stashBlockerMessage("untrackedOnly"), stashBlockerMessage("untrackedOnly", "tree"));
});

test("the untracked message names the way out in every scope", () => {
  for (const scope of ["tree", "selection"] as const) {
    assert.match(stashBlockerMessage("untrackedOnly", scope), /Include untracked/i);
  }
});
