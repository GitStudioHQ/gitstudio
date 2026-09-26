import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChainCommit } from "../src/rebase/chain";
import {
  applyManyMessage,
  dropManyQuestion,
  dropManyTarget,
  listInWords,
  manyOutcomeMessage,
  manyRefusalMessage,
  manyTarget,
  squashMessage,
  squashCarryQuestion,
  squashQuestion,
  squashTarget,
  type ManyRefusal,
} from "../src/rebase/many";

// Several commits at once (issue #32): which selections Drop N Commits… and
// Squash N Commits… may take, what each replays, and what the questions say —
// the state space as a table, without git. History is newest first, as
// `rev-list --first-parent HEAD` prints it.

const c = (sha: string, ...parents: string[]): ChainCommit => ({ sha, parents });
/** e ← d ← c ← b ← a (the root). */
const linear = [c("e", "d"), c("d", "c"), c("c", "b"), c("b", "a"), c("a")];
/** f ← m (merge of b and side) ← b ← a. */
const merged = [c("f", "m"), c("m", "b", "side"), c("b", "a"), c("a")];

type Want = { rows: string; base?: string } | ManyRefusal;
/** rows written as "e d* c*": the run newest first, * = selected. */
const show = (t: ReturnType<typeof manyTarget>): Want =>
  t.ok ? { rows: t.rows.map((r) => r.sha + (r.selected ? "*" : "")).join(" "), ...(t.base ? { base: t.base } : {}) } : t.reason;

// One row per selection shape: [what, history, selection, drop, squash].
const TABLE: Array<[string, ChainCommit[], string[], Want, Want]> = [
  ["two at the tip", linear, ["e", "d"], { rows: "e* d*", base: "c" }, { rows: "e* d*", base: "c" }],
  ["two in the middle", linear, ["d", "c"], { rows: "e d* c*", base: "b" }, { rows: "e d* c*", base: "b" }],
  ["the selection's order does not matter", linear, ["c", "d"], { rows: "e d* c*", base: "b" }, { rows: "e d* c*", base: "b" }],
  ["three down to the root", linear, ["c", "b", "a"], { rows: "e d c* b* a*" }, { rows: "e d c* b* a*" }],
  ["a gap between them", linear, ["e", "c"], { rows: "e* d c*", base: "b" }, "not-contiguous"],
  ["a gap, the oldest the root", linear, ["d", "a"], { rows: "e d* c b a*" }, "not-contiguous"],
  ["every commit, root to tip", linear, ["e", "d", "c", "b", "a"], "only-commit", { rows: "e* d* c* b* a*" }],
  ["one commit", linear, ["c"], { rows: "e d c*", base: "b" }, "too-few"],
  ["the same commit twice", linear, ["c", "c"], { rows: "e d c*", base: "b" }, "too-few"],
  ["nothing", linear, [], "not-on-branch", "too-few"],
  ["one off the branch", linear, ["d", "elsewhere"], "not-on-branch", "not-on-branch"],
  ["a merge among them", merged, ["f", "m"], "merge", "merge"],
  ["below a merge", merged, ["b", "a"], "past-merge", "past-merge"],
  ["one above a merge, one below", merged, ["f", "b"], "past-merge", "past-merge"],
  ["above the merge only", [c("g", "f"), ...merged], ["g", "f"], { rows: "g* f*", base: "m" }, { rows: "g* f*", base: "m" }],
];

for (const [what, history, sel, drop, squash] of TABLE) {
  test(`drop and squash: ${what}`, () => {
    assert.deepEqual(show(dropManyTarget(history, sel)), drop, "drop");
    assert.deepEqual(show(squashTarget(history, sel)), squash, "squash");
  });
}

test("a walk that hit its limit says 'too far', not 'not on the branch'", () => {
  assert.equal(show(dropManyTarget(linear.slice(0, 2), ["d", "a"], { capped: true })), "too-far");
  assert.equal(show(squashTarget(linear.slice(0, 2), ["b", "a"], { capped: true })), "too-far");
  assert.equal(show(manyTarget(linear.slice(0, 2), ["b", "a"])), "not-on-branch");
});

test("every refusal has words for both verbs, and no two refusals say the same", () => {
  const reasons: ManyRefusal[] = ["not-on-branch", "merge", "past-merge", "only-commit", "too-far", "not-contiguous", "too-few"];
  for (const verb of ["drop", "squash"] as const) {
    const texts = reasons.map((r) => manyRefusalMessage(r, verb));
    for (const t of texts) assert.ok(t.length > 20, t);
    assert.equal(new Set(texts).size, texts.length, verb);
  }
  assert.match(manyRefusalMessage("merge", "squash"), /squashing it/);
  assert.match(manyRefusalMessage("merge", "drop"), /dropping it/);
});

test("lists read as English with every item in them", () => {
  assert.equal(listInWords([]), "");
  assert.equal(listInWords(["a"]), "a");
  assert.equal(listInWords(["a", "b"]), "a and b");
  assert.equal(listInWords(["a", "b", "c", "d"]), "a, b, c and d");
});

const three = [
  { shortSha: "3333333", subject: "third" },
  { shortSha: "2222222", subject: "second" },
  { shortSha: "1111111", subject: "" },
];

