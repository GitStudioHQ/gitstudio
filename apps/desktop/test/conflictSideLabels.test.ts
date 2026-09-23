// Which side is YOURS depends on the operation — and since merge-parity (issue
// #12, decision D1) the desktop no longer just RENAMES the sides, it SWAPS
// them: during a rebase the Yours content (git's stage 3, your own commit
// being replayed) is `ours` in the ConflictModel and sits on the LEFT, under a
// title naming your branch.
//
// Git's stage 2 is "ours" and stage 3 is "theirs", and which of your work each
// holds is inverted during a rebase:
//
//   merge / cherry-pick / revert / am   stage 2 = HEAD, your branch
//                                       stage 3 = the change being brought in
//   rebase                              stage 2 = the UPSTREAM you replay onto
//                                       stage 3 = YOUR commit being replayed
//   stash pop                           stage 2 = what is committed
//                                       stage 3 = YOUR stashed changes
//
// The old fix (`sideLabels`) only swapped the words, so the left pane was still
// the branch being rebased onto — and "Take ours" + Continue removed the
// reporter's only commit from their branch. These tests assert the CONTENT on
// each side as well as the words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true" };

function repo(name: string): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), `gs-sides-${name}-`));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root], { env, stdio: "ignore" });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  return { root, git };
}

async function bridge(root: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(root);
  return new GitBridge(repos);
}

