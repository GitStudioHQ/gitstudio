// Which side is YOURS depends on the operation.
//
// Git's index stage 2 is "ours" and stage 3 is "theirs", and the conflict UI
// takes a side by asking for one of those stages. But which of your work each
// stage holds is INVERTED during a rebase:
//
//   merge / cherry-pick / revert  ours = HEAD, your branch
//                                 theirs = the change being brought in
//   rebase                        ours = the UPSTREAM you are replaying onto
//                                 theirs = YOUR commit being replayed
//
// The labels were hardcoded to the merge reading — "Current Change (ours)" /
// "Incoming Change (theirs)" — so in a rebase the button offering "your
// version" handed you the branch you were rebasing onto and threw away the
// commit being replayed, with the tooltip and the success toast both agreeing
// it had done the opposite. That is unrecoverable work loss behind a label that
// says the opposite of what it does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sideLabels } from "../src/main/gitBridge";

const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

test("a merge names the sides for a merge", () => {
  const l = sideLabels("merge");
  assert.match(l.oursLabel, /your branch/i);
  assert.match(l.theirsLabel, /incoming/i);
  assert.ok(!/upstream/i.test(l.oursLabel), "a merge's ours is not an upstream");
});

test("a rebase names them the other way round", () => {
  const l = sideLabels("rebase");
  assert.match(l.oursLabel, /upstream/i, "stage 2 in a rebase is what you are replaying ONTO");
  assert.match(l.theirsLabel, /your commit/i, "stage 3 is the commit of yours being replayed");
  // The decisive property: the two operations must not describe stage 2 the
  // same way, because it does not hold the same thing.
  assert.notEqual(l.oursLabel, sideLabels("merge").oursLabel);
});

test("cherry-pick and revert read like a merge, because they are", () => {
  for (const kind of ["cherry-pick", "revert"] as const) {
    assert.equal(sideLabels(kind).oursLabel, sideLabels("merge").oursLabel, kind);
  }
});

test("git agrees about cherry-pick and revert too", () => {
  // The claim above was an assertion about `sideLabels` agreeing with itself,
  // which proves nothing about git. `am` was wrong for exactly that reason —
  // it was grouped by assumption and never checked. So: real conflicts, real
  // stages, for both remaining operations.
  const root = mkdtempSync(join(tmpdir(), "gs-pick-sides-"));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", env });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root], { env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "f.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  // A commit on a side branch, to be picked onto main.
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(root, "f.txt"), "PICKED\n");
  git("commit", "-qam", "the pick");
  const picked = git("rev-parse", "HEAD").trim();

  git("checkout", "-q", "main");
  writeFileSync(join(root, "f.txt"), "MINE\n");
  git("commit", "-qam", "mine");

  git("cherry-pick", picked); // conflicts
  assert.equal(git("show", ":2:f.txt").trim(), "MINE", "cherry-pick: stage 2 is YOUR branch");
  assert.equal(git("show", ":3:f.txt").trim(), "PICKED", "and stage 3 is the commit picked");
  git("cherry-pick", "--abort");

  // And a revert: undoing an earlier commit against a since-changed file.
  writeFileSync(join(root, "g.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "add g");
  const target = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "g.txt"), "two\n");
  git("commit", "-qam", "change g");
  git("revert", "--no-edit", target); // conflicts
  assert.equal(git("show", ":2:g.txt").trim(), "two", "revert: stage 2 is YOUR branch");

  // Which is what the labels say for both.
  for (const kind of ["cherry-pick", "revert"] as const) {
    assert.match(sideLabels(kind).oursLabel, /your branch/i, kind);
    assert.match(sideLabels(kind).theirsLabel, /incoming/i, kind);
  }
});

test("`git am` reads like a merge, NOT like a rebase", () => {
  // The distinction that matters, and the one this function originally got
  // wrong by lumping the two together: a rebase checks the upstream out and
  // replays onto it, so stage 2 is the upstream; `git am` applies a patch onto
  // the branch you are standing on, so stage 2 is YOURS.
  const l = sideLabels("am");
  assert.match(l.oursLabel, /your branch/i, "stage 2 during an am is your own branch");
  assert.match(l.theirsLabel, /patch/i, "and stage 3 is the patch being applied");
  assert.ok(!/rebasing onto/i.test(l.oursLabel), "it must not borrow the rebase wording");
  assert.notEqual(l.oursLabel, sideLabels("rebase").oursLabel);
});

test("git really does NOT invert the sides during an am", () => {
  // The premise, against real git — the same proof the rebase case gets, since
  // the whole bug was assuming these two behaved alike.
  const root = mkdtempSync(join(tmpdir(), "gs-am-sides-"));
  const patches = join(root, "patches");
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", env });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root], { env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "f.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  // A patch that will conflict, exported from a side branch.
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(root, "f.txt"), "FROM-THE-PATCH\n");
  git("commit", "-qam", "patch commit");
  git("format-patch", "-q", "-1", "-o", patches);

  git("checkout", "-q", "main");
  writeFileSync(join(root, "f.txt"), "MY-BRANCH\n");
  git("commit", "-qam", "mine");
  git("am", "--3way", join(patches, "0001-patch-commit.patch"));

  assert.equal(git("show", ":2:f.txt").trim(), "MY-BRANCH", 'during an am, stage 2 is YOUR branch');
  assert.equal(
    git("show", ":3:f.txt").trim(),
    "FROM-THE-PATCH",
    "and stage 3 is the incoming patch",
  );

  const l = sideLabels("am");
  assert.match(l.oursLabel, /your branch/i);
  assert.match(l.theirsLabel, /patch/i);
});

test("no operation still yields usable labels", () => {
  const l = sideLabels(null);
  assert.ok(l.oursLabel.length > 0 && l.theirsLabel.length > 0);
});

test("git really does invert the sides during a rebase", () => {
  // The premise, against real git — because the whole fix rests on it and a
  // stale belief here would make the labels confidently wrong in the other
  // direction.
  const root = mkdtempSync(join(tmpdir(), "gs-rebase-sides-"));
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", env });
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", root], { env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "f.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  // main gains UPSTREAM; the feature branch gains MINE.
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "f.txt"), "MINE\n");
  git("commit", "-qam", "mine");
  git("checkout", "-q", "main");
  writeFileSync(join(root, "f.txt"), "UPSTREAM\n");
  git("commit", "-qam", "upstream");

  git("checkout", "-q", "feature");
  git("rebase", "main"); // conflicts

  const stage2 = git("show", ":2:f.txt").trim();
  const stage3 = git("show", ":3:f.txt").trim();
  assert.equal(stage2, "UPSTREAM", 'during a rebase, stage 2 ("ours") is the upstream');
  assert.equal(stage3, "MINE", 'and stage 3 ("theirs") is the commit being replayed');

  // And the labels agree with what git actually holds.
  const l = sideLabels("rebase");
  assert.match(l.oursLabel, /upstream/i);
  assert.match(l.theirsLabel, /your commit/i);
});
