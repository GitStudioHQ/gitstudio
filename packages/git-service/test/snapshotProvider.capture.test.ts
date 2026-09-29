import { test } from "node:test";
import assert from "node:assert/strict";
import { noCopyClause, whyNoCopy, CLEAN_TREE, type Snapshot } from "../src/SnapshotProvider";
import { around, refused, snapRepo } from "./snapshotProvider.fixture";

// What a snapshot records up front, the words for a tree git won't copy, and
// the small questions the envelope asks of a snapshot (changed? pushed?).

test("the no-copy clause reads in the present for the question and the past for the answer", () => {
  assert.equal(noCopyClause("conflict", "now"), "while a conflict is unresolved");
  assert.equal(noCopyClause("conflict", "then"), "while a conflict was unresolved");
  assert.equal(noCopyClause("intent-to-add", "now"), "while a file is only marked to be added (git add -N)");
  assert.equal(noCopyClause("intent-to-add", "then"), "while a file was only marked to be added (git add -N)");
  assert.equal(noCopyClause("other", "now"), "as they are");
  assert.equal(noCopyClause("other", "then"), "as they were");
});

test("whyNoCopy: nothing to copy and a plain edit both say a copy can be kept", async () => {
  const r = snapRepo("why-clean");
  try {
    r.commit("base", "f.txt", "base\n");
    assert.equal(await r.snap.whyNoCopy(), undefined, "a clean tree needs no copy");
    r.write("f.txt", "edited\n");
    assert.equal(await r.snap.whyNoCopy(), undefined, "an ordinary edit can be copied");
  } finally {
    r.dispose();
  }
});

test("whyNoCopy names a conflict in progress and a git add -N file as the reasons git won't copy", async () => {
  const r = snapRepo("why-conflict");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    assert.notEqual(r.tryGit("merge", "side").code, 0, "the merge stops on a conflict");
    assert.equal(await r.snap.whyNoCopy(), "conflict");
    r.git("merge", "--abort");

    r.write("new.txt", "new\n");
    r.git("add", "-N", "new.txt");
    const made = r.tryGit("stash", "create");
    if (made.code === 0) {
      // Newer git copies an intent-to-add entry; then there is nothing to say.
      assert.equal(await r.snap.whyNoCopy(), undefined);
    } else {
      assert.equal(await r.snap.whyNoCopy(), "intent-to-add");
    }
  } finally {
    r.dispose();
  }
});

test("whyNoCopy says 'other' when git refuses the copy for no reason it names", async () => {
  const r = snapRepo("why-other");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "edited\n");
    const proc = r.intercepted((args) => (args[0] === "stash" && args[1] === "create" ? refused("fatal: out of cheese") : undefined));
    assert.equal(await proc.whyNoCopy(), "other");
    // The same answer through the free function, over the same process.
    assert.equal(await whyNoCopy(r.ctx.process), undefined, "real git copies it fine");
  } finally {
    r.dispose();
  }
});

test("a capture over only an untracked file keeps no copy — git stash create has nothing to stash", async () => {
  const r = snapRepo("untracked-only");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("scratch.txt", "mine\n");
    const snap = await r.snap.capture("Checkout");
    assert.equal(snap.stashSha, null);
    // Untracked files aren't in the fingerprint: nothing an undo runs deletes them.
    assert.equal(snap.scope?.tree, CLEAN_TREE);
  } finally {
    r.dispose();
  }
});

test("a capture during a conflict records why there is no copy, and the files that differed", async () => {
  const r = snapRepo("uncopied-capture");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.tryGit("merge", "side");
    const snap = await r.snap.capture("Delete branch side");
    assert.equal(snap.stashSha, null);
    assert.equal(snap.scope?.uncopied, "conflict");
    assert.deepEqual(Object.keys(snap.scope?.files ?? {}), ["f.txt"]);
    assert.equal(snap.scope?.op?.kind, "merge");
    assert.equal(snap.scope?.op?.head, r.git("rev-parse", "side"));
  } finally {
    r.dispose();
  }
});

