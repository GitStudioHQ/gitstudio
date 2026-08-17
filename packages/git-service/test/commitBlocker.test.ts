import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { commitBlockerMessage } from "../src/StagingProvider";

// `git commit` with nothing staged is the one refusal that says NOTHING on
// stderr. It exits 1 and writes its explanation to STDOUT, so the Changes view
// showed an error dialog with no text in it (issue #16).
//
// These tests pin both halves against real git: that commit() really does come
// back ok:false with an empty stderr and a non-empty stdout, and that
// whyNothingToCommit() tells the three situations apart WITHOUT reading a word
// of git's prose — the reporter could just as easily have been on a translated
// git, where any English matching would have produced the wrong message.

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-blocker-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  write("tracked.txt", "one\ntwo\nthree\n");
  git("add", "tracked.txt");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("the reported bug: a refused commit carries NO stderr, only stdout", async () => {
  write("tracked.txt", "one\nEDITED\nthree\n"); // changed but not staged

  const r = await ctx.staging.commit("a message");

  assert.equal(r.ok, false, "git refuses when nothing is staged");
  assert.equal(r.stderr.trim(), "", "…and says nothing on stderr — the whole bug");
  assert.ok(
    r.stdout.trim().length > 0,
    "the reason is on stdout, which we used to discard",
  );
});

test("unstaged tracked edits are told apart from a clean tree", async () => {
  write("tracked.txt", "one\nEDITED\nthree\n");
  assert.equal(await ctx.staging.whyNothingToCommit(), "unstagedChanges");
});

test("a clean tree reads as clean", async () => {
  assert.equal(await ctx.staging.whyNothingToCommit(), "cleanTree");
});

test("untracked-only is its own case, not 'unstaged changes'", async () => {
  // Worth separating: "stage your changes" is confusing advice when the only
  // thing there is a file git has never heard of.
  write("brand-new.txt", "hello\n");
  assert.equal(await ctx.staging.whyNothingToCommit(), "untrackedOnly");
});

test("ignored files are not mistaken for stageable changes", async () => {
  // Without --exclude-standard every build artefact would count, so a genuinely
  // clean repo with a dist/ folder would be told it has changes to stage.
  write(".gitignore", "ignored.log\n");
  git("add", ".gitignore");
  git("commit", "-m", "ignore");
  write("ignored.log", "noise\n");
  assert.equal(await ctx.staging.whyNothingToCommit(), "cleanTree");
});

test("tracked edits win over untracked files when both are present", async () => {
  // The advice that matters is about the edits; mentioning the new file instead
  // would send the user looking in the wrong place.
  write("tracked.txt", "one\nEDITED\nthree\n");
  write("brand-new.txt", "hello\n");
  assert.equal(await ctx.staging.whyNothingToCommit(), "unstagedChanges");
});

test("something staged means the failure is NOT ours to explain", async () => {
  // The guard that keeps this from hijacking real failures: with a staged
  // change, a failed commit is a rejecting hook or a bad signing key, and git's
  // own stderr is the better message.
  write("tracked.txt", "one\nEDITED\nthree\n");
  git("add", "tracked.txt");
  assert.equal(
    await ctx.staging.whyNothingToCommit(),
    undefined,
    "must fall through so git's real reason reaches the user",
  );
});

test("a staged deletion still counts as staged", async () => {
  // `diff --cached --name-only` reports deletions, so this must not read as an
  // empty index and get explained away as "nothing staged".
  git("rm", "-q", "tracked.txt");
  assert.equal(await ctx.staging.whyNothingToCommit(), undefined);
  const r = await ctx.staging.commit("remove it");
  assert.equal(r.ok, true, "and the commit itself succeeds");
});

test("an amend with nothing staged is a real commit, not a blocked one", async () => {
  // Amending only the message is legitimate with an empty index — the fix must
  // not start explaining "nothing is staged" over a working amend.
  const r = await ctx.staging.commit("reworded", { amend: true });
  assert.equal(r.ok, true);
  assert.match(git("log", "-1", "--pretty=%s"), /reworded/);
});

test("every blocker has a message that names a next step", () => {
  const messages = [
    commitBlockerMessage("unstagedChanges"),
    commitBlockerMessage("untrackedOnly"),
    commitBlockerMessage("cleanTree"),
  ];
  for (const m of messages) {
    assert.ok(m.length > 0, "no blocker may produce an empty string — the bug");
    assert.match(m, /[.!]$/, "full sentences, like the rest of our copy");
  }
  assert.equal(new Set(messages).size, 3, "each situation reads differently");
  // No "GitStudio: " prefix here — the extension adds it because it is a guest
  // in another editor; the desktop app must not say its own name back at you.
  for (const m of messages) {
    assert.doesNotMatch(m, /^GitStudio/);
  }
});
