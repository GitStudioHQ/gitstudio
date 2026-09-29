import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { around, bareRemote, ENV, snapRepo, words } from "./snapshotProvider.fixture";

// The other branches an op moved, created or deleted: each goes back only while
// it is where the op left it — and with its config when the op took that too.

const short = (sha: string) => sha.slice(0, 7);

test("a deleted branch whose name has been taken again is not brought back over it", async () => {
  const r = snapRepo("taken-again");
  try {
    r.commit("base");
    r.git("branch", "x");
    const snap = await around(r, "Delete branch x", () => void r.git("branch", "-D", "x"));
    r.commit("new");
    r.git("branch", "x");
    assert.equal(await r.snap.whyNotRestorable(snap), `A branch named 'x' exists again, so Undo won't bring back the one "Delete branch x" deleted. Nothing was changed.`);
  } finally {
    r.dispose();
  }
});

test("a branch the op moved and the user deleted since has nothing to put back", async () => {
  const r = snapRepo("moved-deleted");
  try {
    r.commit("base");
    r.git("branch", "x");
    r.commit("M");
    const snap = await around(r, "Reset 'x'", () => void r.git("branch", "-f", "x", "HEAD"));
    r.git("branch", "-D", "x");
    assert.equal(await r.snap.whyNotRestorable(snap), `'x' has been deleted since "Reset 'x'", so there is nothing to put back.`);
  } finally {
    r.dispose();
  }
});

