import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { listChangeBlocks, setBlockStaged, isStageableText } from "../src/blockStaging";

// Against real git, because the only definition of "staged" that matters is
// git's. The engine tests pin the maths; these pin that the maths and git agree.
//
// This is also the first coverage the UNSTAGE direction has ever had in either
// product — there is no test file for the extension's lineStaging.ts, and the
// desktop's stageLines has never been exercised with reverse: true.

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

const write = (name: string, body: string): void => writeFileSync(join(repo, name), body);
const read = (name: string): string => readFileSync(join(repo, name), "utf8");
const T = (...lines: string[]): string => lines.join("\n") + "\n";

/** What git itself says is staged / unstaged, so the assertions are git's view. */
const cached = (): string => git("diff", "--cached", "--unified=0");
const unstagedDiff = (): string => git("diff", "--unified=0");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-blockstaging-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  write("f.txt", T("a", "b", "c", "d", "e"));
  git("add", "f.txt");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("a clean file has no blocks", async () => {
  const blocks = await listChangeBlocks(ctx, "f.txt", read("f.txt"));
  assert.deepEqual(blocks, []);
});

test("two edits list as two unstaged blocks", async () => {
  const working = T("a", "B", "c", "D", "e");
  write("f.txt", working);

  const blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.state), ["unstaged", "unstaged"]);
});

test("THE KILLER: staging one block of two leaves the other alone, on disk and in the index", async () => {
  const working = T("a", "B", "c", "D", "e");
  write("f.txt", working);
  const blocks = await listChangeBlocks(ctx, "f.txt", working);

  const r = await setBlockStaged(ctx, "f.txt", working, blocks[0], true);
  assert.equal(r.ok, true, r.stderr);

  // git agrees exactly one change is staged, and it is the first one.
  const staged = cached();
  assert.match(staged, /^\+B$/m, "the ticked change is staged");
  assert.doesNotMatch(staged, /^\+D$/m, "the unticked change is NOT staged");

  // ...the other is still waiting in the working tree...
  assert.match(unstagedDiff(), /^\+D$/m);

  // ...and the file the user is editing was never touched.
  assert.equal(read("f.txt"), working, "the working tree is untouched by staging");
});

test("after staging, the model reports that block staged and the other unstaged", async () => {
  const working = T("a", "B", "c", "D", "e");
  write("f.txt", working);
  let blocks = await listChangeBlocks(ctx, "f.txt", working);
  await setBlockStaged(ctx, "f.txt", working, blocks[0], true);

  blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(blocks.length, 2, "still two changes since HEAD");
  assert.deepEqual(blocks.map((b) => b.state), ["staged", "unstaged"]);
});

test("unstaging returns the index to HEAD for that block only", async () => {
  const working = T("a", "B", "c", "D", "e");
  write("f.txt", working);
  git("add", "f.txt"); // stage everything the blunt way

  let blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.deepEqual(blocks.map((b) => b.state), ["staged", "staged"]);

  const r = await setBlockStaged(ctx, "f.txt", working, blocks[0], false);
  assert.equal(r.ok, true, r.stderr);

  const staged = cached();
  assert.doesNotMatch(staged, /^\+B$/m, "the first block was rolled back");
  assert.match(staged, /^\+D$/m, "the second is still staged");
  assert.equal(read("f.txt"), working, "and the working tree still has both");

  blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.deepEqual(blocks.map((b) => b.state), ["unstaged", "staged"]);
});

test("a partially staged block completes when ticked", async () => {
  // Stage the middle line of what will become one 3-line block.
  write("f.txt", T("a", "b", "C", "d", "e"));
  git("add", "f.txt");
  const working = T("a", "B", "C", "D", "e");
  write("f.txt", working);

  let blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].state, "partial");

  const r = await setBlockStaged(ctx, "f.txt", working, blocks[0], true);
  assert.equal(r.ok, true, r.stderr);

  assert.equal(unstagedDiff().trim(), "", "nothing left unstaged for this file");
  blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(blocks[0].state, "staged");
});

test("a staged deletion reads staged, and unstages cleanly", async () => {
  const working = T("a", "c", "d", "e"); // "b" deleted
  write("f.txt", working);
  git("add", "f.txt");

  let blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].state, "staged", "a deletion must not be stuck at partial");

  const r = await setBlockStaged(ctx, "f.txt", working, blocks[0], false);
  assert.equal(r.ok, true, r.stderr);
  assert.equal(cached().trim(), "", "the deletion is no longer staged");
  assert.equal(read("f.txt"), working, "but it is still deleted on disk");
});

test("unstaging the only block of a NEW file removes the entry, not zeroes it", async () => {
  // The trap: writing "" would leave an empty file staged for addition, so the
  // commit would still create it. git reset drops the entry entirely.
  const body = T("brand", "new");
  write("new.txt", body);
  git("add", "new.txt");

  const blocks = await listChangeBlocks(ctx, "new.txt", body);
  assert.equal(blocks.length, 1);

  const r = await setBlockStaged(ctx, "new.txt", body, blocks[0], false);
  assert.equal(r.ok, true, r.stderr);

  assert.equal(git("ls-files", "--", "new.txt").trim(), "", "no index entry remains");
  assert.equal(read("new.txt"), body, "the file itself is untouched");
});

