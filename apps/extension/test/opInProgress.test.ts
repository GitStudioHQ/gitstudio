import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pausedForUser as isPaused,
  type OperationMarker,
} from "../src/git/pausedForUser";

// A cherry-pick, revert, merge or rebase that stops to ask the user is NOT a
// failure, but git says so only in prose — and prose is localised.
//
// A user on a Russian locale cherry-picked a commit whose change was already on
// the branch. Git paused and explained (in Russian) that the pick was now empty
// and offered --skip. Our /conflict/i test did not match, so a routine outcome
// was shown as "Cherry-pick failed" AND filed as a crash report.
//
// The marker refs are the locale-independent answer: git writes CHERRY_PICK_HEAD
// / REVERT_HEAD / MERGE_HEAD / REBASE_HEAD while an operation is paused, and
// `rev-parse --verify --quiet` exits 0 only then. These tests pin that contract
// against real git, because it is git's behaviour we are relying on, not ours.
//
// Merge and rebase (issue #9) need the pinning MORE than cherry-pick did, not
// less: for them exit code 1 is genuinely ambiguous. `git merge nosuchref` and a
// rebase refused over a dirty tree both exit 1 without pausing, so the marker is
// the only thing keeping those two on the error path. The last four tests cover
// exactly that.

// Hermetic git, for the reason packages/git-service/test/hermetic.ts spells out:
// against a developer's real global config, git inherits LFS filters, hooks, and
// — the actual culprit behind an intermittent ENOTEMPTY teardown flake — a trace2
// listener that writes to the repo asynchronously AFTER the foreground command
// exits, racing rmSync.
//
// That matters more than usual here: both release workflows run the repo-root
// `npm test` on four operating systems, so a flake in this file fails a DESKTOP
// build leg and strands the release as a draft. This file is the extension
// workspace's only test that shells out to git, so it carries the guard itself
// rather than changing the workspace-wide test script.
const HERMETIC_CFG = join(mkdtempSync(join(tmpdir(), "gs-op-cfg-")), "config");
writeFileSync(HERMETIC_CFG, "");

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: HERMETIC_CFG,
  GIT_CONFIG_SYSTEM: HERMETIC_CFG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TRACE2: undefined,
  GIT_TRACE2_EVENT: undefined,
  GIT_TRACE2_PERF: undefined,
};

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number };
    return { code: err.status ?? 1, out: "" };
  }
}

/** Teardown must never fail the run — a slow background writer is not a bug. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* the OS tmpdir gets swept anyway */
  }
}

/**
 * The SHIPPED predicate — exit code 1 AND the marker ref — driven against real
 * git in a real repo. Imported rather than reimplemented: a local copy would
 * keep passing after the source drifted away from it, which is the one failure
 * this file exists to prevent.
 */
