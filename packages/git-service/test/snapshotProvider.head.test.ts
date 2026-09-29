import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { removeTempRepo } from "./tmpRepo";
import { around, snapRepo, words } from "./snapshotProvider.fixture";

// Undo and HEAD: switching back to what HEAD was on, moving HEAD's own branch
// (or a detached HEAD) back — and every reason that is refused instead.

const short = (sha: string) => sha.slice(0, 7);

// ── Switching back ───────────────────────────────────────────────────────────

test("switching back is refused when the branch left behind has since been deleted", async () => {
  const r = snapRepo("gone-branch");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("F");
    const snap = await around(r, "Checkout main", () => void r.git("checkout", "-q", "main"));
    r.git("branch", "-D", "feature");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      "'feature' is not in this repository any more, so there is nothing to switch back to.",
    );
  } finally {
    r.dispose();
  }
});

test("switching back is refused while the branch is checked out in another worktree, which is named", async () => {
  const r = snapRepo("wt-branch");
  const wt = mkdtempSync(join(tmpdir(), "gs-snapprov-wt-"));
  removeTempRepo(wt);
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("F");
    const snap = await around(r, "Checkout main", () => void r.git("checkout", "-q", "main"));
    r.git("worktree", "add", "-q", wt, "feature");
    const why = (await r.snap.whyNotRestorable(snap)) ?? "";
    assert.match(why, /^'feature' is checked out in another worktree, at .+, so this one can't switch back to it\.$/);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/main", "refused, so nothing moved");
  } finally {
    r.tryGit("worktree", "remove", "--force", wt);
    removeTempRepo(wt);
    r.dispose();
  }
});

test("a branch whose name git would read as an option is never switched to — refused with a way out", async () => {
  const r = snapRepo("dash-branch");
  try {
    r.commit("base");
    // `git branch` won't make such a name, but a ref can hold one.
    r.git("update-ref", "refs/heads/-x", "HEAD");
    r.git("symbolic-ref", "HEAD", "refs/heads/-x");
    const snap = await around(r, "Checkout main", () => void r.git("checkout", "-q", "main"));
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      "'-x' can't be switched to safely — git would read its name as an option. Rename it, then undo.",
    );
  } finally {
    r.dispose();
  }
});

test("a checkout from a detached HEAD goes back to that commit, carrying what is uncommitted now", async () => {
  const r = snapRepo("from-detached");
  try {
    const base = r.commit("base", "f.txt", "base\n");
    r.commit("M", "m.txt");
    r.git("checkout", "-q", "--detach", base);
    const snap = await around(r, "Checkout main", () => void r.git("checkout", "-q", "main"));
    assert.equal(snap.ref, null);
    assert.deepEqual(words(await r.snap.plan(snap)), [`Go back to the detached HEAD at ${short(base)}.`]);
    r.write("f.txt", "edited since\n");
    assert.deepEqual(words(await r.snap.plan(snap)), [
      `Go back to the detached HEAD at ${short(base)}.`,
      "Your uncommitted changes come along.",
    ]);
    await r.snap.restore(snap);
    assert.equal(r.tryGit("symbolic-ref", "-q", "HEAD").code, 1, "detached again");
    assert.equal(r.git("rev-parse", "HEAD"), base);
    assert.equal(r.read("f.txt"), "edited since\n", "the edit came along");
  } finally {
    r.dispose();
  }
});

test("a switch the checkout step can't make is reported with git's reason", async () => {
  const r = snapRepo("switch-fails");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    const snap = await around(r, "Checkout main", () => void r.git("checkout", "-q", "main"));
    const p = r.intercepted((args) => (args[0] === "checkout" ? { code: 1, stdout: "", stderr: "error: nope\n" } : undefined));
    await assert.rejects(p.restore(snap), { message: "Undo couldn't switch back to 'feature': error: nope" });
    const q = r.intercepted((args) => (args[0] === "checkout" ? { code: 1, stdout: "", stderr: "" } : undefined));
    await assert.rejects(q.restore(snap), { message: "Undo couldn't switch back to 'feature': git refused" });
    // A detached target is named by its commit.
    const sha = r.git("rev-parse", "HEAD");
    await assert.rejects(q.execute(snap, [{ do: "switch", ref: null, sha }]), { message: `Undo couldn't switch back to ${short(sha)}: git refused` });
  } finally {
    r.dispose();
  }
});

