import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess } from "../src/GitProcess";
import { StagingProvider } from "../src/StagingProvider";
import { makeRepo, FIVE, edit, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// markedConflicts: the check the Changes view makes before `git add` marks an
// UNMERGED file resolved — staging one that still has <<<<<<< in it would put
// the markers in the next commit. Only unmerged paths are looked inside; an
// ordinary file that merely contains marker-shaped lines stays stageable.

const MARKER_DOC = "How a conflict looks:\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n";

/**
 * master and side each change line 3 of f.txt and g.txt; side deletes h.txt,
 * master edits it; docs.txt (tracked, never conflicted) contains marker lines.
 * `git merge side` stops with f, g and h unmerged.
 */
function conflicted(): Repo {
  const r = makeRepo("staging-marked");
  r.write("f.txt", FIVE);
  r.write("g.txt", FIVE);
  r.write("h.txt", FIVE);
  r.write("docs.txt", MARKER_DOC);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  r.write("f.txt", edit(FIVE, { three: "three-side" }));
  r.write("g.txt", edit(FIVE, { three: "three-side" }));
  r.git("rm", "-q", "h.txt");
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { three: "three-master" }));
  r.write("g.txt", edit(FIVE, { three: "three-master" }));
  r.write("h.txt", edit(FIVE, { one: "one-master" }));
  r.commitAll("master");
  assert.notEqual(r.tryGit("merge", "side"), 0, "the merge stops on conflicts");
  return r;
}

test("an unmerged file that still has markers is reported; one resolved on disk is not", async () => {
  const r = conflicted();
  try {
    assert.match(r.read("f.txt"), /^<<<<<<< /m, "precondition: git wrote markers");
    r.write("g.txt", edit(FIVE, { three: "three-both" })); // resolved by hand, not yet added
    const staging = r.ctx().staging;
    assert.deepEqual(await staging.markedConflicts(["f.txt", "g.txt"]), ["f.txt"]);
  } finally {
    r.cleanup();
  }
});

test("an ordinary tracked file with marker-shaped lines is never reported", async () => {
  const r = conflicted();
  try {
    assert.deepEqual(await r.ctx().staging.markedConflicts(["docs.txt"]), [], "not unmerged, so not looked inside");
  } finally {
    r.cleanup();
  }
});

test("an unmerged path gone from disk is not reported (and does not throw)", async () => {
  const r = conflicted();
  try {
    rmSync(join(r.root, "h.txt"));
    assert.deepEqual(await r.ctx().staging.markedConflicts(["h.txt", "f.txt"]), ["f.txt"]);
  } finally {
    r.cleanup();
  }
});

test("a path asked about twice is reported once, in the order asked", async () => {
  const r = conflicted();
  try {
    r.write("g.txt", "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
    assert.deepEqual(await r.ctx().staging.markedConflicts(["g.txt", "f.txt", "g.txt"]), ["g.txt", "f.txt"]);
  } finally {
    r.cleanup();
  }
});

test("no paths asks git nothing and reports nothing", async () => {
  let runs = 0;
  const proc = new (class extends GitProcess {
    override run(...a: Parameters<GitProcess["run"]>) {
      runs++;
      return super.run(...a);
    }
  })({ cwd: tmpdir() });
  assert.deepEqual(await new StagingProvider(proc).markedConflicts([]), []);
  assert.equal(runs, 0);
});

test("outside a repository (git refuses the listing) nothing is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-stage-norepo-"));
  try {
    const staging = new StagingProvider(new GitProcess({ cwd: dir }));
    assert.deepEqual(await staging.markedConflicts(["f.txt"]), []);
  } finally {
    removeTempRepo(dir);
  }
});