test("a block that no longer exists is refused, and says so as a user state", async () => {
  const working = T("a", "B", "c", "d", "e");
  write("f.txt", working);
  const [block] = await listChangeBlocks(ctx, "f.txt", working);

  // The user reverts that edit in their editor before the click lands.
  const reverted = T("a", "b", "c", "d", "e");

  const r = await setBlockStaged(ctx, "f.txt", reverted, block, true);
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "a moved file is a user state, not a crash report");
  assert.match(r.stderr, /no longer there/i);
  assert.equal(cached().trim(), "", "and nothing was staged from the stale request");
});

test("a vanished block is refused even when OTHER blocks remain", async () => {
  // The dangerous shape, and the one a weaker test misses: if the target block
  // is gone but the file still has changes, a lookup that does not really check
  // identity finds *a* block and stages the wrong change. Nothing in the UI
  // would show that the wrong edit went in.
  const working = T("a", "B", "c", "D", "e");
  write("f.txt", working);
  const blocks = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(blocks.length, 2);
  const first = blocks[0];

  // The user undoes the FIRST edit only; the second is still there.
  const partly = T("a", "b", "c", "D", "e");
  write("f.txt", partly);

  const r = await setBlockStaged(ctx, "f.txt", partly, first, true);
  assert.equal(r.ok, false, "the block it named is gone");
  assert.equal(r.expected, true);
  assert.equal(cached().trim(), "", "and emphatically NOT the surviving block instead");
});

test("a block that merely SHIFTED is still stageable", async () => {
  // The reason identity is content-derived rather than positional: an edit above
  // must not invalidate the tick below it.
  const working = T("a", "b", "c", "D", "e");
  write("f.txt", working);
  const [block] = await listChangeBlocks(ctx, "f.txt", working);

  // A line is inserted above; the same change is now one line lower.
  const shifted = T("NEW", "a", "b", "c", "D", "e");
  write("f.txt", shifted);

  const blocks = await listChangeBlocks(ctx, "f.txt", shifted);
  const stillThere = blocks.find((b) => b.head.start === block.head.start);
  assert.ok(stillThere, "the same HEAD-side change is still listed");

  const r = await setBlockStaged(ctx, "f.txt", shifted, stillThere, true);
  assert.equal(r.ok, true, r.stderr);
  assert.match(cached(), /^\+D$/m);
});

test("CRLF content stages the same blob git add would write", async () => {
  // The clean-filter path: under text=auto git normalises on the way into the
  // index, and our blob has to agree or the file reads as wholly modified.
  write(".gitattributes", "* text=auto\n");
  git("add", ".gitattributes");
  git("commit", "-m", "normalise");
  write("crlf.txt", "one\r\ntwo\r\n");
  git("add", "crlf.txt");
  git("commit", "-m", "add crlf");

  const working = "one\r\nTWO\r\n";
  write("crlf.txt", working);
  const [block] = await listChangeBlocks(ctx, "crlf.txt", working);
  const r = await setBlockStaged(ctx, "crlf.txt", working, block, true);
  assert.equal(r.ok, true, r.stderr);

  // What git itself would have produced for the same content.
  const ours = git("ls-files", "-s", "crlf.txt").trim().split(/\s+/)[1];
  git("reset", "-q");
  git("add", "crlf.txt");
  const theirs = git("ls-files", "-s", "crlf.txt").trim().split(/\s+/)[1];
  assert.equal(ours, theirs, "our blob must match `git add`");
});

// Files where a per-change tick could not be honest. Offering one would put a
// real control over a meaningless line diff, so these degrade to no ticks and
// the whole-file staging path stays the way to handle them.

const BINARY = `PNG\u0000rubbish\u0000bytes\n`;

test("binary content gets no ticks, and refuses a write", async () => {
  write("logo.png", BINARY);
  git("add", "logo.png");
  git("commit", "-m", "add binary");
  const edited = BINARY + `more\u0000bytes\n`;
  write("logo.png", edited);

  const blocks = await listChangeBlocks(ctx, "logo.png", edited);
  assert.deepEqual(blocks, [], "a line diff of binary content is not stageable");

  const r = await setBlockStaged(
    ctx,
    "logo.png",
    edited,
    { head: { start: 0, end: 0 }, working: { start: 0, end: 0 }, state: "unstaged" },
    true,
  );
  assert.equal(r.ok, false);
  assert.equal(r.expected, true, "a binary file is a user state, not a crash report");
  assert.match(r.stderr, /staged whole/i);
});

test("a NUL anywhere is enough to call it binary", () => {
  assert.equal(isStageableText("plain text\n"), true);
  assert.equal(isStageableText(`has a \u0000 in it\n`), false);
});

test("an enormous file gets no ticks", () => {
  // Cheaper to assert on the predicate than to write 20k lines to disk.
  assert.equal(isStageableText("x\n".repeat(20_001)), false);
  assert.equal(isStageableText("x\n".repeat(100)), true);
});

test("the guard does not reject ordinary source files", () => {
  assert.equal(isStageableText(""), true);
  assert.equal(isStageableText("const a = 1;\n"), true);
  assert.equal(isStageableText("emoji and accents e\u0301\n"), true);
  assert.equal(isStageableText("crlf\r\nlines\r\n"), true);
});
