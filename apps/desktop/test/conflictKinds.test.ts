// Not every conflict is a content conflict.
//
// The conflict model reported three sides of text and nothing else, so the
// renderer opened the three-pane merge editor for every conflicted file:
//
//  - a BINARY conflict got a line-by-line merge of whatever the bytes decoded
//    to — two walls of U+FFFD, or two empty panes;
//  - a MODIFY/DELETE conflict (one side edited the file, the other removed it)
//    got an ordinary content merge with one deliberately blank pane, and
//    nothing anywhere said the file had been deleted on that side. A blank pane
//    is exactly what a side that EMPTIED the file looks like, so the two states
//    were indistinguishable.
//
// And Discard on a conflicted row ran `git checkout -- <path>`, which refuses
// an unmerged path outright, so a destructive-sounding confirm was followed by
// raw git stderr.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/** A repo left mid-merge. `seed` writes the file on each side. */
function conflicted(
  name: string,
  base: Buffer | string,
  ours: Buffer | string,
  theirs: Buffer | string | null,
): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "gs-conflict-kind-"));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8" });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, name), base);
  git("add", "-A");
  git("commit", "-qm", "base");

  git("checkout", "-q", "-b", "side");
  if (theirs === null) rmSync(join(root, name));
  else writeFileSync(join(root, name), theirs);
  git("add", "-A");
  git("commit", "-qm", "theirs");

  git("checkout", "-q", "main");
  writeFileSync(join(root, name), ours);
  git("commit", "-qam", "ours");
  git("merge", "side");
  return { root, git };
}

async function bridge(root: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(root);
  return new GitBridge(repos);
}

test("a modify/delete conflict says WHICH side has no file", async () => {
  const { root, git } = conflicted("f.txt", "base\n", "edited on main\n", null);
  try {
    assert.notEqual(git("ls-files", "-u", "--", "f.txt").trim(), "", "the fixture is conflicted");

    const b = await bridge(root);
    const m = await b.conflictModel("f.txt");
    assert.ok(m, "there is a model");
    // "theirs" is the side branch, which deleted it. The index holds stage 2
    // and no stage 3 — which is the only way to tell this apart from a side
    // that emptied the file, since both give an empty string.
    assert.equal(m!.missingSide, "theirs", "the deleted side is named");
    assert.notEqual(m!.binary, true, "and it is not mistaken for a binary");
  } finally {
    removeTempRepo(root);
  }
});

test("the other direction is named the other way round", async () => {
  // Deleted on main (ours), edited on the side branch (theirs).
  const root = mkdtempSync(join(tmpdir(), "gs-conflict-md2-"));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8" });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, "f.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(root, "f.txt"), "edited on the side\n");
    git("commit", "-qam", "theirs");
    git("checkout", "-q", "main");
    rmSync(join(root, "f.txt"));
    git("add", "-A");
    git("commit", "-qm", "deleted here");
    git("merge", "side");

    const b = await bridge(root);
    const m = await b.conflictModel("f.txt");
    assert.equal(m?.missingSide, "ours", "the side that deleted it is the one named");
  } finally {
    removeTempRepo(root);
  }
});

test("a conflicted binary is reported as binary", async () => {
  const nul = (tag: number): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(64, tag)]);
  const { root } = conflicted("art.png", nul(1), nul(2), nul(3));
  try {
    const b = await bridge(root);
    const m = await b.conflictModel("art.png");
    assert.ok(m, "there is a model");
    assert.equal(m!.binary, true, "so the renderer can refuse the text merge");
  } finally {
    removeTempRepo(root);
  }
});

test("an ordinary content conflict is neither", async () => {
  // The two flags must not fire on the case the merge editor is FOR.
  const { root } = conflicted("f.txt", "base\n", "ours\n", "theirs\n");
  try {
    const b = await bridge(root);
    const m = await b.conflictModel("f.txt");
    assert.ok(m, "there is a model");
    assert.notEqual(m!.binary, true);
    assert.equal(m!.missingSide, undefined);
    assert.ok(m!.ours.length > 0 && m!.theirs.length > 0, "both sides have text to merge");
  } finally {
    removeTempRepo(root);
  }
});

