import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictOps } from "@gitstudio/git-service/ConflictOps";
import { GitContext } from "@gitstudio/git-service/GitContext";
import type { OperationSource } from "@gitstudio/git-service/OperationProvider";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { GENERIC_LABELS, markersOnlyPayload, readMergePayload } from "../src/payload";
import { mergeConflict, removeTemp, reporterRebase, view } from "./fixtures";

// The merge editor's payload is the ROLE-mapped read, for every operation.
// During a rebase (and a stash re-apply) Yours is git's stage 3 — the user's
// own commit — and it is the LEFT pane (`ours`). Both extensions used to put
// stage 2 on the left under "Current change", so merge-studio#12's "Accept
// Yours" took master during `git rebase master`.
//
// The operation comes from a FAKE OperationSource returning hand-built views;
// the stages come from real git, through the real ConflictOps.readSides.

let reporter: { dir: string; repo: string };
let merge: { dir: string; repo: string };

before(() => {
  reporter = reporterRebase();
  merge = mergeConflict();
});

after(() => {
  removeTemp(reporter?.dir);
  removeTemp(merge?.dir);
});

function opsFor(root: string, op: OperationView): { ctx: GitContext; ops: ConflictOps } {
  const ctx = new GitContext({ root });
  const source: OperationSource = { view: async () => op };
  return { ctx, ops: new ConflictOps(ctx.process, root, ctx.conflict, source) };
}

const input = (root: string) => ({
  fileName: join(root, "a.txt"),
  workingText: readFileSync(join(root, "a.txt"), "utf8"),
  autoApplyNonConflicting: false,
});

test("rebase: Yours (left, `ours`) is the commit being replayed — stage 3 — with its pane title", async () => {
  const op = view("rebase");
  const { ctx, ops } = opsFor(reporter.repo, op);
  try {
    const p = await readMergePayload(ops, "a.txt", input(reporter.repo));
    assert.match(p.ours, /three-test/, "the reporter's own change is on the left");
    assert.doesNotMatch(p.ours, /three-master/);
    assert.match(p.theirs, /three-master/, "master is on the right");
    assert.equal(p.oursLabel, "Rebasing 1a2b3c4 from test");
    assert.equal(p.theirsLabel, "Already rebased commits and commits from master");
    assert.deepEqual(p.op, op, "the shell gets the operation it is resolving");
    assert.equal(p.source, "git-stages");
    assert.match(p.base, /^one\ntwo\nthree\nfour/);
    assert.match(p.result, /^<<<<<<< /m, "the result starts from the working text, markers and all");
  } finally {
    ctx.dispose();
  }
});

test("merge: Yours is stage 2 (the branch you are on); nothing is swapped", async () => {
  const op = view("merge");
  const { ctx, ops } = opsFor(merge.repo, op);
  try {
    const p = await readMergePayload(ops, "a.txt", input(merge.repo));
    assert.match(p.ours, /three-master/);
    assert.match(p.theirs, /three-feature/);
    assert.equal(p.oursLabel, "Changes from master");
    assert.equal(p.theirsLabel, "Changes from feature");
  } finally {
    ctx.dispose();
  }
});

test("the swap follows op.yours.stage, not the operation's name: the same stages under a stash view swap", async () => {
  const { ctx, ops } = opsFor(merge.repo, view("stash"));
  try {
    const p = await readMergePayload(ops, "a.txt", input(merge.repo));
    assert.match(p.ours, /three-feature/, "stage 3 on the left when Yours is stage 3");
    assert.match(p.theirs, /three-master/);
  } finally {
    ctx.dispose();
  }
});

test("an operation the caller already read is used as-is (no second view() call)", async () => {
  const op = view("rebase");
  let calls = 0;
  const ctx = new GitContext({ root: reporter.repo });
  const ops = new ConflictOps(ctx.process, reporter.repo, ctx.conflict, {
    view: async () => {
      calls++;
      return view("merge");
    },
  });
  try {
    const p = await readMergePayload(ops, "a.txt", input(reporter.repo), { op });
    assert.equal(calls, 0);
    assert.match(p.ours, /three-test/);
  } finally {
    ctx.dispose();
  }
});

test("the auto-apply setting rides along; it defaults OFF upstream of here", async () => {
  const { ctx, ops } = opsFor(merge.repo, view("merge"));
  try {
    const off = await readMergePayload(ops, "a.txt", input(merge.repo));
    assert.equal(off.autoApplyNonConflicting, false);
    const on = await readMergePayload(ops, "a.txt", { ...input(merge.repo), autoApplyNonConflicting: true });
    assert.equal(on.autoApplyNonConflicting, true);
  } finally {
    ctx.dispose();
  }
});

test("a file with nothing to resolve and nothing in progress gets no operation strip", async () => {
  const { ctx, ops } = opsFor(merge.repo, view("none"));
  const clean = join(merge.repo, "clean.txt");
  writeFileSync(clean, "hello\n");
  try {
    const p = await readMergePayload(ops, "clean.txt", {
      fileName: clean,
      workingText: "hello\n",
      autoApplyNonConflicting: false,
    });
    assert.equal(p.op, undefined);
    assert.equal(p.source, "none");
    assert.equal(p.conflictType, "unknown");
  } finally {
    ctx.dispose();
  }
});

test("outside a repository the sides come from the markers, with no operation and generic labels", () => {
  const text = [
    "a",
    "<<<<<<< ours",
    "mine",
    "||||||| base",
    "orig",
    "=======",
    "yours-not",
    ">>>>>>> theirs",
    "z",
  ].join("\n");
  const p = markersOnlyPayload({ fileName: "/tmp/x.txt", workingText: text, autoApplyNonConflicting: false });
  assert.equal(p.op, undefined);
  assert.equal(p.oursLabel, GENERIC_LABELS.yours);
  assert.equal(p.theirsLabel, GENERIC_LABELS.theirs);
  assert.equal(p.ours, "a\nmine\nz");
  assert.equal(p.theirs, "a\nyours-not\nz");
  assert.equal(p.base, "a\norig\nz");
  assert.equal(p.source, "markers");
  assert.equal(p.hasBase, true);
});
