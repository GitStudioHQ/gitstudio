// The one question both products ask before a worktree is removed or
// forgotten — cell by cell: what it names, and what saying yes agrees to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreeRemovalQuestion, worktreeRemovalRefusal, type WorktreeRemovalFacts } from "../src/worktreeRemoval";

const base: WorktreeRemovalFacts = {
  kind: "present",
  label: "feat",
  shownPath: "~/wt/feat",
  branch: "feat",
  head: "0123456789abcdef",
  locked: false,
  changes: [],
};

test("clean: Remove, no --force, and the branch stays", () => {
  const q = worktreeRemovalQuestion(base);
  assert.equal(q.title, "Remove worktree feat?");
  assert.equal(q.confirmLabel, "Remove");
  assert.equal(q.discardChanges, false);
  assert.match(q.message, /Deletes its folder, ~\/wt\/feat\./);
  assert.match(q.message, /The branch feat and its commits stay\./);
});

test("dirty: names five of the files, counts the rest, and agrees to discard them", () => {
  const q = worktreeRemovalQuestion({ ...base, changes: ["a", "b", "c", "d", "e", "f", "g"] });
  assert.equal(q.confirmLabel, "Discard Changes and Remove");
  assert.equal(q.discardChanges, true);
  assert.match(q.message, /Its 7 uncommitted changes go with it/);
  assert.match(q.message, / {2}e\n {2}and 2 more/);
  assert.ok(!q.message.includes("  f"));
});

test("changes that could not be read are treated as there, and said so", () => {
  const q = worktreeRemovalQuestion({ ...base, changes: undefined });
  assert.equal(q.discardChanges, true);
  assert.match(q.message, /couldn't be read/);
});

test("locked: the reason is quoted, or its absence said; the label says Unlock", () => {
  assert.match(worktreeRemovalQuestion({ ...base, locked: true, lockReason: "on a USB drive" }).message, /It is locked: “on a USB drive”\./);
  const q = worktreeRemovalQuestion({ ...base, locked: true });
  assert.match(q.message, /It is locked, with no reason given\./);
  assert.equal(q.confirmLabel, "Unlock and Remove");
  assert.equal(q.discardChanges, false, "clean past a lock: unlock, then a remove git can still refuse");
  assert.equal(worktreeRemovalQuestion({ ...base, locked: true, changes: ["x"] }).confirmLabel, "Unlock, Discard Changes and Remove");
});

test("missing: Forget, nothing on disk changes, never a discard", () => {
  const q = worktreeRemovalQuestion({ ...base, kind: "missing", changes: ["ignored"] });
  assert.equal(q.title, "Forget worktree feat?");
  assert.equal(q.confirmLabel, "Forget");
  assert.equal(q.discardChanges, false);
  assert.match(q.message, /nothing on disk changes/);
  const locked = worktreeRemovalQuestion({ ...base, kind: "missing", locked: true, lockReason: "agent 42" });
  assert.equal(locked.confirmLabel, "Unlock and Forget");
  assert.match(locked.message, /“agent 42”\. Forgetting it unlocks it\./);
});

test("detached: names the commit instead of a branch", () => {
  const q = worktreeRemovalQuestion({ ...base, branch: undefined, label: "0123456 (detached)" });
  assert.match(q.message, /detached at 0123456/);
});

test("refusals say why, in words", () => {
  assert.match(worktreeRemovalRefusal("main", "main"), /main worktree/);
  assert.match(worktreeRemovalRefusal("current", "feat"), /This window has feat open/);
  assert.match(worktreeRemovalRefusal("notListed", "feat"), /no longer a worktree/);
});
