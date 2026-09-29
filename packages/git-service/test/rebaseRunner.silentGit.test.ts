// The runner's words when git gives it none: a git binary that cannot be
// started at all, and a git whose `rebase` fails without printing anything.
// Every outcome still carries a sentence the user can read — never an empty
// message — and the observer hears each attempt exactly once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortRebase,
  continueRebase,
  isRebaseInProgress,
  runRebasePlan,
  skipRebase,
  type RebaseRunOptions,
} from "../src/RebaseRunner";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

function threeCommits(name: string): { r: Repo; sha: Record<string, string> } {
  const r = makeRepo(name);
  const sha: Record<string, string> = {};
  for (const n of ["base", "one", "two"]) {
    r.write(`${n}.txt`, `${n}\n`);
    sha[n] = r.commitAll(n);
  }
  return { r, sha };
}

test("a git that cannot be started fails the run with the spawn error, observed once per attempt", async () => {
  const { r, sha } = threeCommits("nogit");
  try {
    const events: Parameters<NonNullable<RebaseRunOptions["onRun"]>>[0][] = [];
    const gitPath = join(tmpdir(), "gs-no-such-git-binary", "git");
    const out = await runRebasePlan(
      r.root,
      { base: sha.base, todo: `pick ${sha.one} one\npick ${sha.two} two\n`, rewords: [] },
      { gitPath, onRun: (e) => events.push(e) },
    );
    assert.equal(out.status, "failed");
    assert.match(out.status === "failed" ? out.message : "", /ENOENT/, "the reason it could not start");
    assert.equal(r.sha("HEAD"), sha.two, "nothing moved");
    // 'error' and 'close' both fire for a failed spawn; each attempt is
    // reported once, never twice.
    const rebaseRuns = events.filter((e) => e.args.includes("rebase"));
    assert.equal(rebaseRuns.length, 1);
    assert.equal(rebaseRuns[0].exitCode, null);
    assert.equal(rebaseRuns[0].failed, true);
    assert.ok(events.every((e) => e.failed && e.exitCode === null), "every attempt failed to start, and said so");
  } finally {
    r.cleanup();
  }
});

/**
 * A `git` that runs the real one but, for `rebase`, throws its output away and
 * exits 1 — git failing without a word. A shell script, so POSIX only.
 */
function silentRebaseGit(): { gitPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-silent-git-"));
  const gitPath = join(dir, "git");
  writeFileSync(
    gitPath,
    '#!/bin/sh\ncase " $* " in\n  *" rebase "*) git "$@" >/dev/null 2>&1; exit 1 ;;\nesac\nexec git "$@"\n',
  );
  chmodSync(gitPath, 0o755);
  return { gitPath, dir };
}

const posixOnly = process.platform === "win32" ? "a shell-script git does not run on Windows" : false;

test("a rebase that stops without a word is still reported with a sentence", { skip: posixOnly }, async () => {
  const { r, sha } = threeCommits("silent-stop");
  const fake = silentRebaseGit();
  try {
    const opts = { gitPath: fake.gitPath };
    const run = await runRebasePlan(r.root, { base: sha.base, todo: `edit ${sha.one} one\npick ${sha.two} two\n`, rewords: [] }, opts);
    assert.deepEqual(run, { status: "stopped", reason: "unknown", message: "Rebase paused." }, "live, so a stop");
    assert.equal(await isRebaseInProgress(r.root), true);

    // Real git sets the lock aside for skip/continue to fail on; the fake
    // swallows its words, so the runner has only the exit code and the state.
    const lock = join(r.root, ".git", "index.lock");
    writeFileSync(lock, "");
    assert.deepEqual(await continueRebase(r.root, opts), { status: "stopped", reason: "unknown", message: "Rebase paused." });
    assert.deepEqual(await skipRebase(r.root, opts), { status: "stopped", reason: "unknown", message: "Rebase paused." });
    assert.deepEqual(await abortRebase(r.root, opts), { status: "failed", message: "Couldn't abort the rebase." });
    removeTempRepo(lock);
    assert.equal(await isRebaseInProgress(r.root), true, "still the same stop");
  } finally {
    r.git("rebase", "--abort");
    r.cleanup();
    removeTempRepo(fake.dir);
  }
});

test("a rebase that fails without a word, with nothing left in progress, says which verb failed", { skip: posixOnly }, async () => {
  const { r, sha } = threeCommits("silent-fail");
  const fake = silentRebaseGit();
  try {
    const opts = { gitPath: fake.gitPath };
    const run = await runRebasePlan(r.root, { base: sha.base, todo: `pick ${sha.two} two\npick ${sha.one} one\n`, rewords: [] }, opts);
    assert.deepEqual(run, { status: "failed", message: "Rebase failed." });
    assert.deepEqual(await continueRebase(r.root, opts), { status: "failed", message: "Continue failed." });
    assert.deepEqual(await skipRebase(r.root, opts), { status: "failed", message: "Skip failed." });
  } finally {
    r.cleanup();
    removeTempRepo(fake.dir);
  }
});
