import { test } from "node:test";
import assert from "node:assert/strict";
import { stopReason, type ChainCommit } from "../src/rebase/chain";
import { dropOutcomeMessage, dropQuestion, dropRefusalMessage, dropTarget, type DropRefusal } from "../src/rebase/drop";

// Drop Commit (issue #32): which commits the menu may offer to drop, what a drop
// replays, and what the confirmation says — the state space, without git.
// History is given newest first, as `rev-list --first-parent HEAD` prints it.

const c = (sha: string, ...parents: string[]): ChainCommit => ({ sha, parents });
const linear = [c("d", "c"), c("c", "b"), c("b", "a"), c("a")]; // a is the root

test("the tip drops with nothing replayed, onto its parent", () => {
  assert.deepEqual(dropTarget(linear, "d"), { ok: true, later: [], base: "c" });
});

test("a middle commit drops with the later ones replayed, newest first", () => {
  assert.deepEqual(dropTarget(linear, "b"), { ok: true, later: ["d", "c"], base: "a" });
});

test("the oldest commit — the root — drops with --root (no base)", () => {
  const t = dropTarget(linear, "a");
  assert.ok(t.ok);
  assert.equal(t.base, undefined, "no parent: the rebase runs with --root");
  assert.deepEqual(t.later, ["d", "c", "b"]);
});

test("the ONLY commit is not offered — dropping it would leave nothing", () => {
  assert.deepEqual(dropTarget([c("a")], "a"), { ok: false, reason: "only-commit" });
});

test("a merge commit is not offered", () => {
  const h = [c("d", "m"), c("m", "b", "side"), c("b", "a"), c("a")];
  assert.deepEqual(dropTarget(h, "m"), { ok: false, reason: "merge" });
});

test("a commit below a merge is not offered — replaying past the merge would flatten it", () => {
  const h = [c("d", "m"), c("m", "b", "side"), c("b", "a"), c("a")];
  assert.deepEqual(dropTarget(h, "b"), { ok: false, reason: "past-merge" });
  // …but the commit ABOVE the merge is fine, and runs onto the merge.
  assert.deepEqual(dropTarget(h, "d"), { ok: true, later: [], base: "m" });
});

test("a commit that is not on HEAD's first-parent line is not offered", () => {
  assert.deepEqual(dropTarget(linear, "elsewhere"), { ok: false, reason: "not-on-branch" });
});

test("a walk that hit its limit says 'too far', not 'not on the branch'", () => {
  assert.deepEqual(dropTarget(linear.slice(0, 2), "a", { capped: true }), { ok: false, reason: "too-far" });
});

test("a published commit is still droppable — the reorder chain's stop does not apply", () => {
  // The chain walk here does not know about remotes at all; published-ness
  // only changes the confirmation's words (below), never whether it is offered.
  assert.ok(dropTarget(linear, "c").ok);
});

test("every refusal has words, and they differ", () => {
  const reasons: DropRefusal[] = ["not-on-branch", "merge", "past-merge", "only-commit", "too-far"];
  const texts = reasons.map(dropRefusalMessage);
  for (const t of texts) assert.ok(t.length > 20, t);
  assert.equal(new Set(texts).size, texts.length);
});

test("the confirmation names the commit, the branch and how many are replayed", () => {
  const base = { shortSha: "a1b2c3d", subject: "fix: typo", published: false, branch: "main" };
  const none = dropQuestion({ ...base, replayed: 0 });
  assert.equal(none.title, "Drop a1b2c3d?");
  assert.match(none.message, /a1b2c3d "fix: typo" is removed from main\./);
  assert.match(none.message, /nothing else is replayed/);
  assert.match(dropQuestion({ ...base, replayed: 1 }).message, /The 1 commit after it is replayed/);
  assert.match(dropQuestion({ ...base, replayed: 4 }).message, /The 4 commits after it are replayed/);
  assert.match(none.message, /Undo is available afterwards\./);
  assert.doesNotMatch(none.message, /pushed|force/i, "no push warning for a local commit");
  assert.match(dropQuestion({ ...base, replayed: 0, branch: null }).message, /from the detached HEAD/);
});

test("branches on replayed commits are named with the replay, before the warnings and the undo note", () => {
  const base = { shortSha: "a1b2c3d", subject: "x", published: true, branch: "main", replayed: 2 };
  const one = dropQuestion({ ...base, carryable: ["feature"] }).message;
  assert.match(one, /get new identities\. feature points at a commit that is replayed\. Already pushed\./);
  const many = dropQuestion({ ...base, carryable: ["a", "b", "c", "d", "e"] }).message;
  assert.match(many, /a, b, c and 2 more point at a commit that is replayed\./);
  assert.ok(many.endsWith("Undo is available afterwards."));
});

test("a published commit's confirmation warns in the reorder flow's own words, plus the force push", () => {
  const q = dropQuestion({ shortSha: "a1b2c3d", subject: "x", published: true, branch: "main", replayed: 2 });
  // The reorder hover's sentence, with the verb changed — one warning, two doors.
  assert.ok(q.message.includes(stopReason("published").replace("Reordering", "Dropping")), q.message);
  assert.match(q.message, /force push/);
});

test("how a drop ended, in words: done, a conflict stop, another stop, and failures by tone", () => {
  assert.equal(dropOutcomeMessage("a1b2c3d", { status: "done" }), "Dropped a1b2c3d.");
  const conflict = dropOutcomeMessage("a1b2c3d", { status: "stopped", reason: "conflict" });
  assert.match(conflict, /hit a conflict while replaying a later commit/);
  assert.match(conflict, /continue the rebase — or skip that commit, or abort to put the branch back as it was\./);
  assert.match(dropOutcomeMessage("a1b2c3d", { status: "stopped", reason: "unknown" }), /stopped and needs you.*abort/);
  // The user's own state is its own sentence; a real failure is prefixed.
  const dirty = "You have uncommitted changes. Commit or stash them, then drop the commit.";
  assert.equal(dropOutcomeMessage("a1b2c3d", { status: "failed", expected: true, message: dirty }), dirty);
  assert.equal(dropOutcomeMessage("a1b2c3d", { status: "failed", message: "boom" }), "Couldn't drop a1b2c3d: boom");
  assert.equal(dropOutcomeMessage("a1b2c3d", { status: "failed" }), "Couldn't drop a1b2c3d.");
});
