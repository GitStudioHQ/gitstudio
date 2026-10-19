// Changelists (#122): the model, and where it is kept.
//
// They are GitStudio's own bookkeeping in the git-dir — never in the tracked
// tree, per worktree — and a file anyone (or a crash) left half-written must
// read as "no changelists", never break the Changes view.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addChangelist,
  changelistNameProblem,
  deleteChangelist,
  emptyChangelists,
  forgetPaths,
  moveToChangelist,
  parkedAmong,
  parseChangelists,
  renameChangelist,
  serializeChangelists,
  CHANGELISTS_FILE,
} from "../src/Changelists";
import { GitContext } from "../src/GitContext";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-changelists-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { dir, git };
}

test("make, move, rename and delete: a delete hands its files back to the default list", () => {
  let s = emptyChangelists();
  const made = addChangelist(s, "  no   commit ");
  s = made.state;
  assert.deepEqual(s.lists, [{ id: made.id, name: "no commit" }], "the name is kept tidy");
  assert.match(made.id, /^[A-Za-z0-9_-]+$/, "ids are safe in a page key");
  s = moveToChangelist(s, ["config.local.json", "debug.ts"], made.id);
  assert.deepEqual(parkedAmong(s, ["config.local.json", "src/a.ts"]), { "config.local.json": made.id });
  s = renameChangelist(s, made.id, "local only");
  assert.equal(s.lists[0].name, "local only");
  assert.equal(s.files["debug.ts"], made.id, "a rename keeps the files");
  s = moveToChangelist(s, ["debug.ts"], undefined);
  assert.equal(s.files["debug.ts"], undefined, "moved back to the default list");
  const gone = deleteChangelist(s, made.id);
  assert.deepEqual(gone.freed, ["config.local.json"]);
  assert.deepEqual(gone.state, emptyChangelists());
});

test("a move to a list that is not there is a move to the default list", () => {
  const s = moveToChangelist({ lists: [], files: { "a.txt": "gone" } }, ["a.txt", "b.txt"], "nope");
  assert.deepEqual(s.files, {});
});

test("names: empty, the view's own group names and a duplicate (any case) are refused", () => {
  const s = addChangelist(emptyChangelists(), "nocommit").state;
  assert.equal(changelistNameProblem(s, "   "), "empty");
  for (const taken of ["Changes", "staged", "UNSTAGED", "NoCommit"]) {
    assert.equal(changelistNameProblem(s, taken), "taken", taken);
  }
  assert.equal(changelistNameProblem(s, "nocommit", s.lists[0].id), undefined, "its own name is not taken");
  assert.equal(changelistNameProblem(s, "x".repeat(81)), "tooLong");
  assert.equal(changelistNameProblem(s, "local config"), undefined);
});

test("a broken, foreign or newer file reads as no changelists; a stray path is dropped", () => {
  for (const text of ["", "{", "null", "[]", '{"version":2,"lists":[],"files":{}}', '{"version":1}']) {
    assert.deepEqual(parseChangelists(text), emptyChangelists(), JSON.stringify(text));
  }
  const s = parseChangelists(JSON.stringify({
    version: 1,
    lists: [{ id: "a", name: "one" }, { id: "a", name: "dup id" }, { id: "b c", name: "bad id" }, { id: "d", name: "ONE" }, { id: "e", name: 3 }],
    files: { "x.txt": "a", "y.txt": "zzz", "z.txt": 4 },
  }));
  assert.deepEqual(s, { lists: [{ id: "a", name: "one" }], files: { "x.txt": "a" } });
  assert.deepEqual(parseChangelists(serializeChangelists(s)), s, "what is written reads back");
});

test("forgetPaths drops only the paths it is given", () => {
  const made = addChangelist(emptyChangelists(), "l");
  const s = moveToChangelist(made.state, ["a", "b"], made.id);
  assert.deepEqual(forgetPaths(s, ["a"]).files, { b: made.id });
});

test("the store keeps them in the git-dir, never in the working tree", async () => {
  const { dir, git } = repo();
  const ctx = new GitContext({ root: dir });
  cleanups.push(() => ctx.dispose());
  assert.deepEqual(await ctx.changelists.read(), emptyChangelists(), "none yet");
  const kept = await ctx.changelists.update((s) => {
    const made = addChangelist(s, "nocommit");
    return moveToChangelist(made.state, ["a.txt"], made.id);
  });
  const file = join(dir, ".git", CHANGELISTS_FILE);
  assert.ok(existsSync(file), "written in .git");
  assert.deepEqual(parseChangelists(readFileSync(file, "utf8")), kept);
  assert.equal(git("status", "--porcelain"), "", "the working tree is untouched");
  assert.deepEqual(await new GitContext({ root: dir }).changelists.read(), kept, "another reader sees the same");
});

test("updates run one after another: two quick moves both land", async () => {
  const { dir } = repo();
  const ctx = new GitContext({ root: dir });
  cleanups.push(() => ctx.dispose());
  const id = (await ctx.changelists.update((s) => addChangelist(s, "l").state)).lists[0].id;
  await Promise.all([
    ctx.changelists.update((s) => moveToChangelist(s, ["one"], id)),
    ctx.changelists.update((s) => moveToChangelist(s, ["two"], id)),
  ]);
  assert.deepEqual(Object.keys((await ctx.changelists.read()).files).sort(), ["one", "two"]);
});

test("a linked worktree has its own changelists", async () => {
  const { dir, git } = repo();
  const wt = mkdtempSync(join(tmpdir(), "gs-changelists-wt-"));
  rmSync(wt, { recursive: true, force: true });
  git("worktree", "add", "-q", wt, "-b", "side");
  cleanups.push(() => rmSync(wt, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const main = new GitContext({ root: dir });
  const side = new GitContext({ root: wt });
  cleanups.push(() => main.dispose(), () => side.dispose());
  await main.changelists.update((s) => addChangelist(s, "main only").state);
  assert.notEqual(await main.changelists.path(), await side.changelists.path());
  assert.deepEqual(await side.changelists.read(), emptyChangelists());
});

test("outside a repository there is nothing to read, and an update says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-changelists-norepo-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = new GitContext({ root: dir });
  cleanups.push(() => ctx.dispose());
  assert.deepEqual(await ctx.changelists.read(), emptyChangelists());
  await assert.rejects(ctx.changelists.update((s) => s), /not a git repository/);
});
