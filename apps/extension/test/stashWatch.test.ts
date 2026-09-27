// The Changes view's Stashes group follows the stash list as it changes
// outside GitStudio — a terminal, another worktree — through RepoManager's
// watch on refs/** (gitWatchTargets' refsGlob).
//
// The list is refs/stash and its reflog. Dropping a stash that is not the
// newest leaves refs/stash pointing where it did, so it was taken to change
// only logs/refs/stash, which nothing watched — and a watch was added for
// it. git rewrites refs/stash anyway, through refs/stash.lock (reflog expire
// --updateref), whether it was loose or packed: refs/** sees every drop.
// This pins that, so the watch stays one.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { gitWatchTargets } from "@gitstudio/merge-vscode/gitWatch";
import { scratchRepo } from "./changesHost";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

test("dropping an older stash rewrites refs/stash — the refs/** watch sees it, packed or loose", async () => {
  const repo = scratchRepo("stash-watch");
  cleanups.push(repo.done);
  writeFileSync(join(repo.dir, "f.txt"), "base\n");
  repo.git("add", "f.txt");
  repo.git("commit", "-qm", "base");
  for (const n of ["1", "2", "3", "4"]) {
    writeFileSync(join(repo.dir, "f.txt"), `${n}\n`);
    repo.git("stash", "push", "-q", "-m", `s${n}`);
  }
  const ctx = new GitContext({ root: repo.dir });
  const t = await gitWatchTargets(ctx.operation).finally(() => ctx.dispose());
  assert.equal(t.refsGlob, "refs/**");
  const ref = join(t.commonDir, "refs", "stash");
  const top = repo.git("rev-parse", "refs/stash");
  const before = statSync(ref).ino;
  repo.git("stash", "drop", "-q", "stash@{2}");
  assert.equal(repo.git("rev-parse", "refs/stash"), top, "the newest stash is still on top");
  assert.notEqual(statSync(ref).ino, before, "and refs/stash was written again all the same");
  // Packed: the drop writes it loose, under refs/.
  repo.git("pack-refs", "--all");
  assert.equal(existsSync(ref), false);
  repo.git("stash", "drop", "-q", "stash@{1}");
  assert.equal(existsSync(ref), true);
});
