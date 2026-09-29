import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChangeBlocks } from "@gitstudio/engine/staging/blockStaging";
import { initRepo, type BridgeRepo } from "./gitBridgeFixture";

// The Changes view's writes: ticks per change block and per hunk, Stage / Stage
// all over a conflicted merge, Discard and its Undo, Stash, and Commit. Every
// case reads the index or the repository back after the call — the answer
// the bridge gives is only half of it.

let r: BridgeRepo | undefined;
afterEach(() => {
  r?.cleanup();
  r = undefined;
});

function repo(prefix = "staging"): BridgeRepo {
  r = initRepo(prefix);
  return r;
}

const LINES = (n: number, edit: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

const indexOf = (t: BridgeRepo, rel: string): string => t.git("show", `:${rel}`);

// ── change-block ticks ──────────────────────────────────────────────────────

test("ticking one change block stages that block alone and hands back the new index", async () => {
  const t = repo();
  t.write("f.txt", LINES(20));
  t.commitAll("base");
  const working = LINES(20, { 2: "EDIT TWO", 18: "EDIT EIGHTEEN" });
  t.write("f.txt", working);

  const head = LINES(20);
  const blocks = computeChangeBlocks(head, head, working);
  assert.equal(blocks.length, 2, "two separate changes");
  const second = blocks[1];

  const on = await t.bridge.blocksSet({ path: "f.txt", block: second, staged: true });
  assert.equal(on.ok, true, on.message);
  assert.equal(on.changed, true);
  const idx = indexOf(t, "f.txt");
  assert.match(idx, /EDIT EIGHTEEN/, "the ticked block is staged");
  assert.doesNotMatch(idx, /EDIT TWO/, "the other one is not");
  assert.equal(on.indexText, idx, "the ticks repaint from the index git now holds");

  // And the tick comes off again: the block goes back to HEAD in the index.
  const now = computeChangeBlocks(head, idx, working)[1];
  const off = await t.bridge.blocksSet({ path: "f.txt", block: now, staged: false });
  assert.equal(off.ok, true, off.message);
  assert.equal(indexOf(t, "f.txt"), head);
});

test("a block that moved under the tick is a stated refusal, and the index is untouched", async () => {
  const t = repo();
  t.write("f.txt", LINES(10));
  t.commitAll("base");
  t.write("f.txt", LINES(10, { 5: "changed" }));
  const stale = { head: { start: 0, end: 0 }, working: { start: 0, end: 0 }, state: "unstaged" as const };
  const res = await t.bridge.blocksSet({ path: "f.txt", block: stale, staged: true });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true, "the file moved — a user state, not a crash report");
  assert.equal(indexOf(t, "f.txt"), LINES(10));
});

test("a block tick on a path outside the repository or a missing file changes nothing", async () => {
  const t = repo();
  t.write("f.txt", "x\n");
  t.commitAll("base");
  const block = { head: { start: 0, end: 0 }, working: { start: 0, end: 0 }, state: "unstaged" as const };
  const outside = await t.bridge.blocksSet({ path: "../escape.txt", block, staged: true });
  assert.equal(outside.ok, false);
  assert.match(outside.message ?? "", /valid git reference/);

  const missing = await t.bridge.blocksSet({ path: "gone.txt", block, staged: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.expected, undefined, "an unreadable file we were asked to tick is news");
  assert.match(missing.message ?? "", /ENOENT/);
});

// ── per-file stage / unstage over a merge ───────────────────────────────────

function mergeConflict(t: BridgeRepo): void {
  t.write("clash.txt", "base\n");
  t.write("resolved.txt", "base\n");
  t.write("gone-on-topic.txt", "base\n");
  t.write("pic.bin", Buffer.from([1, 0, 2, 0, 3]));
  t.write("plain.txt", "plain\n");
  t.commitAll("base");
  t.git("checkout", "-q", "-b", "topic");
  t.write("clash.txt", "theirs\n");
  t.write("resolved.txt", "theirs\n");
  t.git("rm", "-q", "gone-on-topic.txt");
  t.write("pic.bin", Buffer.from([9, 0, 9, 0, 9]));
  t.commitAll("topic");
  t.git("checkout", "-q", "main");
  t.write("clash.txt", "ours\n");
  t.write("resolved.txt", "ours\n");
  t.write("gone-on-topic.txt", "edited on main\n");
  t.write("pic.bin", Buffer.from([7, 0, 7, 0, 7]));
  t.commitAll("main");
  t.gitTry("merge", "topic");
}

const unmerged = (t: BridgeRepo): string[] =>
  t.git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean).sort();

