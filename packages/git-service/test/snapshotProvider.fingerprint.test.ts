import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLEAN_TREE } from "../src/SnapshotProvider";
import { around, ENV, snapRepo, words } from "./snapshotProvider.fixture";

// The fingerprint of the uncommitted state is how Undo tells whether anything
// changed since the op — a symlink by its target, a directory as a directory,
// a very big file by size and time, a missing file as missing.

async function tree(r: ReturnType<typeof snapRepo>, provider = r.snap): Promise<string> {
  return (await provider.capture("look")).scope!.tree;
}

test("a symlink is fingerprinted by where it points", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async () => {
  const r = snapRepo("fp-symlink");
  try {
    symlinkSync("a.txt", join(r.dir, "link"));
    r.commit("base", "a.txt", "a\n");
    unlinkSync(join(r.dir, "link"));
    symlinkSync("b.txt", join(r.dir, "link"));
    const one = await tree(r);
    assert.notEqual(one, CLEAN_TREE);
    assert.equal(await tree(r), one, "stable while nothing changes");
    unlinkSync(join(r.dir, "link"));
    symlinkSync("c.txt", join(r.dir, "link"));
    assert.notEqual(await tree(r), one, "a new target is a change");
  } finally {
    r.dispose();
  }
});

test("a tracked file deleted, and then replaced by a folder, are two different states", async () => {
  const r = snapRepo("fp-dir");
  try {
    r.commit("base", "p", "file\n");
    rmSync(join(r.dir, "p"));
    const gone = await tree(r);
    assert.notEqual(gone, CLEAN_TREE);
    mkdirSync(join(r.dir, "p"));
    writeFileSync(join(r.dir, "p", "inside.txt"), "x\n");
    const folder = await tree(r);
    assert.notEqual(folder, gone);
    writeFileSync(join(r.dir, "p", "inside.txt"), "y\n");
    assert.equal(await tree(r), folder, "a folder is a folder: what is inside is untracked, not in the fingerprint");
  } finally {
    r.dispose();
  }
});

test("a very big file is fingerprinted by size and time, never read", async () => {
  const r = snapRepo("fp-big");
  try {
    r.commit("base", "big.bin", "small\n");
    const size = 16 * 1024 * 1024 + 1;
    const p = join(r.dir, "big.bin");
    writeFileSync(p, Buffer.alloc(size, 1));
    const when = new Date(Math.floor(statSync(p).mtimeMs / 1000) * 1000);
    utimesSync(p, when, when);
    const one = await tree(r);
    // Same size, same time, other bytes: indistinguishable by design.
    writeFileSync(p, Buffer.alloc(size, 2));
    utimesSync(p, when, when);
    assert.equal(await tree(r), one);
    // Another size is a change.
    writeFileSync(p, Buffer.alloc(size + 1, 2));
    utimesSync(p, when, when);
    assert.notEqual(await tree(r), one);
  } finally {
    r.dispose();
  }
});

