// A stash of chosen files takes THOSE files — whatever they are called.
//
// StashProvider handed the user's paths to `git stash push -- …` (and to the
// diff / ls-files questions asked before it) as pathspecs, and a pathspec is
// not a file name: ":odd" is pathspec magic for the file "odd", "*glob*" is a
// wildcard, "a[bc].txt" is a character class. So a selection of ":odd"
// stashed a DIFFERENT file and left the chosen one where it was; "*glob*" took
// every file with "glob" in its name; and the pre-flight, asked through the
// same pathspec, called a clean selection dirty because of a neighbour it
// matched. Stash & Retry (stashTheWay) builds its stash through the same
// save(), so a file in the way named like that was never put away and the
// retry was refused all over again.
//
// Every path is a literal pathspec now. Pinned against real git, for tracked
// edits, a clean selection, untracked files and Stash & Retry — each with a
// neighbour the name would have matched as a pattern, which must be left alone.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitProcess } from "../src/GitProcess";
import { StashProvider } from "../src/StashProvider";
import { runApplying, stashAndRetry, type ApplyOp } from "../src/changesInTheWay";

/** A name, and a neighbour the name matches when it is read as a pathspec. */
interface Named {
  name: string;
  /** What git would take instead of (or as well as) `name`, were it a pattern. */
  decoy: string;
}

// ':' and '*' cannot be in a file name on Windows; the class and the unicode
// name can, so every platform tests a pattern.
const NAMES: Named[] = [
  ...(process.platform === "win32"
    ? []
    : [
        { name: ":odd", decoy: "odd" }, // short magic: ":odd" is the pathspec "odd"
        { name: "*glob*", decoy: "a-glob-b.txt" }, // a wildcard
      ]),
  { name: "a[bc].txt", decoy: "ab.txt" }, // a character class
  { name: "ünïcødé файл 文件.txt", decoy: "plain.txt" },
];

const trash: string[] = [];
afterEach(() => {
  for (const d of trash.splice(0)) removeTempRepo(d);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");

/** A repo whose base commit has `n.name`, `n.decoy` and other.txt — or none of them when `tracked` is false. */
function repo(n: Named, tracked = true): { dir: string; proc: GitProcess; stashes: StashProvider } {
  const dir = mkdtempSync(join(tmpdir(), "gitstudio-stash-literal-"));
  trash.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Me");
  git(dir, "config", "user.email", "me@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.quotePath", "false");
  writeFileSync(join(dir, "other.txt"), LINES("line 0", 0));
  if (tracked) {
    writeFileSync(join(dir, n.name), LINES("line 0", 0));
    writeFileSync(join(dir, n.decoy), LINES("line 0", 0));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const proc = new GitProcess({ cwd: dir });
  return { dir, proc, stashes: new StashProvider(proc) };
}

const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
const stashCount = (dir: string): number => git(dir, "stash", "list").split("\n").filter(Boolean).length;

/** Every path the newest stash holds — its tracked changes and its untracked files. */
function stashed(dir: string): string[] {
  const own = git(dir, "diff", "--name-only", "-z", "--no-renames", "stash@{0}^1", "stash@{0}", "--").split("\0");
  let third: string[] = [];
  try {
    third = git(dir, "ls-tree", "-r", "--name-only", "-z", "stash@{0}^3", "--").split("\0");
  } catch {
    // no untracked part
  }
  return [...own, ...third].filter(Boolean).sort();
}

for (const n of NAMES) {
  test(`a selection of ${JSON.stringify(n.name)} stashes that file, never ${JSON.stringify(n.decoy)}`, async () => {
    const { dir, stashes } = repo(n);
    for (const f of [n.name, n.decoy, "other.txt"]) writeFileSync(join(dir, f), LINES("mine", 4));

    const r = await stashes.save({ paths: [n.name], message: "chosen" });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.created, true, "a stash was made");
    assert.deepEqual(stashed(dir), [n.name], "the stash holds the chosen file and nothing else");
    assert.equal(read(dir, n.name), LINES("line 0", 0), "the chosen file is put away");
    assert.equal(read(dir, n.decoy), LINES("mine", 4), "the file its name matches as a pattern is left alone");
    assert.equal(read(dir, "other.txt"), LINES("mine", 4));
  });

  test(`a clean ${JSON.stringify(n.name)} is nothing to stash, though ${JSON.stringify(n.decoy)} is dirty`, async () => {
    const { dir, stashes } = repo(n);
    writeFileSync(join(dir, n.decoy), LINES("mine", 4));

    const r = await stashes.save({ paths: [n.name], message: "nothing here" });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.created, false, "the chosen file has no changes");
    assert.equal(r.blocker, "cleanTree");
    assert.equal(stashCount(dir), 0, "no stash");
    assert.equal(read(dir, n.decoy), LINES("mine", 4), "and the neighbour was not taken instead");
  });

  test(`an untracked ${JSON.stringify(n.name)} is stashed with includeUntracked, and only it`, async () => {
    const { dir, stashes } = repo(n, false);
    writeFileSync(join(dir, n.name), "new\n");
    writeFileSync(join(dir, n.decoy), "new too\n");

    const without = await stashes.save({ paths: [n.name] });
    assert.equal(without.created, false);
    assert.equal(without.blocker, "untrackedOnly", "scoped to the chosen file");

    const r = await stashes.save({ paths: [n.name], includeUntracked: true, message: "new file" });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.created, true, r.stderr);
    assert.deepEqual(stashed(dir), [n.name], "the untracked part holds the chosen file alone");
    assert.equal(existsSync(join(dir, n.name)), false, "the chosen file is put away");
    assert.equal(read(dir, n.decoy), "new too\n", "the neighbour stays");
  });

  test(`Stash & Retry puts away ${JSON.stringify(n.name)} when it is the file in the way`, async () => {
    const { dir, proc } = repo(n);
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, n.name), LINES("feature", 0));
    git(dir, "commit", "-q", "-am", "feature changes it");
    git(dir, "checkout", "-q", "main");
    // The user's edits: the chosen file (in the way — the switch writes it),
    // and its neighbour (not in the way — the switch does not touch it).
    writeFileSync(join(dir, n.name), LINES("mine", 8));
    writeFileSync(join(dir, n.decoy), LINES("mine", 4));

    const op: ApplyOp = { kind: "checkout", target: "refs/heads/feature", args: ["checkout", "feature"] };
    const first = await runApplying(proc, op);
    assert.notEqual(first.result.code, 0, "git refused the switch");
    assert.deepEqual(first.inTheWay?.paths, [n.name], "the chosen file is what is in the way");

    const out = await stashAndRetry(proc, op);
    assert.equal(out.result.code, 0, `the retry ran: ${out.result.stderr}${out.stashFailed ?? ""}`);
    assert.deepEqual(out.stashed?.paths, [n.name]);
    assert.equal(out.fate, "restored", "and the edit came back");
    assert.equal(git(dir, "symbolic-ref", "--short", "HEAD").trim(), "feature", "the switch happened");
    assert.equal(
      read(dir, n.name),
      LINES("feature", 0).replace("line 8\n", "mine\n"),
      "the user's edit sits on top of what the switch brought",
    );
    assert.equal(read(dir, n.decoy), LINES("mine", 4), "the neighbour's edit never left the working tree");
    assert.equal(stashCount(dir), 0, "the stash was popped");
  });
}
