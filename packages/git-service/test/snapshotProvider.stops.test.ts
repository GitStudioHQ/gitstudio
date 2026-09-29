import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { around, snapRepo, words, type SnapRepo } from "./snapshotProvider.fixture";

// Operations git is stopped in — the op's own (a several-commit pick that
// stopped part-way), and ones it didn't start (which Undo never ends) — and the
// uncommitted state git wouldn't copy because a conflict was in progress.

const short = (sha: string) => sha.slice(0, 7);

/** base; side: S1 (s1.txt), S2 (f.txt clash); main: M (f.txt). On main. */
function twoPicks(r: SnapRepo): { s1: string; s2: string; m: string } {
  r.commit("base", "f.txt", "base\n");
  r.git("checkout", "-q", "-b", "side");
  const s1 = r.commit("S1", "s1.txt");
  const s2 = r.commit("S2", "f.txt", "side\n");
  r.git("checkout", "-q", "main");
  const m = r.commit("M", "f.txt", "main\n");
  return { s1, s2, m };
}

for (const kind of ["cherry-pick", "revert"] as const) {
  test(`a ${kind} of several commits that stopped part-way: its undo puts HEAD back AND ends the run`, async () => {
    const r = snapRepo(`seq-${kind}`);
    try {
      const { s1, s2, m } = twoPicks(r);
      let start = m;
      if (kind === "revert") {
        // Revert needs the commits on main: bring them in, then revert both.
        r.git("merge", "-q", "--no-edit", "-X", "ours", "side");
        start = r.git("rev-parse", "HEAD");
      }
      const args = kind === "cherry-pick" ? ["cherry-pick", s1, s2] : ["revert", "--no-edit", s1, s2];
      const snap = await around(r, `${kind} 2 commits`, () => {
        assert.notEqual(r.tryGit(...args).code, 0, "the second one stops");
      });
      assert.equal(snap.scope?.settled?.op?.kind, kind);
      assert.equal(snap.scope?.settled?.op?.sequence, true);
      const p = await r.snap.plan(snap);
      assert.deepEqual(words(p), [`'main' goes back to ${short(start)}.`, `The ${kind} in progress is abandoned.`]);
      assert.deepEqual(p.kind === "restore" && p.steps.at(-1), { do: "quit-sequence", kind });
      await r.snap.restore(snap);
      assert.equal(r.git("rev-parse", "HEAD"), start);
      assert.equal(existsSync(join(r.dir, ".git", "sequencer")), false, "the rest of the run is gone");
      assert.equal(r.git("status", "--porcelain"), "");
    } finally {
      r.dispose();
    }
  });
}

test("ending the run is reported when git refuses — after everything else was put back", async () => {
  const r = snapRepo("seq-quit-fails");
  try {
    const { s1, s2, m } = twoPicks(r);
    const snap = await around(r, "Cherry-pick", () => void r.tryGit("cherry-pick", s1, s2));
    const p = r.intercepted((args) => (args[0] === "cherry-pick" && args[1] === "--quit" ? { code: 1, stdout: "", stderr: "" } : undefined));
    await assert.rejects(p.restore(snap), { message: "Undo put things back, but couldn't end the cherry-pick in progress: git refused" });
    assert.equal(r.git("rev-parse", "HEAD"), m, "HEAD is back");
  } finally {
    r.dispose();
  }
});

test("a merge the op didn't start is never ended by its undo — refused, and named", async () => {
  const r = snapRepo("foreign-merge");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    assert.notEqual(r.tryGit("merge", "side").code, 0);
    assert.equal(await r.snap.whyNotRestorable(snap), "A merge is in progress. Finish or abort it first, then undo.");
    assert.ok(existsSync(join(r.dir, ".git", "MERGE_HEAD")), "still merging");
  } finally {
    r.dispose();
  }
});

test("a patch series (git am) the op didn't start is named as such, and never ended", async () => {
  const r = snapRepo("foreign-am");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    const patch = r.git("format-patch", "-1", "--stdout");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    const snap = await around(r, "Commit", () => void r.commit("X"));
    const patchFile = join(r.dir, ".git", "am-input.patch");
    r.write(".git/am-input.patch", `${patch}\n`);
    assert.notEqual(r.tryGit("am", patchFile).code, 0, "the patch doesn't apply");
    assert.equal(await r.snap.whyNotRestorable(snap), "A patch series (git am) is in progress. Finish or abort it first, then undo.");
    assert.ok(existsSync(join(r.dir, ".git", "rebase-apply", "applying")));
  } finally {
    r.dispose();
  }
});

