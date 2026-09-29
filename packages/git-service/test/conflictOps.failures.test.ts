// ConflictOps when git can't answer or refuses a step — and the reads that
// take an operation from the caller. The rule in every write: a failure is
// said in git's words (or a plain fallback), and the conflict is left exactly
// as it was — never a file deleted or a side guessed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, FIVE, edit, type Repo } from "./opRepo";
import { ConflictOps, xyFromStages, CONFLICT_TEXT_CAP_BYTES } from "../src/ConflictOps";
import type { OperationSource } from "../src/OperationProvider";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { cmd, fail, tap, type Rule } from "./stashProvider.kit";

const repos: Repo[] = [];
const procs: { dispose(): void }[] = [];
after(() => {
  for (const p of procs.splice(0)) p.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

/**
 * master and side from one base, then `git merge side`:
 *   both.txt       UU  (line three edited on each side)
 *   gone.txt       UD  (master edits, side deletes)
 *   deep/sub/f.txt DU  (master deletes the folder, side edits)
 *   doomed.txt     DD  (renamed differently on each side: ours.txt AU, theirs.txt UA)
 */
function conflicted(name: string): Repo {
  const r = makeRepo(name);
  repos.push(r);
  r.write("both.txt", FIVE);
  r.write("gone.txt", "gone\n");
  r.write("deep/sub/f.txt", "deep\n");
  r.write("doomed.txt", "contents\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  r.write("both.txt", edit(FIVE, { three: "three-side" }));
  rmSync(join(r.root, "gone.txt"));
  r.write("deep/sub/f.txt", "deep, edited on side\n");
  r.git("mv", "doomed.txt", "theirs.txt");
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  r.write("both.txt", edit(FIVE, { three: "three-master" }));
  r.write("gone.txt", "gone, edited on master\n");
  rmSync(join(r.root, "deep"), { recursive: true });
  r.git("mv", "doomed.txt", "ours.txt");
  r.commitAll("master");
  r.tryGit("merge", "side");
  return r;
}

/** ConflictOps over `r`, git answered through `rule`, the operation read for real (and counted). */
function opsFor(r: Repo, rule: Rule = () => undefined, operation?: OperationSource): { ops: ConflictOps; ran: string[][]; views: () => number } {
  const t = tap(r.root, rule);
  procs.push(t);
  const ctx = r.ctx();
  let views = 0;
  const counted: OperationSource = operation ?? {
    view: (o) => {
      views++;
      return ctx.operation.view(o);
    },
  };
  return { ops: new ConflictOps(t.proc, r.root, ctx.conflict, counted), ran: t.ran, views: () => views };
}

const unmerged = (r: Repo): string => r.git("ls-files", "-u");
const stage0 = (r: Repo, p: string): string => r.git("ls-files", "-s", "--", p).trim();
const isListing = (a: string[]): boolean => a[0] === "ls-files" && a.includes("-u") && !a.includes("--eol");

// ── Reads that take the caller's operation ─────────────────────────────────

test("every read and write handed the operation uses it, and never reads it again", async () => {
  const r = conflicted("given-op");
  const { ops, views } = opsFor(r);
  const op = await r.ctx().operation.view();
  const files = await ops.conflictFiles({ op });
  assert.deepEqual(files.map((f) => f.path).sort(), ["both.txt", "deep/sub/f.txt", "doomed.txt", "gone.txt", "ours.txt", "theirs.txt"]);
  assert.equal((await ops.fileFacts("gone.txt", { op }))?.missingRole, "theirs");
  const sides = await ops.readSides("both.txt", { op });
  assert.match(sides.yours, /three-master/);
  const snap = await ops.snapshot({ op });
  assert.equal(snap.total, 6);
  assert.equal((await ops.takeRole("both.txt", "theirs", { op })).ok, true);
  assert.equal((await ops.deleteFile("doomed.txt", { op })).ok, true);
  assert.equal((await ops.writeResolution("gone.txt", "hand merged\n", { op })).ok, true);
  assert.equal(views(), 0, "the operation was never read");
  const after = await ops.snapshot({ op });
  assert.deepEqual(
    after.files.filter((f) => f.status === "resolved").map((f) => [f.path, f.choice]),
    [["both.txt", "theirs"], ["doomed.txt", undefined], ["gone.txt", "merged"]].sort(),
  );
});

test("readSides of a path that is not conflicted reads the sides from its markers, as text", async () => {
  const r = conflicted("sides-markers");
  const { ops } = opsFor(r);
  const workingText = "<<<<<<< ours\nmine\n||||||| base\norig\n=======\nyours-too\n>>>>>>> theirs\n";
  const sides = await ops.readSides("elsewhere.txt", { workingText });
  assert.equal(sides.source, "markers");
  assert.equal(sides.shape, "text");
  assert.equal(sides.hasBase, true, "a diff3 marker block has a base");
  assert.equal(sides.base, "orig\n");
  assert.equal(sides.missingRole, undefined);
  // A merge: yours is stage 2, the markers' "ours" section.
  assert.equal(sides.yours, "mine\n");
  assert.equal(sides.theirs, "yours-too\n");
});

test("when git can't list the conflicted files, the read throws rather than report none", async () => {
  const r = conflicted("listing-throws");
  const worded = opsFor(r, (a) => (a.includes("--eol") ? fail("fatal: index file corrupt\n", 128) : undefined));
  await assert.rejects(worded.ops.conflictFiles(), /Couldn't read the conflicted files: fatal: index file corrupt$/);
  const silent = opsFor(r, (a) => (a.includes("--eol") ? fail("", 128) : undefined));
  await assert.rejects(silent.ops.fileFacts("both.txt"), /Couldn't read the conflicted files: git ls-files -u failed \(128\)$/);
});

// ── Writes refused when the conflict state can't be read ──────────────────

test("take, delete and restore refuse when git can't list the conflict, and change nothing", async () => {
  const r = conflicted("listing-refused");
  const before = unmerged(r);
  const { ops, ran } = opsFor(r, (a) => (isListing(a) ? fail("fatal: bad") : undefined));
  for (const out of [
    await ops.takeRole("both.txt", "yours"),
    await ops.takeStage("both.txt", 3),
    await ops.deleteFile("doomed.txt"),
    await ops.restore("both.txt"),
  ]) {
    assert.equal(out.ok, false);
    assert.equal(out.expected, true);
    assert.match(out.message ?? "", /^Couldn't read the conflict state for \S+\. Nothing was changed\.$/);
  }
  assert.equal(ran.some((a) => a.includes("checkout") || a.includes("rm") || a.includes("add")), false);
  assert.equal(unmerged(r), before);
});

test("delete and restore refuse an unusable path before asking git anything", async () => {
  const r = conflicted("guard");
  const { ops, ran } = opsFor(r);
  for (const out of [await ops.deleteFile(""), await ops.restore("../outside.txt")]) {
    assert.equal(out.ok, false);
    assert.equal(out.changed, false);
  }
  assert.deepEqual(ran, []);
});

// ── Delete (both-deleted) ─────────────────────────────────────────────────

test("deleteFile refuses a path no longer conflicted, and one a side still has", async () => {
  const r = conflicted("delete-refusals");
  const { ops } = opsFor(r);
  const clean = await ops.deleteFile("never-conflicted.txt");
  assert.deepEqual(clean, { ok: false, changed: false, expected: true, message: "never-conflicted.txt is no longer conflicted — nothing was changed." });
  const side = await ops.deleteFile("gone.txt");
  assert.match(side.message ?? "", /gone\.txt still exists on one side\. Accept Yours or Accept Theirs instead\./);
  assert.match(unmerged(r), /\tgone\.txt$/m, "still conflicted");
});

test("deleteFile reports git's refusal of the rm, and the both-deleted row stays unmerged", async () => {
  const r = conflicted("delete-rm-fails");
  const { ops } = opsFor(r, (a) => (a.includes("rm") ? fail("hint: try again\nfatal: Unable to create index.lock\n", 128) : undefined));
  const out = await ops.deleteFile("doomed.txt");
  assert.deepEqual(out, { ok: false, changed: false, message: "fatal: Unable to create index.lock" });
  assert.match(unmerged(r), /\tdoomed\.txt$/m);
});

test("deleteFile settles a both-deleted file even when the operation can't be read", async () => {
  const r = conflicted("delete-no-op");
  const broken: OperationSource = { view: () => Promise.reject(new Error("no operation")) };
  const { ops } = opsFor(r, () => undefined, broken);
  const out = await ops.deleteFile("doomed.txt");
  assert.deepEqual(out, { ok: true, changed: true });
  assert.doesNotMatch(unmerged(r), /\tdoomed\.txt$/m);
});

// ── Take a side ───────────────────────────────────────────────────────────

test("takeStage of a path no longer conflicted is refused, and notes nothing", async () => {
  const r = conflicted("takestage-clean");
  const { ops, ran } = opsFor(r);
  const out = await ops.takeStage("never.txt", 2);
  assert.equal(out.ok, false);
  assert.match(out.message ?? "", /no longer conflicted/);
  assert.equal(ran.some((a) => a.includes("-s")), false, "no stage-0 entry was read to note");
});

test("a checkout that worked but an add git refused: said in git's words, or plainly when git only hints", async () => {
  const r = conflicted("add-fails");
  const worded = opsFor(r, (a) => (a.includes("add") ? fail("hint: a hint\r\n\r\nerror: insufficient permission\r\n") : undefined));
  assert.deepEqual(await worded.ops.takeRole("both.txt", "yours"), { ok: false, changed: false, message: "error: insufficient permission" });
  const hinted = opsFor(r, (a) => (a.includes("add") ? fail("hint: only a hint\n") : undefined));
  assert.deepEqual(await hinted.ops.takeRole("both.txt", "yours"), { ok: false, changed: false, message: "Couldn't stage both.txt." });
  assert.match(unmerged(r), /\tboth\.txt$/m, "the conflict is still there to resolve");
});

test("taking the side that recreates a deleted folder works even when the folder is gone from disk", async () => {
  const r = conflicted("folder-gone");
  // The user cleared the folder away while deciding; the guard climbs to the
  // nearest folder that exists (the repository) to check where the path leads.
  rmSync(join(r.root, "deep"), { recursive: true, force: true });
  const { ops } = opsFor(r);
  const out = await ops.takeRole("deep/sub/f.txt", "theirs");
  assert.deepEqual(out, { ok: true, changed: true });
  assert.equal(r.read("deep/sub/f.txt"), "deep, edited on side\n");
  assert.match(stage0(r, "deep/sub/f.txt"), / 0\tdeep\/sub\/f\.txt$/);
});

test("when git can't list a folder's files, the folder on disk still blocks taking the file", async () => {
  const r = conflicted("folder-listing");
  // gone.txt is conflicted; a folder now stands where the file was.
  rmSync(join(r.root, "gone.txt"));
  mkdirSync(join(r.root, "gone.txt"));
  writeFileSync(join(r.root, "gone.txt", "inside.txt"), "inside\n");
  const { ops } = opsFor(r, (a) => (cmd(a).endsWith("-- gone.txt/") ? fail("fatal: bad") : undefined));
  const out = await ops.takeRole("gone.txt", "yours");
  assert.equal(out.ok, false);
  assert.match(out.message ?? "", /gone\.txt is a file on one side and a folder on the other \(gone\.txt\/ is in the folder\)/);
  assert.equal(r.read("gone.txt/inside.txt"), "inside\n");
});

/** layout/panel: a file on master (stage 2 in a rebase), a folder with a file on test (stage 0), rebase --apply stopped. */
function fileVersusFolder(): Repo {
  const r = makeRepo("cov-file-folder");
  repos.push(r);
  r.write("keep.txt", "keep\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "test");
  r.write("layout/panel/index.txt", "the folder's file\n");
  r.commitAll("test: a folder");
  r.git("checkout", "-q", "master");
  r.write("layout/panel", "the file\n");
  r.commitAll("master: a file");
  r.git("checkout", "-q", "test");
  r.tryGit("rebase", "--apply", "master");
  // git 2.50+ moves the file aside in the index too; put it back in 2.49's shape.
  const aside = /^(\d{6}) ([0-9a-f]+) 2\tlayout\/panel~HEAD$/m.exec(r.git("ls-files", "-u"));
  if (aside) {
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: r.root,
      input: `0 ${"0".repeat(aside[2].length)}\tlayout/panel~HEAD\n${aside[1]} ${aside[2]} 2\tlayout/panel\n`,
    });
  }
  return r;
}

test("a file/folder conflict: when git refuses to drop the file's entry, the folder and the conflict stay", async () => {
  const r = fileVersusFolder();
  const { ops } = opsFor(r, (a) => (a[0] === "update-index" && a.includes("--force-remove") ? fail("") : undefined));
  const out = await ops.takeRole("layout/panel", "yours");
  assert.deepEqual(out, { ok: false, changed: false, message: "Couldn't delete layout/panel." });
  assert.match(unmerged(r), /\tlayout\/panel\n/);
  assert.equal(r.read("layout/panel/index.txt"), "the folder's file\n");
});

/** A gitlink conflict with no submodule checked out: lib at 1… (base), 3… (master), 2… (side). */
function gitlinkConflict(): Repo {
  const r = makeRepo("cov-gitlink");
  repos.push(r);
  r.write("f.txt", "f\n");
  r.git("add", "f.txt");
  r.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},lib`);
  r.git("commit", "-q", "-m", "base");
  r.git("checkout", "-q", "-b", "side");
  r.git("update-index", "--cacheinfo", `160000,${"2".repeat(40)},lib`);
  r.git("commit", "-q", "-m", "side");
  r.git("checkout", "-q", "master");
  r.git("update-index", "--cacheinfo", `160000,${"3".repeat(40)},lib`);
  r.git("commit", "-q", "-m", "master");
  r.tryGit("merge", "side");
  return r;
}

test("a submodule's row in the snapshot names the commit each side points it at", async () => {
  const r = gitlinkConflict();
  const { ops } = opsFor(r);
  const snap = await ops.snapshot();
  const row = snap.files.find((f) => f.path === "lib");
  assert.equal(row?.shape, "submodule");
  assert.deepEqual(row?.commits, { yours: "3".repeat(40), theirs: "2".repeat(40) });
  assert.equal(row?.badge, "submodule: yours at 3333333, theirs at 2222222");
});

test("a submodule side git won't record is reported, and the submodule stays conflicted", async () => {
  const r = gitlinkConflict();
  const { ops } = opsFor(r, (a) => (a[0] === "update-index" && a.includes("--cacheinfo") ? fail("error: invalid object") : undefined));
  const out = await ops.takeRole("lib", "theirs");
  assert.deepEqual(out, { ok: false, changed: false, message: "error: invalid object" });
  assert.equal(unmerged(r).split("\n").filter((l) => l.endsWith("\tlib")).length, 3);
});

// ── Restore (hold-to-undo) ────────────────────────────────────────────────

test("restore refuses when git can't read its resolve-undo record", async () => {
  const r = conflicted("restore-undo-list");
  const real = opsFor(r);
  assert.equal((await real.ops.takeRole("both.txt", "yours")).ok, true);
  const { ops } = opsFor(r, (a) => (a.includes("--resolve-undo") ? fail("fatal: bad") : undefined));
  const out = await ops.restore("both.txt");
  assert.equal(out.message, "There is no earlier conflict to bring back for both.txt.");
  assert.doesNotMatch(unmerged(r), /\tboth\.txt$/m, "still resolved");
});

test("restore refuses when git can't say whether the file changed since its resolution", async () => {
  const r = conflicted("restore-diff-unknown");
  const { ops } = opsFor(r, (a) => (a.includes("--quiet") && a.includes("diff") ? fail("fatal: bad", 128) : undefined));
  assert.equal((await ops.takeRole("both.txt", "yours")).ok, true);
  const out = await ops.restore("both.txt");
  assert.equal(out.message, "Couldn't tell whether both.txt has changed since it was resolved. Nothing was changed.");
  assert.doesNotMatch(unmerged(r), /\tboth\.txt$/m);
});

test("restore refuses when the index entry this resolution left can't be read back", async () => {
  const r = conflicted("restore-stage0-unknown");
  let blind = false;
  const { ops } = opsFor(r, (a) => (blind && a[1] === "ls-files" && a.includes("-s") ? fail("fatal: bad") : undefined));
  assert.equal((await ops.takeRole("both.txt", "yours")).ok, true);
  blind = true;
  const out = await ops.restore("both.txt");
  assert.equal(out.message, "Couldn't tell whether both.txt has changed since it was resolved. Nothing was changed.");
  assert.equal(r.read("both.txt"), edit(FIVE, { three: "three-master" }), "the resolution is untouched");
});

test("a resolution whose index entry couldn't be noted is still undone from its record", async () => {
  const r = conflicted("restore-unnoted");
  const { ops } = opsFor(r, (a) => (a[1] === "ls-files" && a.includes("-s") ? fail("fatal: bad") : undefined));
  assert.equal((await ops.takeStage("both.txt", 2)).ok, true);
  const out = await ops.restore("both.txt");
  assert.deepEqual(out, { ok: true, changed: true });
  assert.match(unmerged(r), /\tboth\.txt$/m, "conflicted again");
  assert.match(r.read("both.txt"), /^<{7} /m);
});

test("restore reports git's refusal to re-merge a text conflict, and the resolution stays", async () => {
  const r = conflicted("restore-checkout-m");
  const { ops } = opsFor(r, (a) => (a.includes("-m") && a.includes("checkout") ? fail("error: path both.txt does not have all necessary versions") : undefined));
  assert.equal((await ops.takeRole("both.txt", "theirs")).ok, true);
  const out = await ops.restore("both.txt");
  assert.deepEqual(out, { ok: false, changed: false, message: "error: path both.txt does not have all necessary versions" });
  assert.equal(r.read("both.txt"), edit(FIVE, { three: "three-side" }));
});

test("restore of a one-sided conflict: an --unresolve git refuses is reported, and nothing moves", async () => {
  const r = conflicted("restore-unresolve");
  const { ops } = opsFor(r, (a) => (a.includes("--unresolve") ? fail("") : undefined));
  assert.equal((await ops.takeRole("gone.txt", "yours")).ok, true);
  const out = await ops.restore("gone.txt");
  assert.deepEqual(out, { ok: false, changed: false, message: "Couldn't bring the conflict in gone.txt back." });
  assert.doesNotMatch(unmerged(r), /\tgone\.txt$/m);
});

test("restore of a one-sided conflict whose surviving side can't be put on disk says the conflict is back", async () => {
  const r = conflicted("restore-kept-checkout");
  let refuse = false;
  const { ops } = opsFor(r, (a) => (refuse && a.includes("checkout") && a.includes("--ours") ? fail("") : undefined));
  assert.equal((await ops.takeRole("gone.txt", "theirs")).ok, true, "theirs deleted it");
  refuse = true;
  const out = await ops.restore("gone.txt");
  assert.deepEqual(out, { ok: false, changed: false, message: "The conflict is back, but gone.txt couldn't be restored on disk." });
  assert.match(unmerged(r), /\tgone\.txt$/m, "unmerged again, as the message says");
});

test("restore believes the caller's operation: nothing stopped means the resolution's operation is over", async () => {
  const r = conflicted("restore-given-none");
  const real = opsFor(r);
  for (const p of ["both.txt", "gone.txt", "deep/sub/f.txt", "ours.txt", "theirs.txt"]) {
    assert.equal((await real.ops.takeRole(p, "yours")).ok, true, p);
  }
  assert.equal((await real.ops.deleteFile("doomed.txt")).ok, true);
  const view = await r.ctx().operation.view();
  const none: OperationView = { ...view, kind: "none" };
  const out = await real.ops.restore("both.txt", { op: none });
  assert.equal(out.message, "The operation both.txt was resolved in has finished — its conflict can't be brought back.");
  assert.equal(unmerged(r), "");
});

// ── Write a hand merge ────────────────────────────────────────────────────

test("writeResolution over a path that is now a folder reports the write error and stages nothing", async () => {
  const r = conflicted("write-eisdir");
  rmSync(join(r.root, "both.txt"));
  mkdirSync(join(r.root, "both.txt"));
  const { ops, ran } = opsFor(r);
  const out = await ops.writeResolution("both.txt", "merged\n");
  assert.equal(out.ok, false);
  assert.equal(out.changed, false);
  assert.match(out.message ?? "", /EISDIR|illegal operation on a directory|EPERM|EACCES/);
  assert.equal(ran.some((a) => a.includes("add")), false);
  assert.match(unmerged(r), /\tboth\.txt$/m);
});

test("writeResolution that saved but couldn't stage says so; and it saves even when the operation can't be read", async () => {
  const r = conflicted("write-add");
  const refused = opsFor(r, (a) => (a.includes("add") ? fail("") : undefined));
  const out = await refused.ops.writeResolution("both.txt", "merged by hand\n");
  assert.deepEqual(out, { ok: false, changed: false, message: "Saved both.txt, but couldn't stage it." });
  assert.equal(r.read("both.txt"), "merged by hand\n", "the text is on disk");
  assert.match(unmerged(r), /\tboth\.txt$/m, "but the conflict is not marked resolved");

  const broken: OperationSource = { view: () => Promise.reject(new Error("no operation")) };
  const blind = opsFor(r, () => undefined, broken);
  assert.deepEqual(await blind.ops.writeResolution("both.txt", "merged again\n"), { ok: true, changed: true });
  assert.equal(stage0(r, "both.txt").split(" ")[1], r.git("hash-object", "both.txt").trim());
});

// ── Facts when git's side reads fail ──────────────────────────────────────

/** A merge with a big text file, a binary one and a CR-only text file, each conflicted. */
function shapes(): Repo {
  const r = makeRepo("cov-shapes");
  repos.push(r);
  const nul = (tag: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0, tag]), Buffer.alloc(32, tag)]);
  const each = (side: string, n: number): void => {
    r.write("big.txt", `${side} line of ordinary text\n`.repeat(Math.ceil(CONFLICT_TEXT_CAP_BYTES / 20)));
    r.write("art.bin", nul(n));
    r.write("mac.txt", `one\r${side}\rthree\r`);
  };
  each("base", 0);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  each("side", 2);
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  each("master", 1);
  r.commitAll("master");
  r.tryGit("merge", "side");
  return r;
}

test("when git can't size the blobs, attribute them, or diff them, every shape is still read right", async () => {
  const r = shapes();
  const { ops, ran } = opsFor(r, (a) => {
    if (a[0] === "cat-file" && a[1].startsWith("--batch-check")) return fail("fatal: bad");
    if (a[0] === "check-attr") return fail("fatal: bad");
    if (a[0] === "diff" && a[1] === "--numstat") return fail("fatal: bad");
    return undefined;
  });
  const by = new Map((await ops.conflictFiles()).map((f) => [f.path, f.shape]));
  assert.equal(by.get("big.txt"), "too-large", "the working copy's size still says so");
  assert.equal(by.get("art.bin"), "binary", "a NUL in the blob's head, read directly");
  assert.equal(by.get("mac.txt"), "text", "a CR-only file has no NUL: it merges as text");
  assert.ok(ran.some((a) => a[0] === "cat-file" && a[1] === "blob"), "the blob itself was looked at");
});

test("xyFromStages of no stages at all is git's catch-all UU", () => {
  assert.equal(xyFromStages([]), "UU");
});

test("handed only a signal, every call reads the operation itself — and hold-to-undo brings back a side deleted by ours", async () => {
  const r = conflicted("signal-only");
  const { ops, views } = opsFor(r);
  const signal = new AbortController().signal;
  assert.equal((await ops.conflictFiles({ signal })).length, 6);
  assert.equal((await ops.fileFacts("deep/sub/f.txt", { signal }))?.missingRole, "yours");
  assert.equal((await ops.snapshot({ signal })).resolved, 0);
  assert.equal((await ops.takeRole("deep/sub/f.txt", "yours", { signal })).ok, true, "ours deleted it: rm");
  assert.equal(r.exists("deep/sub/f.txt"), false);
  assert.equal((await ops.takeStage("both.txt", 2, { signal })).ok, true);
  assert.equal((await ops.takeRole("gone.txt", "yours", { signal })).ok, true);
  assert.equal((await ops.takeRole("ours.txt", "yours", { signal })).ok, true);
  assert.equal((await ops.takeRole("theirs.txt", "yours", { signal })).ok, true);
  assert.equal((await ops.deleteFile("doomed.txt", { signal })).ok, true);
  assert.equal(unmerged(r), "", "everything is resolved, the merge still stopped");
  const counted = views();
  assert.ok(counted >= 5, `the operation was read by the calls themselves (${counted})`);

  // Nothing unmerged, but the merge is still stopped: the resolution can come back.
  const back = await ops.restore("deep/sub/f.txt", { signal });
  assert.deepEqual(back, { ok: true, changed: true });
  assert.equal(views(), counted + 1, "restore read the operation to see it still stopped");
  assert.equal(r.read("deep/sub/f.txt"), "deep, edited on side\n", "the surviving (theirs) side is back on disk");
  assert.match(unmerged(r), / 1\tdeep\/sub\/f\.txt\n[\s\S]* 3\tdeep\/sub\/f\.txt/);

  assert.deepEqual(await ops.writeResolution("deep/sub/f.txt", "settled\n", { signal }), { ok: true, changed: true });
  assert.equal(r.read("deep/sub/f.txt"), "settled\n");
});

test("a submodule side taken with a signal records that side's commit", async () => {
  const r = gitlinkConflict();
  const { ops } = opsFor(r);
  const out = await ops.takeRole("lib", "yours", { signal: new AbortController().signal });
  assert.deepEqual(out, { ok: true, changed: true });
  assert.equal(stage0(r, "lib"), `160000 ${"3".repeat(40)} 0\tlib`);
});

test("with a signal: a both-deleted file's sides still carry its base, and a text conflict comes back with markers", async () => {
  const r = conflicted("signal-text");
  const { ops } = opsFor(r);
  const signal = new AbortController().signal;
  const dd = await ops.readSides("doomed.txt", { signal });
  assert.equal(dd.shape, "both-deleted");
  assert.equal(dd.hasBase, true);
  assert.equal(dd.base, "contents\n");
  assert.equal((await ops.takeRole("both.txt", "theirs", { signal })).ok, true);
  assert.deepEqual(await ops.restore("both.txt", { signal }), { ok: true, changed: true });
  assert.match(r.read("both.txt"), /^<{7} ours\n[\s\S]*three-master[\s\S]*three-side[\s\S]*^>{7} theirs$/m);
});