test("Drop N's question lists every commit it removes, and what is replayed", () => {
  const q = dropManyQuestion({ commits: three, replayed: 0, published: false, branch: "main" });
  assert.equal(q.title, "Drop 3 commits?");
  assert.match(q.message, /^3 commits will be removed from main: 3333333 "third", 2222222 "second" and 1111111\./);
  assert.match(q.message, /Nothing else changes\./);
  assert.match(q.message, /Undo is available afterwards\.$/);
  assert.doesNotMatch(q.message, /pushed|force/i);
  assert.match(dropManyQuestion({ commits: three, replayed: 1, published: false, branch: "main" }).message, /One later commit will be replayed on top, with a new SHA\./);
  assert.match(dropManyQuestion({ commits: three, replayed: 5, published: false, branch: "main" }).message, /The 5 later commits will be replayed on top, with new SHAs\./);
  assert.match(dropManyQuestion({ commits: three, replayed: 0, published: false, branch: null }).message, /from the detached HEAD:/);
});

test("pushed history is warned about, with the force push, in both questions — about them, not it", () => {
  const s = { commits: three, replayed: 2, published: true, branch: "main" };
  assert.match(dropManyQuestion(s).message, /Some of these commits are already pushed\. Dropping them would rewrite history other people have\. The next push will need to be a force push\./);
  assert.match(squashQuestion(s).message, /Some of these commits are already pushed\. Squashing them would rewrite history other people have\. The next push will need to be a force push\./);
  for (const m of [dropManyQuestion(s).message, squashQuestion(s).message, squashCarryQuestion({ ...s, carryable: ["feature"] }).message]) {
    assert.doesNotMatch(m, /\bit would\b/, "one pronoun for several commits");
  }
});

test("branches on rewritten commits are named, before the warnings", () => {
  const s = { commits: three, replayed: 1, published: true, branch: "main" };
  const one = dropManyQuestion({ ...s, carryable: ["feature"] }).message;
  assert.match(one, /feature points at a commit that will be rewritten\./);
  assert.ok(one.indexOf("feature points") < one.indexOf("already pushed"));
  const many = squashQuestion({ ...s, carryable: ["a", "b", "c", "d", "e"] }).message;
  assert.match(many, /a, b, c and 2 more point at a commit that will be rewritten\./);
});

test("Squash N's question names the commits that become one", () => {
  const q = squashQuestion({ commits: three, replayed: 0, published: false, branch: "main" });
  assert.equal(q.title, "Squash 3 commits");
  assert.match(q.message, /^3333333, 2222222 and 1111111 on main will become one commit with the message below\./);
  assert.match(q.message, /Nothing else changes\./);
});

test("Squash N's carry question says what the branches choice is about — not the message editor's words", () => {
  const s = { commits: three, replayed: 2, published: false, branch: "main", carryable: ["feature"] };
  const q = squashCarryQuestion(s);
  assert.equal(q.title, "Squash 3 commits — move the branches too?");
  assert.doesNotMatch(q.message, /message below/, "no message is below this question: its choices are");
  assert.match(q.message, /^3333333, 2222222 and 1111111 on main will become one commit\./);
  assert.match(q.message, /The 2 later commits will be replayed on top, with new SHAs\./);
  assert.match(q.message, /feature points at a commit that will be rewritten\./);
  assert.match(q.message, /Undo is available afterwards\.$/);
  // The editor's own question keeps its words.
  assert.match(squashQuestion(s).message, /will become one commit with the message below\./);
});

test("the squash message is every message in full, oldest first, repeats kept once", () => {
  assert.equal(
    squashMessage([
      { subject: "feat: add the parser", body: "It reads the header.\n" },
      { subject: "wip", body: "" },
      { subject: "fix: an off-by-one", body: "" },
      { subject: "wip", body: "" },
      { subject: "  ", body: "" },
    ]),
    "feat: add the parser\n\nIt reads the header.\n\nwip\n\nfix: an off-by-one",
  );
});

test("outcomes: done, a conflict, another stop, a refusal and a failure", () => {
  assert.equal(manyOutcomeMessage("drop", 3, { status: "done" }), "Dropped 3 commits.");
  assert.equal(manyOutcomeMessage("squash", 3, { status: "done" }), "Squashed 3 commits into one.");
  assert.match(manyOutcomeMessage("squash", 2, { status: "stopped", reason: "conflict" }), /^Squashing 2 commits hit a conflict while replaying a later commit\..*abort to put the branch back as it was\.$/);
  assert.match(manyOutcomeMessage("drop", 2, { status: "stopped", reason: "edit" }), /^Dropping 2 commits stopped and needs you/);
  assert.equal(manyOutcomeMessage("drop", 2, { status: "failed", expected: true, message: "You have uncommitted changes." }), "You have uncommitted changes.");
  assert.equal(manyOutcomeMessage("drop", 2, { status: "failed", message: "boom" }), "Couldn't drop 2 commits: boom");
  assert.equal(manyOutcomeMessage("squash", 2, { status: "failed" }), "Couldn't squash 2 commits.");
});

test("cherry-pick and revert of N: done, and a stop that says abort puts it all back", () => {
  assert.equal(applyManyMessage("cherry-pick", 3, "done"), "Cherry-picked 3 commits.");
  assert.equal(applyManyMessage("revert", 2, "done"), "Reverted 2 commits.");
  for (const verb of ["cherry-pick", "revert"] as const) {
    const m = applyManyMessage(verb, 3, "stopped");
    assert.match(m, /3 commits stopped on a commit that needs you/);
    assert.match(m, /continue, skip that commit, or abort to put the branch back as it was\.$/);
  }
});