test("when git can't say where its markers live, no stop is claimed", async () => {
  const r = snapRepo("gitpath-fails");
  try {
    r.commit("base", "f.txt", "base\n");
    r.git("checkout", "-q", "-b", "side");
    r.commit("S", "f.txt", "side\n");
    r.git("checkout", "-q", "main");
    r.commit("M", "f.txt", "main\n");
    r.tryGit("merge", "side");
    assert.equal((await r.snap.capture("x")).scope?.op?.kind, "merge");
    const blind = r.intercepted((args) => (args[0] === "rev-parse" && args[1] === "--git-path" ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.equal((await blind.capture("x")).scope?.op, undefined);
  } finally {
    r.dispose();
  }
});

// ── A conflict in progress when the op ran: no copy of the tree ─────────────

/**
 * base: f.txt, g.txt. main: A (f.txt), M (g.txt). side: S (f.txt). A merge of
 * side stops on f.txt; the op is a mixed reset to A, which leaves M's g.txt in
 * the working tree.
 */
async function mixedResetDuringConflict(r: SnapRepo) {
  r.commit("base", "f.txt", "base\n");
  r.write("g.txt", "g\n");
  r.commit("g");
  r.git("checkout", "-q", "-b", "side");
  r.commit("S", "f.txt", "side\n");
  r.git("checkout", "-q", "main");
  const a = r.commit("A", "f.txt", "main\n");
  const m = r.commit("M", "g.txt", "g from M\n");
  assert.notEqual(r.tryGit("merge", "side").code, 0);
  const snap = await around(r, "Reset to A (--mixed)", () => void r.git("reset", "-q", "--mixed", a));
  assert.equal(snap.scope?.uncopied, "conflict");
  return { snap, a, m };
}

test("uncopied work, then edits since that the undo doesn't touch: the branch goes back with reset --keep", async () => {
  const r = snapRepo("uncopied-keep");
  try {
    const { snap, m } = await mixedResetDuringConflict(r);
    // Put g.txt back as A has it (so nothing in A..M is dirty) and edit another file.
    r.git("checkout", "--", "g.txt");
    r.write("h.txt", "new\n");
    r.git("add", "h.txt");
    const p = await r.snap.plan(snap);
    assert.deepEqual(words(p), [
      `'main' goes back to ${short(m)}.`,
      "Your uncommitted changes are kept.",
      "The uncommitted changes you had before it can't come back — git couldn't keep a copy of them while a conflict was unresolved.",
    ]);
    assert.deepEqual(p.kind === "restore" && p.steps, [{ do: "reset", to: m, mode: "keep", stash: null }]);
    await r.snap.restore(snap);
    assert.equal(r.git("rev-parse", "HEAD"), m);
    assert.equal(r.read("h.txt"), "new\n", "the new file stays");
    assert.equal(r.read("g.txt"), "g from M\n");
  } finally {
    r.dispose();
  }
});

test("uncopied work, then an edit to a file the undo would overwrite: refused, saying why git kept no copy", async () => {
  const r = snapRepo("uncopied-refuse");
  try {
    const { snap } = await mixedResetDuringConflict(r);
    r.write("g.txt", "edited since\n");
    assert.equal(
      await r.snap.whyNotRestorable(snap),
      `Putting 'main' back would overwrite uncommitted changes, and some of them you had before "Reset to A (--mixed)" — ` +
        "git couldn't keep a copy of those while a conflict was unresolved. Commit or stash them, then undo.",
    );
    // When git can't compare the files at all, it is assumed they overlap.
    r.write("g.txt", "g\n");
    r.write("h.txt", "new\n");
    const blind = r.intercepted((args) => (args[0] === "diff" && args.includes("--name-only") && !args.includes("HEAD") && !args.includes("--diff-filter=A") ? { code: 128, stdout: "", stderr: "fatal" } : undefined));
    assert.match((await blind.whyNotRestorable(snap)) ?? "", /^Putting 'main' back would overwrite uncommitted changes/);
  } finally {
    r.dispose();
  }
});