// ── A detached HEAD moved ────────────────────────────────────────────────────

test("commits made on a detached HEAD by the op go back, and HEAD is said as HEAD, not a branch", async () => {
  const r = snapRepo("detached-moved");
  try {
    r.commit("base");
    const at = r.commit("A");
    r.git("checkout", "-q", "--detach");
    const snap = await around(r, "Cherry-pick", () => void r.commit("picked"));
    assert.deepEqual(snap.scope?.settled?.published, [], "the detached move asks who has it: nobody");
    assert.deepEqual(words(await r.snap.plan(snap)), [`HEAD goes back to ${short(at)}.`]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), at);
    assert.equal(r.tryGit("symbolic-ref", "-q", "HEAD").code, 1);
  } finally {
    r.dispose();
  }
});

test("a detached HEAD already put back by hand leaves nothing to undo", async () => {
  const r = snapRepo("detached-back");
  try {
    r.commit("base");
    const at = r.commit("A");
    r.git("checkout", "-q", "--detach");
    const snap = await around(r, "Cherry-pick", () => void r.commit("picked"));
    r.git("checkout", "-q", "--detach", at);
    assert.equal((await r.snap.plan(snap)).kind, "nothing");
  } finally {
    r.dispose();
  }
});

test("a detached HEAD moved by the op but on a branch now is refused, with how to get back", async () => {
  const r = snapRepo("detached-left");
  try {
    r.commit("base");
    r.git("checkout", "-q", "--detach");
    const snap = await around(r, "Cherry-pick", () => void r.commit("picked"));
    const after = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "-b", "keep");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `HEAD was detached when "Cherry-pick" ran, and it isn't now. Detach it at ${short(after)} again, then undo.`,
    );
  } finally {
    r.dispose();
  }
});

// ── HEAD's branch moved ──────────────────────────────────────────────────────

test("HEAD's branch put back by hand leaves nothing to undo", async () => {
  const r = snapRepo("branch-back");
  try {
    const base = r.commit("base");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    r.git("reset", "-q", "--hard", base);
    assert.deepEqual(await r.snap.plan(snap), { kind: "nothing", reason: "everything it changed is already back as it was." });
  } finally {
    r.dispose();
  }
});

test("HEAD's branch deleted by the op can't be put back from under HEAD — refused, nothing changed", async () => {
  const r = snapRepo("head-deleted");
  try {
    r.commit("base");
    const snap = await around(r, "Delete", () => void r.git("update-ref", "-d", "refs/heads/main"));
    assert.equal(snap.scope?.settled?.headSha, "", "HEAD names no commit now");
    assert.equal(await r.snap.whyNotRestorable(snap), `"Delete" changed 'main' in a way Undo can't put back. Nothing was changed.`);
  } finally {
    r.dispose();
  }
});

test("HEAD's branch moved by the op, but another branch checked out now: refused, and told to check it out", async () => {
  const r = snapRepo("branch-left");
  try {
    r.commit("base");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    r.git("checkout", "-q", "-b", "elsewhere");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `'main' was checked out here when "Commit" ran, and it isn't now. Check it out again, then undo.`,
    );
  } finally {
    r.dispose();
  }
});

test("HEAD's branch deleted since the op: 'it is at nothing now'", async () => {
  const r = snapRepo("branch-nothing");
  try {
    r.commit("base");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    r.git("update-ref", "-d", "refs/heads/main");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      "'main' has moved since (it is at nothing now), and putting it back would throw that away.",
    );
  } finally {
    r.dispose();
  }
});

