// The stopped-operation state table, desktop column: every door that applies
// commits — and the pull — through the REAL bridge methods, pressed while git
// is ALREADY stopped: a merge, a rebase, a cherry-pick, a revert or a `git am`
// waiting for the user (conflicted, or resolved and not yet continued), or
// files left unmerged by a stash.
//
// Where the two lines met. git refuses most of these over a stop, and the
// bridge answered git's text un-`expected` — "Merging is not possible because
// you have unmerged files", "You have not concluded your merge (MERGE_HEAD
// exists)", "It seems that there is already a rebase-merge directory", "your
// local changes would be overwritten by cherry-pick" — so the IPC wrapper
// FILED each one as a crash: seventy-odd cells of this table. Over a stopped
// `git am`, and in a rebasing pull over a stopped cherry-pick or revert, the
// stop's staged resolution came back as "your uncommitted changes", and
// Stash & Retry stashed it out of the operation. And git does not refuse them
// all: a checkout ENDED a stopped merge, cherry-pick or revert.
//
// Per cell: nothing filed, `expected`, never git's words, never offered to
// Stash & Retry, the stop exactly as it was, and the message says what is
// stopped. A stash git lets apply over a staged resolution simply applies.
// (The engine: packages/git-service/test/operationInTheWay.test.ts; the
// extension column: apps/extension/test/operationInTheWayTable.test.ts.)

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import type { CommitActionResult } from "../src/shared/ipc";

const scratch = mkdtempSync(join(tmpdir(), "gs-opway-table-"));
after(() => removeTempRepo(scratch));

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_EDITOR: "true" },
  });
}
function tryGit(cwd: string, ...a: string[]): void {
  try {
    git(cwd, ...a);
  } catch {
    // the stop is the point
  }
}
const LINES = (tag: string, n: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === n ? `${tag}\n` : `line ${i}\n`)).join("");

type Stop = "merge" | "rebase" | "cherry-pick" | "revert" | "am" | "stash";

/**
 * Stopped mid-`stop` on a conflict in a.txt (`resolved`: resolved and staged,
 * not continued). Made first: branch `other` (main + o.txt), a stash of an
 * edit to e.txt, and origin/main one commit ahead (u.txt), not yet fetched.
 */
function stopped(stop: Stop, resolved: boolean): { dir: string; other: string; main: string } {
  const base = mkdtempSync(join(scratch, "cell-"));
  const dir = join(base, "work");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  git(base, "init", "-q", "-b", "main", dir);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git(dir, "config", k, v);
  }
  writeFileSync(join(dir, "a.txt"), LINES("line 0", 0));
  writeFileSync(join(dir, "e.txt"), LINES("line 0", 0));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), LINES("feature", 0));
  git(dir, "commit", "-q", "-am", "feature changes a");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), LINES("main", 0));
  git(dir, "commit", "-q", "-am", "main changes a");
  git(dir, "checkout", "-q", "-b", "other");
  writeFileSync(join(dir, "o.txt"), "other\n");
  git(dir, "add", "o.txt");
  git(dir, "commit", "-q", "-m", "other adds o");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "e.txt"), LINES("stashed", 4));
  git(dir, "stash", "push", "-q", "-m", "the door's stash");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  const seed = join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  for (const [k, v] of [["user.email", "u@example.com"], ["user.name", "u"], ["commit.gpgsign", "false"]]) {
    git(seed, "config", k, v);
  }
  writeFileSync(join(seed, "u.txt"), "theirs\n");
  git(seed, "add", "u.txt");
  git(seed, "commit", "-q", "-m", "theirs adds u");
  git(seed, "push", "-q", "origin", "main");
  const main = git(dir, "rev-parse", "main").trim();
  const other = git(dir, "rev-parse", "other").trim();
  switch (stop) {
    case "merge":
      tryGit(dir, "merge", "--no-edit", "feature");
      break;
    case "rebase":
      git(dir, "checkout", "-q", "feature");
      tryGit(dir, "rebase", "main");
      break;
    case "cherry-pick":
      tryGit(dir, "cherry-pick", "feature");
      break;
    case "revert":
      writeFileSync(join(dir, "a.txt"), LINES("main again", 0));
      git(dir, "commit", "-q", "-am", "main changes a again");
      tryGit(dir, "revert", "--no-edit", "HEAD~1");
      break;
    case "am": {
      const patch = join(base, "feature.patch");
      writeFileSync(patch, git(dir, "format-patch", "-1", "--stdout", "feature"));
      tryGit(dir, "am", "-3", patch);
      break;
    }
    case "stash":
      writeFileSync(join(dir, "a.txt"), LINES("stashed a", 0));
      git(dir, "stash", "push", "-q", "-m", "the stop's stash");
      writeFileSync(join(dir, "a.txt"), LINES("main moved", 0));
      git(dir, "commit", "-q", "-am", "main moves a");
      tryGit(dir, "stash", "pop");
      break;
  }
  assert.ok(git(dir, "ls-files", "-u").trim(), `${stop}: stopped on a conflict`);
  if (resolved) {
    writeFileSync(join(dir, "a.txt"), LINES("resolved", 0));
    git(dir, "add", "a.txt");
  }
  return { dir, other, main };
}

