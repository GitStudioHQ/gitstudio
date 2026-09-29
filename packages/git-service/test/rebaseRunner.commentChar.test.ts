// A reword whose message has a line starting with `#` ("#123 was the ticket").
// The runner picks a comment character that begins none of the messages it
// installs, so git's cleanup keeps every line — and must keep choosing it when
// the rebase pauses before the reword and is resumed with --continue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { continueRebase, runRebasePlan } from "../src/RebaseRunner";
import { makeRepo, type Repo } from "./opRepo";

const MESSAGE = "Fix login\n\n#123 was the ticket";

function threeCommits(name: string): { r: Repo; sha: Record<string, string> } {
  const r = makeRepo(name);
  const sha: Record<string, string> = {};
  for (const n of ["base", "one", "two"]) {
    r.write(`${n}.txt`, `${n}\n`);
    sha[n] = r.commitAll(n);
  }
  return { r, sha };
}

test("a reword line that starts with # is kept when the rebase runs straight through", async () => {
  const { r, sha } = threeCommits("hash-straight");
  try {
    const out = await runRebasePlan(r.root, {
      base: sha.base,
      todo: `pick ${sha.one} one\nreword ${sha.two} two\n`,
      rewords: [{ sha: sha.two, message: MESSAGE }],
    });
    assert.deepEqual(out, { status: "done" });
    assert.equal(r.git("log", "-1", "--format=%B").trimEnd(), MESSAGE);
  } finally {
    r.cleanup();
  }
});

// The chosen comment character used to be saved beside the STAGING queue
// (.git/gitstudio-reword-queue.json.commentchar) while only the queue and its
// installer were moved into rebase-merge/ at a pause — and resumeEnv reads the
// note from beside the MOVED queue. It was never there, so every --continue /
// --skip ran with core.commentChar=# and git's cleanup deleted the user's
// "#123 …" line from a reword after the stop; the stale note stayed in .git.
test("a reword line that starts with # is kept when the reword comes after a pause", async () => {
  const { r, sha } = threeCommits("hash-paused");
  try {
    const out = await runRebasePlan(r.root, {
      base: sha.base,
      todo: `edit ${sha.one} one\nreword ${sha.two} two\n`,
      rewords: [{ sha: sha.two, message: MESSAGE }],
    });
    assert.equal(out.status, "stopped");
    const gitDir = r.git("rev-parse", "--absolute-git-dir").trim();
    assert.equal(existsSync(join(gitDir, "gitstudio-reword-queue.json.commentchar")), false, "nothing is left in .git");
    assert.deepEqual(await continueRebase(r.root), { status: "done" });
    assert.equal(r.git("log", "-1", "--format=%B").trimEnd(), MESSAGE);
  } finally {
    r.cleanup();
  }
});