test("the fingerprint doesn't depend on git naming the top folder — the repository root is the fallback", async () => {
  const r = snapRepo("fp-toplevel");
  try {
    r.commit("base", "f.txt", "base\n");
    r.write("f.txt", "edited\n");
    const blind = r.intercepted((args) => (args[0] === "rev-parse" && args[1] === "--show-toplevel" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.equal(await tree(r, blind), await tree(r));
  } finally {
    r.dispose();
  }
});

test("during a conflict, the file digests fall back to the root folder too — and are left out when git can't list them", async () => {
  const r = snapRepo("fp-digests");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.tryGit("merge", "side");
    const real = await r.snap.capture("x");
    const noTop = r.intercepted((args) => (args[0] === "rev-parse" && args[1] === "--show-toplevel" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.deepEqual((await noTop.capture("x")).scope?.files, real.scope?.files);
    const noList = r.intercepted((args) => (args[0] === "ls-files" && args[1] === "--others" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    const snap = await noList.capture("x");
    assert.equal(snap.scope?.uncopied, "conflict");
    assert.equal("files" in (snap.scope ?? {}), false);
  } finally {
    r.dispose();
  }
});

test("a mixed reset during a conflict whose file digests couldn't be read falls back to the overlap check", async () => {
  const r = snapRepo("fp-nodigests");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.commit("N", "n.txt");
    r.tryGit("merge", "side");
    const noList = r.intercepted((args) => (args[0] === "ls-files" && args[1] === "--others" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    const snap = await noList.capture("Reset (--mixed)");
    r.git("reset", "-q", "--mixed", "HEAD~1");
    await r.snap.settle(snap);
    // n.txt is left untracked by the reset, and the undo would bring it back: the overlap check refuses.
    assert.match((await r.snap.whyNotRestorable(snap)) ?? "", /^Putting 'main' back would overwrite uncommitted changes/);
  } finally {
    r.dispose();
  }
});

test("an untracked file whose name holds a newline is counted as in the way without being compared", { skip: process.platform === "win32" && "no newlines in Windows file names" }, async () => {
  const r = snapRepo("fp-newline");
  try {
    r.commit("base");
    r.commit("A", "a\nb.txt", "a\n");
    const snap = await around(r, "Reset (--hard)", () => void r.git("reset", "-q", "--hard", "HEAD~1"));
    r.write("a\nb.txt", "a\n"); // the very same content — but it can't be hashed through --stdin-paths
    assert.match((await r.snap.whyNotRestorable(snap)) ?? "", /^'a\nb\.txt' is untracked here/);
  } finally {
    r.dispose();
  }
});

test("switching back that the user already did by hand leaves nothing to undo — on a branch and detached", async () => {
  const r = snapRepo("switch-back-done");
  try {
    const base = r.commit("base");
    r.git("branch", "feature");
    const snap = await around(r, "Checkout feature", () => void r.git("checkout", "-q", "feature"));
    r.git("checkout", "-q", "main");
    assert.equal((await r.snap.plan(snap)).kind, "nothing");
    r.git("checkout", "-q", "--detach", base);
    const det = await around(r, "Checkout main", () => void r.git("checkout", "-q", "main"));
    r.git("checkout", "-q", "--detach", base);
    assert.equal((await r.snap.plan(det)).kind, "nothing");
  } finally {
    r.dispose();
  }
});

test("a branch created over leftover config keeps that config when its undo deletes it", async () => {
  const r = snapRepo("leftover-config");
  try {
    r.commit("base");
    r.git("config", "branch.x.description", "from before");
    const snap = await around(r, "Create branch x", () => void r.git("branch", "x"));
    assert.equal(snap.scope?.settled?.moved[0]?.configCreated, undefined);
    await r.snap.restore(snap);
    assert.equal(r.tryGit("rev-parse", "--verify", "-q", "refs/heads/x").code, 1);
    assert.equal(r.git("config", "branch.x.description"), "from before");
  } finally {
    r.dispose();
  }
});

test("a valueless branch config key is kept with the branch, as an empty value", async () => {
  const r = snapRepo("valueless-config");
  try {
    r.commit("base");
    r.git("branch", "x");
    const cfg = join(r.dir, ".git", "config");
    writeFileSync(cfg, `${r.read(".git/config")}[branch "x"]\n\tflag\n`);
    const snap = await around(r, "Delete branch x", () => void r.git("branch", "-D", "x"));
    assert.deepEqual(snap.scope?.settled?.moved[0]?.config, [["branch.x.flag", ""]]);
  } finally {
    r.dispose();
  }
});

test("a rebase finish in an older git's words still ties the branch's move to the op", async () => {
  const r = snapRepo("old-finish");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    const f = r.commit("F");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    const snap = await around(r, "Interactive rebase", () => undefined, { deferred: { onto: m } });
    const rebased = r.git("commit-tree", "-p", m, "-m", "F'", `${f}^{tree}`);
    r.git("update-ref", "-m", `rebase finished: refs/heads/feature onto ${m}`, "refs/heads/feature", rebased);
    assert.deepEqual(words(await r.snap.plan(snap)), [`'feature' goes back to ${f.slice(0, 7)}.`]);
  } finally {
    r.dispose();
  }
});

test("a deferred rebase whose branch was deleted since is refused — its reflog went with it", async () => {
  const r = snapRepo("deferred-deleted");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("F");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    const snap = await around(r, "Interactive rebase", () => undefined, { deferred: { onto: m } });
    r.git("rebase", "-q", "main");
    r.git("checkout", "-q", "main");
    r.git("branch", "-D", "feature");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `GitStudio can't tell what moved 'feature' since "Interactive rebase" (it keeps no reflog), so it won't guess. Nothing was changed.`,
    );
  } finally {
    r.dispose();
  }
});

test("branches made or deleted around a deferred rebase are not the rebase's", async () => {
  const r = snapRepo("deferred-others");
  try {
    r.commit("base");
    r.git("branch", "doomed");
    r.git("checkout", "-q", "-b", "feature");
    const f = r.commit("F");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "feature");
    const snap = await around(r, "Interactive rebase", () => undefined, { deferred: { onto: m } });
    r.git("rebase", "-q", "main");
    r.git("branch", "fresh");
    r.git("branch", "-D", "doomed");
    assert.deepEqual(words(await r.snap.plan(snap)), [`'feature' goes back to ${f.slice(0, 7)}.`]);
  } finally {
    r.dispose();
  }
});

test("a deferred detached --update-refs rebase is refused once the branch it carried moved again", async () => {
  const r = snapRepo("det-carried-moved");
  try {
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
    r.commit("A");
    r.git("branch", "mid");
    r.commit("B");
    r.git("checkout", "-q", "main");
    const m = r.commit("M");
    r.git("checkout", "-q", "--detach", "feature");
    const snap = await around(r, "Interactive rebase", () => undefined, { deferred: { onto: m } });
    execFileSync("git", ["rebase", "-q", "-i", "--update-refs", "main"], { cwd: r.dir, env: { ...ENV, GIT_SEQUENCE_EDITOR: "true" }, stdio: "ignore" });
    const carried = r.git("rev-parse", "mid");
    const moved = r.git("commit-tree", "-p", carried, "-m", "more", `${carried}^{tree}`);
    r.git("update-ref", "refs/heads/mid", moved);
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `'mid' has moved since the rebase (it is at ${moved.slice(0, 7)} now), and putting it back would throw that away.`,
    );
  } finally {
    r.dispose();
  }
});

test("a branch moved to a commit that becomes known to 65+ remote branches counts as pushed since", async () => {
  const r = snapRepo("published-many");
  try {
    r.commit("base");
    r.git("branch", "y");
    const m = r.commit("M");
    const snap = await around(r, "Fast-forward 'y'", () => void r.git("branch", "-f", "y", m));
    assert.deepEqual(snap.scope?.settled?.moved[0]?.published, []);
    execFileSync("git", ["update-ref", "--stdin"], {
      cwd: r.dir,
      env: ENV,
      input: Array.from({ length: 65 }, (_, i) => `create refs/remotes/origin/r${i} ${m}\n`).join(""),
    });
    assert.match((await r.snap.whyNotRestorable(snap)) ?? "", /^'y' has been pushed since/);
    // When git can't say which remote branches have it, nobody is taken to have it.
    const blind = r.intercepted((args) => (args[0] === "for-each-ref" && args.at(-1) === "refs/remotes/" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.deepEqual(words(await blind.plan(snap)), [`'y' goes back to ${r.git("rev-parse", "main~1").slice(0, 7)}.`]);
  } finally {
    r.dispose();
  }
});

test("an empty marker file in a rebase folder reads as unknown, not as an empty name", async () => {
  const r = snapRepo("empty-marker");
  try {
    r.commit("base");
    mkdirSync(join(r.dir, ".git", "rebase-merge"));
    writeFileSync(join(r.dir, ".git", "rebase-merge", "head-name"), "\n");
    writeFileSync(join(r.dir, ".git", "rebase-merge", "onto"), `${r.git("rev-parse", "HEAD")}\n`);
    const snap = await r.snap.capture("x");
    assert.deepEqual(snap.scope?.op, { kind: "rebase", headName: undefined, origHead: undefined, onto: r.git("rev-parse", "HEAD") });
  } finally {
    r.dispose();
  }
});
