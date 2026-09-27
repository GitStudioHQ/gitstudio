// The one question both products ask before a worktree is removed or
// forgotten — cell by cell: what it names, and what saying yes agrees to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreeChangedSinceAsked, worktreeRemovalQuestion, worktreeRemovalRefusal, type WorktreeRemovalFacts } from "../src/worktreeRemoval";

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
  assert.match(q.message, /Its 7 uncommitted changes go with it, and nothing can bring them back:/);
  const one = worktreeRemovalQuestion({ ...base, changes: ["a.txt"] });
  assert.match(one.message, /Its 1 uncommitted change goes with it, and nothing can bring it back:\n {2}a\.txt/);
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

test("missing and locked: never 'nothing on disk changes' — a folder on a drive that isn't connected stops being a worktree", () => {
  // git's lock is for exactly this: a worktree on a drive or share that is not
  // always mounted. Forgotten while unplugged, the folder that comes back has
  // a .git file pointing at a record that is gone ("not a git repository").
  const q = worktreeRemovalQuestion({ ...base, kind: "missing", locked: true, lockReason: "on a USB drive" });
  assert.doesNotMatch(q.message, /nothing on disk changes/);
  assert.match(
    q.message,
    /^Its folder isn't there: ~\/wt\/feat\. Forgetting it removes git's record of the worktree\. If the folder is on a drive that isn't connected, it is no longer a worktree when the drive comes back\./,
  );
  assert.match(q.message, /It is locked: “on a USB drive”\. Forgetting it unlocks it\./);
  assert.equal(q.confirmLabel, "Unlock and Forget");
  assert.equal(q.danger, true);
});

test("changed since it was asked: says nothing was removed, and how to see what it holds", () => {
  assert.equal(
    worktreeChangedSinceAsked("feat"),
    "feat has uncommitted changes it didn't have when you were asked, so nothing was removed. Remove it again to see what it holds now.",
  );
});

test("detached: names the commit instead of a branch", () => {
  const q = worktreeRemovalQuestion({ ...base, branch: undefined, label: "0123456 (detached)" });
  assert.match(q.message, /detached at 0123456/);
});

test("refusals say why, in words", () => {
  assert.match(worktreeRemovalRefusal("main", "main"), /main worktree/);
  assert.match(worktreeRemovalRefusal("current", "feat"), /This window has feat open/);
  assert.match(worktreeRemovalRefusal("openInTab", "feat"), /^feat is open in another tab of this window, so it can't be removed — .*Close that tab first\.$/);
  assert.match(worktreeRemovalRefusal("notListed", "feat"), /no longer a worktree/);
});

test("the desktop holds a repository per TAB: its 'current' words say this tab, and a way out that works there", () => {
  const said = worktreeRemovalRefusal("current", "feat", "tab");
  assert.equal(
    said,
    "This tab has feat open, so it can't be removed from here — its folder would be deleted from under the tab. Close this tab, then remove it from another worktree of the repository.",
  );
  // "Open something else in this one" opens a new TAB now, and removing it from
  // there is the openInTab refusal: the desktop's words never send you there.
  assert.doesNotMatch(said, /window/);
  assert.equal(worktreeRemovalRefusal("current", "feat", "window"), worktreeRemovalRefusal("current", "feat"), "the extension's, by default");
});

test("an operation stopped in it is named, with what removing it abandons", () => {
  const merge = worktreeRemovalQuestion({ ...base, operation: "merge", changes: ["a.ts"] });
  assert.match(merge.message, /A merge is in progress in it\. Removing the worktree abandons the merge\./);
  assert.equal(merge.confirmLabel, "Discard Changes and Remove");

  // Mid-rebase the worktree is detached, and clean it goes with a plain
  // remove: the question is the only place the rebase is mentioned.
  const rebase = worktreeRemovalQuestion({ ...base, branch: undefined, label: "0123456 (detached)", operation: "rebase" });
  assert.match(rebase.message, /A rebase is in progress in it\. Removing the worktree abandons the rebase; the branch being rebased stays as it was before the rebase began\./);
  assert.doesNotMatch(rebase.message, /no branch checked out/);
  assert.equal(rebase.confirmLabel, "Remove");

  assert.doesNotMatch(worktreeRemovalQuestion({ ...base, kind: "missing", operation: "merge" }).message, /merge/);
});
