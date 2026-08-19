import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { listUnstagedHunks, stageHunks } from "../src/hunkStaging";
import { removeTempRepo } from "./tmpRepo";

// Hunk-level staging driven from a PATH rather than from the active editor, so
// the Changes view can offer a tick per hunk (issue #20). Without it the checkbox
// staging model is file-level only, which is a downgrade for anyone who stages
// partially today.
//
// The property that makes the model honest: the baseline is the INDEX, so the
// hunks you can still tick are exactly what git calls unstaged. Tick one and it
// leaves the list, because the index now contains it.

let repo: string;
let ctx: GitContext;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const write = (n: string, c: string): void => writeFileSync(join(repo, n), c);
const read = (n: string): string => readFileSync(join(repo, n), "utf8");

/** Ten numbered lines — enough room for several well-separated hunks. */
const BASE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-hunks-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  write("f.txt", BASE);
  git("add", ".");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

/** Edit lines 1 and 9, leaving a gap so they are two distinct hunks. */
function twoEdits(): string {
  const lines = BASE.split("\n");
  lines[0] = "FIRST EDIT";
  lines[8] = "SECOND EDIT";
  const text = lines.join("\n");
  write("f.txt", text);
  return text;
}

test("an unmodified file has no tickable hunks", async () => {
  assert.deepEqual(await listUnstagedHunks(ctx, "f.txt", BASE), []);
});

test("two separated edits list as two hunks, with a readable preview", async () => {
  const modified = twoEdits();
  const hunks = await listUnstagedHunks(ctx, "f.txt", modified);

  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].preview, "FIRST EDIT");
  assert.equal(hunks[1].preview, "SECOND EDIT");
  assert.ok(hunks[0].start < hunks[1].start, "listed in file order");
  for (const h of hunks) {
    assert.ok(h.lineCount >= 1, "never reports a zero-line hunk");
  }
});

test("ticking ONE hunk stages exactly that change, and leaves the other alone", async () => {
  const modified = twoEdits();
  const hunks = await listUnstagedHunks(ctx, "f.txt", modified);

  const r = await stageHunks(ctx, "f.txt", modified, [hunks[0].index]);
  assert.equal(r.ok, true);
  assert.equal(r.staged, 1);

  // The index has the first edit and NOT the second.
  const staged = git("show", ":f.txt");
  assert.match(staged, /FIRST EDIT/);
  assert.doesNotMatch(staged, /SECOND EDIT/);

  // The working tree is untouched — both edits still there.
  assert.match(read("f.txt"), /FIRST EDIT/);
  assert.match(read("f.txt"), /SECOND EDIT/);
});

test("…and the staged hunk then drops out of the tickable list", async () => {
  // This is what makes the tick honest: the list is "what is still unstaged".
  const modified = twoEdits();
  const before = await listUnstagedHunks(ctx, "f.txt", modified);
  await stageHunks(ctx, "f.txt", modified, [before[0].index]);

  const after = await listUnstagedHunks(ctx, "f.txt", modified);
  assert.equal(after.length, 1);
  assert.equal(after[0].preview, "SECOND EDIT");
});

test("ticking both stages the whole file", async () => {
  const modified = twoEdits();
  const hunks = await listUnstagedHunks(ctx, "f.txt", modified);

  await stageHunks(ctx, "f.txt", modified, hunks.map((h) => h.index));

  assert.equal(git("show", ":f.txt"), modified);
  assert.deepEqual(await listUnstagedHunks(ctx, "f.txt", modified), []);
});

test("a brand-new file's content is one tickable hunk", async () => {
  // baseline() falls back to HEAD, and for an untracked file both are empty.
  const text = "hello\nworld\n";
  write("new.txt", text);
  const hunks = await listUnstagedHunks(ctx, "new.txt", text);
  assert.ok(hunks.length >= 1);
  const r = await stageHunks(ctx, "new.txt", text, hunks.map((h) => h.index));
  assert.equal(r.ok, true);
  assert.equal(git("show", ":new.txt"), text);
});

test("staging nothing is a no-op, not an error", async () => {
  const r = await stageHunks(ctx, "f.txt", BASE, []);
  assert.deepEqual({ ok: r.ok, staged: r.staged }, { ok: true, staged: 0 });
});

test("stale indexes are REFUSED rather than staging the wrong lines", async () => {
  // The file changed between listing and ticking. Applying the old indexes would
  // stage whatever now happens to sit at those positions.
  const modified = twoEdits();
  const hunks = await listUnstagedHunks(ctx, "f.txt", modified);
  assert.equal(hunks.length, 2);

  // Everything gets staged by other means; nothing is left to tick.
  git("add", "f.txt");

  const r = await stageHunks(ctx, "f.txt", modified, [hunks[1].index]);
  assert.equal(r.ok, false, "must refuse rather than guess");
  assert.match(r.stderr, /no longer there/);
});

test("a deletion-only change is still tickable", async () => {
  // Pure deletions collapse to an empty range in the modified file — the hunk
  // must still be listed, or lines you removed could never be staged from here.
  const lines = BASE.split("\n");
  lines.splice(3, 2); // drop two lines
  const modified = lines.join("\n");
  write("f.txt", modified);

  const hunks = await listUnstagedHunks(ctx, "f.txt", modified);
  assert.ok(hunks.length >= 1, "a deletion is a hunk");

  const r = await stageHunks(ctx, "f.txt", modified, hunks.map((h) => h.index));
  assert.equal(r.ok, true);
  assert.equal(git("show", ":f.txt"), modified);
});
