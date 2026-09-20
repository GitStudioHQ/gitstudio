import { test } from "node:test";
import assert from "node:assert/strict";
import { slowStateChanged, type SlowState } from "../src/changes/slowState";

// A Changes-view state push posts twice: instantly with last-known values,
// then again once git and the AI probe have answered. The second post is the
// whole payload — every file list — and it used to go out on every push of
// the onDidChange firehose whether or not it corrected anything. These pin
// when it is owed and when it is not.

const steady: SlowState = {
  aiEnabled: true,
  branchesSig: '{"local":[{"name":"main","current":true}],"remote":["origin/main"],"recent":[],"tags":[]}',
  unpushed: 2,
  canPublish: true,
};

test("nothing moved: the second post is not owed", () => {
  assert.equal(slowStateChanged(steady, { ...steady }), false);
});

test("a branch appearing, or the star toggling, is owed", () => {
  const withBranch = steady.branchesSig!.replace('"recent":[]', '"recent":["fix"]');
  assert.equal(slowStateChanged(steady, { ...steady, branchesSig: withBranch }), true);
});

test("a repo switch carried no branches, so the fresh list is owed", () => {
  // The first post only reuses the last branch list when it belongs to the
  // repo now on screen; after a switch it carries none.
  assert.equal(slowStateChanged({ ...steady, branchesSig: undefined }, steady), true);
});

test("the AI button flipping is owed", () => {
  assert.equal(slowStateChanged(steady, { ...steady, aiEnabled: false }), true);
});

test("a never-pushed branch waits for the rev-list count", () => {
  // Without an upstream the first post cannot know the count; the resolved
  // one is always news, even when it is zero.
  const sent: SlowState = { ...steady, unpushed: undefined, canPublish: undefined };
  assert.equal(slowStateChanged(sent, { ...steady, unpushed: 0, canPublish: false }), true);
});

test("a push landing changes the count, and that is owed", () => {
  assert.equal(slowStateChanged(steady, { ...steady, unpushed: 0 }), true);
  assert.equal(slowStateChanged(steady, { ...steady, canPublish: false }), true);
});
