import { test } from "node:test";
import assert from "node:assert/strict";
import { rowStatsReply } from "../src/graph/rowStatsReply";

// The CHANGES column's stats arrive one `git log --numstat` batch per visible
// window. Two things can be missing from the answer, and the webview must be
// told which: a sha git SKIPPED (an answer — zeros, never asked again) and a
// batch git could not run (not an answer — handed back, asked again on the
// next repaint). The host used to answer zeros for both, and one transient
// failure kept an empty cell on the whole window for the rest of the session.

const stat = (sha: string, files = 1) => ({ sha, files, additions: files * 3, deletions: files });

test("every sha git answered is passed through", () => {
  const r = rowStatsReply(["a", "b"], [stat("a"), stat("b", 2)]);
  assert.deepEqual(r, { type: "rowStats", stats: [stat("a"), stat("b", 2)] });
  assert.equal(r.unanswered, undefined, "nothing to retry");
});

test("a sha git skipped is answered with zeros — an answer, so it is not asked again", () => {
  const r = rowStatsReply(["a", "gone", "b"], [stat("a"), stat("b")]);
  assert.deepEqual(r.stats, [stat("a"), { sha: "gone", files: 0, additions: 0, deletions: 0 }, stat("b")]);
  assert.equal(r.unanswered, undefined);
});

test("a batch that failed as a whole hands every sha back unanswered, with no zeros", () => {
  const r = rowStatsReply(["a", "b", "c"], undefined);
  assert.deepEqual(r, { type: "rowStats", stats: [], unanswered: ["a", "b", "c"] });
});

test("the reply keeps the window's order, whatever order git answered in", () => {
  const r = rowStatsReply(["b", "a"], [stat("a"), stat("b")]);
  assert.deepEqual(r.stats.map((s) => s.sha), ["b", "a"]);
});
