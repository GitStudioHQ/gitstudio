// What a Worktrees row SAYS and what it OFFERS, over the whole state table:
// kind × window × folder × head × sync × tree × operation × lock. Every cell
// is asserted by words (its facts, the one state the row shows beside its
// name, and the tooltip that says the rest) and by capabilities (what the
// row lets them do, each refusal with the reason it states).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  headWords,
  orderWorktreeRows,
  prunableCount,
  unpublishedTitle,
  worktreeCaps,
  worktreeFacts,
  worktreeState,
  worktreeTip,
  type WorktreeRow,
  type WorktreeRowStatus,
} from "../src/worktreesProtocol";
import { worktreeRemovalAsk, worktreeStashMessage, type WorktreeRemovalChoiceFacts } from "../src/worktreeRemoval";

const clean: WorktreeRowStatus = { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };

function row(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/src/wt/app-feat",
    name: "app-feat",
    relPath: "wt/app-feat",
    shownPath: "~/src/wt/app-feat",
    kind: "linked",
    branch: "feat",
    head: "0123456789abcdef0123456789abcdef01234567",
    current: false,
    locked: false,
    missing: false,
    unlinked: false,
    upstream: "origin/feat",
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    hasRemotes: true,
    defaultBranch: "origin/main",
    onDefaultBranch: false,
    status: clean,
    ...over,
  };
}
const words = (r: WorktreeRow): string[] => worktreeFacts(r).map((b) => b.text);
const ids = (r: WorktreeRow): string[] => worktreeFacts(r).map((b) => b.id);

// ── Kind × window ────────────────────────────────────────────────────────────

test("a plain linked worktree, clean and up to date: no facts, everything offered but Unlock and Push", () => {
  const r = row();
  assert.deepEqual(words(r), []);
  const c = worktreeCaps(r);
  assert.equal(c.expand, true);
  assert.deepEqual([c.openHere.ok, c.openNew.ok, c.reveal, c.terminal], [true, true, true, true]);
  assert.equal(c.pull.ok, true);
  assert.deepEqual(c.push, { ok: false, why: "Nothing to push — it is up to date with origin/feat." });
  assert.deepEqual([c.lock.ok, c.unlock.ok, c.remove.ok, c.forget], [true, false, true, false]);
  assert.deepEqual(c.unlock, { ok: false, why: "It isn't locked." });
});

test("main worktree: says so, never removed or locked", () => {
  const r = row({ kind: "main", branch: "main", upstream: "origin/main", onDefaultBranch: true });
  assert.deepEqual(words(r), ["Main worktree"]);
  const c = worktreeCaps(r);
  assert.equal(c.remove.ok, false);
  assert.match((c.remove as { why: string }).why, /main worktree holds the repository itself/);
  assert.deepEqual(c.lock, { ok: false, why: "The main worktree holds the repository itself, so git can't lock it." }, "shown, with why — as Remove is");
});

test("this window's worktree: its first fact, no Open, no Remove — both say why", () => {
  const r = row({ current: true });
  assert.deepEqual(ids(r), ["current"]);
  const c = worktreeCaps(r);
  assert.deepEqual(c.openHere, { ok: false, why: "This window has it open." });
  assert.deepEqual(c.openNew, { ok: false, why: "This window has it open." });
  assert.equal(c.remove.ok, false);
  assert.match((c.remove as { why: string }).why, /deleted from under the window/);
});

test("this window's worktree that is also the main one: both facts, this window first", () => {
  assert.deepEqual(ids(row({ kind: "main", current: true })), ["current", "main"]);
});

test("a bare repository's entry: no facts, not expandable, nothing to do but Reveal", () => {
  const r = row({ kind: "bare", branch: undefined, upstream: undefined, status: undefined });
  assert.deepEqual(words(r), []);
  assert.equal(headWords(r), "Bare repository");
  const c = worktreeCaps(r);
  assert.equal(c.expand, false);
  assert.deepEqual([c.openHere.ok, c.pull.ok, c.push.ok, c.remove.ok, c.lock.ok, c.forget], [false, false, false, false, false, false]);
  assert.equal(c.reveal, true);
});

