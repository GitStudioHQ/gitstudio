// The operation reads fail CLOSED: a listing git could not produce (a locked
// or corrupt index, a git killed mid-answer) is never "nothing unmerged",
// "no markers staged" or "nothing unstaged" — any of which would offer
// Continue over files that are still conflicted. Real stopped repositories,
// driven through a GitProcess that fails the one command under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationProvider } from "../src/OperationProvider";
import { FIVE, edit } from "./opRepo";
import * as S from "./opScenarios";
import { routedProc, starts } from "./syncOps.fixture";

test("an unmerged listing git could not produce is an error, not 'nothing unmerged'", async () => {
  const s = S.mergeStop();
  try {
    const ctx = s.r.ctx();
    const withReason = new OperationProvider(
      routedProc(ctx.process, (a) => (starts(a, "ls-files", "-u") ? { code: 128, stderr: "fatal: index file corrupt" } : undefined)),
      s.r.root,
    );
    await assert.rejects(withReason.detect(), /index file corrupt/);
    await assert.rejects(withReason.inspect(), /index file corrupt/);
    await assert.rejects(withReason.continue(), /index file corrupt/, "no Continue is decided on an unknown");

    const silent = new OperationProvider(
      routedProc(ctx.process, (a) => (starts(a, "ls-files", "-u") ? { code: 141 } : undefined)),
      s.r.root,
    );
    await assert.rejects(silent.detect(), /ls-files -u failed \(141\), so the unmerged files are unknown/);
  } finally {
    s.r.cleanup();
  }
});

test("a git-path answer that is cut short is not trusted: nothing is claimed stopped", async () => {
  const s = S.mergeStop();
  try {
    const ctx = s.r.ctx();
    const short = new OperationProvider(
      routedProc(ctx.process, (a) =>
        starts(a, "rev-parse", "--git-path") && a.length > 3 ? { stdout: ".git/MERGE_HEAD\n" } : undefined,
      ),
      s.r.root,
    );
    assert.deepEqual(await short.detect(), { kind: "none", unmerged: 0 });
    assert.equal((await short.inspect()).view.kind, "none");
    await assert.rejects(short.markers(), /git rev-parse --git-path failed \(0\)/);
  } finally {
    s.r.cleanup();
  }
});

test("gitPath rejects with a sentence even when git says nothing", async () => {
  const s = S.cleanRepo();
  try {
    const op = new OperationProvider(
      routedProc(s.r.ctx().process, (a) => (starts(a, "rev-parse", "--git-path") ? { code: 128 } : undefined)),
      s.r.root,
    );
    await assert.rejects(op.gitPath("MERGE_HEAD"), /git rev-parse --git-path MERGE_HEAD failed \(128\)\./);
  } finally {
    s.r.cleanup();
  }
});

test("the staged-markers gate fails closed when either of its git reads fails", async () => {
  const s = S.mergeStop();
  try {
    s.r.write("f.txt", edit(FIVE, { three: "three-merged", five: "five-merged" }));
    s.r.git("add", "f.txt");
    const ctx = s.r.ctx();
    assert.deepEqual(await ctx.operation.stagedMarkerFiles(), [], "fixture: resolved cleanly");

    const undoFails = new OperationProvider(
      routedProc(ctx.process, (a) => (a.includes("--resolve-undo") ? { code: 128 } : undefined)),
      s.r.root,
    );
    await assert.rejects(undoFails.stagedMarkerFiles(), /ls-files --resolve-undo failed \(128\)/);
    await assert.rejects(undoFails.view(), /resolve-undo/, "the view is not computed over an unknown gate");

    const checkDies = new OperationProvider(
      routedProc(ctx.process, (a) => (a.includes("--check") ? { code: 129 } : undefined)),
      s.r.root,
    );
    await assert.rejects(checkDies.stagedMarkerFiles(), /diff --cached --check failed \(129\)/);
    const checkSays = new OperationProvider(
      routedProc(ctx.process, (a) => (a.includes("--check") ? { code: 128, stderr: "fatal: unable to read tree" } : undefined)),
      s.r.root,
    );
    await assert.rejects(checkSays.stagedMarkerFiles(), /unable to read tree/, "git's own words when it has some");
  } finally {
    s.r.cleanup();
  }
});

test("the unstaged-changes gate of a rebase fails closed when git cannot list them", async () => {
  const s = S.rebaseMergeStop();
  try {
    s.r.git("checkout", "--theirs", "f.txt");
    s.r.git("add", "f.txt");
    const ctx = s.r.ctx();
    assert.equal((await ctx.operation.view()).canContinue, true, "fixture: nothing blocks Continue");
    const unknown = (stderr: string) =>
      new OperationProvider(
        routedProc(ctx.process, (a) => (starts(a, "diff", "--name-only", "-z", "--ignore-submodules") ? { code: 128, stderr } : undefined)),
        s.r.root,
      );
    await assert.rejects(unknown("fatal: index.lock exists").view(), /index\.lock exists/);
    await assert.rejects(unknown("").view(), /git diff --name-only failed \(128\)/);
  } finally {
    s.r.cleanup();
  }
});

test("an abort git refuses without a word is reported with its exit code, and nothing is claimed aborted", async () => {
  const s = S.mergeStop();
  try {
    const ctx = s.r.ctx();
    const op = new OperationProvider(
      routedProc(ctx.process, (a) => (starts(a, "merge", "--abort") ? { code: 1 } : undefined)),
      s.r.root,
    );
    const out = await op.abort({});
    assert.equal(out.ok, false);
    assert.equal(out.message, "git exited with code 1.");
    assert.equal(out.expected, undefined, "a failed abort is ours to hear about");
    assert.equal(out.view.kind, "merge", "still merging");
    assert.equal(out.remainingConflicts, 1);
  } finally {
    s.r.cleanup();
  }
});
