// Staging a conflicted file is how you tell git the conflict is resolved.
//
// `git add` on an unmerged path clears its stage entries and marks it settled.
// So adding a file that still contains `<<<<<<<` does not "stage a broken file"
// — it declares the conflict RESOLVED with the markers in it, and the next
// commit carries them into the tree, where they compile as garbage and read, in
// the history, as a deliberate change.
//
// `stageAll()` has refused this since it was written, with a long comment about
// why. `stage(path)` did not — and per-file Stage is the button people actually
// press while working through a conflict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/** A repo left mid-merge with one genuinely conflicted file. */
function conflicted(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-conflict-stage-`);
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root }).toString();
    } catch (e) {
      // `merge` exits non-zero ON a conflict, which is the state we want.
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  writeFileSync(`${root}/f.txt`, "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "side");
  writeFileSync(`${root}/f.txt`, "theirs\n");
  git("commit", "-qam", "theirs");
  git("checkout", "-q", "main");
  writeFileSync(`${root}/f.txt`, "ours\n");
  git("commit", "-qam", "ours");
  git("merge", "side");
  return { root, git };
}

test("a file still carrying conflict markers cannot be staged one file at a time", async () => {
  const { root, git } = conflicted();
  try {
    const onDisk = readFileSync(`${root}/f.txt`, "utf8");
    assert.match(onDisk, /^<{7} /m, "the fixture is not actually conflicted");

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const r = await b.stage("f.txt");
    assert.equal(r.ok, false, "staging is refused");
    assert.match(r.message ?? "", /conflict markers/i, "and says why");
    assert.equal(r.expected, true, "it is a condition, not a crash to report");

    // The decisive check: git must still consider the path UNMERGED. If the add
    // had gone through, `ls-files -u` would be empty and the conflict would read
    // as settled.
    assert.notEqual(
      git("ls-files", "-u", "--", "f.txt").trim(),
      "",
      "the path is still unmerged — the conflict was not marked resolved",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("resolving it first makes the very same call succeed", async () => {
  // The guard must not make a conflicted file unstageable forever — that is the
  // failure mode stageAll's comment warns about: "someone who resolved a
  // conflict properly in another editor would find that file could never be
  // staged and Continue disabled forever".
  const { root, git } = conflicted();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    assert.equal((await b.stage("f.txt")).ok, false);
    writeFileSync(`${root}/f.txt`, "ours and theirs, reconciled\n");
    const r = await b.stage("f.txt");
    assert.equal(r.ok, true, "a resolved file stages normally");
    assert.equal(git("ls-files", "-u", "--", "f.txt").trim(), "", "and the conflict is settled");
  } finally {
    removeTempRepo(root);
  }
});

test("a conflicted file cannot be staged in PARTS either", async () => {
  // `git add` on an unmerged path settles the whole conflict, so ticking one
  // hunk of a conflicted file marked it resolved with every other hunk's
  // markers still in it. Both partial-staging routes meet in `lineStageable`.
  const { root, git } = conflicted();
  try {
    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    const lines = await b.stageLines({ path: "f.txt", lines: [1] });
    assert.equal(lines.ok, false, "line staging is refused");
    assert.match(lines.message ?? "", /conflicted/i, "and says why");
    assert.equal(lines.expected, true, "it is a condition, not a crash");

    const hunk = await b.hunksStage({ path: "f.txt", index: 0 });
    assert.equal(hunk.ok, false, "hunk staging is refused too");

    assert.notEqual(
      git("ls-files", "-u", "--", "f.txt").trim(),
      "",
      "the path is still unmerged — nothing declared the conflict settled",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("an ordinary file is unaffected", async () => {
  // The guard reads the working file on every stage; a normal edit must not be
  // slowed down or refused by it.
  const root = mkdtempSync(`${tmpdir()}/gs-conflict-plain-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(`${root}/f.txt`, "one\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/f.txt`, "two\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    assert.equal((await b.stage("f.txt")).ok, true);
    assert.equal(git("diff", "--cached", "--name-only").trim(), "f.txt");
  } finally {
    removeTempRepo(root);
  }
});

test("a file that merely mentions the markers in its text is judged by both ends", async () => {
  // `hasConflictMarkers` requires BOTH a `<<<<<<< ` and a `>>>>>>> ` line, so
  // documentation about conflicts — this project has some — still stages.
  const root = mkdtempSync(`${tmpdir()}/gs-conflict-doc-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(`${root}/README.md`, "A conflict opens with a line of seven `<` characters.\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(
      `${root}/README.md`,
      "A conflict opens with a line of seven `<` characters, like this:\n\n<<<<<<< HEAD\n",
    );

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    assert.equal(
      (await b.stage("README.md")).ok,
      true,
      "an opening marker alone is not a conflict",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("a conflicted BINARY is held back by Stage all too", async () => {
  // The whole guard is "no markers means somebody resolved it" — and a binary
  // cannot contain markers, any more than a modify/delete can. So the one kind
  // of conflict the app itself refuses to open a text merge for was the one
  // kind "Stage all" waved straight through, declaring it resolved with
  // whichever side happened to be sitting in the worktree.
  const root = mkdtempSync(`${tmpdir()}/gs-conflict-bin-`);
  const git = (...a: string[]): string => {
    try {
      return execFileSync("git", a, { cwd: root }).toString();
    } catch (e) {
      return String((e as { stdout?: Buffer }).stdout ?? "");
    }
  };
  try {
    const nul = (tag: number): Buffer =>
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.alloc(48, tag)]);
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    git("config", "core.autocrlf", "false");
    writeFileSync(`${root}/art.png`, nul(1));
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "side");
    writeFileSync(`${root}/art.png`, nul(2));
    git("commit", "-qam", "theirs");
    git("checkout", "-q", "main");
    writeFileSync(`${root}/art.png`, nul(3));
    git("commit", "-qam", "ours");
    git("merge", "side");

    assert.notEqual(git("ls-files", "-u", "--", "art.png").trim(), "", "the fixture is conflicted");

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    const r = await b.stageAll();

    // The decisive check: git must still consider the path UNMERGED. If the
    // add had gone through, the conflict would read as settled and Continue
    // would light up over a file nobody chose a side for.
    assert.notEqual(
      git("ls-files", "-u", "--", "art.png").trim(),
      "",
      "the binary conflict is still unmerged",
    );
    assert.equal(r.ok, false, "and Stage all says it could not take everything");
    assert.match(r.message ?? "", /art\.png/, "naming the file that needs a decision");
  } finally {
    removeTempRepo(root);
  }
});
