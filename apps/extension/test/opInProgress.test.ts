import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A cherry-pick or revert that stops to ask the user is NOT a failure, but git
// says so only in prose — and prose is localised.
//
// A user on a Russian locale cherry-picked a commit whose change was already on
// the branch. Git paused and explained (in Russian) that the pick was now empty
// and offered --skip. Our /conflict/i test did not match, so a routine outcome
// was shown as "Cherry-pick failed" AND filed as a crash report.
//
// The marker refs are the locale-independent answer: git writes CHERRY_PICK_HEAD
// / REVERT_HEAD while an operation is paused, and `rev-parse --verify --quiet`
// exits 0 only then. These tests pin that contract against real git, because it
// is git's behaviour we are relying on, not ours.

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
 * Exactly what commitActions.ts's pausedForUser() decides: exit code 1 AND the
 * marker ref. Both conditions matter — see the "already paused" test below.
 */
function pausedForUser(cwd: string, code: number, marker: string): boolean {
  if (code !== 1) return false;
  return git(cwd, "rev-parse", "--verify", "--quiet", marker).code === 0;
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

test("an empty cherry-pick reads as paused, not failed", () => {
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
      pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"),
      true,
      "this is the case that was misreported as a crash on a non-English locale",
    );
  } finally {
    cleanup(dir);
  }
});

test("a conflicting cherry-pick reads as paused", () => {
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
    assert.equal(pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"), true);
  } finally {
    cleanup(dir);
  }
});

test("a genuine cherry-pick failure is NOT paused, so it still reports", () => {
  const dir = repo();
  try {
    const r = git(dir, "cherry-pick", "deadbeef".repeat(5));
    assert.equal(r.code, 128, "a refusal is exit 128");
    assert.equal(
      pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"),
      false,
      "a bad revision is a real failure and must keep reaching the error path",
    );
  } finally {
    cleanup(dir);
  }
});

test("a pick REFUSED because one is already paused is not treated as paused", () => {
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
      pausedForUser(dir, r.code, "CHERRY_PICK_HEAD"),
      false,
      "must fall through to the real error so git's reason reaches the user",
    );
  } finally {
    cleanup(dir);
  }
});

test("a conflicting revert reads as paused, and a clean repo does not", () => {
  const dir = repo();
  try {
    assert.equal(pausedForUser(dir, 1, "REVERT_HEAD"), false, "nothing in progress yet");

    writeFileSync(join(dir, "f.txt"), "second\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "second");
    const target = git(dir, "rev-parse", "HEAD").out.trim();
    writeFileSync(join(dir, "f.txt"), "third\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "third");

    const r = git(dir, "revert", "--no-edit", target);
    assert.equal(r.code, 1, "a pause is exit 1");
    assert.equal(pausedForUser(dir, r.code, "REVERT_HEAD"), true);
  } finally {
    cleanup(dir);
  }
});