test("Stage on a conflicted file that still has markers is refused; once resolved it stages", async () => {
  const t = repo();
  mergeConflict(t);
  const refused = await t.bridge.stage("clash.txt");
  assert.equal(refused.ok, false);
  assert.equal(refused.expected, true);
  assert.match(refused.message ?? "", /still contains conflict markers/);
  assert.ok(unmerged(t).includes("clash.txt"), "the conflict is not marked resolved");

  t.write("clash.txt", "resolved by hand\n");
  const ok = await t.bridge.stage("clash.txt");
  assert.equal(ok.ok, true, ok.message);
  assert.equal(unmerged(t).includes("clash.txt"), false);
  assert.equal(indexOf(t, "clash.txt"), "resolved by hand\n");
});

test("a conflicted file removed from disk stages as its deletion", async () => {
  const t = repo();
  mergeConflict(t);
  unlinkSync(join(t.repo, "clash.txt"));
  const res = await t.bridge.stage("clash.txt");
  assert.equal(res.ok, true, res.message);
  assert.equal(unmerged(t).includes("clash.txt"), false);
  assert.equal(t.gitTry("cat-file", "-e", ":clash.txt").code === 0, false, "gone from the index");
});

test("Stage all holds back marker-bearing, modify/delete and binary conflicts and stages the rest", async () => {
  const t = repo();
  mergeConflict(t);
  t.write("resolved.txt", "resolved\n");
  t.write("plain.txt", "plain, edited during the merge\n");

  const res = await t.bridge.stageAll();
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.equal(res.changed, true, "everything else WAS staged");
  assert.match(res.message ?? "", /^Staged everything else\./);
  assert.match(res.message ?? "", /1 still contains conflict markers \(clash\.txt\)/);
  assert.match(res.message ?? "", /2 are modify\/delete conflicts \(gone-on-topic\.txt, pic\.bin\)|2 are modify\/delete conflicts \(pic\.bin, gone-on-topic\.txt\)/);

  // What the message says is what the index holds.
  assert.deepEqual(unmerged(t), ["clash.txt", "gone-on-topic.txt", "pic.bin"]);
  assert.equal(indexOf(t, "resolved.txt"), "resolved\n");
  assert.equal(indexOf(t, "plain.txt"), "plain, edited during the merge\n");
});

test("Stage all names the first three held files and counts the rest", async () => {
  const t = repo();
  const files = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
  for (const f of files) t.write(f, "base\n");
  t.commitAll("base");
  t.git("checkout", "-q", "-b", "topic");
  for (const f of files) t.write(f, "theirs\n");
  t.commitAll("topic");
  t.git("checkout", "-q", "main");
  for (const f of files) t.write(f, "ours\n");
  t.commitAll("main");
  t.gitTry("merge", "topic");

  const res = await t.bridge.stageAll();
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /5 still contain conflict markers \(a\.txt, b\.txt, c\.txt and 2 more\)/);
  assert.equal(unmerged(t).length, 5, "nothing was marked resolved");
});

test("Unstage takes one file out of the index and leaves the working copy", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  t.write("a.txt", "two\n");
  t.git("add", "a.txt");
  const res = await t.bridge.unstage("a.txt");
  assert.equal(res.ok, true, res.message);
  assert.equal(indexOf(t, "a.txt"), "one\n");
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "two\n");
});

// ── discard ────────────────────────────────────────────────────────────────

test("Discard on a modify/delete conflict says git's reason and changes nothing", async () => {
  const t = repo();
  mergeConflict(t);
  const res = await t.bridge.discard("gone-on-topic.txt");
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /does not have all necessary versions/);
  assert.equal(readFileSync(join(t.repo, "gone-on-topic.txt"), "utf8"), "edited on main\n");
});

