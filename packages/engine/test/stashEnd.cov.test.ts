// The stash-apply end tracker (src/conflict/stashEnd.ts) — whether it is
// still watching, through a stash apply, its end, another operation, and a clear.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConflictFileView, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { StashEndTracker } from "../src/conflict/stashEnd";

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string) => ({ role, stage, name, paneTitle: name, description: name });
const op = (kind: OperationView["kind"]): OperationView => ({
  kind,
  title: "",
  yours: side("yours", 3, "stash"),
  theirs: side("theirs", 2, "main"),
  verbs: { abort: "Cancel" },
  canContinue: false,
  canSkip: false,
  episode: kind,
});
const row = (path: string, over: Partial<ConflictFileView> = {}): ConflictFileView => ({ path, status: "pending", shape: "text", ...over });

test("watching: from the stash apply's conflicts, through its end, until cleared", () => {
  const t = new StashEndTracker();
  assert.equal(t.watching, false, "nothing seen yet");
  t.fold({ op: op("stash"), files: [row("a")] });
  assert.equal(t.watching, true);
  // A read that still has an unresolved row while git says "none" keeps waiting.
  assert.equal(t.fold({ op: op("none"), files: [row("a")] }), undefined);
  assert.equal(t.watching, true);
  const ended = t.fold({ op: op("none"), files: [] });
  assert.ok(ended);
  assert.equal(t.watching, true, "the finished card is still shown");
  t.clear();
  assert.equal(t.watching, false);
  assert.equal(t.fold({ op: op("none"), files: [] }), undefined, "after a clear, nothing ends");
});

test("another operation starting forgets the stash apply", () => {
  const t = new StashEndTracker();
  t.fold({ op: op("stash"), files: [row("a")] });
  assert.equal(t.fold({ op: op("merge"), files: [row("a")] }), undefined);
  assert.equal(t.watching, false);
  assert.equal(t.fold({ op: op("none"), files: [] }), undefined, "a merge's end is not a stash's");
});

test("nothing in progress with no stash apply seen, or files still listed, ends nothing", () => {
  const t = new StashEndTracker();
  assert.equal(t.fold({ op: op("none"), files: [] }), undefined);
  t.fold({ op: op("stash"), files: [row("a")] });
  assert.equal(t.fold({ op: op("none"), files: [row("a", { status: "resolved" })] }), undefined, "resolved rows still listed are not the end");
  assert.equal(t.watching, false);
});