/** main gains UPSTREAM, feature gains MINE, both on f.txt. */
function diverged(name: string): { root: string; git: (...a: string[]) => string; mine: string } {
  const r = repo(name);
  writeFileSync(join(r.root, "f.txt"), "base\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "base");
  r.git("checkout", "-q", "-b", "feature");
  writeFileSync(join(r.root, "f.txt"), "MINE\n");
  r.git("commit", "-qam", "mine");
  const mine = r.git("rev-parse", "HEAD").trim();
  r.git("checkout", "-q", "main");
  writeFileSync(join(r.root, "f.txt"), "UPSTREAM\n");
  r.git("commit", "-qam", "upstream");
  return { ...r, mine };
}

test("git really does invert the stages during a rebase (the premise)", () => {
  const { root, git } = diverged("premise");
  try {
    git("checkout", "-q", "feature");
    git("rebase", "main"); // conflicts
    assert.equal(git("show", ":2:f.txt").trim(), "UPSTREAM", 'during a rebase, stage 2 ("ours") is the upstream');
    assert.equal(git("show", ":3:f.txt").trim(), "MINE", 'and stage 3 ("theirs") is the commit being replayed');
  } finally {
    removeTempRepo(root);
  }
});

test("a rebase: YOUR commit is on the left, under your branch's name", async () => {
  const { root, git, mine } = diverged("rebase");
  try {
    git("checkout", "-q", "feature");
    git("rebase", "main");
    const m = await (await bridge(root)).conflictModel("f.txt");
    assert.ok(m);
    assert.equal(m.ours, "MINE\n", "the LEFT pane holds your commit's content — swapped, not just renamed");
    assert.equal(m.theirs, "UPSTREAM\n");
    assert.equal(m.oursLabel, `Rebasing ${mine.slice(0, 7)} from feature`);
    assert.equal(m.theirsLabel, "Already rebased commits and commits from main");
    assert.equal(m.op?.kind, "rebase");
    assert.equal(m.op?.yours.stage, 3);
    assert.equal(m.op?.title, `Rebasing feature onto main · commit 1 of 1: ${mine.slice(0, 7)} mine`);
    assert.equal(m.shape, "text");
  } finally {
    removeTempRepo(root);
  }
});

test("a merge is not swapped: your branch is stage 2, on the left", async () => {
  const { root, git } = diverged("merge");
  try {
    git("merge", "feature");
    const m = await (await bridge(root)).conflictModel("f.txt");
    assert.ok(m);
    assert.equal(m.ours, "UPSTREAM\n", "main's own content");
    assert.equal(m.theirs, "MINE\n");
    assert.equal(m.oursLabel, "Changes from main");
    assert.equal(m.theirsLabel, "Changes from feature");
    assert.equal(m.op?.yours.stage, 2);
    assert.equal(m.op?.title, "Merging feature into main");
  } finally {
    removeTempRepo(root);
  }
});

test("cherry-pick and revert read like a merge — verified against git's stages", async () => {
  const r = repo("pick");
  try {
    writeFileSync(join(r.root, "f.txt"), "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("checkout", "-q", "-b", "side");
    writeFileSync(join(r.root, "f.txt"), "PICKED\n");
    r.git("commit", "-qam", "the pick");
    const picked = r.git("rev-parse", "HEAD").trim();
    r.git("checkout", "-q", "main");
    writeFileSync(join(r.root, "f.txt"), "MINE\n");
    r.git("commit", "-qam", "mine");

    r.git("cherry-pick", picked); // conflicts
    assert.equal(r.git("show", ":2:f.txt").trim(), "MINE", "cherry-pick: stage 2 is YOUR branch");
    let m = await (await bridge(r.root)).conflictModel("f.txt");
    assert.equal(m?.ours, "MINE\n");
    assert.equal(m?.theirs, "PICKED\n");
    assert.equal(m?.oursLabel, "Changes from main");
    assert.equal(m?.theirsLabel, `Changes from cherry-pick ${picked.slice(0, 7)} the pick`);
    r.git("cherry-pick", "--abort");

    writeFileSync(join(r.root, "g.txt"), "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "add g");
    const target = r.git("rev-parse", "HEAD").trim();
    writeFileSync(join(r.root, "g.txt"), "two\n");
    r.git("commit", "-qam", "change g");
    r.git("revert", "--no-edit", target); // conflicts
    assert.equal(r.git("show", ":2:g.txt").trim(), "two", "revert: stage 2 is YOUR branch");
    m = await (await bridge(r.root)).conflictModel("g.txt");
    assert.equal(m?.ours, "two\n");
    assert.equal(m?.oursLabel, "Changes from main");
    assert.equal(m?.theirsLabel, `Undo of ${target.slice(0, 7)} add g`);
  } finally {
    removeTempRepo(r.root);
  }
});

test("`git am` reads like a merge, NOT like a rebase — verified against git's stages", async () => {
  const r = repo("am");
  const patches = mkdtempSync(join(tmpdir(), "gs-sides-am-p-"));
  try {
    writeFileSync(join(r.root, "f.txt"), "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("checkout", "-q", "-b", "side");
    writeFileSync(join(r.root, "f.txt"), "FROM-THE-PATCH\n");
    r.git("commit", "-qam", "patch commit");
    r.git("format-patch", "-q", "-1", "-o", patches);
    r.git("checkout", "-q", "main");
    writeFileSync(join(r.root, "f.txt"), "MY-BRANCH\n");
    r.git("commit", "-qam", "mine");
    r.git("am", "--3way", join(patches, "0001-patch-commit.patch"));

    assert.equal(r.git("show", ":2:f.txt").trim(), "MY-BRANCH", "during an am, stage 2 is YOUR branch");
    const m = await (await bridge(r.root)).conflictModel("f.txt");
    assert.equal(m?.ours, "MY-BRANCH\n", "so it is not swapped");
    assert.equal(m?.theirs, "FROM-THE-PATCH\n");
    assert.equal(m?.oursLabel, "Changes from main");
    assert.equal(m?.theirsLabel, "Patch 1/1: patch commit");
    assert.equal(m?.op?.kind, "am");
  } finally {
    removeTempRepo(r.root);
    rmSync(patches, { recursive: true, force: true });
  }
});

test("a stash pop is swapped like a rebase: your stashed changes on the left", async () => {
  const r = repo("stash");
  try {
    writeFileSync(join(r.root, "f.txt"), "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(join(r.root, "f.txt"), "STASHED\n");
    r.git("stash", "-q");
    writeFileSync(join(r.root, "f.txt"), "COMMITTED\n");
    r.git("commit", "-qam", "committed");
    r.git("stash", "pop"); // conflicts
    const m = await (await bridge(r.root)).conflictModel("f.txt");
    assert.equal(m?.op?.kind, "stash");
    assert.equal(m?.ours, "STASHED\n");
    assert.equal(m?.theirs, "COMMITTED\n");
    assert.equal(m?.oursLabel, "Your stashed changes");
    assert.equal(m?.theirsLabel, "Committed on main");
  } finally {
    removeTempRepo(r.root);
  }
});

test("a rebase's modify/delete: missingSide stays in STAGE terms, missingRole says whose", async () => {
  const r = repo("rebase-md");
  try {
    writeFileSync(join(r.root, "d.txt"), "d\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("checkout", "-q", "-b", "feature");
    writeFileSync(join(r.root, "d.txt"), "edited on feature\n");
    r.git("commit", "-qam", "edit d");
    r.git("checkout", "-q", "main");
    rmSync(join(r.root, "d.txt"));
    r.git("commit", "-qam", "delete d");
    r.git("checkout", "-q", "feature");
    r.git("rebase", "main");
    const m = await (await bridge(r.root)).conflictModel("d.txt");
    assert.ok(m);
    // Stage 2 (main, the upstream) deleted it — git's DU.
    assert.equal(m.missingSide, "ours", "the legacy stage-2 name, for conflict:takeSide");
    assert.equal(m.missingRole, "theirs", "and in role terms it is THEIRS (main) that deleted it");
    assert.equal(m.shape, "modify-delete");
    assert.equal(m.ours, "edited on feature\n", "your version, on the left");
  } finally {
    removeTempRepo(r.root);
  }
});
