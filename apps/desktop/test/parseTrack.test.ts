// What git's `%(upstream:track)` field actually says.
//
// `[gone]` used to be dropped on the floor, so a branch whose upstream had been
// deleted came back as `{ ahead: 0, behind: 0 }` — byte-identical to perfectly
// in sync. That is the most common state in this project's own workflow, since
// GitHub deletes the head branch when a pull request merges, and it is the
// clearest signal that a branch is finished and safe to delete.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrack } from "../src/main/gitBridge";

test("a branch in sync is zero, zero, and not gone", () => {
  assert.deepEqual(parseTrack(""), { ahead: 0, behind: 0, gone: false });
});

test("ahead and behind are read independently", () => {
  assert.deepEqual(parseTrack("[ahead 2]"), { ahead: 2, behind: 0, gone: false });
  assert.deepEqual(parseTrack("[behind 5]"), { ahead: 0, behind: 5, gone: false });
  assert.deepEqual(parseTrack("[ahead 2, behind 1]"), { ahead: 2, behind: 1, gone: false });
});

test("a deleted upstream is GONE, not in sync", () => {
  const t = parseTrack("[gone]");
  assert.equal(t.gone, true);
  // And it must not masquerade as agreement: zero/zero is the same shape a
  // fully-synced branch has, which is precisely why this flag exists.
  assert.equal(t.ahead, 0);
  assert.equal(t.behind, 0);
});

test("a word merely containing 'gone' is not a gone upstream", () => {
  // The field is git's, but a branch named e.g. `feat/dragonet` reaching this
  // parser through some other path must not read as gone.
  assert.equal(parseTrack("[ahead 1] dragonet").gone, false);
});
