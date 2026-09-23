import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { gitWatchTargets } from "../src/gitWatch";
import { git, gitFails, newRepo, removeTemp } from "./fixtures";

// Both extensions watched `<root>/.git/{MERGE_HEAD,…}`. In a LINKED worktree
// `<root>/.git` is a file, so a conflict there was invisible to them until
// vscode.git's own poll caught up (PLAN matrix row 12). The targets now come
// from `rev-parse --git-path`.

let dir: string;
let main: string;
let linked: string;

before(() => {
  const r = newRepo("worktree");
  dir = r.dir;
  main = r.repo;
  linked = join(dir, "linked");
  writeFileSync(join(main, "f.txt"), "one\ntwo\nthree\n");
  git(main, "add", "f.txt");
  git(main, "commit", "-m", "base");
  git(main, "branch", "other");
  git(main, "worktree", "add", "-b", "feature", linked);
  writeFileSync(join(linked, "f.txt"), "one\nTWO-feature\nthree\n");
  git(linked, "commit", "-am", "feature edit");
  git(main, "checkout", "other");
  writeFileSync(join(main, "f.txt"), "one\nTWO-other\nthree\n");
  git(main, "commit", "-am", "other edit");
  git(main, "checkout", "master");
  gitFails(linked, "merge", "other");
});

after(() => removeTemp(dir));

const real = (p: string) => realpathSync(p);

test("in a linked worktree the operation files are watched in its PRIVATE git dir, where MERGE_HEAD really is", async () => {
  assert.ok(statSync(join(linked, ".git")).isFile(), "the old `<root>/.git` watch base is a file here");
  const ctx = new GitContext({ root: linked });
  try {
    const t = await gitWatchTargets(ctx.operation);
    assert.ok(existsSync(join(t.gitDir, "MERGE_HEAD")), `MERGE_HEAD is under ${t.gitDir}`);
    assert.equal(real(t.gitDir), real(join(main, ".git", "worktrees", "linked")));
    assert.equal(real(t.commonDir), real(join(main, ".git")), "refs live in the shared dir");
    assert.ok(existsSync(join(t.commonDir, "refs", "heads")));
    assert.match(t.opStateGlob, /MERGE_HEAD/);
    assert.match(t.opStateGlob, /REBASE_HEAD/, "every rebase stop moves REBASE_HEAD");
    assert.match(t.opStateGlob, /rebase-merge/);
  } finally {
    ctx.dispose();
  }
});

test("in the main worktree both targets are its .git directory", async () => {
  const ctx = new GitContext({ root: main });
  try {
    const t = await gitWatchTargets(ctx.operation);
    assert.equal(real(t.gitDir), real(join(main, ".git")));
    assert.equal(real(t.commonDir), real(join(main, ".git")));
    assert.ok(!existsSync(join(t.gitDir, "MERGE_HEAD")), "the merge is the linked worktree's, not this one's");
  } finally {
    ctx.dispose();
  }
});

test("an answer that is not the entry asked about is refused, never watched one folder too high", async () => {
  // GitProcess reads a git killed by dispose() as exit 0 with empty stdout;
  // `--git-path refs` then resolves to the worktree root, and its dirname —
  // the folder ABOVE the repository — became a watch base (seen in
  // vscodeGitLocator.test.ts before the locator learned to drop the answer).
  await assert.rejects(
    gitWatchTargets({ gitPath: async (name) => (name === "refs" ? "/work/repo" : "/work/repo/.git/HEAD") }),
    /did not say where/,
  );
});
