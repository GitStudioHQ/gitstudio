import { test } from "node:test";
import assert from "node:assert/strict";
import { readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, type Repo } from "./opRepo";

// A submodule (a gitlink, mode 160000) and a symlink (mode 120000) conflict
// have no text to merge, so the dashboard offers Accept Yours / Accept Theirs
// and hold-to-undo for them. What those write is checked against git itself:
// the index entry the resolution records, and the link on disk.
//
// `checkout --ours|--theirs -- <gitlink>` never touches a submodule's
// checkout, so the `add` after it records whatever commit the submodule
// happens to have checked out — the OTHER side's as often as not — and the
// resolution reported success. And `checkout -m` cannot merge a gitlink
// ("unable to read blob object") or a link target (it writes the marker text
// AS the link's target), so hold-to-undo has to put those back another way.

/** The commit a path's index entry names at `stage` (0 = resolved). */
function entry(r: Repo, path: string, stage: 0 | 1 | 2 | 3): string | undefined {
  const out = r.git("ls-files", "-s", "--", path);
  for (const line of out.split("\n")) {
    const m = /^(\d{6}) ([0-9a-f]+) (\d)\t/.exec(line);
    if (m && Number(m[3]) === stage) return m[2];
  }
  return undefined;
}

/**
 * A superproject whose submodule `lib` was moved to commit A on master and to
 * commit B on test, stopped in `op` (a merge of test, or test rebased onto
 * master). Returns the repo, the submodule's two commits, and the scratch
 * repositories to clean up.
 */
function submoduleConflict(op: "merge" | "rebase"): { r: Repo; a: string; b: string; extra: Repo[] } {
  const lib = makeRepo(`sublib-${op}`);
  lib.write("l.txt", "base\n");
  lib.commitAll("lib base");
  lib.git("checkout", "-q", "-b", "side-a");
  lib.write("l.txt", "A\n");
  const a = lib.commitAll("lib A");
  lib.git("checkout", "-q", "master");
  lib.git("checkout", "-q", "-b", "side-b");
  lib.write("l.txt", "B\n");
  const b = lib.commitAll("lib B");
  lib.git("checkout", "-q", "master");

  const r = makeRepo(`super-${op}`);
  r.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.root, "lib");
  r.write("f.txt", "one\n");
  r.commitAll("super base");
  const inLib = (...args: string[]) => r.git("-C", join(r.root, "lib"), ...args);
  r.git("checkout", "-q", "-b", "test");
  inLib("checkout", "-q", b);
  r.git("add", "lib");
  r.git("commit", "-q", "-m", "test moves lib to B");
  r.git("checkout", "-q", "master");
  inLib("checkout", "-q", a);
  r.git("add", "lib");
  r.git("commit", "-q", "-m", "master moves lib to A");
  if (op === "merge") {
    assert.notEqual(r.tryGit("merge", "test"), 0, "the merge stops on the submodule");
  } else {
    r.git("checkout", "-q", "test");
    inLib("checkout", "-q", b);
    assert.notEqual(r.tryGit("rebase", "master"), 0, "the rebase stops on the submodule");
  }
  assert.ok(entry(r, "lib", 2) && entry(r, "lib", 3), "lib is conflicted");
  return { r, a, b, extra: [lib] };
}

for (const op of ["merge", "rebase"] as const) {
  for (const role of ["yours", "theirs"] as const) {
    test(`a submodule conflict (${op}): Accept ${role} records THAT side's commit, whatever the submodule has checked out`, async () => {
      const { r, extra } = submoduleConflict(op);
      try {
        const ctx = r.ctx();
        const view = await ctx.operation.view();
        const stage = role === "yours" ? view.yours.stage : view.theirs.stage;
        const want = entry(r, "lib", stage);
        const facts = await ctx.conflictOps.fileFacts("lib");
        // A gitlink has no text to merge — and it is not a binary file either:
        // the no-text panel said "Conflicted binary file" of a submodule.
        assert.equal(facts?.shape, "submodule");
        const yoursSha = entry(r, "lib", view.yours.stage);
        const theirsSha = entry(r, "lib", view.theirs.stage);
        assert.deepEqual(facts?.commits, { yours: yoursSha, theirs: theirsSha }, "the two commits, by role");
        assert.equal(
          facts?.badge,
          `submodule: yours at ${yoursSha!.slice(0, 7)}, theirs at ${theirsSha!.slice(0, 7)}`,
        );
        const out = await ctx.conflictOps.takeRole("lib", role);
        assert.equal(out.ok, true, out.message);
        assert.equal(entry(r, "lib", 2), undefined, "no longer conflicted");
        assert.equal(entry(r, "lib", 0), want, `the index records stage ${stage}'s commit`);
      } finally {
        r.cleanup();
        for (const x of extra) x.cleanup();
      }
    });
  }

  test(`hold-to-undo brings a submodule conflict (${op}) back, all three stages`, async () => {
    const { r, extra } = submoduleConflict(op);
    try {
      const stages = [1, 2, 3].map((s) => entry(r, "lib", s as 1 | 2 | 3));
      const ctx = r.ctx();
      assert.equal((await ctx.conflictOps.takeRole("lib", "theirs")).ok, true);
      const out = await ctx.conflictOps.restore("lib");
      assert.equal(out.ok, true, out.message);
      assert.deepEqual([1, 2, 3].map((s) => entry(r, "lib", s as 1 | 2 | 3)), stages, "the same three commits, unmerged again");
      assert.equal((await ctx.operation.view()).canContinue, false, "so Continue waits for a new answer");
    } finally {
      r.cleanup();
      for (const x of extra) x.cleanup();
    }
  });
}

test("hold-to-undo brings a symlink conflict back with the link as git first left it, not a marker-text target", async () => {
  const r = makeRepo("link-restore");
  try {
    for (const d of ["dirA", "dirB", "dirC"]) r.write(`${d}/x`, `${d}\n`);
    symlinkSync("dirA", join(r.root, "link"));
    r.commitAll("base");
    const relink = (to: string) => {
      rmSync(join(r.root, "link"), { force: true });
      symlinkSync(to, join(r.root, "link"));
    };
    r.git("checkout", "-q", "-b", "test");
    relink("dirB");
    r.commitAll("test: link to dirB");
    r.git("checkout", "-q", "master");
    relink("dirC");
    r.commitAll("master: link to dirC");
    assert.notEqual(r.tryGit("merge", "test"), 0);
    const left = readlinkSync(join(r.root, "link"));
    assert.equal(left, "dirC", "git leaves stage 2's link in place");

    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeRole("link", "theirs")).ok, true);
    assert.equal(readlinkSync(join(r.root, "link")), "dirB");
    const out = await ctx.conflictOps.restore("link");
    assert.equal(out.ok, true, out.message);
    assert.ok(entry(r, "link", 2) && entry(r, "link", 3), "conflicted again");
    assert.equal(readlinkSync(join(r.root, "link")), left, "the link points where git first left it");
  } finally {
    r.cleanup();
  }
});