/** Everything a refused door must leave as it was. */
function state(dir: string): string {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
    .filter((m) => existsSync(join(dir, ".git", m)))
    .join(",");
  let sym = "(detached)";
  try {
    sym = git(dir, "symbolic-ref", "-q", "HEAD").trim();
  } catch {
    // detached, mid-rebase
  }
  return JSON.stringify({
    head: git(dir, "rev-parse", "HEAD").trim(),
    sym,
    markers,
    index: git(dir, "ls-files", "-s"),
    status: git(dir, "status", "--porcelain=v1", "--untracked-files=all"),
    stashes: git(dir, "stash", "list", "--format=%H"),
    remotes: git(dir, "for-each-ref", "refs/remotes/"),
  });
}

type Door =
  | "revert"
  | "cherry-pick"
  | "checkout --detach"
  | "checkout a branch"
  | "create and switch"
  | "create at HEAD and switch"
  | "merge"
  | "rebase"
  | "stash apply"
  | "stash pop"
  | "pull"
  | "pull --merge"
  | "pull --rebase";
const DOORS: Door[] = [
  "revert",
  "cherry-pick",
  "checkout --detach",
  "checkout a branch",
  "create and switch",
  "create at HEAD and switch",
  "merge",
  "rebase",
  "stash apply",
  "stash pop",
  "pull",
  "pull --merge",
  "pull --rebase",
];

async function press(door: Door, c: { dir: string; other: string; main: string }): Promise<CommitActionResult> {
  const repos = new RepoStore([]);
  await repos.open(c.dir);
  const bridge = new GitBridge(repos);
  const doorStash = git(c.dir, "stash", "list", "--format=%gd %s")
    .split("\n")
    .find((l) => l.endsWith("the door's stash"))!
    .split(" ")[0];
  switch (door) {
    case "revert":
      return bridge.commitAction({ action: "revert", sha: c.main });
    case "cherry-pick":
      return bridge.commitAction({ action: "cherry-pick", sha: c.other });
    case "checkout --detach":
      return bridge.commitAction({ action: "checkout", sha: c.other });
    case "checkout a branch":
      return bridge.commitAction({ action: "checkout-ref", sha: "other", name: "other", fullName: "refs/heads/other", refKind: "head" });
    case "create and switch":
      return bridge.branchCreate({ name: "fresh", checkout: true, startPoint: c.other });
    case "create at HEAD and switch":
      return bridge.branchCreate({ name: "fresh", checkout: true });
    case "merge":
      return bridge.branchMerge({ fullName: "refs/heads/other" });
    case "rebase":
      return bridge.branchRebase({ fullName: "refs/heads/other" });
    case "stash apply":
      return bridge.stashApply(doorStash);
    case "stash pop":
      return bridge.stashPop(doorStash);
    case "pull":
      return bridge.syncPull();
    case "pull --merge":
      return bridge.syncPull({ mode: "merge" });
    case "pull --rebase":
      return bridge.syncPull({ mode: "rebase" });
  }
}

