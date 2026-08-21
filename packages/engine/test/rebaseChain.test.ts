import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rewritableChain,
  moveToGap,
  isRealMove,
  legalGaps,
  stopReason,
  type ChainCommit,
} from "../src/rebase/chain";

// The rules that make a drag in the Commits list mean something.
//
// The list shows every branch interleaved, so "move this commit down one" is
// only well defined against the dragged commit's own first-parent chain — and
// only for the part of it that may legally be rewritten. These pin where that
// chain stops and what a move does, without git or a DOM.

const c = (sha: string, ...parents: string[]): ChainCommit => ({ sha, parents });

test("an ordinary run of unpushed commits is all rewritable", () => {
  const chain = rewritableChain([c("c", "b"), c("b", "a"), c("a", "root")]);
  assert.deepEqual(chain.shas, ["c", "b", "a"]);
  assert.equal(chain.stop, "published");
  assert.equal(chain.base, "root", "the rebase runs onto the parent of the oldest");
});

test("the chain stops AT a merge, and the merge itself cannot move", () => {
  // Verified against real git: `rebase -i` composes six linear verbs, so a
  // merge in range is flattened rather than moved past.
  const chain = rewritableChain([
    c("local-3", "local-2"),
    c("local-2", "merge"),
    c("merge", "local-1", "side-1"),
    c("local-1", "pushed-1"),
  ]);
  assert.deepEqual(chain.shas, ["local-3", "local-2"]);
  assert.equal(chain.stop, "merge");
  assert.equal(chain.base, "merge", "the rebase runs onto the merge, not past it");
});

test("a merge at the very top leaves nothing to reorder", () => {
  const chain = rewritableChain([c("m", "a", "b"), c("a", "root")]);
  assert.deepEqual(chain.shas, []);
  assert.equal(chain.stop, "merge");
});

test("running out of unpushed commits means the next one is published", () => {
  const chain = rewritableChain([c("b", "a")]);
  assert.deepEqual(chain.shas, ["b"]);
  assert.equal(chain.stop, "published");
  assert.equal(chain.base, "a");
});

test("a repo with no remote at all is rewritable to the root", () => {
  // Nothing is published, so nothing is protected — verified against real git,
  // where `--not --remotes` returns the whole history.
  const chain = rewritableChain([c("two", "one"), c("one")]);
  assert.deepEqual(chain.shas, ["two", "one"]);
  assert.equal(chain.stop, "root");
  assert.equal(chain.base, undefined, "no base — a rebase here needs --root");
});

test("nothing unpushed means nothing draggable", () => {
  const chain = rewritableChain([]);
  assert.deepEqual(chain.shas, []);
  assert.equal(chain.base, undefined);
});

test("every stop reason says something a user can act on", () => {
  for (const s of ["merge", "published", "root"] as const) {
    const text = stopReason(s);
    assert.ok(text.length > 20, `${s} needs a real explanation`);
    assert.ok(!/error|invalid|cannot be performed/i.test(text), `${s} reads as a scold`);
  }
  assert.notEqual(stopReason("merge"), stopReason("published"));
});

// ── moving ────────────────────────────────────────────────────────────────

test("dragging a commit down lands it in the gap you aimed at", () => {
  // [A,B,C], A into the gap between B and C -> [B,A,C]
  assert.deepEqual(moveToGap(["A", "B", "C"], 0, 2), ["B", "A", "C"]);
});

test("dragging a commit up lands it in the gap you aimed at", () => {
  // [A,B,C], C into the gap between A and B -> [A,C,B]
  assert.deepEqual(moveToGap(["A", "B", "C"], 2, 1), ["A", "C", "B"]);
});

test("dropping into either gap touching the commit changes nothing", () => {
  // Pulling it out and putting it back where it was. Both must be no-ops, or a
  // twitch of the pointer rewrites history for no reason.
  assert.deepEqual(moveToGap(["A", "B", "C"], 1, 1), ["A", "B", "C"]);
  assert.deepEqual(moveToGap(["A", "B", "C"], 1, 2), ["A", "B", "C"]);
  assert.equal(isRealMove(1, 1), false);
  assert.equal(isRealMove(1, 2), false);
});

test("moving to the ends works", () => {
  assert.deepEqual(moveToGap(["A", "B", "C"], 2, 0), ["C", "A", "B"]);
  assert.deepEqual(moveToGap(["A", "B", "C"], 0, 3), ["B", "C", "A"]);
});

test("an out-of-range drag is ignored rather than corrupting the order", () => {
  const src = ["A", "B", "C"];
  for (const [from, to] of [[-1, 1], [9, 1], [0, -1], [0, 99]] as const) {
    assert.deepEqual(moveToGap(src, from, to), src, `from=${from} to=${to}`);
  }
});

test("a move is always a permutation — nothing is lost or duplicated", () => {
  const src = ["A", "B", "C", "D", "E"];
  for (let from = 0; from < src.length; from++) {
    for (let to = 0; to <= src.length; to++) {
      const out = moveToGap(src, from, to);
      assert.equal(out.length, src.length, `from=${from} to=${to} changed length`);
      assert.deepEqual(
        [...out].sort(),
        [...src].sort(),
        `from=${from} to=${to} lost or duplicated a commit`,
      );
    }
  }
});

test("the legal gaps are every gap except the two that do nothing", () => {
  assert.deepEqual(legalGaps(3, 1), [0, 3]);
  assert.deepEqual(legalGaps(3, 0), [2, 3]);
  assert.deepEqual(legalGaps(1, 0), [], "a one-commit chain has nowhere to go");
});
