// OperationProvider cells the state table does not reach: a folder that is no
// repository, a verb whose commit a hook refuses (merge, and the merge step of
// a --rebase-merges rebase), a rebase that finishes and whose autostash then
// conflicts, the plural wordings of the Continue gates, a stop that lands on a
// pause or on a patch, names read from a pull of a bare URL / a lying merge
// message / a missing MERGE_MSG / the rebased branch's upstream, and a
// per-call rebase runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { GitContext } from "../src/GitContext";
import { mergeLabel, readHead } from "../src/OperationProvider";
import type { RebaseRunOptions } from "../src/RebaseRunner";
import { FIVE, edit, makeRepo, seqEditor, topoRepo, type Repo } from "./opRepo";
import * as S from "./opScenarios";
import { removeTempRepo } from "./tmpRepo";

/** A hook that refuses, first printing git-style advice and then its reason. */
function refusingHook(r: Repo, name: string, reason: string): void {
  const dir = join(r.root, ".git", "hooks");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho 'hint: ask the release manager' >&2\necho '${reason}' >&2\nexit 1\n`);
  chmodSync(p, 0o755);
}

test("a folder that is no repository reads as nothing stopped, and its paths cannot be asked for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-op-norepo-"));
  const ctx = new GitContext({ root: dir });
  try {
    const insp = await ctx.operation.inspect();
    assert.equal(insp.view.kind, "none");
    assert.equal(insp.view.canContinue, false);
    assert.equal(insp.view.canSkip, false);
    assert.equal(insp.view.episode, "none");
    assert.deepEqual(insp.unmerged, []);
    assert.equal(insp.indexMatchesHead, false);
    assert.equal(Object.values(insp.markers).some(Boolean), false, "no marker is claimed");
    assert.deepEqual(await ctx.operation.detect(), { kind: "none", unmerged: 0 });
    await assert.rejects(ctx.operation.markers(), /not a git repository/i);
    await assert.rejects(ctx.operation.gitPath("MERGE_HEAD"), /not a git repository/i);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, false);
    assert.equal(out.refused, "not-allowed");
  } finally {
    ctx.dispose();
    removeTempRepo(dir);
  }
});

test("markers() and gitPath() read the stopped merge's own files", async () => {
  const s = S.mergeStop();
  try {
    const op = s.r.ctx().operation;
    const m = await op.markers();
    assert.equal(m.mergeHead, true);
    assert.equal(m.rebaseMerge, false);
    assert.equal(m.cherryPickHead, false);
    assert.equal(await op.gitPath("MERGE_HEAD"), join(s.r.root, ".git", "MERGE_HEAD"));
  } finally {
    s.r.cleanup();
  }
});

test("a merge Continue whose commit a hook refuses fails with the hook's reason, and the merge is still there", async () => {
  const s = S.mergeStop();
  try {
    s.r.write("f.txt", edit(FIVE, { three: "three-merged", five: "five-merged" }));
    s.r.git("add", "f.txt");
    refusingHook(s.r, "pre-commit", "merge commits are frozen today");
    const out = await s.r.ctx().operation.continue();
    assert.equal(out.ok, false);
    assert.equal(out.message, "merge commits are frozen today", "git's first line that is not a hint");
    assert.equal(out.expected, undefined, "a failed merge commit is reported");
    assert.equal(out.view.kind, "merge", "still merging");
    assert.equal(s.r.sha("HEAD"), s.sha.master, "no commit was made");
  } finally {
    s.r.cleanup();
  }
});

test("a merge step resolved to HEAD whose recording commit a hook refuses fails, with the rebase still stopped there", async () => {
  const s = S.rebaseMergeStepStop();
  try {
    const op = s.r.ctx().operation;
    assert.equal((await op.view()).kind, "rebase-merge-step", "fixture");
    s.r.git("checkout", "--ours", "f.txt");
    s.r.git("add", "f.txt");
    const before = await op.inspect();
    assert.equal(before.indexMatchesHead, true, "fixture: the resolution equals HEAD");
    refusingHook(s.r, "pre-commit", "no merges without review");
    const out = await op.continue();
    assert.equal(out.ok, false);
    assert.equal(out.message, "no merges without review");
    assert.equal(out.expected, true, "a stop that did not move is the user's state");
    assert.equal(out.view.kind, "rebase-merge-step");
    assert.equal(out.view.episode, before.view.episode, "nothing moved");
  } finally {
    s.r.cleanup();
  }
});

test("a rebase that finishes and whose autostash then conflicts says both: done, then the new stop", async () => {
  const r = makeRepo("autostash-after");
  try {
    r.write("f.txt", FIVE);
    r.commitAll("base");
    r.git("checkout", "-q", "-b", "test");
    r.write("f.txt", edit(FIVE, { one: "one-test" }));
    r.commitAll("T: line 1");
    r.git("checkout", "-q", "master");
    r.write("f.txt", edit(FIVE, { one: "one-master", three: "three-master" }));
    r.commitAll("M: lines 1 and 3");
    r.git("checkout", "-q", "test");
    r.write("f.txt", edit(FIVE, { one: "one-test", three: "three-dirty" }));
    r.tryGit("rebase", "--autostash", "master");
    const op = r.ctx().operation;
    assert.equal((await op.view()).kind, "rebase", "fixture: stopped on T");
    r.write("f.txt", edit(FIVE, { one: "one-test", three: "three-master" }));
    r.git("add", "f.txt");

    const out = await op.continue();
    assert.equal(out.ok, false);
    assert.equal(out.stopped, true);
    assert.equal(out.view.kind, "stash", "the autostash's conflict is the new stop");
    assert.equal(out.message, `Rebase complete. Then: ${out.view.title}`);
    assert.equal(out.remainingConflicts, 1);
    assert.ok(r.git("stash", "list").trim().length > 0, "the autostash is kept safe in the stash");
  } finally {
    r.cleanup();
  }
});

test("markers staged in two files: Continue names the first and counts the rest", async () => {
  const r = makeRepo("two-markers");
  try {
    r.write("a.txt", FIVE);
    r.write("b.txt", FIVE);
    r.commitAll("base");
    r.git("checkout", "-q", "-b", "side");
    r.write("a.txt", edit(FIVE, { two: "two-side" }));
    r.write("b.txt", edit(FIVE, { two: "two-side" }));
    r.commitAll("side");
    r.git("checkout", "-q", "master");
    r.write("a.txt", edit(FIVE, { two: "two-master" }));
    r.write("b.txt", edit(FIVE, { two: "two-master" }));
    r.commitAll("master");
    r.tryGit("merge", "side");
    r.git("add", "a.txt", "b.txt"); // markers and all
    const op = r.ctx().operation;
    assert.deepEqual(await op.stagedMarkerFiles(), ["a.txt", "b.txt"]);
    const v = await op.view();
    assert.equal(v.canContinue, false);
    assert.equal(v.continueBlocked, "a.txt and 1 more still have conflict markers staged");
    const out = await op.continue();
    assert.equal(out.refused, "blocked");
    assert.equal(out.message, v.continueBlocked);
  } finally {
    r.cleanup();
  }
});

test("a rebase stop with two unstaged files says they have changes that aren't staged", async () => {
  const s = S.rebaseMergeStop();
  try {
    s.r.git("checkout", "--theirs", "f.txt");
    s.r.git("add", "f.txt");
    s.r.write("f.txt", "edited after staging\n");
    s.r.write("g.txt", "also edited\n");
    const v = await s.r.ctx().operation.view();
    assert.equal(v.canContinue, false);
    assert.equal(
      v.continueBlocked,
      "f.txt and 1 more have changes that aren't staged. Stage or stash them first — git won't continue a rebase with unstaged changes.",
    );
  } finally {
    s.r.cleanup();
  }
});

test("a Continue that lands on the next edit row reports the pause's own words", async () => {
  const r = makeRepo("two-edits");
  try {
    r.write("f.txt", FIVE);
    r.commitAll("base");
    r.git("checkout", "-q", "-b", "test");
    r.write("a.txt", "a\n");
    r.commitAll("A");
    r.write("b.txt", "b\n");
    r.commitAll("B");
    r.gitEnv({ GIT_SEQUENCE_EDITOR: seqEditor(r, `t=t.replace(/^pick /gm,"edit ")`), GIT_EDITOR: "true" }, "rebase", "-i", "master");
    const op = r.ctx().operation;
    const before = await op.view();
    assert.equal(before.pause?.reason, "edit", "fixture: paused at A");
    const out = await op.continue();
    assert.equal(out.ok, false);
    assert.equal(out.stopped, true);
    assert.equal(out.view.pause?.reason, "edit", "paused again, at B");
    assert.equal(out.message, out.view.pause?.detail, "in the pause's words, not 'Stopped at …'");
    assert.notEqual(out.view.episode, before.episode);
  } finally {
    r.cleanup();
  }
});

test("an am Continue that stops at the next patch counts patches and files, with no commit to name", async () => {
  const r = topoRepo("am-next");
  try {
    const patches = join(r.root, ".git", "p-am-next");
    r.git("format-patch", "-q", "-3", "test", "-o", patches);
    const files = readdirSync(patches).sort().map((f) => join(patches, f));
    r.tryGit("am", "-3", ...files);
    const op = r.ctx().operation;
    const first = await op.view();
    assert.equal(first.kind, "am");
    assert.deepEqual(first.step, { n: 2, m: 3, unit: "patch" }, "fixture: patch 2 (line 3) conflicts");
    r.write("f.txt", edit(FIVE, { three: "three-test", five: "five-master" }));
    r.git("add", "f.txt");
    const out = await op.continue();
    assert.equal(out.stopped, true);
    assert.deepEqual(out.view.step, { n: 3, m: 3, unit: "patch" });
    assert.equal(out.message, "Stopped at patch 3 of 3 — 1 file to resolve", "an am patch has no sha to name");
  } finally {
    r.cleanup();
  }
});

test("a merge pulled from a path no remote names reads as the branch from the path's last part", async () => {
  const r = topoRepo("pull-url");
  const src = mkdtempSync(join(tmpdir(), "gs-op-pullsrc-"));
  try {
    r.git("clone", "-q", "--bare", r.root, src);
    r.git("branch", "-D", "test");
    assert.equal(r.git("remote").trim(), "", "fixture: no remote configured at all");
    r.tryGit("pull", "--no-rebase", src, "test");
    const v = await r.ctx().operation.view();
    assert.equal(v.kind, "merge");
    assert.equal(v.theirs.name, `test (from ${basename(src)})`);
  } finally {
    r.cleanup();
    removeTempRepo(src);
  }
});

test("a merge message shaped like a pull is not believed without the fetch to back it", async () => {
  const r = topoRepo("pull-lie");
  try {
    r.tryGit("merge", "-m", "Merge branch 'elsewhere' of /some/where/else", "test");
    assert.equal(r.exists(".git/FETCH_HEAD"), false, "fixture: nothing was ever fetched");
    const v = await r.ctx().operation.view();
    assert.equal(v.theirs.name, "test", "named by the ref at MERGE_HEAD");
  } finally {
    r.cleanup();
  }
});

test("a merge whose MERGE_MSG is gone still names the branch it brings in", async () => {
  const s = S.mergeStop();
  try {
    rmSync(join(s.r.root, ".git", "MERGE_MSG"));
    const v = await s.r.ctx().operation.view();
    assert.equal(v.kind, "merge");
    assert.equal(v.theirs.name, "test");
  } finally {
    s.r.cleanup();
  }
});

test("onto is named by the rebased branch's upstream when the rebase was typed as a sha", async () => {
  const r = topoRepo("onto-upstream");
  try {
    // Two branches at onto: by the refs alone `aaa` would win, alphabetically.
    r.git("branch", "aaa", "master");
    r.git("checkout", "-q", "test");
    r.git("branch", "-q", "--set-upstream-to=master");
    r.tryGit("rebase", r.sha("master"));
    const v = await r.ctx().operation.view();
    assert.equal(v.kind, "rebase");
    assert.equal(v.theirs.name, "master");
  } finally {
    r.cleanup();
  }
});

test("a per-call runner hears the rebase verbs Skip and Abort run", async () => {
  const s = S.rebaseApplyStop();
  try {
    s.r.git("checkout", "--ours", "f.txt");
    s.r.git("add", "f.txt");
    const op = s.r.ctx().operation;
    assert.equal((await op.view()).canSkip, true, "fixture: nothing left of the commit, Skip offered");
    const seen: string[][] = [];
    const runner: RebaseRunOptions = { onRun: (e) => seen.push(e.args) };
    const skipped = await op.skip({ runner });
    assert.ok(seen.some((a) => a.includes("--skip")), "the skip ran through the caller's runner");
    assert.equal(skipped.stopped, true, "and stopped at T3's conflict");

    const aborted = await op.abort({ runner });
    assert.equal(aborted.ok, true);
    assert.equal(aborted.message, "Rebase aborted");
    assert.ok(seen.some((a) => a.includes("--abort")));
    assert.equal(s.r.sha("HEAD"), s.sha.test, "back where the rebase started");
  } finally {
    s.r.cleanup();
  }
});

test("aborting a single cherry-pick puts HEAD back with no caveat", async () => {
  const s = S.cherryPickStop();
  try {
    const out = await s.r.ctx().operation.abort();
    assert.equal(out.ok, true);
    assert.equal(out.message, "Cherry-pick aborted");
    assert.equal(s.r.sha("HEAD"), s.sha.master);
    assert.equal(s.r.exists(".git/CHERRY_PICK_HEAD"), false);
  } finally {
    s.r.cleanup();
  }
});

test("mergeLabel skips option words that are not a commit", () => {
  assert.equal(mergeLabel("merge --edit side # Merge branch 'side'"), "side");
  assert.equal(mergeLabel("merge -C 1234567 --no-ff a b"), "a, b");
});

test("readHead reads only the bytes asked for, and nothing from a file that is not there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-op-readhead-"));
  try {
    const p = join(dir, "big.txt");
    writeFileSync(p, "<<<<<<< Updated upstream\n" + "x".repeat(10_000));
    assert.equal(await readHead(p, 7), "<<<<<<<");
    assert.equal((await readHead(p, 1_000_000))?.length, 25 + 10_000, "a short file is read whole");
    assert.equal(await readHead(join(dir, "missing.txt"), 10), undefined);
  } finally {
    removeTempRepo(dir);
  }
});
