import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConflictFileView, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { STASH_FINISHED, StashEndTracker } from "../src/conflict/stashEnd";

// A conflicted stash pop, as the r0923 end-to-end run drove it: git keeps no
// operation for it, so resolving the last file reads as "nothing in
// progress" — and the dashboard closed itself. The tracker turns that moment
// into a finished card that says the stash entry is still in the list.

const side = (role: "yours" | "theirs", stage: 2 | 3, name: string) => ({ role, stage, name, paneTitle: name, description: name });
const op = (kind: OperationView["kind"], episode: string): OperationView => ({
  kind,
  title: "",
  yours: side("yours", 3, "stash"),
  theirs: side("theirs", 2, "main"),
  verbs: { abort: "Cancel" },
  canContinue: false,
  canSkip: false,
  episode,
});
const row = (path: string, over: Partial<ConflictFileView> = {}): ConflictFileView => ({ path, status: "pending", shape: "text", ...over });

test("the last stash conflict resolved: a finished card with the stash's rows, not an empty page", () => {
  const t = new StashEndTracker();
  assert.equal(t.fold({ op: op("stash", "stash:h"), files: [row("a.py"), row("b.py")] }), undefined);
  assert.equal(t.fold({ op: op("stash", "stash:h"), files: [row("a.py", { status: "resolved", choice: "yours" }), row("b.py")] }), undefined);
  // The last file staged: no markers, nothing unmerged — git says "none".
  const ended = t.fold({ op: op("none", "none"), files: [] });
  assert.ok(ended, "the end of the stash apply is shown");
  assert.equal(ended.finished, STASH_FINISHED);
  assert.match(ended.finished.text, /still in your stash list/);
  assert.deepEqual(
    ended.files.map((f) => [f.path, f.status, f.choice]),
    [
      ["a.py", "resolved", "yours"],
      ["b.py", "resolved", undefined],
    ],
  );
  // A re-read changes nothing (the host re-sends after every event).
  assert.deepEqual(t.fold({ op: op("none", "none"), files: [] }), ended);
  // Closing forgets it.
  t.clear();
  assert.equal(t.fold({ op: op("none", "none"), files: [] }), undefined);
});

test("a file edited clean but not yet staged (markers gone, still unmerged) is the same stash apply", () => {
  const t = new StashEndTracker();
  t.fold({ op: op("stash", "stash:h"), files: [row("a.py", { status: "resolved", choice: "theirs" }), row("b.py")] });
  assert.equal(t.fold({ op: op("none", "unmerged:h"), files: [row("b.py")] }), undefined);
  assert.equal(t.fold({ op: op("none", "none"), files: [] })?.files.length, 2);
});

test("nothing finished for what was never a stash apply, and another operation ends the memory", () => {
  const t = new StashEndTracker();
  assert.equal(t.fold({ op: op("none", "none"), files: [] }), undefined, "no conflicts, no stash: nothing to say");
  t.fold({ op: op("stash", "stash:h"), files: [row("a.py")] });
  assert.equal(t.fold({ op: { ...op("merge", "merge:x"), verbs: { continue: "Continue Merge", abort: "Abort Merge" } }, files: [row("m.txt")] }), undefined);
  assert.equal(t.fold({ op: op("none", "none"), files: [] }), undefined, "the merge that followed is not a stash");
  // A finished card lasts until new conflicts come.
  t.fold({ op: op("stash", "stash:h2"), files: [row("a.py")] });
  assert.ok(t.fold({ op: op("none", "none"), files: [] }));
  assert.equal(t.fold({ op: op("stash", "stash:h3"), files: [row("c.py")] }), undefined, "a new stash conflict replaces it");
});
