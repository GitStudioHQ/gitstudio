import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebaseInProgress, type RebaseStateRunner } from "../src/rebaseInProgress";
import { readRewritableChain } from "../src/rebaseChain";
import { GitProcess } from "../src/GitProcess";
import { makeRepo, seqEditor, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// "Is a rebase in progress?" is answered by git's state directories, never by
// REBASE_HEAD — and a `git am` (rebase-apply WITH the `applying` marker) is not
// a rebase.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

/** A runner that answers `rev-parse --git-path <dir>` from a table, relative to `cwd`. */
function runner(cwd: string, answers: Record<string, { code: number; stdout: string }>): RebaseStateRunner {
  return {
    cwd,
    run: async (args) => answers[args[args.length - 1]] ?? { code: 128, stdout: "" },
  };
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gs-rip-"));
  cleanup.push(() => removeTempRepo(dir));
  return dir;
}

test("no state directory: not in progress, even when git cannot answer for either path", async () => {
  const dir = scratch();
  assert.equal(await rebaseInProgress(runner(dir, {})), false);
  assert.equal(
    await rebaseInProgress(
      runner(dir, {
        "rebase-merge": { code: 0, stdout: ".git/rebase-merge\n" },
        "rebase-apply": { code: 0, stdout: ".git/rebase-apply\n" },
      }),
    ),
    false,
    "the paths git names do not exist",
  );
});

test("a FILE where the state directory would be is not a rebase", async () => {
  const dir = scratch();
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "rebase-merge"), "not a directory");
  const r = runner(dir, { "rebase-merge": { code: 0, stdout: ".git/rebase-merge" } });
  assert.equal(await rebaseInProgress(r), false);
});

test("rebase-apply without the applying marker is a rebase; with it, it is a git am", async () => {
  const dir = scratch();
  mkdirSync(join(dir, ".git", "rebase-apply"), { recursive: true });
  const r = runner(dir, { "rebase-apply": { code: 0, stdout: ".git/rebase-apply\n" } });
  assert.equal(await rebaseInProgress(r), true, "an apply-backend rebase");
  writeFileSync(join(dir, ".git", "rebase-apply", "applying"), "");
  assert.equal(await rebaseInProgress(r), false, "a mailbox being applied is not a rebase");
});

test("an absolute path from git (a linked worktree's answer) is used as is", async () => {
  const dir = scratch();
  const elsewhere = join(dir, "common", "worktrees", "wt", "rebase-merge");
  mkdirSync(elsewhere, { recursive: true });
  const r = runner(join(dir, "wt"), { "rebase-merge": { code: 0, stdout: `${elsewhere}\n` } });
  assert.equal(await rebaseInProgress(r), true);
});

test("against real git: a rebase stopped on an edit is in progress, and a finished one is not", async () => {
  const repo: Repo = makeRepo("rip-real");
  cleanup.push(() => repo.cleanup());
  repo.write("a.txt", "a\n");
  repo.commitAll("one");
  repo.write("a.txt", "b\n");
  repo.commitAll("two");
  const proc = new GitProcess({ cwd: repo.root });
  cleanup.push(() => proc.dispose());
  assert.equal(await rebaseInProgress(proc), false);
  const r = repo.gitEnv({ GIT_SEQUENCE_EDITOR: seqEditor(repo, `t=t.replace(/^pick/m,"edit")`) }, "rebase", "-i", "HEAD~1");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await rebaseInProgress(proc), true, "stopped on the edit");
  repo.git("rebase", "--continue");
  assert.equal(await rebaseInProgress(proc), false, "finished — whatever REBASE_HEAD says");
});

test("readRewritableChain: a repository with no commits has nothing to reorder", async () => {
  const repo = makeRepo("chain-empty");
  cleanup.push(() => repo.cleanup());
  const proc = new GitProcess({ cwd: repo.root });
  cleanup.push(() => proc.dispose());
  assert.deepEqual(await readRewritableChain(proc), { shas: [], stop: "root" });
});

test("readRewritableChain: maxCount caps how far back the chain reaches, newest first", async () => {
  const repo = makeRepo("chain-cap");
  cleanup.push(() => repo.cleanup());
  const shas: string[] = [];
  for (const n of ["1", "2", "3", "4"]) {
    repo.write("f.txt", `${n}\n`);
    shas.push(repo.commitAll(`c${n}`));
  }
  const proc = new GitProcess({ cwd: repo.root });
  cleanup.push(() => proc.dispose());
  const full = await readRewritableChain(proc);
  assert.deepEqual(full.shas, [...shas].reverse());
  const capped = await readRewritableChain(proc, { maxCount: 2 });
  assert.deepEqual(capped.shas, [shas[3], shas[2]]);
  // A non-positive cap is no cap.
  assert.deepEqual((await readRewritableChain(proc, { maxCount: 0 })).shas, full.shas);
});