test("several untracked files where going back puts files are all refused by name — the first three, then an ellipsis", async () => {
  const r = snapRepo("untracked-many");
  try {
    r.commit("base");
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit("two files");
    const snap2 = await around(r, "Reset (--hard)", () => void r.git("reset", "-q", "--hard", "HEAD~1"));
    r.write("a.txt", "mine\n");
    r.write("b.txt", "mine\n");
    assert.match(
      (await r.snap.whyNotRestorable(snap2)) ?? "",
      /^2 files \('a\.txt', 'b\.txt'\) are untracked here, and going back to [0-9a-f]{7} would overwrite them\. Move them aside, then undo\.$/,
    );
    // An untracked copy identical to the one going back is not in the way.
    r.write("b.txt", "b\n");
    assert.match((await r.snap.whyNotRestorable(snap2)) ?? "", /^'a\.txt' is untracked here/);
    r.write("a.txt", "a\n");
    assert.equal(await r.snap.whyNotRestorable(snap2), undefined);
  } finally {
    r.dispose();
  }
  const s = snapRepo("untracked-four");
  try {
    s.commit("base");
    for (const f of ["a", "b", "c", "d"]) s.write(`${f}.txt`, `${f}\n`);
    s.commit("four files");
    const snap = await around(s, "Reset (--hard)", () => void s.git("reset", "-q", "--hard", "HEAD~1"));
    for (const f of ["a", "b", "c", "d"]) s.write(`${f}.txt`, "mine\n");
    assert.match((await s.snap.whyNotRestorable(snap)) ?? "", /^4 files \('a\.txt', 'b\.txt', 'c\.txt', …\) are untracked here/);
  } finally {
    s.dispose();
  }
});

test("untracked files that can't be compared with what goes back are counted as in the way", async () => {
  const r = snapRepo("untracked-unhashable");
  try {
    r.commit("base");
    r.commit("A", "a.txt", "a\n");
    const snap = await around(r, "Reset (--hard)", () => void r.git("reset", "-q", "--hard", "HEAD~1"));
    r.write("a.txt", "a\n"); // the same copy — in the way only if it can't be compared
    assert.equal(await r.snap.whyNotRestorable(snap), undefined);
    const noHash = r.intercepted((args) => (args[0] === "hash-object" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.match((await noHash.whyNotRestorable(snap)) ?? "", /^'a\.txt' is untracked here/);
    const short1 = r.intercepted((args) => (args[0] === "hash-object" ? { code: 0, stdout: "", stderr: "" } : undefined));
    assert.match((await short1.whyNotRestorable(snap)) ?? "", /^'a\.txt' is untracked here/);
    // When git can't list the untracked files at all, nothing is claimed in the way.
    const noList = r.intercepted((args) => (args[0] === "diff" && args.includes("--diff-filter=A") ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.equal(await noList.whyNotRestorable(snap), undefined);
  } finally {
    r.dispose();
  }
});

test("an undo whose question was open during the op says, in red, that edits made meanwhile go too", async () => {
  const r = snapRepo("asked-hard");
  try {
    r.commit("base", "f.txt", "base\n");
    const m1 = r.git("rev-parse", "HEAD");
    r.commit("M2", "f.txt", "m2\n");
    const snap = await r.snap.capture("Reset to M1 (--soft)");
    r.snap.markAsked(snap);
    r.git("reset", "-q", "--soft", m1);
    await r.snap.settle(snap);
    const p = await r.snap.plan(snap);
    assert.equal(p.kind, "restore");
    assert.equal(p.kind === "restore" && p.danger, true);
    assert.deepEqual(words(p), [
      `'main' goes back to ${short(r.git("rev-parse", "HEAD@{1}"))}.`,
      "Anything you changed while its question was open is discarded too.",
    ]);
  } finally {
    r.dispose();
  }
});

test("a pop's undo is refused once HEAD has moved since — the tree it changed can't be taken back safely", async () => {
  const r = snapRepo("pop-head-moved");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "stashed\n");
    r.git("stash", "push", "-q", "-m", "work");
    const snap = await around(r, "Pop", () => void r.git("stash", "pop", "-q"));
    r.commit("later", "g.txt");
    assert.match(
      (await r.snap.whyNotRestorable(snap)) ?? "",
      /^HEAD has moved since "Pop" \(it is at [0-9a-f]{7} now\), so the changes it made to your working tree can't be taken back safely\.$/,
    );
  } finally {
    r.dispose();
  }
});

test("a pop's undo names edits made since as discarded, and still puts the stash back", async () => {
  const r = snapRepo("pop-edits-since");
  try {
    r.commit("base", "f.txt", "base\n");
    r.commit("g", "g.txt", "g\n");
    r.write("f.txt", "stashed\n");
    r.git("stash", "push", "-q", "-m", "work");
    const snap = await around(r, "Pop", () => void r.git("stash", "pop", "-q"));
    r.write("g.txt", "edited since\n");
    const p = await r.snap.plan(snap);
    assert.equal(p.kind === "restore" && p.danger, true);
    assert.deepEqual(words(p), [
      "The changes it made to your working tree are taken back.",
      "Uncommitted changes you have made since are discarded.",
      "Put the stash “work” back on top of the stash list.",
    ]);
    await r.snap.restore(snap);
    assert.equal(r.git("status", "--porcelain"), "");
    assert.equal(r.git("stash", "list", "--format=%gs"), "On main: work");
  } finally {
    r.dispose();
  }
});

test("a tree step git refuses is reported, and nothing claims the tree came back", async () => {
  const r = snapRepo("tree-fails");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "stashed\n");
    r.git("stash", "push", "-q", "-m", "work");
    const snap = await around(r, "Pop", () => void r.git("stash", "pop", "-q"));
    const p = r.intercepted((args) => (args[0] === "reset" && args[1] === "--hard" ? { code: 128, stdout: "", stderr: "fatal: index.lock\n" } : undefined));
    await assert.rejects(p.restore(snap), { message: "Undo couldn't put your working tree back: fatal: index.lock" });
    assert.equal(r.read("f.txt"), "stashed\n");
  } finally {
    r.dispose();
  }
});