test("undoing a discard over several files edited again since names them all and restores none", async () => {
  const t = repo();
  t.write("a.txt", "a\n");
  t.write("b.txt", "b\n");
  t.commitAll("base");
  t.write("a.txt", "a work\n");
  t.write("b.txt", "b work\n");
  const snap = await t.bridge.discardSnapshot();
  assert.ok(snap.sha);
  t.git("checkout", "--", "a.txt", "b.txt");
  t.write("a.txt", "a newer\n");
  t.write("b.txt", "b newer\n");

  const res = await t.bridge.discardUndo({ sha: snap.sha, paths: ["a.txt", "b.txt"] });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /^2 files have changed since their changes were discarded \(a\.txt, b\.txt\)/);
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "a newer\n");
  assert.equal(readFileSync(join(t.repo, "b.txt"), "utf8"), "b newer\n");
});

test("undoing a discard against a restore point git cannot read changes nothing and is reported", async () => {
  const t = repo();
  t.write("a.txt", "a\n");
  const plain = t.commitAll("base — a commit, not a snapshot: it has no second parent");
  t.write("a.txt", "work\n");
  const res = await t.bridge.discardUndo({ sha: plain, paths: ["a.txt"] });
  assert.equal(res.ok, false);
  assert.equal(res.expected, undefined, "our own restore point failing is our bug");
  assert.match(res.message ?? "", /Couldn't tell whether those files have changed since/);
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "work\n");

  const empty = await t.bridge.discardUndo({ sha: plain, paths: [""] });
  assert.deepEqual(empty, { ok: false, expected: true, message: "Nothing to restore." });
  const flag = await t.bridge.discardUndo({ sha: "--hard", paths: ["a.txt"] });
  assert.equal(flag.ok, false);
});

// ── commit ─────────────────────────────────────────────────────────────────

test("Commit records the staged change and nothing else", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  t.write("a.txt", "two\n");
  t.write("b.txt", "not staged\n");
  t.git("add", "a.txt");
  const res = await t.bridge.commit({ message: "change a" });
  assert.deepEqual(res, { ok: true, changed: true });
  assert.equal(t.git("log", "-1", "--format=%s").trim(), "change a");
  assert.equal(t.git("show", "--name-only", "--format=", "HEAD").trim(), "a.txt");
});

test("Commit with no message is refused before git runs", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  const head = t.commitAll("base");
  t.write("a.txt", "two\n");
  t.git("add", "a.txt");
  const res = await t.bridge.commit({ message: "   " });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /message is required/);
  assert.equal(t.git("rev-parse", "HEAD").trim(), head);
});

test("Commit with nothing staged says why in the app's words, not an empty toast", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  t.write("a.txt", "edited but not staged\n");
  const res = await t.bridge.commit({ message: "too early" });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /Nothing is staged/);
});

test("Commit refused by a silent pre-commit hook says to check the hook, as a state", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  const hooks = mkdtempSync(join(tmpdir(), "gitstudio-hooks-"));
  t.alsoRemove.push(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  t.git("config", "core.hooksPath", hooks.split("\\").join("/"));
  t.write("a.txt", "two\n");
  t.git("add", "a.txt");
  const res = await t.bridge.commit({ message: "blocked" });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true, "a hook doing its job is not a GitStudio crash");
  assert.match(res.message ?? "", /pre-commit hook/);
  assert.equal(t.git("log", "-1", "--format=%s").trim(), "base");
});

test("Commit during a part-applied patch series is refused in favour of Continue", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  t.git("checkout", "-q", "-b", "patch");
  t.write("a.txt", "from the patch\n");
  t.commitAll("the patch");
  const out = mkdtempSync(join(tmpdir(), "gitstudio-patches-"));
  t.alsoRemove.push(out);
  t.git("format-patch", "-q", "-1", "-o", out);
  t.git("checkout", "-q", "main");
  t.write("a.txt", "conflicting line\n");
  t.commitAll("main moves");
  const patch = join(out, readdirSync(out)[0]);
  assert.notEqual(t.gitTry("am", patch).code, 0, "the patch stops");

  const state = await t.bridge.opState();
  assert.equal(state.amApplying, true);
  assert.equal(state.kind, "am");

  t.write("b.txt", "unrelated\n");
  t.git("add", "b.txt");
  const res = await t.bridge.commit({ message: "a plain commit" });
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.message ?? "", /patch series is part-applied/);
  assert.equal(t.git("log", "-1", "--format=%s").trim(), "main moves", "nothing was committed");

  // Abandoning the series ends it and says nothing of rewinding when HEAD had not moved.
  const aborted = await t.bridge.amAbort();
  assert.equal(aborted.ok, true, aborted.message);
  assert.equal(aborted.message, undefined);
  assert.equal((await t.bridge.opState()).amApplying, false);
});

