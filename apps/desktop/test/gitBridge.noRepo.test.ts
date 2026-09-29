import { test } from "node:test";
import assert from "node:assert/strict";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import type { CommitActionResult } from "../src/shared/ipc";

// The app starts with no repository open, and a tab can close under a request
// already in flight. Every channel must then answer as a STATE: reads come back
// empty (never a throw the renderer paints as "Couldn't load"), and writes are
// refused with `expected: true` — the flag that keeps "no repository open" out
// of the crash reporter (main/expectedError.ts). A write that answered ok, or
// a refusal without `expected`, would file a report every time someone clicked
// before opening a folder.

const noRepo = new GitBridge({
  getContext: () => undefined,
  current: () => undefined,
  state: () => ({ tabs: [], active: undefined }),
  runnerOptions: () => ({ gitPath: "git", onRun: () => undefined }),
} as unknown as RepoStore);

function refusedAsState(r: CommitActionResult | { ok: boolean; expected?: boolean; message?: string }, what: string): void {
  assert.equal(r.ok, false, `${what} must not claim success with no repository`);
  assert.equal(r.expected, true, `${what}: no repository open is a state, not a crash`);
  assert.match(r.message ?? "", /no repository/i, `${what} says why`);
  if ("changed" in r) assert.equal(r.changed, false, `${what} changed nothing`);
}

test("with no repository open, the graph answers an empty page with an empty ref list", async () => {
  const page = await noRepo.graphLoad({ skip: 0 });
  assert.deepEqual(page.rows, []);
  assert.equal(page.head, "");
  assert.equal(page.hasMore, false);
  assert.equal(page.nextSkip, 0);
  assert.equal(page.refFilter, null);
  assert.deepEqual(page.refList, [], "a renderer holding no list is sent the (empty) list");

  // A renderer that already holds the empty list is not sent it again.
  const again = await noRepo.graphLoad({ skip: 0, refListSig: page.refListSig });
  assert.equal("refList" in again, false);
  assert.equal(again.refListSig, page.refListSig);
});

test("with no repository open, every read answers empty rather than throwing", async () => {
  assert.deepEqual(await noRepo.refsContains("abc1234"), { branches: [], refs: [], truncated: false });
  assert.deepEqual(await noRepo.refsList(), []);
  assert.equal(await noRepo.head(), undefined);
  assert.deepEqual(await noRepo.commitBranches("abc1234"), { branches: [], onCurrent: false });
  assert.equal(await noRepo.commitDetails("abc1234"), undefined);
  assert.deepEqual(await noRepo.rowStats(["abc1234"]), []);
  assert.deepEqual(await noRepo.status(), []);
  assert.deepEqual(await noRepo.diffFiles(), []);
  assert.equal(await noRepo.fileDiff({ path: "a.txt" }), undefined);
  assert.equal(await noRepo.conflictModel("a.txt"), undefined);
  assert.equal(await noRepo.blameFile("a.txt"), undefined);
  assert.deepEqual(await noRepo.discardSnapshot(), {});
  assert.deepEqual(await noRepo.stashList(), []);
  assert.deepEqual(await noRepo.hunksList("a.txt"), []);
  assert.deepEqual(await noRepo.worktreeList(), []);
  assert.deepEqual(await noRepo.worktreeRemoval({ path: "/somewhere" }), { kind: "notListed" });
  assert.equal(await noRepo.compareRefs({ base: "main", head: "topic" }), undefined);
  assert.equal(await noRepo.compareFileDiff({ base: "main", head: "topic", path: "a.txt" }), undefined);
  assert.equal(await noRepo.headCommit({ count: true }), undefined);
  assert.deepEqual(await noRepo.treeList({ path: "" }), []);
  assert.equal(await noRepo.fileText({ path: "README.md" }), undefined);
  assert.deepEqual(await noRepo.syncStatus(), { ahead: 0, behind: 0, noUpstream: true });
  assert.deepEqual(await noRepo.branchesList(), []);
  assert.deepEqual(await noRepo.refLog({ ref: "main" }), []);
  assert.deepEqual(await noRepo.branchesPeople(), {});
  assert.deepEqual(await noRepo.conflictList(), []);
  assert.deepEqual(await noRepo.graphReaches("abc1234"), { reached: true });

  const conflicts = await noRepo.conflictState();
  assert.deepEqual(conflicts.files, []);
  assert.equal(conflicts.total, 0);
  assert.equal(conflicts.op.kind, "none");

  const op = await noRepo.opState();
  assert.equal(op.kind, null);
  assert.equal(op.canContinue, false);
  assert.equal(op.canSkip, false);
  assert.equal(op.conflicts, 0);
  assert.equal(op.merging || op.rebasing || op.cherryPicking || op.reverting || op.amApplying, false);
});