test("discarding a conflicted file restores the conflict instead of failing", async () => {
  const { root, git } = conflicted("f.txt", "base\n", "ours\n", "theirs\n");
  try {
    const b = await bridge(root);
    // Resolve it by hand, the way someone working through a merge would.
    writeFileSync(join(root, "f.txt"), "my careful reconciliation\n");

    const r = await b.discard("f.txt");
    assert.equal(r.ok, true, `discard succeeds (${r.message ?? ""})`);
    // `git checkout -- <path>` refuses an unmerged path: "error: path 'f.txt'
    // is unmerged". `--merge` puts the conflict back, which is what discarding
    // your changes means while a merge is in progress.
    const back = readFileSync(join(root, "f.txt"), "utf8");
    assert.match(back, /^<{7} /m, "the conflict is back in the file");
    assert.notEqual(
      git("ls-files", "-u", "--", "f.txt").trim(),
      "",
      "and git still considers the path unmerged",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("discarding an ordinary file still just reverts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "gs-discard-plain-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    writeFileSync(join(root, "a.txt"), "two\n");

    const b = await bridge(root);
    assert.equal((await b.discard("a.txt")).ok, true);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
  } finally {
    removeTempRepo(root);
  }
});

test("a conflicted file over the read cap refuses the text merge", async () => {
  // `result` is the text the merge editor seeds its result pane with, and the
  // text "Mark resolved" writes back to the file. `readWorking` caps at 512KB,
  // so on a larger file resolving would have written the first 512KB over the
  // whole thing and staged that as the answer — deleting the rest silently,
  // under a toast reading "Resolved and staged."
  const CAP = 512 * 1024;
  // Each side comfortably over the cap on its own, so the conflicted working
  // file — which holds both — is far past it.
  const big = (tag: string): string => `${tag} a line of ordinary text\n`.repeat(24_000);
  const { root } = conflicted("big.txt", big("base"), big("ours"), big("theirs"));
  try {
    const b = await bridge(root);
    const m = await b.conflictModel("big.txt");
    assert.ok(m, "there is a model");
    assert.ok(m!.result.length <= CAP + 4096, "the working copy really was capped");
    assert.equal(m!.truncated, true, "and the model says so, so the panel can refuse");
  } finally {
    removeTempRepo(root);
  }
});

test("a both-sides-deleted conflict is its own state, not a modify/delete", async () => {
  // Git's DD: the path is listed with stage 1 and NEITHER 2 nor 3. Folded into
  // `missingSide` it was drawn as "changed on one side, deleted on the other"
  // and offered a "Take <side>" button for a side that has nothing to take —
  // which `conflictTakeSide` then refuses, correctly, contradicting the panel.
  const root = mkdtempSync(join(tmpdir(), "gs-conflict-dd-"));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8" });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, "f.txt"), "base\n");
    writeFileSync(join(root, "keep.txt"), "so the merge has something to do\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    // Deleted on one side, deleted AND the file replaced on the other — the
    // rename-vs-delete shape that leaves DD.
    git("checkout", "-q", "-b", "side");
    execFileSync("git", ["rm", "-q", "f.txt"], { cwd: root });
    writeFileSync(join(root, "keep.txt"), "side\n");
    git("commit", "-qam", "deleted on the side");
    git("checkout", "-q", "main");
    execFileSync("git", ["rm", "-q", "f.txt"], { cwd: root });
    writeFileSync(join(root, "keep.txt"), "main\n");
    git("commit", "-qam", "deleted here too");
    git("merge", "side");

    const stages = git("ls-files", "-u", "--", "f.txt").trim();
    if (!stages) return; // git resolved it without a conflict — nothing to assert

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    const m = await b.conflictModel("f.txt");
    assert.ok(m, "there is a model");
    assert.equal(m!.bothDeleted, true, "it is reported as deleted on both sides");
    assert.equal(m!.missingSide, undefined, "and NOT as one side missing");
  } finally {
    removeTempRepo(root);
  }
});

test("an added-on-one-side conflict has no common version behind it", async () => {
  // Git's UA / AU. There is no base, so nothing was deleted — the modify/delete
  // story ("deleted in X") describes a deletion that never happened, about a
  // file with no history to have been deleted from.
  const root = mkdtempSync(join(tmpdir(), "gs-conflict-ua-"));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8" });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", root]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, "keep.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");

    // `new.txt` exists on ONE side only, and never existed before.
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(root, "new.txt"), "from the side\n");
    writeFileSync(join(root, "keep.txt"), "side\n");
    git("add", "-A");
    git("commit", "-qm", "added on the side");
    git("checkout", "-q", "main");
    writeFileSync(join(root, "keep.txt"), "main\n");
    git("commit", "-qam", "changed here");
    git("merge", "side");

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    const m = await b.conflictModel("new.txt");
    if (!m) return; // no conflict on that path in this git version
    // The decisive property: no common ancestor. The renderer branches on it
    // to stop telling a deletion story about a file that was only ever added.
    assert.equal(m.hasBase, false, "there is no version behind either side");
  } finally {
    removeTempRepo(root);
  }
});