test("abandoning a patch series when none is running reports git's refusal", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  const res = await t.bridge.amAbort();
  assert.equal(res.ok, false);
  assert.equal(res.changed, false);
  assert.match(res.message ?? "", /not in progress/i, "git's own reason, not a blank toast");
  assert.equal(t.git("log", "-1", "--format=%s").trim(), "base");
});

// ── stash save ─────────────────────────────────────────────────────────────

test("Stash puts the working tree away and says so; a clean tree or selection is a stated no-op", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.write("b.txt", "b\n");
  t.commitAll("base");

  const clean = await t.bridge.stashSave({ message: "nothing" });
  assert.equal(clean.ok, false);
  assert.equal(clean.expected, true);
  assert.equal(clean.message, "Nothing to stash — the working tree is clean.");

  t.write("a.txt", "work\n");
  const cleanSelection = await t.bridge.stashSave({ paths: ["b.txt"] });
  assert.equal(cleanSelection.message, "Nothing to stash — the files you selected have no changes.");
  const nothingStaged = await t.bridge.stashSave({ stagedOnly: true });
  assert.equal(nothingStaged.message, "Nothing to stash — nothing is staged.");

  const saved = await t.bridge.stashSave({ message: "my work", paths: ["a.txt", ""] });
  assert.deepEqual(saved, { ok: true, changed: true });
  assert.equal(readFileSync(join(t.repo, "a.txt"), "utf8"), "one\n");
  assert.match(t.git("stash", "list"), /my work/);
});

test("Stash refuses a path outside the repository and git's unsupported staged-plus-paths", async () => {
  const t = repo();
  t.write("a.txt", "one\n");
  t.commitAll("base");
  t.write("a.txt", "work\n");
  t.git("add", "a.txt");
  const outside = await t.bridge.stashSave({ paths: ["../../etc/passwd"] });
  assert.equal(outside.ok, false);
  assert.match(outside.message ?? "", /valid git reference/);

  const mixed = await t.bridge.stashSave({ stagedOnly: true, paths: ["a.txt"] });
  assert.equal(mixed.ok, false);
  assert.match(mixed.message ?? "", /not supported by git/);
  assert.equal(t.git("stash", "list").trim(), "", "nothing was stashed");
  assert.equal(indexOf(t, "a.txt"), "work\n");
});

// ── hunks ──────────────────────────────────────────────────────────────────

test("hunks are listed for a text file and staged one at a time", async () => {
  const t = repo();
  t.write("f.txt", LINES(30));
  t.commitAll("base");
  t.write("f.txt", LINES(30, { 3: "top edit", 27: "bottom edit" }));

  const hunks = await t.bridge.hunksList("f.txt");
  assert.equal(hunks.length, 2);
  const res = await t.bridge.hunksStage({ path: "f.txt", index: 1 });
  assert.equal(res.ok, true, res.message);
  const idx = indexOf(t, "f.txt");
  assert.match(idx, /bottom edit/);
  assert.doesNotMatch(idx, /top edit/);
  assert.equal((await t.bridge.hunksList("f.txt")).length, 1, "one change left to stage");

  const stale = await t.bridge.hunksStage({ path: "f.txt", index: 7 });
  assert.equal(stale.ok, false);
  assert.equal(stale.expected, true, "the list moved under the tick");
});