test("a capture that names the branch it moves records where it was, and a deferred op keeps its onto — or none", async () => {
  const r = snapRepo("capture-opts");
  try {
    const base = r.commit("base");
    r.git("branch", "other");
    r.commit("M");
    const named = await r.snap.capture("Reset 'other'", { branch: "refs/heads/other" });
    assert.deepEqual(named.branch, { ref: "refs/heads/other", sha: base, checkedOut: false });
    assert.equal(named.scope?.refsOnly, true, "a branch that isn't checked out moves refs only");
    assert.equal(named.scope?.tree, "not the op's");

    const own = await r.snap.capture("Reset 'main'", { branch: "refs/heads/main" });
    assert.equal(own.branch?.checkedOut, true);
    assert.equal(own.scope?.refsOnly, undefined);

    const withOnto = await r.snap.capture("Rebase", { deferred: { onto: base } });
    assert.deepEqual(withOnto.scope?.deferred, { onto: base });
    const bare = await r.snap.capture("Rebase", { deferred: {} });
    assert.deepEqual(bare.scope?.deferred, {});
  } finally {
    r.dispose();
  }
});

test("a capture naming a branch that doesn't exist fails with git's words, not a half-made snapshot", async () => {
  const r = snapRepo("capture-missing");
  try {
    r.commit("base");
    await assert.rejects(r.snap.capture("Reset 'ghost'", { branch: "refs/heads/ghost" }), /git rev-parse --verify refs\/heads\/ghost\^\{commit\} failed:/);
  } finally {
    r.dispose();
  }
});

test("settle notes where the named branch was left — and nothing when the op deleted it", async () => {
  const r = snapRepo("settle-branch");
  try {
    r.commit("base");
    r.git("branch", "other");
    const moved = await around(r, "Reset 'other'", () => void r.git("branch", "-f", "other", "HEAD"), { branch: "refs/heads/other" });
    assert.equal(moved.branch?.after, r.git("rev-parse", "other"));
    const gone = await around(r, "Delete 'other'", () => void r.git("branch", "-D", "other"), { branch: "refs/heads/other" });
    assert.equal(gone.branch?.after, undefined);
    assert.equal(gone.scope?.settled?.moved[0]?.after, null);
  } finally {
    r.dispose();
  }
});

test("a snapshot from before scopes existed is settled as-is and refused by plan, in words", async () => {
  const r = snapRepo("old-snap");
  try {
    const head = r.commit("base");
    const old: Snapshot = { headSha: head, stashSha: null, ref: "main", label: "Commit" };
    await r.snap.settle(old);
    assert.equal(old.scope, undefined);
    assert.equal(r.snap.changed(old), true, "unknown counts as changed");
    const why = await r.snap.whyNotRestorable(old);
    assert.match(why ?? "", /older version of GitStudio/);
    await assert.rejects(r.snap.restore(old), /older version of GitStudio/);
  } finally {
    r.dispose();
  }
});

test("changed(): a deferred op counts before it happens, a stash the op pushed counts, an idle op doesn't", async () => {
  const r = snapRepo("changed");
  try {
    r.commit("base", "f.txt", "base\n");
    const deferred = await r.snap.capture("Rebase -i", { deferred: {} });
    assert.equal(r.snap.changed(deferred), true, "unsettled");
    await r.snap.settle(deferred);
    assert.equal(r.snap.changed(deferred), true, "deferred ops always count");
    assert.ok(deferred.scope?.branches, "and keep their before-list for the reflog read");

    r.write("f.txt", "work\n");
    const pushed = await around(r, "Stash", () => void r.git("stash", "push", "-q", "-m", "w"));
    assert.equal(pushed.scope?.settled?.pushed?.length, 1);
    assert.equal(r.snap.changed(pushed), true);

    const idle = await around(r, "Nothing", () => undefined);
    assert.equal(r.snap.changed(idle), false);
    assert.deepEqual(await r.snap.plan(idle), { kind: "nothing", reason: "everything it changed is already back as it was." });
  } finally {
    r.dispose();
  }
});

test("markAsked flags the scope, and does nothing to a snapshot without one", async () => {
  const r = snapRepo("asked");
  try {
    const head = r.commit("base");
    const snap = await r.snap.capture("Pop");
    r.snap.markAsked(snap);
    assert.equal(snap.scope?.asked, true);
    const old: Snapshot = { headSha: head, stashSha: null, ref: "main", label: "x" };
    r.snap.markAsked(old);
    assert.equal(old.scope, undefined);
  } finally {
    r.dispose();
  }
});

test("isPushed is false for a sha git can't look up", async () => {
  const r = snapRepo("ispushed");
  try {
    r.commit("base");
    assert.equal(await r.snap.isPushed("0".repeat(40)), false);
  } finally {
    r.dispose();
  }
});