test("a branch the op moved forward and that has been pushed since is never rewound", async () => {
  const r = snapRepo("pushed-other");
  const remote = bareRemote();
  try {
    const base = r.commit("base");
    r.git("remote", "add", "origin", remote.dir);
    r.git("branch", "x");
    r.commit("M");
    const snap = await around(r, "Fast-forward 'x'", () => void r.git("branch", "-f", "x", "HEAD"));
    assert.deepEqual(snap.scope?.settled?.moved.find((m) => m.ref === "refs/heads/x")?.published, [], "not pushed when the op ended");
    r.git("push", "-q", "origin", "refs/heads/x:refs/heads/x");
    assert.equal(await r.snap.whyNotRestorable(snap), "'x' has been pushed since, so putting it back would rewrite published history. Nothing was changed.");
    assert.equal(r.git("rev-parse", "x"), r.git("rev-parse", "HEAD"));

    // A branch the op moved BACK can go forward again even once pushed: nothing published is lost.
    const back = await around(r, "Reset 'x' back", () => void r.git("branch", "-f", "x", base));
    r.git("push", "-q", "-f", "origin", "refs/heads/x:refs/heads/x");
    assert.deepEqual(words(await r.snap.plan(back)), [`'x' goes back to ${short(r.git("rev-parse", "HEAD"))}.`]);
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("a branch the op created is not deleted while it is checked out, or while it holds the only copy of its commits", async () => {
  const r = snapRepo("created-guards");
  try {
    r.commit("base");
    const made = await around(r, "Create branch x", () => void r.git("branch", "x"));
    r.git("checkout", "-q", "x");
    assert.equal(await r.snap.whyNotRestorable(made), "'x' is checked out. Switch to another branch, then undo.");
    r.git("checkout", "-q", "main");
    assert.deepEqual(words(await r.snap.plan(made)), [`Delete branch 'x', which "Create branch x" created.`]);

    const lone = r.git("commit-tree", "-p", "HEAD", "-m", "only here", "HEAD^{tree}");
    const only = await around(r, "Create branch y", () => void r.git("branch", "y", lone));
    assert.equal(await r.snap.whyNotRestorable(only), "'y' has the only copy of its commits, so Undo won't delete it. Nothing was changed.");
    // When git can't say who else has the commit, it is not claimed orphaned.
    const blind = r.intercepted((args) => (args[0] === "for-each-ref" && args.includes("refs/tags/") ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.deepEqual(words(await blind.plan(only)), [`Delete branch 'y', which "Create branch y" created.`]);
  } finally {
    r.dispose();
  }
});

test("a deleted branch comes back with its upstream, said in words, and its config restored", async () => {
  const r = snapRepo("upstream-back");
  try {
    const base = r.commit("base");
    r.git("remote", "add", "origin", "../no-such-remote.git");
    r.git("update-ref", "refs/remotes/origin/x", base);
    r.git("branch", "--track", "x", "origin/x");
    const snap = await around(r, "Delete branch x", () => void r.git("branch", "-D", "x"));
    assert.equal(r.tryGit("config", "branch.x.remote").code, 1, "git took the config with it");
    assert.deepEqual(words(await r.snap.plan(snap)), [`Bring back branch 'x' at ${short(base)}, tracking 'origin/x'.`]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "x"), base);
    assert.equal(r.git("config", "branch.x.remote"), "origin");
    assert.equal(r.git("config", "branch.x.merge"), "refs/heads/x");
  } finally {
    r.dispose();
  }
});

test("a deleted branch's config is not doubled when something wrote it back already", async () => {
  const r = snapRepo("config-present");
  try {
    const base = r.commit("base");
    r.git("remote", "add", "origin", "../no-such-remote.git");
    r.git("update-ref", "refs/remotes/origin/x", base);
    r.git("branch", "--track", "x", "origin/x");
    const snap = await around(r, "Delete branch x", () => void r.git("branch", "-D", "x"));
    r.git("config", "branch.x.remote", "origin");
    await r.snap.restore(snap);
    assert.equal(r.git("config", "--get-all", "branch.x.remote"), "origin", "one value, not two");
    assert.equal(r.tryGit("config", "branch.x.merge").code, 1, "and nothing added beside it");
  } finally {
    r.dispose();
  }
});

test("a deleted branch that tracked a local branch is brought back without a remote named", async () => {
  const r = snapRepo("upstream-local");
  try {
    const base = r.commit("base");
    r.git("branch", "--track", "x", "main");
    const snap = await around(r, "Delete branch x", () => void r.git("branch", "-D", "x"));
    assert.deepEqual(words(await r.snap.plan(snap)), [`Bring back branch 'x' at ${short(base)}.`]);
    await r.snap.restore(snap);
    assert.equal(r.git("config", "branch.x.remote"), ".");
  } finally {
    r.dispose();
  }
});

test("only branch.<name>.<key> entries are a branch's config — a bare branch.<key> setting is nobody's", async () => {
  const r = snapRepo("config-parse");
  try {
    r.commit("base");
    r.git("branch", "x");
    r.git("config", "branch.autoSetupMerge", "always");
    r.git("config", "branch.x.description", "line one");
    const snap = await around(r, "Delete branch x", () => void r.git("branch", "-D", "x"));
    const moved = snap.scope?.settled?.moved.find((m) => m.ref === "refs/heads/x");
    assert.deepEqual(moved?.config, [["branch.x.description", "line one"]]);
  } finally {
    r.dispose();
  }
});

test("a branch the op created with a tracking config goes, and so does the config section it made", async () => {
  const r = snapRepo("config-created");
  try {
    const base = r.commit("base");
    r.git("remote", "add", "origin", "../no-such-remote.git");
    r.git("update-ref", "refs/remotes/origin/x", base);
    const snap = await around(r, "Checkout origin/x", () => void r.git("branch", "--track", "x", "origin/x"));
    assert.equal(snap.scope?.settled?.moved[0]?.configCreated, true);
    await r.snap.restore(snap);
    assert.equal(r.tryGit("rev-parse", "--verify", "-q", "refs/heads/x").code, 1, "the branch is gone");
    assert.equal(r.tryGit("config", "--get-regexp", "^branch\\.x\\.").code, 1, "and so is its config");
  } finally {
    r.dispose();
  }
});

test("a branch the op moved and that is checked out now goes back with its files, keeping uncommitted work", async () => {
  const r = snapRepo("here-moved");
  try {
    const base = r.commit("base", "f.txt", "base\n");
    r.git("branch", "x");
    r.commit("M", "m.txt");
    const snap = await around(r, "Reset 'x'", () => void r.git("branch", "-f", "x", "HEAD"));
    r.git("checkout", "-q", "x");
    r.write("f.txt", "edited\n");
    assert.deepEqual(words(await r.snap.plan(snap)), [
      `'x' goes back to ${short(base)}.`,
      "It is checked out, so its files change with it; your uncommitted changes are kept.",
    ]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), base);
    assert.equal(r.git("symbolic-ref", "HEAD"), "refs/heads/x");
    assert.equal(r.read("f.txt"), "edited\n");
  } finally {
    r.dispose();
  }
});

test("a dropped stash with no message is named by its commit", async () => {
  const r = snapRepo("stash-nameless");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "work\n");
    const sha = r.git("stash", "create");
    r.git("reset", "-q", "--hard");
    r.git("update-ref", "--create-reflog", "-m", "x", "refs/stash", sha);
    // git won't write an empty reflog message; strip the one it wrote.
    const log = join(r.dir, ".git", "logs", "refs", "stash");
    writeFileSync(log, readFileSync(log, "utf8").replace(/\tx\n$/, "\t\n"));
    assert.equal(r.git("stash", "list", "--format=%gs"), "");
    const snap = await around(r, "Drop stash", () => void r.git("stash", "drop", "-q"));
    assert.deepEqual(words(await r.snap.plan(snap)), [`Put the stash “${short(sha)}” back on top of the stash list.`]);
  } finally {
    r.dispose();
  }
});

test("a stash that can't be put back is reported with the reason, and a stash step already done is left be", async () => {
  const r = snapRepo("stash-fails");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "work\n");
    r.git("stash", "push", "-q", "-m", "keep me");
    const snap = await around(r, "Drop stash", () => void r.git("stash", "drop", "-q"));
    const gone = r.intercepted((args) => (args[0] === "cat-file" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    await assert.rejects(gone.restore(snap), { message: "That stash is no longer in the repository." });
    assert.equal(r.git("stash", "list"), "", "nothing half-restored");
  } finally {
    r.dispose();
  }
});

test("dropping the op's own stash again is reported when git refuses, and skipped when it's already gone", async () => {
  const r = snapRepo("dropstash-fails");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "work\n");
    r.git("stash", "push", "-q", "-m", "mine");
    const [sha, message] = r.git("stash", "list", "--format=%H%x1f%gs").split("\x1f");
    const snap = await r.snap.capture("x");
    const p = r.intercepted((args) => (args[0] === "stash" && args[1] === "drop" ? { code: 1, stdout: "", stderr: "error: locked\n" } : undefined));
    await assert.rejects(p.execute(snap, [{ do: "drop-stash", entry: { sha, message } }]), {
      message: "Undo put your changes back, but couldn't drop the stash “On main: mine”: error: locked",
    });
    r.git("stash", "drop", "-q");
    await r.snap.execute(snap, [{ do: "drop-stash", entry: { sha, message } }]);
    assert.equal(r.git("stash", "list"), "");
  } finally {
    r.dispose();
  }
});

test("a branch moved to a commit that 65+ remote branches have is counted, and pushed-since compares the counts", async () => {
  const r = snapRepo("published-count");
  try {
    const base = r.commit("base");
    r.git("branch", "x");
    const m = r.commit("M");
    const many = (n: number, prefix: string) =>
      execFileSync("git", ["update-ref", "--stdin"], {
        cwd: r.dir,
        env: ENV,
        input: Array.from({ length: n }, (_, i) => `create refs/remotes/origin/${prefix}${i} ${m}\n`).join(""),
      });
    many(65, "a");
    const snap = await around(r, "Fast-forward 'x'", () => void r.git("branch", "-f", "x", m));
    assert.deepEqual(snap.scope?.settled?.moved[0]?.published, { count: 65 });
    assert.deepEqual(words(await r.snap.plan(snap)), [`'x' goes back to ${short(base)}.`], "no more than when the op ended");
    many(1, "b");
    assert.match((await r.snap.whyNotRestorable(snap)) ?? "", /^'x' has been pushed since/);
  } finally {
    r.dispose();
  }
});