test("with no repository open, every write is refused as an expected state", async () => {
  const writes: Array<[string, () => Promise<CommitActionResult | { ok: boolean; expected?: boolean; message?: string }>]> = [
    ["stage", () => noRepo.stage("a.txt")],
    ["unstage", () => noRepo.unstage("a.txt")],
    ["discard", () => noRepo.discard("a.txt")],
    ["stageAll", () => noRepo.stageAll()],
    ["unstageAll", () => noRepo.unstageAll()],
    ["discardUndo", () => noRepo.discardUndo({ sha: "abc1234", paths: ["a.txt"] })],
    ["commit", () => noRepo.commit({ message: "hello" })],
    ["blocksSet", () => noRepo.blocksSet({ path: "a.txt", block: { index: 0 } as never, staged: true })],
    ["stashApply", () => noRepo.stashApply("abc1234")],
    ["stashPop", () => noRepo.stashPop({ ref: "abc1234" })],
    ["stashDrop", () => noRepo.stashDrop("abc1234")],
    ["stashRestore", () => noRepo.stashRestore({ sha: "abc1234" })],
    ["stashSave", () => noRepo.stashSave({ message: "wip" })],
    ["hunksStage", () => noRepo.hunksStage({ path: "a.txt", index: 0 })],
    ["worktreeAdd", () => noRepo.worktreeAdd("/tmp/wt", "main")],
    ["syncFetch", () => noRepo.syncFetch()],
    ["syncPull", () => noRepo.syncPull()],
    ["syncPush", () => noRepo.syncPush(undefined)],
    ["branchPullFf", () => noRepo.branchPullFf("refs/heads/main")],
    ["branchResetPlan", () => noRepo.branchResetPlan({ fullName: "refs/heads/main" })],
    ["branchResetToUpstream", () => noRepo.branchResetToUpstream({ fullName: "refs/heads/main" } as never)],
    ["branchResetUndo", () => noRepo.branchResetUndo({ fullName: "refs/heads/main" } as never)],
    ["commitAction", () => noRepo.commitAction({ action: "checkout", sha: "abc1234" })],
    ["amAbort", () => noRepo.amAbort()],
    ["amContinue", () => noRepo.amContinue()],
    ["mergeAbort", () => noRepo.mergeAbort()],
    ["rebaseContinue", () => noRepo.rebaseContinue()],
    ["rebaseSkip", () => noRepo.rebaseSkip()],
    ["tagCreate", () => noRepo.tagCreate({ name: "v1" })],
    ["tagRestore", () => noRepo.tagRestore({ name: "v1", sha: "abc1234" })],
    ["tagPush", () => noRepo.tagPush({ name: "v1" })],
    ["branchRestoreRemote", () => noRepo.branchRestoreRemote({ remote: "origin", name: "x", sha: "abc1234" })],
    ["stageLines", () => noRepo.stageLines({ path: "a.txt", lines: [1] })],
    ["conflictResolve", () => noRepo.conflictResolve({ path: "a.txt", content: "x" })],
    ["conflictTakeSide", () => noRepo.conflictTakeSide({ path: "a.txt", side: "ours" })],
    ["conflictTakeRole", () => noRepo.conflictTakeRole({ path: "a.txt", role: "yours" })],
    ["conflictRestore", () => noRepo.conflictRestore({ path: "a.txt" })],
    ["conflictDelete", () => noRepo.conflictDelete({ path: "a.txt" })],
  ];
  for (const [what, run] of writes) refusedAsState(await run(), what);
});

test("with no repository open, the operation verbs refuse as not-allowed and say why", async () => {
  for (const verb of [() => noRepo.opContinue({ confirmDrop: true }), () => noRepo.opSkip(), () => noRepo.opAbort()]) {
    const r = await verb();
    assert.equal(r.ok, false);
    assert.equal(r.expected, true);
    assert.equal((r as { refused?: string }).refused, "not-allowed");
    assert.equal(r.view.kind, "none");
    assert.equal(r.remainingConflicts, 0);
  }
});

test("with no repository open, deleting a branch, tag or remote branch refuses without recording an undo", async () => {
  const branch = await noRepo.branchDelete({ fullName: "refs/heads/topic" });
  refusedAsState(branch, "branchDelete");
  assert.equal(branch.was, undefined, "no tip was read, so there is nothing to put back");

  const tag = await noRepo.tagDelete("v1");
  refusedAsState(tag, "tagDelete");
  assert.equal(tag.was, undefined);

  const remote = await noRepo.branchDeleteRemote({ remote: "origin", name: "topic" });
  refusedAsState(remote, "branchDeleteRemote");
  assert.equal(remote.was, undefined);

  const made = await noRepo.branchCreate({ name: "x", upstream: "origin/x" });
  refusedAsState(made, "branchCreate");
});