test("a reset step git refuses says which kind: keep names the uncommitted changes, hard names the commit", async () => {
  const r = snapRepo("reset-fails");
  try {
    const base = r.commit("base", "f.txt", "base\n");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    const p = r.intercepted((args) => (args[0] === "reset" ? { code: 1, stdout: "", stderr: "error: would be overwritten\n" } : undefined));
    await assert.rejects(p.execute(snap, [{ do: "reset", to: base, mode: "keep", stash: null }]), {
      message: `Undo couldn't go back to ${short(base)} without overwriting your uncommitted changes: error: would be overwritten`,
    });
    await assert.rejects(p.execute(snap, [{ do: "reset", to: base, mode: "hard", stash: null }]), {
      message: `Undo failed: could not reset to ${base}: error: would be overwritten`,
    });
    assert.notEqual(r.git("rev-parse", "HEAD"), base, "nothing moved");
  } finally {
    r.dispose();
  }
});

test("uncommitted work that can't go back staged comes back unstaged; one that conflicts says how to get it", async () => {
  const r = snapRepo("apply-fallback");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "work\n");
    r.git("add", "f.txt");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    assert.ok(snap.stashSha);
    // The staged part can't go back (`--index` refused): applied plain instead.
    const noIndex = r.intercepted((args) => (args[0] === "stash" && args[1] === "apply" && args[2] === "--index" ? { code: 1, stdout: "", stderr: "Conflicts in index" } : undefined));
    await noIndex.restore(snap);
    assert.equal(r.read("f.txt"), "work\n");
    assert.equal(r.git("status", "--porcelain", "--untracked-files=no"), "M f.txt", "back, but unstaged");

    // Again, and this time the plain apply fails too: the message says how to recover.
    r.git("reset", "-q", "--hard");
    r.write("f.txt", "work\n");
    r.git("add", "f.txt");
    const again = await around(r, "Commit", () => void r.git("commit", "-q", "--allow-empty", "-m", "Y"));
    assert.ok(again.stashSha);
    const neither = r.intercepted((args) => (args[0] === "stash" && args[1] === "apply" ? { code: 1, stdout: "", stderr: "CONFLICT (content)" } : undefined));
    await assert.rejects(
      neither.restore(again),
      new RegExp(`re-applying your uncommitted changes hit a conflict: CONFLICT \\(content\\) \`git stash apply ${again.stashSha}\` brings them back\\.`),
    );

    // Something uncommitted in the way of a plain apply: the --index refusal is the one reported.
    r.git("reset", "-q", "--hard");
    r.write("f.txt", "work\n");
    r.git("add", "f.txt");
    const third = await around(r, "Commit", () => void r.git("commit", "-q", "--allow-empty", "-m", "Z"));
    assert.ok(third.stashSha);
    const dirty = r.intercepted((args) => {
      if (args[0] === "stash" && args[1] === "apply" && args[2] === "--index") return { code: 1, stdout: "", stderr: "index refused" };
      if (args[0] === "status" && args.includes("--untracked-files=no")) return { code: 0, stdout: " M f.txt\n", stderr: "" };
      return undefined;
    });
    await assert.rejects(dirty.restore(third), /hit a conflict: index refused `git stash apply/);
  } finally {
    r.dispose();
  }
});