// ── Folder × lock ────────────────────────────────────────────────────────────

test("missing folder: Folder missing, only Forget (and Unlock when locked)", () => {
  const r = row({ missing: true, status: undefined });
  assert.deepEqual(words(r), ["Folder missing"]);
  const c = worktreeCaps(r);
  assert.equal(c.expand, false);
  assert.deepEqual([c.openHere.ok, c.openNew.ok, c.reveal, c.terminal, c.pull.ok, c.push.ok, c.remove.ok], [false, false, false, false, false, false, false]);
  assert.equal(c.forget, true);
  assert.deepEqual(c.lock, { ok: false, why: "Its folder is missing." }, "Lock… is shown, and says why not");
  assert.equal(c.unlock.ok, false);
  const locked = row({ missing: true, locked: true, lockReason: "on a USB drive", status: undefined });
  assert.deepEqual(words(locked), ["Locked: on a USB drive", "Folder missing"]);
  assert.equal(worktreeCaps(locked).unlock.ok, true);
  assert.match(worktreeFacts(locked)[1].tip, /drive that isn't connected/);
});

test("a folder that isn't a worktree any more (its .git gone): says so in words, and offers only Forget and Reveal", () => {
  const r = row({ unlinked: true, unlinkedWhy: "gitdir file points to non-existent location", status: undefined });
  assert.deepEqual(words(r), ["Not a worktree"]);
  const fact = worktreeFacts(r)[0];
  assert.equal(fact.tone, "danger");
  assert.equal(
    fact.tip,
    "Its folder is there, but it isn't a worktree any more: its .git file is gone. Forget it to clear it from the list — the folder and its files stay.",
  );
  const c = worktreeCaps(r);
  assert.equal(c.expand, false, "its tree is never read, so there is nothing to open to");
  const gone = { ok: false, why: "It isn't a worktree any more — its .git file is gone." };
  assert.deepEqual([c.openHere, c.openNew, c.pull, c.push], [gone, gone, gone, gone]);
  assert.deepEqual([c.reveal, c.terminal], [true, false], "its folder can still be shown");
  assert.equal(c.remove.ok, false);
  assert.equal(c.forget, true);
  const damaged = row({ unlinked: true, unlinkedWhy: "invalid gitdir file", status: undefined });
  assert.match(worktreeFacts(damaged)[0].tip, /git says: “invalid gitdir file”/);
  const locked = row({ unlinked: true, locked: true, lockReason: "agent 9", status: undefined });
  assert.deepEqual(words(locked), ["Locked: agent 9", "Not a worktree"]);
  assert.match(worktreeFacts(locked)[1].tip, /its \.git file is gone/, "a locked one: git gives no reason, the folder does");
  assert.equal(worktreeCaps(locked).forget, true);
});

test("locked with a reason, and without one: the reason is on the row; Lock becomes Unlock", () => {
  const r = row({ locked: true, lockReason: "claude agent a2c9 (pid 73264)" });
  assert.deepEqual(words(r), ["Locked: claude agent a2c9 (pid 73264)"]);
  assert.match(worktreeFacts(r)[0].tip, /won't prune, move or remove it/);
  assert.deepEqual([worktreeCaps(r).lock.ok, worktreeCaps(r).unlock.ok], [false, true]);
  assert.deepEqual(words(row({ locked: true })), ["Locked"]);
});

// ── Head × sync ──────────────────────────────────────────────────────────────

test("sync against an upstream: ahead, behind, diverged — words, and Push only when there is something to push", () => {
  assert.deepEqual(words(row({ ahead: 2 })), ["2 to push"]);
  assert.equal(worktreeCaps(row({ ahead: 2 })).push.ok, true);
  assert.deepEqual(words(row({ behind: 1 })), ["1 to pull"]);
  assert.equal(worktreeCaps(row({ behind: 1 })).push.ok, false);
  const diverged = row({ ahead: 1, behind: 3 });
  assert.deepEqual(words(diverged), ["1 to push, 3 to pull"]);
  assert.equal(worktreeFacts(diverged)[0].tone, "warn");
  assert.match(worktreeFacts(diverged)[0].tip, /have diverged/);
});

test("upstream gone: said, and Pull says why not; Push publishes again", () => {
  const r = row({ upstreamGone: true, ahead: 0 });
  assert.deepEqual(words(r), ["Upstream gone"]);
  assert.deepEqual(worktreeCaps(r).pull, { ok: false, why: "Its upstream, origin/feat, is gone from the remote." });
  assert.equal(worktreeCaps(r).push.ok, true);
});

test("no upstream with remotes: No upstream, or N unpublished once counted (one fact); Push publishes, Pull says why not", () => {
  const r = row({ upstream: undefined, status: { ...clean, unpublished: 3 } });
  // "unpublished", never "not pushed": beside "3 to push" (ahead of an
  // upstream) the two read as one thing said two ways.
  assert.deepEqual(words(r), ["3 unpublished"]);
  assert.match(worktreeFacts(r)[0].tip, /^No upstream: 3 commits no remote has yet/);
  assert.equal(worktreeCaps(r).push.ok, true);
  assert.deepEqual(worktreeCaps(r).pull, { ok: false, why: "Its branch has no upstream to pull from." });
  assert.deepEqual(words(row({ upstream: undefined, status: { ...clean, unpublished: 0 } })), ["No upstream"]);
  assert.equal(unpublishedTitle(r), "Not on any remote");
});

test("no remote at all: N not on the default branch; Push and Pull say the repository has no remote", () => {
  const r = row({ upstream: undefined, hasRemotes: false, defaultBranch: "main", status: { ...clean, unpublished: 2 } });
  assert.deepEqual(words(r), ["2 not on main"]);
  assert.deepEqual(worktreeCaps(r).push, { ok: false, why: "The repository has no remote to push to." });
  assert.deepEqual(worktreeCaps(r).pull, { ok: false, why: "The repository has no remote to pull from." });
  assert.equal(unpublishedTitle(r), "Not on main");
  const onMain = row({ kind: "main", branch: "main", upstream: undefined, hasRemotes: false, defaultBranch: "main", onDefaultBranch: true });
  assert.equal(unpublishedTitle(onMain), undefined);
});

test("detached: 'detached at <sha>', no sync facts, no Pull or Push — each saying why", () => {
  const r = row({ branch: undefined, upstream: undefined, ahead: 0 });
  assert.equal(headWords(r), "detached at 0123456");
  assert.deepEqual(words(r), []);
  assert.match((worktreeCaps(r).pull as { why: string }).why, /nothing to pull into/);
  assert.match((worktreeCaps(r).push as { why: string }).why, /nothing to push/);
  assert.equal(unpublishedTitle(r), "Not on any remote");
});

// ── Tree × operation ─────────────────────────────────────────────────────────

test("uncommitted changes: one 'N changed' fact whose tip splits staged / unstaged / untracked", () => {
  const r = row({ status: { changed: 5, staged: 2, unstaged: 2, untracked: 1, conflicted: 0 } });
  assert.deepEqual(words(r), ["5 changed"]);
  assert.equal(worktreeFacts(r)[0].tip, "5 uncommitted changes: 2 staged, 2 unstaged, 1 untracked.");
});

test("stopped in a merge with a conflict: said with the count; Pull and Push refuse with the reason", () => {
  const r = row({ status: { changed: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 1, operation: "merge" }, ahead: 1 });
  assert.deepEqual(words(r), ["Merge in progress · 1 conflict", "1 changed", "1 to push"]);
  assert.equal(worktreeFacts(r)[0].tone, "danger");
  assert.deepEqual(worktreeCaps(r).pull, { ok: false, why: "A merge is in progress in it — continue or abort it first." });
  assert.deepEqual(worktreeCaps(r).push, { ok: false, why: "A merge is in progress in it — continue or abort it first." });
});

test("each operation has its words; a rebase names the branch it is rebasing", () => {
  const op = (operation: WorktreeRowStatus["operation"]) => words(row({ status: { ...clean, operation } }))[0];
  assert.equal(op("rebase"), "Rebase stopped");
  assert.equal(op("cherry-pick"), "Cherry-pick stopped");
  assert.equal(op("revert"), "Revert stopped");
  assert.equal(op("am"), "Applying patches");
  const rebasing = row({ branch: undefined, upstream: undefined, status: { ...clean, operation: "rebase", rebasing: "feat" } });
  assert.equal(headWords(rebasing), "feat (rebasing)");
  // git lists it detached, but what stops Pull and Push is the rebase — said first.
  const why = { ok: false, why: "A rebase is stopped in it — continue or abort it first." };
  assert.deepEqual([worktreeCaps(rebasing).pull, worktreeCaps(rebasing).push], [why, why]);
});

test("files left unmerged with no operation (a stash that conflicted): N conflicts", () => {
  assert.deepEqual(words(row({ status: { ...clean, changed: 2, conflicted: 2 } })), ["2 conflicts", "2 changed"]);
  assert.equal(worktreeFacts(row({ status: { ...clean, changed: 2, conflicted: 2 } }))[0].tip, "2 files left unmerged in it. Open the worktree to resolve them.");
  assert.equal(worktreeFacts(row({ status: { ...clean, changed: 1, conflicted: 1 } }))[0].tip, "1 file left unmerged in it. Open the worktree to resolve it.");
});

test("before tier 1 lands a row says only what tier 0 knows — no guessing 'clean'", () => {
  assert.deepEqual(words(row({ status: undefined, ahead: 1 })), ["1 to push"]);
  assert.deepEqual(words(row({ status: undefined, upstream: undefined })), ["No upstream"]);
});

// ── The one state a row shows ────────────────────────────────────────────────

test("the state beside the name: the most pressing fact, in a few lower-case words — or nothing", () => {
  const st = (over: Partial<WorktreeRow>) => {
    const s = worktreeState(row(over));
    return s ? `${s.text} (${s.tone})` : "";
  };
  const dirty = { ...clean, changed: 3, staged: 1, unstaged: 2 };
  const table: [string, Partial<WorktreeRow>, string][] = [
    ["clean and up to date", {}, ""],
    ["this window's, clean", { current: true }, ""],
    ["the main one, clean", { kind: "main", branch: "main", upstream: "origin/main", onDefaultBranch: true }, ""],
    ["a bare repository", { kind: "bare", branch: undefined, upstream: undefined, status: undefined }, ""],
    ["detached", { branch: undefined, upstream: undefined }, ""],
    ["no upstream, nothing unpublished", { upstream: undefined }, ""],
    ["tier 1 not read yet", { status: undefined }, ""],
    ["ahead", { ahead: 2 }, "2 to push (muted)"],
    ["behind", { behind: 4 }, "4 to pull (muted)"],
    ["diverged", { ahead: 1, behind: 3 }, "diverged (muted)"],
    ["upstream gone", { upstreamGone: true }, "upstream gone (muted)"],
    ["no upstream, 3 no remote has", { upstream: undefined, status: { ...clean, unpublished: 3 } }, "3 unpublished (muted)"],
    ["no remote, 2 not on main", { upstream: undefined, hasRemotes: false, defaultBranch: "main", status: { ...clean, unpublished: 2 } }, "2 not on main (muted)"],
    ["locked, clean", { locked: true, lockReason: "agent 9" }, "locked (muted)"],
    ["changed", { status: dirty }, "3 changed (muted)"],
    ["changed beats to push", { status: dirty, ahead: 2 }, "3 changed (muted)"],
    ["changed beats locked", { status: dirty, locked: true }, "3 changed (muted)"],
    ["to push beats locked", { ahead: 1, locked: true }, "1 to push (muted)"],
    ["a merge beats its changes", { status: { ...clean, changed: 2, conflicted: 1, operation: "merge" }, ahead: 1 }, "merge in progress (attention)"],
    ["a rebase", { branch: undefined, upstream: undefined, status: { ...clean, operation: "rebase", rebasing: "feat" } }, "rebase stopped (attention)"],
    ["a cherry-pick", { status: { ...clean, operation: "cherry-pick" } }, "cherry-pick stopped (attention)"],
    ["a revert", { status: { ...clean, operation: "revert" } }, "revert stopped (attention)"],
    ["git am", { status: { ...clean, operation: "am" } }, "applying patches (attention)"],
    ["unmerged with no operation", { status: { ...clean, changed: 2, conflicted: 2 } }, "2 conflicts (attention)"],
    ["one unmerged file", { status: { ...clean, changed: 1, conflicted: 1 } }, "1 conflict (attention)"],
    ["folder missing", { missing: true, status: undefined }, "folder missing (attention)"],
    ["folder missing beats its lock", { missing: true, locked: true, lockReason: "on a USB drive", status: undefined }, "folder missing (attention)"],
    ["not a worktree any more", { unlinked: true, status: undefined }, "not a worktree (attention)"],
    ["this window's, dirty", { current: true, status: dirty }, "3 changed (muted)"],
  ];
  for (const [what, over, want] of table) assert.equal(st(over), want, what);
});

test("a state that needs attention has one word for a narrow sidebar, said before the name gives way; a routine one has none", () => {
  const short = (over: Partial<WorktreeRow>) => {
    const s = worktreeState(row(over));
    return s ? [s.text, s.short ?? ""] : [];
  };
  const table: [string, Partial<WorktreeRow>, string[]][] = [
    ["a merge", { status: { ...clean, operation: "merge" } }, ["merge in progress", "merging"]],
    ["a rebase", { status: { ...clean, operation: "rebase" } }, ["rebase stopped", "rebasing"]],
    ["a cherry-pick", { status: { ...clean, operation: "cherry-pick" } }, ["cherry-pick stopped", "cherry-picking"]],
    ["a revert", { status: { ...clean, operation: "revert" } }, ["revert stopped", "reverting"]],
    ["git am", { status: { ...clean, operation: "am" } }, ["applying patches", "applying"]],
    ["folder missing", { missing: true, status: undefined }, ["folder missing", "missing"]],
    ["not a worktree", { unlinked: true, status: undefined }, ["not a worktree", "unlinked"]],
    ["conflicts: already a word and a number", { status: { ...clean, changed: 2, conflicted: 2 } }, ["2 conflicts", ""]],
    ["routine: goes whole instead", { status: { ...clean, changed: 3, unstaged: 3 } }, ["3 changed", ""]],
  ];
  for (const [what, over, want] of table) assert.deepEqual(short(over), want, what);
  for (const [what, over] of table) {
    const s = worktreeState(row(over));
    if (s?.short) assert.ok(s.short.length < s.text.length, `${what}: shorter`);
  }
});

test("the tooltip names the folder once: no fact says its path again", () => {
  const rows: [string, WorktreeRow][] = [
    ["missing", row({ missing: true, status: undefined })],
    ["missing, locked", row({ missing: true, locked: true, lockReason: "on a USB drive", status: undefined })],
    ["not a worktree", row({ unlinked: true, unlinkedWhy: "gitdir file points to non-existent location", status: undefined })],
    ["not a worktree, locked", row({ unlinked: true, locked: true, lockReason: "agent 9", status: undefined })],
    ["clean", row()],
    ["dirty, this window's, the main one", row({ current: true, kind: "main", ahead: 2, status: { ...clean, changed: 5, staged: 2, unstaged: 2, untracked: 1 } })],
    ["merging", row({ status: { ...clean, changed: 1, conflicted: 1, operation: "merge" } })],
  ];
  for (const [what, r] of rows) {
    const lines = worktreeTip(r).split("\n");
    assert.equal(lines[0], r.shownPath, `${what}: the folder first`);
    assert.deepEqual(lines.slice(1).filter((l) => l.includes(r.shownPath)), [], `${what}: said once`);
  }
  assert.equal(worktreeFacts(row({ missing: true, status: undefined }))[0].tip, "Its folder isn't there. Forget it to clear it from the list.");
});

test("the state never says what the name already does: 'This window' and 'Main worktree' are the tooltip's", () => {
  for (const over of [{ current: true }, { kind: "main" as const }, { kind: "main" as const, current: true }]) {
    assert.equal(worktreeState(row(over)), undefined);
    assert.ok(ids(row(over)).length > 0, "still facts, for the tooltip");
  }
});

test("the tooltip: where the folder is, then every fact as a sentence — the state's too, with more than the row can say", () => {
  assert.equal(worktreeTip(row()), "~/src/wt/app-feat\nUp to date with origin/feat.");
  assert.equal(
    worktreeTip(row({ current: true, kind: "main", ahead: 2, status: { ...clean, changed: 5, staged: 2, unstaged: 2, untracked: 1 } })),
    [
      "~/src/wt/app-feat",
      "Current — open in this window.",
      "Main worktree — the repository's own folder.",
      "5 uncommitted changes: 2 staged, 2 unstaged, 1 untracked.",
      "2 commits not pushed to origin/feat.",
    ].join("\n"),
  );
  const agent = worktreeTip(row({ locked: true, lockReason: "claude agent a2c9 (pid 73264)", upstream: undefined, status: { ...clean, unpublished: 4 } }));
  assert.match(agent, /^~\/src\/wt\/app-feat\nLocked: “claude agent a2c9 \(pid 73264\)”\. Git won't prune, move or remove it until it is unlocked\.\nNo upstream: 4 commits no remote has yet\. Push publishes the branch\.$/);
  assert.doesNotMatch(worktreeTip(row({ missing: true, status: undefined })), /Up to date/, "a folder that is gone is up to date with nothing");
  assert.doesNotMatch(worktreeTip(row({ ahead: 1 })), /Up to date/);
});

// ── The list ─────────────────────────────────────────────────────────────────

test("order: this window, the main worktree, the rest by name (numbers read as numbers), the missing last", () => {
  const rows = [
    row({ path: "/b", name: "b-10" }),
    row({ path: "/gone", name: "a-gone", missing: true }),
    row({ path: "/unlinked", name: "a-unlinked", unlinked: true }),
    row({ path: "/main", name: "zz-main", kind: "main" }),
    row({ path: "/b2", name: "b-9" }),
    row({ path: "/here", name: "m-here", current: true }),
  ];
  assert.deepEqual(orderWorktreeRows(rows).map((r) => r.path), ["/here", "/main", "/b2", "/b", "/gone", "/unlinked"]);
});

test("Prune counts the ones git would prune — missing, or not a worktree any more — never a locked one", () => {
  assert.equal(prunableCount([row({ missing: true }), row({ missing: true, locked: true }), row()]), 1);
  assert.equal(prunableCount([row({ unlinked: true }), row({ unlinked: true, locked: true }), row({ missing: true })]), 2);
});

// ── The removal question with choices ────────────────────────────────────────

const facts: WorktreeRemovalChoiceFacts = {
  kind: "present",
  label: "feat",
  shownPath: "~/wt/feat",
  branch: "feat",
  head: "0123456789abcdef",
  locked: false,
  changes: [],
};

test("clean: one way, Remove — and 'Also delete the branch' only when it is merged", () => {
  const a = worktreeRemovalAsk(facts);
  assert.deepEqual(a.choices.map((c) => c.id), ["remove"]);
  assert.equal(a.deleteBranch, undefined);
  const merged = worktreeRemovalAsk({ ...facts, mergedInto: "origin/main" });
  assert.deepEqual(merged.deleteBranch, {
    label: "Also delete the branch feat",
    description: "It is fully merged into origin/main, so no commit is lost.",
  });
});

test("dirty: Stash & Remove first (the safe default), Discard Changes and Remove second, danger", () => {
  const a = worktreeRemovalAsk({ ...facts, changes: ["a.txt", "b.txt"] });
  assert.deepEqual(a.choices.map((c) => [c.id, c.label, c.danger]), [
    ["stash", "Stash & Remove", false],
    ["discard", "Discard Changes and Remove", true],
  ]);
  assert.match(a.message, /It has 2 uncommitted changes:\n {2}a\.txt\n {2}b\.txt/);
  assert.doesNotMatch(a.message, /go with it/);
  assert.match(a.choices[0].description, /stash you can apply from any worktree/);
});

test("the words agree with the count: one change goes and is deleted, two go and are", () => {
  const one = worktreeRemovalAsk({ ...facts, changes: ["a.txt"] });
  assert.deepEqual(one.choices.map((c) => c.description), [
    "Its 1 uncommitted change goes into a stash you can apply from any worktree of this repository; then its folder is deleted.",
    "Its 1 uncommitted change is deleted with its folder, and nothing can bring it back.",
  ]);
  assert.match(one.message, /It has 1 uncommitted change:\n {2}a\.txt/);
  const two = worktreeRemovalAsk({ ...facts, changes: ["a.txt", "b.txt"] });
  assert.deepEqual(two.choices.map((c) => c.description), [
    "Its 2 uncommitted changes go into a stash you can apply from any worktree of this repository; then its folder is deleted.",
    "Its 2 uncommitted changes are deleted with its folder, and nothing can bring them back.",
  ]);
  const unread = worktreeRemovalAsk({ ...facts, changes: undefined });
  assert.equal(unread.choices[0].description, "Its uncommitted changes are deleted with its folder, and nothing can bring them back.");
});

test("dirty and locked: both choices unlock first, and say so", () => {
  const a = worktreeRemovalAsk({ ...facts, changes: ["a.txt"], locked: true, lockReason: "agent 7" });
  assert.deepEqual(a.choices.map((c) => c.label), ["Unlock, Stash & Remove", "Unlock, Discard Changes and Remove"]);
  assert.match(a.message, /It is locked: “agent 7”/);
});

test("unmerged files, or changes that couldn't be read: no Stash & Remove, and the question says why", () => {
  const u = worktreeRemovalAsk({ ...facts, changes: ["a.txt"], unmerged: 1, operation: "merge" });
  assert.deepEqual(u.choices.map((c) => c.id), ["discard"]);
  assert.match(u.message, /A file is left unmerged in it, which git can't stash\./);
  assert.match(u.message, /abandons the merge/);
  const unread = worktreeRemovalAsk({ ...facts, changes: undefined });
  assert.deepEqual(unread.choices.map((c) => c.id), ["discard"]);
  assert.match(unread.message, /can't be stashed without knowing what they are/);
});

test("missing: Forget (Unlock and Forget when locked)", () => {
  assert.deepEqual(worktreeRemovalAsk({ ...facts, kind: "missing" }).choices.map((c) => c.label), ["Forget"]);
  assert.deepEqual(worktreeRemovalAsk({ ...facts, kind: "missing", locked: true }).choices.map((c) => c.label), ["Unlock and Forget"]);
});

test("not a worktree any more: Forget — nothing on disk changes (Unlock and Forget when locked)", () => {
  const a = worktreeRemovalAsk({ ...facts, kind: "stale", changes: ["main's.txt"] });
  assert.equal(a.title, "Forget worktree feat?");
  assert.deepEqual(a.choices.map((c) => [c.id, c.label, c.danger]), [["forget", "Forget", false]]);
  assert.equal(a.choices[0].description, "Removes git's record of the worktree; the folder stays.");
  assert.match(a.message, /^Its folder, ~\/wt\/feat, isn't a worktree any more: its \.git file is gone\. Forgetting it removes git's record of the worktree; the folder and everything in it stay\./);
  assert.doesNotMatch(a.message, /main's\.txt|Deletes/, "never a change list, never a delete");
  assert.deepEqual(worktreeRemovalAsk({ ...facts, kind: "stale", locked: true }).choices.map((c) => c.label), ["Unlock and Forget"]);
});

test("the stash says where it came from", () => {
  assert.equal(worktreeStashMessage("feat", "~/wt/feat"), "Changes from worktree feat (~/wt/feat), stashed before removing it");
});
