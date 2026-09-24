// The AI tools pressed while git is ALREADY stopped — over the whole conflict
// matrix (scripts/merge-e2e/fixtures.sh: a merge, a rebase with either
// backend, a rebase re-creating a merge, a cherry-pick and a range of them, a
// revert, a `git am`, a conflicted stash pop and the #12 reporter's rebase, in
// every merge.conflictStyle), conflicted and then resolved-but-not-continued.
//
// The app's doors refuse a checkout over a stop (runApplying: `git switch`'s
// own rule), because `git checkout` ENDS a stopped merge, cherry-pick or
// revert and moves HEAD out from under a rebase or an am — and `git checkout
// -b` does the same. The agent's git_checkout and git_create_branch (with
// checkout) still ran git directly: over a conflicted merge, create_branch
// answered ok and the merge was gone. They go through the same door now, and
// say why in the doors' sentence — never git's text.
//
// And the words for "you still have conflicts": `unresolvedConflictsMessage`
// told a rebase, a cherry-pick and a `git am` to "commit", which is the one
// thing not to do there. It names each operation's own way on now, read from
// the same stop.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { GitProcess } from "../src/GitProcess";
import { createGitToolHost } from "../src/GitToolHost";
import { unresolvedConflictsMessage } from "../src/ConflictProvider";
import { operationInTheWayMessage, pick, stoppedIn, type StoppedOperation } from "../src/stoppedOperation";

const FIXTURES = fileURLToPath(new URL("../../../scripts/merge-e2e/fixtures.sh", import.meta.url));

interface Scenario {
  id: string;
  op: string;
  dir: string;
}

let target: string;
let scenarios: Scenario[] = [];
const contexts: GitContext[] = [];

before(() => {
  target = mkdtempSync(join(tmpdir(), "gs-ai-stop-matrix-"));
  const r = spawnSync("bash", [FIXTURES, target], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`fixtures.sh failed (${r.status}):\n${r.stderr}`);
  const manifest = JSON.parse(readFileSync(join(target, "matrix.json"), "utf8")) as { scenarios: Scenario[] };
  scenarios = manifest.scenarios.map((s) => ({ ...s, dir: join(target, s.dir) }));
});

after(() => {
  for (const c of contexts.splice(0)) c.dispose();
  removeTempRepo(target);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "false" },
  });
}

/**
 * Resolve every conflict and stage the resolution, without continuing. Each
 * conflicted path is resolved as removed — the one resolution that is always a
 * valid index (taking a side is not: the matrix's file/directory case keeps
 * the other side's files at stage 0, and its gitlink has no commit checked out
 * for `git add` to take).
 */
function resolveAll(dir: string): void {
  const paths = new Set(git(dir, "ls-files", "-u", "-z").split("\0").filter(Boolean).map((row) => row.slice(row.indexOf("\t") + 1)));
  for (const path of paths) git(dir, "update-index", "--force-remove", "--", path);
  assert.equal(git(dir, "ls-files", "-u"), "", `${dir}: every conflict resolved`);
}

/** Everything a refused tool must leave as it was. */
function state(dir: string): string {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"].filter((m) => {
    const p = git(dir, "rev-parse", "--git-path", m).trim();
    return existsSync(isAbsolute(p) ? p : join(dir, p));
  });
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
    status: git(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    branches: git(dir, "for-each-ref", "refs/heads/"),
  });
}

function hostFor(dir: string) {
  const ctx = new GitContext({ root: dir });
  contexts.push(ctx);
  return { host: createGitToolHost(ctx), proc: new GitProcess({ cwd: dir }) };
}

/** A local branch other than the one HEAD is on — or, with none, HEAD's parent. */
function elsewhere(dir: string): string {
  let current = "";
  try {
    current = git(dir, "symbolic-ref", "-q", "--short", "HEAD").trim();
  } catch {
    // detached
  }
  const other = git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .find((b) => b && b !== current);
  return other ?? git(dir, "rev-parse", "HEAD~1").trim();
}

const GIT_WORDS = /fatal:|error:|hint:|warning:|you need to resolve|overwritten by|not possible|cancelling/;

/** Each operation's way on — and "commit" only for a merge. */
const WAY_ON: Record<StoppedOperation, RegExp> = {
  merge: /Resolve them and commit the merge, or abort it, then try again\.$/,
  rebase: /Resolve them and continue the rebase, or abort it, then try again\.$/,
  "cherry-pick": /Resolve them and continue the cherry-pick, or abort it, then try again\.$/,
  revert: /Resolve them and continue the revert, or abort it, then try again\.$/,
  am: /Resolve them and continue, or abort it, then try again\.$/,
};

test("the matrix is whole: every operation, every style", () => {
  const ops = new Set(scenarios.map((s) => s.op));
  for (const op of ["merge", "rebase", "rebase-apply", "rebase-merges", "cherry-pick", "cherry-pick-range", "revert", "am", "stash", "issue12", "issue12-exact"]) {
    assert.ok(ops.has(op), `the matrix has ${op}`);
  }
  assert.equal(scenarios.length, 33);
});