test("no hunks are offered for binaries, paths outside the repo or a missing file", async () => {
  const t = repo();
  t.write("pic.bin", Buffer.from([0x89, 0x50, 0x00, 0x01]));
  t.commitAll("base");
  t.write("pic.bin", Buffer.from([0x89, 0x50, 0x00, 0x02]));
  assert.deepEqual(await t.bridge.hunksList("pic.bin"), []);
  assert.deepEqual(await t.bridge.hunksList("../outside.txt"), []);
  assert.deepEqual(await t.bridge.hunksList(""), []);
  assert.deepEqual(await t.bridge.hunksList("never-existed.txt"), []);

  const bin = await t.bridge.hunksStage({ path: "pic.bin", index: 0 });
  assert.equal(bin.ok, false);
  assert.equal(bin.expected, true);
  assert.match(bin.message ?? "", /isn't UTF-8 text/);
  const outside = await t.bridge.hunksStage({ path: "../x", index: 0 });
  assert.equal(outside.ok, false);
});

// ── line staging ────────────────────────────────────────────────────────────

test("unstaging lines of a newly added file unstages the whole add and keeps the file", async () => {
  const t = repo();
  t.write("a.txt", "a\n");
  t.commitAll("base");
  t.write("new.txt", "first\nsecond\n");
  t.git("add", "new.txt");
  const res = await t.bridge.stageLines({ path: "new.txt", lines: [1], reverse: true });
  assert.deepEqual(res, { ok: true, changed: true });
  assert.equal(t.gitTry("cat-file", "-e", ":new.txt").code === 0, false, "no longer in the index");
  assert.equal(readFileSync(join(t.repo, "new.txt"), "utf8"), "first\nsecond\n", "the file is untouched");
});

test("unstaging a run of lines inside one staged change rolls back that change", async () => {
  const t = repo();
  t.write("f.txt", LINES(10));
  t.commitAll("base");
  const edited = LINES(10, { 4: "four A", 5: "five A" });
  t.write("f.txt", edited);
  t.git("add", "f.txt");
  // Lines 4 and 5, in working-tree numbering, both inside the one staged change.
  const res = await t.bridge.stageLines({ path: "f.txt", lines: [5, 4], reverse: true });
  assert.equal(res.ok, true, res.message);
  assert.equal(indexOf(t, "f.txt"), LINES(10));
  assert.equal(readFileSync(join(t.repo, "f.txt"), "utf8"), edited);
});

test("line staging refuses an empty selection, a selection with no change under it, and a binary index side", async () => {
  const t = repo();
  t.write("f.txt", LINES(5));
  t.write("blob.txt", "text\n");
  t.commitAll("base");
  t.write("f.txt", LINES(5, { 5: "edited" }));

  const none = await t.bridge.stageLines({ path: "f.txt", lines: [0, -1, 1.5] });
  assert.deepEqual(none, { ok: false, changed: false, expected: true, message: "No lines selected." });

  const nothingThere = await t.bridge.stageLines({ path: "f.txt", lines: [1] });
  assert.equal(nothingThere.ok, false);
  assert.equal(nothingThere.message, "Nothing to apply in the selection.");

  const nothingStaged = await t.bridge.stageLines({ path: "f.txt", lines: [1], reverse: true });
  assert.equal(nothingStaged.ok, false);
  assert.equal(nothingStaged.message, "Nothing to apply in the selection.");

  // The index side is binary even though the working file is text again.
  t.write("blob.txt", Buffer.from([0, 1, 2, 3]));
  t.git("add", "blob.txt");
  t.write("blob.txt", "text\nmore\n");
  const bin = await t.bridge.stageLines({ path: "blob.txt", lines: [2] });
  assert.equal(bin.ok, false);
  assert.equal(bin.expected, true);
  assert.match(bin.message ?? "", /staged as a binary file/);

  const outside = await t.bridge.stageLines({ path: "../f.txt", lines: [1] });
  assert.equal(outside.ok, false);
  assert.match(outside.message ?? "", /valid git reference/);
});

test("a held index.lock surfaces git's own advice when staging lines", async () => {
  const t = repo();
  t.write("f.txt", LINES(5));
  t.commitAll("base");
  t.write("f.txt", LINES(5, { 2: "edited" }));
  const lock = join(t.repo, ".git", "index.lock");
  writeFileSync(lock, "");
  try {
    const res = await t.bridge.stageLines({ path: "f.txt", lines: [2] });
    assert.equal(res.ok, false);
    assert.match(res.message ?? "", /index\.lock|Another git process/i, "git's words, not a generic failure");
  } finally {
    rmSync(lock, { force: true });
  }
  assert.equal(existsSync(lock), false);
  assert.equal(indexOf(t, "f.txt"), LINES(5), "nothing was staged");
});
