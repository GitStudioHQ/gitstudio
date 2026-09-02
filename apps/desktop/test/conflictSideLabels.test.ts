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