// Before the next test resolves them: every scenario is still conflicted here.
test("unresolvedConflictsMessage names each operation's own way on — 'commit' only for a merge", async () => {
  const seen = new Set<string>();
  for (const s of scenarios) {
    const stop = await stoppedIn(new GitProcess({ cwd: s.dir }));
    assert.ok(stop && stop.unmerged > 0, `${s.id}: stopped with conflicts`);
    const said = unresolvedConflictsMessage(stop.unmerged, stop);
    const files = stop.unmerged === 1 ? "1 file still has" : `${stop.unmerged} files still have`;
    assert.ok(said.startsWith(`${files} unresolved conflicts. `), `${s.id}: counts the files: ${said}`);
    if (stop.operation) {
      assert.match(said, stop.unmerged === 1 ? new RegExp(WAY_ON[stop.operation].source.replace("them", "it")) : WAY_ON[stop.operation], `${s.id}: ${said}`);
      seen.add(stop.operation);
    } else {
      assert.match(said, /Resolve (it|them), then try again\.$/, `${s.id}: a conflicted stash pop has nothing to commit or continue: ${said}`);
      seen.add("stash pop");
    }
    if (stop.operation !== "merge") assert.doesNotMatch(said, /commit/, `${s.id}: never "commit" outside a merge: ${said}`);
  }
  assert.deepEqual([...seen].sort(), ["am", "cherry-pick", "merge", "rebase", "revert", "stash pop"]);
});

test("git_checkout and git_create_branch over every stop, conflicted then resolved: refused in the doors' words, the stop untouched", async () => {
  const cells: string[] = [];
  for (const s of scenarios) {
    for (const resolved of [false, true]) {
      if (resolved) resolveAll(s.dir);
      const { host, proc } = hostFor(s.dir);
      const stop = await stoppedIn(proc);
      if (!stop) {
        // A conflicted stash pop, resolved, is no stop at all: no operation,
        // nothing unmerged.
        assert.ok(s.op === "stash" && resolved, `${s.id}: only a resolved stash pop is no stop`);
        continue;
      }
      const cell = `${s.id}${resolved ? " (resolved)" : ""}`;
      const refused = operationInTheWayMessage({ kind: "checkout", ...pick(stop) });
      const before = state(s.dir);

      // git_checkout — a branch, and a commit.
      for (const ref of [elsewhere(s.dir), git(s.dir, "rev-parse", "HEAD~1").trim()]) {
        const r = await host.checkout(ref);
        assert.equal(r.ok, false, `${cell}: git_checkout ${ref} must not run over the stop`);
        assert.equal(r.message, refused, `${cell}: git_checkout ${ref} says what is stopped`);
        assert.equal(state(s.dir), before, `${cell}: git_checkout ${ref} left the stop exactly as it was`);
      }

      // git_create_branch with checkout: `git checkout -b` ENDS a merge,
      // cherry-pick or revert and moves HEAD under a rebase or an am.
      const created = await host.createBranch("gs-ai-new", true);
      if (stop.operation) {
        assert.equal(created.ok, false, `${cell}: create_branch+checkout must not run over the stop`);
        assert.equal(created.message, refused, `${cell}: create_branch+checkout says what is stopped`);
        assert.equal(state(s.dir), before, `${cell}: create_branch+checkout left the stop exactly as it was`);
      } else {
        // Files unmerged by a stash pop, and no operation: a branch at HEAD
        // ends nothing (the desktop's own door runs it too).
        const unmerged = git(s.dir, "ls-files", "-u");
        assert.equal(created.ok, true, `${cell}: ${created.message}`);
        assert.equal(git(s.dir, "ls-files", "-u"), unmerged, `${cell}: still conflicted`);
        // Back onto main by the ref alone: the two are the same commit, and a
        // switch over an unmerged index is refused.
        git(s.dir, "symbolic-ref", "HEAD", JSON.parse(before).sym);
        git(s.dir, "branch", "-D", "gs-ai-new");
        assert.equal(state(s.dir), before, `${cell}: back where it was`);
      }
      assert.doesNotMatch(created.message ?? "", GIT_WORDS, `${cell}: never git's words`);

      // Without checkout it is a branch at HEAD, and nothing else.
      const plain = await host.createBranch("gs-ai-plain", false);
      assert.equal(plain.ok, true, `${cell}: create_branch without checkout still works (${plain.message})`);
      git(s.dir, "branch", "-D", "gs-ai-plain");
      assert.equal(state(s.dir), before, `${cell}: …and touched no stop`);
      cells.push(cell);
    }
  }
  assert.equal(cells.length, 33 * 2 - 3, "every scenario, conflicted and resolved (a resolved stash pop is no stop)");
});