function pausedForUser(
  cwd: string,
  code: number,
  marker: OperationMarker,
): Promise<boolean> {
  return isPaused({ run: async (args) => git(cwd, ...args) }, code, marker);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gs-op-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "f.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("an empty cherry-pick reads as paused, not failed", async () => {
  const dir = repo();
  try {
    git(dir, "checkout", "-qb", "side");
    writeFileSync(join(dir, "g.txt"), "change\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "add g");
    const sha = git(dir, "rev-parse", "HEAD").out.trim();
    git(dir, "checkout", "-q", "main");
    // Same content lands on main independently, so the pick becomes empty.
    writeFileSync(join(dir, "g.txt"), "change\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "same change");

    const r = git(dir, "cherry-pick", sha);
    assert.equal(r.code, 1, "a pause is exit 1");
    assert.equal(
      await pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"),
      true,
      "this is the case that was misreported as a crash on a non-English locale",
    );
  } finally {
    cleanup(dir);
  }
});

test("a conflicting cherry-pick reads as paused", async () => {
  const dir = repo();
  try {
    git(dir, "checkout", "-qb", "side");
    writeFileSync(join(dir, "f.txt"), "SIDE\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "side edit");
    const sha = git(dir, "rev-parse", "HEAD").out.trim();
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "f.txt"), "MAIN\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "main edit");

    const r = git(dir, "cherry-pick", sha);
    assert.equal(r.code, 1, "a pause is exit 1");
    assert.equal(await pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"), true);
  } finally {
    cleanup(dir);
  }
});

test("a genuine cherry-pick failure is NOT paused, so it still reports", async () => {
  const dir = repo();
  try {
    const r = git(dir, "cherry-pick", "deadbeef".repeat(5));
    assert.equal(r.code, 128, "a refusal is exit 128");
    assert.equal(
      await pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"),
      false,
      "a bad revision is a real failure and must keep reaching the error path",
    );
  } finally {
    cleanup(dir);
  }
});

test("a pick REFUSED because one is already paused is not treated as paused", async () => {
  // The marker alone gets this wrong. With a pick already paused, starting
  // another one makes git refuse — but CHERRY_PICK_HEAD is still present, still
  // pointing at the EARLIER commit. Reading only the marker would announce that
  // the commit you just picked "needs a decision", naming a commit git never
  // touched, and swallow the real reason ("you have unmerged files").
  const dir = repo();
  try {
    git(dir, "checkout", "-qb", "side");
    writeFileSync(join(dir, "f.txt"), "SIDE\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "side edit");
    const first = git(dir, "rev-parse", "HEAD").out.trim();
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "f.txt"), "MAIN\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "main edit");
    writeFileSync(join(dir, "h.txt"), "unrelated\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "unrelated");
    const second = git(dir, "rev-parse", "HEAD").out.trim();

    assert.equal(git(dir, "cherry-pick", first).code, 1, "first pick pauses");

    const r = git(dir, "cherry-pick", second);
    assert.equal(r.code, 128, "git REFUSES while unmerged files exist");
    assert.equal(
      git(dir, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD").code,
      0,
      "the stale marker is still there — which is exactly the trap",
    );
    assert.equal(
      await pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"),
      false,
      "must fall through to the real error so git's reason reaches the user",
    );
  } finally {
    cleanup(dir);
  }
});

test("a conflicting revert reads as paused, and a clean repo does not", async () => {
  const dir = repo();
  try {
    assert.equal(await pausedForUser(dir, 1, "REVERT_HEAD"), false, "nothing in progress yet");

    writeFileSync(join(dir, "f.txt"), "second\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "second");
    const target = git(dir, "rev-parse", "HEAD").out.trim();
    writeFileSync(join(dir, "f.txt"), "third\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "third");

    const r = git(dir, "revert", "--no-edit", target);
    assert.equal(r.code, 1, "a pause is exit 1");
    assert.equal(await pausedForUser(dir, r.code, "REVERT_HEAD"), true);
  } finally {
    cleanup(dir);
  }
});

// ── Merge / rebase (issue #9) ────────────────────────────────────────────────
//
// branchActions.ts used to read `/conflict/i` off stderr for these two. Same
// defect as the cherry-pick one, and the same fix — but the exit codes here are
// messier than cherry-pick's clean 1-vs-128 split, which is why each case below
// asserts the raw code as well as the verdict.

/** A repo whose `side` branch conflicts with `main` on f.txt, HEAD on main. */
function diverged(): string {
  const dir = repo();
  git(dir, "checkout", "-qb", "side");
  writeFileSync(join(dir, "f.txt"), "SIDE\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "side edit");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "f.txt"), "MAIN\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "main edit");
  return dir;
}

test("a conflicting merge reads as paused, not failed", async () => {
  const dir = diverged();
  try {
    assert.equal(await pausedForUser(dir, 1, "MERGE_HEAD"), false, "nothing in progress yet");

    const r = git(dir, "merge", "side");
    assert.equal(r.code, 1, "a pause is exit 1");
    assert.equal(
      await pausedForUser(dir, r.code, "MERGE_HEAD"),
      true,
      "the user must get 'resolve, then continue or abort', not raw stderr",
    );
  } finally {
    cleanup(dir);
  }
});

test("a merge REFUSED is not paused — including the exit-1 refusals", async () => {
  // The case that makes merge harder than cherry-pick: git exits 1 for an
  // unknown ref too, so the exit code ALONE would call it a conflict and tell
  // the user to go resolve something that was never started.
  const dir = diverged();
  try {
    const unknown = git(dir, "merge", "nosuchref");
    assert.equal(unknown.code, 1, "git exits 1 here as well — the trap");
    assert.equal(
      await pausedForUser(dir, unknown.code, "MERGE_HEAD"),
      false,
      "no MERGE_HEAD means nothing paused, whatever the exit code says",
    );

    // A merge onto a dirty tree: a third exit code again (2), still a refusal.
    writeFileSync(join(dir, "f.txt"), "uncommitted\n");
    const dirty = git(dir, "merge", "side");
    assert.notEqual(dirty.code, 0, "git refuses to merge over local changes");
    assert.equal(await pausedForUser(dir, dirty.code, "MERGE_HEAD"), false);
    git(dir, "checkout", "--", ".");

    // And the stale-marker trap: with a merge already paused, a second one is
    // refused while MERGE_HEAD still stands from the first.
    assert.equal(git(dir, "merge", "side").code, 1, "first merge pauses");
    const second = git(dir, "merge", "side");
    assert.notEqual(second.code, 1, "git REFUSES while a merge is in progress");
    assert.equal(
      git(dir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD").code,
      0,
      "the stale marker is still there — which is exactly the trap",
    );
    assert.equal(
      await pausedForUser(dir, second.code, "MERGE_HEAD"),
      false,
      "must fall through so git's real reason reaches the user",
    );
  } finally {
    cleanup(dir);
  }
});

test("a conflicting rebase reads as paused, not failed", async () => {
  const dir = diverged();
  try {
    assert.equal(await pausedForUser(dir, 1, "REBASE_HEAD"), false, "nothing in progress yet");

    const r = git(dir, "rebase", "side");
    assert.equal(r.code, 1, "a pause is exit 1");
    assert.equal(await pausedForUser(dir, r.code, "REBASE_HEAD"), true);
  } finally {
    cleanup(dir);
  }
});

test("a rebase REFUSED is not paused, and a clean one leaves no marker", async () => {
  const dir = diverged();
  try {
    // Unstaged changes: git refuses with exit 1 — again, the code alone lies.
    writeFileSync(join(dir, "f.txt"), "uncommitted\n");
    const dirty = git(dir, "rebase", "side");
    assert.equal(dirty.code, 1, "a refusal that exits 1 — the trap");
    assert.equal(
      await pausedForUser(dir, dirty.code, "REBASE_HEAD"),
      false,
      "no REBASE_HEAD means nothing paused",
    );
    git(dir, "checkout", "--", ".");

    // A rebase that succeeds must leave nothing behind that a LATER failed
    // operation could mistake for its own pause.
    git(dir, "checkout", "-qb", "clean", "main");
    writeFileSync(join(dir, "unrelated.txt"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "unrelated");
    const ok = git(dir, "rebase", "main");
    assert.equal(ok.code, 0, "a clean rebase succeeds");
    assert.equal(
      git(dir, "rev-parse", "--verify", "--quiet", "REBASE_HEAD").code,
      1,
      "no marker survives a completed rebase",
    );
  } finally {
    cleanup(dir);
  }
});