const OPERATION: Record<Stop, RegExp> = {
  merge: /^A merge is still in progress/,
  rebase: /^A rebase is still in progress/,
  "cherry-pick": /^A cherry-pick is still in progress/,
  revert: /^A revert is still in progress/,
  am: /^Applying patches \(git am\) is still in progress/,
  stash: /^1 file is still conflicted/,
};

for (const stop of ["merge", "rebase", "cherry-pick", "revert", "am", "stash"] as Stop[]) {
  for (const resolved of [false, true]) {
    // A conflicted stash pop, resolved, is no stop: no operation, nothing
    // unmerged — the user's changes, which is inTheWayStateTable's business.
    if (stop === "stash" && resolved) continue;
    for (const door of DOORS) {
      test(`${stop}${resolved ? ", resolved" : ", conflicted"} × ${door}`, async () => {
        const c = stopped(stop, resolved);
        const before = state(c.dir);
        const r = await press(door, c);
        assert.equal(reportableResultMessage(r), undefined, `nothing filed: ${r.message}`);
        assert.equal(r.inTheWay, undefined, `the stop's files are never offered to a stash: ${r.message}`);
        if (r.ok) {
          // git let it run: only a stash applied over a staged resolution may
          // — and, with no operation at all (a conflicted stash pop), a branch
          // made at HEAD, which ends nothing.
          assert.ok(
            (door.startsWith("stash") && resolved) || (stop === "stash" && door === "create at HEAD and switch"),
            `${door} never runs over a stopped operation`,
          );
          assert.ok(state(c.dir).includes(JSON.parse(before).markers), "the operation still stopped");
          return;
        }
        assert.equal(r.expected, true, r.message);
        assert.doesNotMatch(
          r.message ?? "",
          /fatal:|error:|hint:|overwritten by|not possible|not concluded|rebase-merge directory|'git am' is in progress/,
          "never git's words",
        );
        assert.match(r.message ?? "", OPERATION[stop], "says what is stopped");
        assert.equal(state(c.dir), before, "the stop exactly as it was — HEAD, markers, index, files, stashes, nothing fetched");
      });
    }
  }
}

test("a genuine failure over a stop is still reported: a pick that fails at a plain rebase stop, for its own reason", async () => {
  // A rebase paused at an `edit`, clean tree: picking a commit in is ordinary
  // git and runs — so when it fails, it failed for its own reason. A merge
  // commit picked with no -m is refused for THAT.
  const c = stopped("merge", false);
  git(c.dir, "merge", "--abort");
  git(c.dir, "merge", "--no-ff", "--no-edit", "other");
  const mergeCommit = git(c.dir, "rev-parse", "HEAD").trim();
  const seq = join(c.dir, "..", "seq.sh");
  writeFileSync(seq, '#!/bin/sh\nsed -i.bak "1s/^pick/edit/" "$1"\n', { mode: 0o755 });
  execFileSync("git", ["rebase", "-i", "HEAD~2"], {
    cwd: c.dir,
    stdio: "ignore",
    env: { ...process.env, GIT_SEQUENCE_EDITOR: seq, GIT_EDITOR: "true" },
  });
  assert.ok(existsSync(join(c.dir, ".git", "rebase-merge")), "paused at edit");
  const repos = new RepoStore([]);
  await repos.open(c.dir);
  const bridge = new GitBridge(repos);
  const r = await bridge.commitAction({ action: "cherry-pick", sha: mergeCommit });
  assert.equal(r.ok, false);
  assert.ok(reportableResultMessage(r), `git's own failure, reported: ${r.message}`);
});
