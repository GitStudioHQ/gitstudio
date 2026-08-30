import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRebasePlan, type RebasePlanRow } from "../src/rebasePlan";

// Carrying other branches along with a rewrite (issue #18).
//
// Reordering gives commits new shas. A branch pointing at an old one is not
// "left alone" by that — it is left on a commit no longer in this branch's
// history. `update-ref` moves it onto the rewritten commit instead.
//
// The placement is the whole game: an update-ref line means "this branch points
// HERE", so it must sit immediately after its own pick, in the REVERSED (git)
// order. Detached from its commit the branch lands somewhere arbitrary — which
// is exactly what happened when this was first tried by hand.

const row = (sha: string, subject: string, branches?: string[]): RebasePlanRow => ({
  sha, subject, action: "pick", branches,
});

// Display order is newest first; git's todo is the reverse.
const DISPLAY = [
  row("cccccc", "C"),
  row("bbbbbb", "B", ["feat-2"]),
  row("aaaaaa", "A", ["feat-1"]),
];

test("off by default — rewriting refs nobody named is not a side effect", () => {
  const r = buildRebasePlan(DISPLAY);
  assert.equal(r.ok, true);
  assert.ok(r.ok && !r.todo.includes("update-ref"), "no ref lines unless asked");
});

test("each update-ref follows its OWN pick, in git's order", () => {
  const r = buildRebasePlan(DISPLAY, { updateRefs: true });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.deepEqual(r.todo.trim().split("\n"), [
    "pick aaaaaa A",
    "update-ref refs/heads/feat-1",
    "pick bbbbbb B",
    "update-ref refs/heads/feat-2",
    "pick cccccc C",
  ]);
});

test("a reorder carries each branch with its commit", () => {
  // B moved above A on screen — so in git's order A now comes after B, and each
  // branch must still sit with the commit it belongs to.
  const reordered = [row("cccccc", "C"), row("aaaaaa", "A", ["feat-1"]), row("bbbbbb", "B", ["feat-2"])];
  const r = buildRebasePlan(reordered, { updateRefs: true });
  assert.ok(r.ok);
  assert.deepEqual(r.todo.trim().split("\n"), [
    "pick bbbbbb B",
    "update-ref refs/heads/feat-2",
    "pick aaaaaa A",
    "update-ref refs/heads/feat-1",
    "pick cccccc C",
  ]);
});

test("a dropped commit takes no branch with it", () => {
  // Pointing a branch at a commit that will not exist is worse than leaving it.
  const rows = [row("cccccc", "C"), { ...row("bbbbbb", "B", ["feat-2"]), action: "drop" }];
  const r = buildRebasePlan(rows, { updateRefs: true });
  assert.ok(r.ok);
  assert.ok(!r.todo.includes("feat-2"), `dropped rows must not update a ref:\n${r.todo}`);
});

test("several branches on one commit all follow it", () => {
  const r = buildRebasePlan([row("aaaaaa", "A", ["x", "y"])], { updateRefs: true });
  assert.ok(r.ok);
  assert.deepEqual(r.todo.trim().split("\n"), [
    "pick aaaaaa A",
    "update-ref refs/heads/x",
    "update-ref refs/heads/y",
  ]);
});

test("a branch name that could inject a command is refused, not written", () => {
  // This string becomes a script git RUNS — the same reason the action and sha
  // are validated. git's own ref rules already forbid all of these.
  const nasty = ["a\nexec rm -rf /", "has space", "tilde~1", "caret^", "star*", "..dots", "-lead"];
  for (const name of nasty) {
    const r = buildRebasePlan([row("aaaaaa", "A", [name])], { updateRefs: true });
    assert.ok(r.ok);
    assert.equal(
      r.todo.trim().split("\n").length,
      1,
      `${JSON.stringify(name)} produced an extra todo line:\n${r.todo}`,
    );
    assert.ok(!r.todo.includes("exec"), "no command injected");
  }
});

test("an ordinary branch name still gets through", () => {
  const r = buildRebasePlan([row("aaaaaa", "A", ["feature/some-work"])], { updateRefs: true });
  assert.ok(r.ok);
  assert.ok(r.todo.includes("update-ref refs/heads/feature/some-work"));
});

/**
 * An update-ref line must sit after the LAST row that folds into its commit.
 *
 * git records the ref the moment it reaches the line, and a squash or fixup
 * below then AMENDS the commit the branch was just pointed at — so the branch
 * ends on a commit that is no longer in the rewritten history, which is exactly
 * the orphaning `--update-refs` exists to prevent. git's own `--autosquash`
 * emits `pick c2 / fixup fixup!c2 / update-ref …`, after the fold.
 *
 * `drop` is transparent to that scan: a `drop` between the pick and the fixup
 * does not stop the fixup folding into the same commit.
 */
test("update-ref follows the fold, not the pick", () => {
  const rows = [
    { action: "pick" as const, sha: "aaa1111", subject: "c1" },
    { action: "pick" as const, sha: "bbb2222", subject: "c2", branches: ["feature"] },
    { action: "fixup" as const, sha: "ccc3333", subject: "c3" },
  ];
  // Display order is newest first; buildRebasePlan reverses into git's todo.
  const built = buildRebasePlan([...rows].reverse(), { updateRefs: true });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const lines = built.todo.trim().split("\n");
  const ref = lines.findIndex((l) => l.startsWith("update-ref"));
  const fixup = lines.findIndex((l) => l.startsWith("fixup"));
  assert.ok(ref > fixup, `update-ref must come after the fixup it folds into:\n${built.todo}`);
});

test("a drop between the pick and its fixup does not detach the update-ref", () => {
  const rows = [
    { action: "pick" as const, sha: "bbb2222", subject: "c2", branches: ["feature"] },
    { action: "drop" as const, sha: "ccc3333", subject: "c3" },
    { action: "fixup" as const, sha: "ddd4444", subject: "c4" },
  ];
  const built = buildRebasePlan([...rows].reverse(), { updateRefs: true });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const lines = built.todo.trim().split("\n");
  const ref = lines.findIndex((l) => l.startsWith("update-ref"));
  const fixup = lines.findIndex((l) => l.startsWith("fixup"));
  assert.ok(ref > fixup, `a dropped row must not end the fold run:\n${built.todo}`);
});

test("a dropped commit's own branch gets no update-ref at all", () => {
  // Alongside a surviving pick — a plan that drops everything is refused on
  // its own grounds, which would make this assert nothing.
  const built = buildRebasePlan(
    [
      { action: "drop" as const, sha: "eee5555", subject: "gone", branches: ["stranded"] },
      { action: "pick" as const, sha: "fff6666", subject: "kept" },
    ],
    { updateRefs: true },
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(
    !built.todo.includes("update-ref"),
    "a commit that is not in the rewritten history has nowhere for its branch to point",
  );
});
