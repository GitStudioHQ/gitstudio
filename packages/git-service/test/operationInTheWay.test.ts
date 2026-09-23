// A command that applies commits — or a pull — pressed while git is ALREADY
// stopped in an operation: a merge, a rebase, a cherry-pick, a revert or a
// `git am` waiting for the user, or files left unmerged by a stash.
//
// Where the two lines of work meet. The operation core names every stop from
// git's state (OperationProvider.detect); the doors (runApplying, SyncOps.pull)
// kept their own list of markers, and it missed two things:
//
//   · git REFUSES these commands over a stop — "Merging is not possible because
//     you have unmerged files", "You have not concluded your merge",
//     "It seems that there is already a rebase-merge directory", "your local
//     changes would be overwritten by cherry-pick" over the staged resolution —
//     and that went out as git's text: in red, and on the desktop filed as a
//     crash. It is the user's state. Now: `blocked`, naming the operation.
//   · a stopped `git am` is no marker the doors knew, and a stopped
//     cherry-pick or revert with nothing left unmerged was no block to the
//     pull. Their staged resolution was read as "your uncommitted changes", and
//     Stash & Retry stashed it OUT of the operation: over a stopped revert,
//     the stash and the retried rebasing pull left no revert at all
//     (REVERT_HEAD gone, the resolution in a stash); a cherry-pick was left
//     stopped with nothing staged. Now the resolution is the operation's,
//     never offered to a stash.
//
// And the commands that would END a stopped operation, or move HEAD out from
// under it, are not run over one at all: a checkout (`git switch`'s own
// rule), a merge, a rebase, a pull — and a pick, except at a plain rebase
// stop. What git itself does there is pinned below.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitProcess } from "../src/GitProcess";
import { GitContext } from "../src/GitContext";
import {
  newBranchAtHead,
  operationInTheWayMessage,
  runApplying,
  stashAndRetry,
  type ApplyOp,
} from "../src/changesInTheWay";

const trash: string[] = [];
const contexts: GitContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  for (const d of trash.splice(0)) removeTempRepo(d);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true" },
  });
}
function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // the stop is the point
  }
}

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");

type Stop = "merge" | "rebase" | "cherry-pick" | "revert" | "am" | "stash";
const STOPS: Stop[] = ["merge", "rebase", "cherry-pick", "revert", "am", "stash"];

/**
 * A repository stopped mid-`stop` on a conflict in a.txt — `resolved`: the
 * conflict resolved and staged, the operation NOT continued.
 *
 * Doors' targets, made before the stop: branch `other` (main + o.txt), a
 * stash of an edit to e.txt (stash@{0} once the stop's own stash is popped),
 * and `origin/main` one commit ahead (u.txt), not yet fetched.
 */
function stopped(stop: Stop, resolved: boolean): { dir: string; proc: GitProcess; other: string; main: string } {
  const base = mkdtempSync(join(tmpdir(), "gitstudio-opway-"));
  trash.push(base);
  const dir = join(base, "work");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  git(base, "init", "-q", "-b", "main", dir);
  for (const [k, v] of [["user.email", "me@example.com"], ["user.name", "Me"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
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
  // The doors' targets.
  git(dir, "branch", "other");
  git(dir, "checkout", "-q", "other");
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
  for (const [k, v] of [["user.email", "them@example.com"], ["user.name", "Them"], ["commit.gpgsign", "false"]]) {
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
  return { dir, proc: new GitProcess({ cwd: dir }), other, main };
}

/** Everything a refusal must leave as it was. */
function state(dir: string): string {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
    .filter((m) => existsSync(join(dir, ".git", m)))
    .join(",");
  let sym = "";
  try {
    sym = git(dir, "symbolic-ref", "-q", "HEAD").trim();
  } catch {
    sym = "(detached)";
  }
  return JSON.stringify({
    head: git(dir, "rev-parse", "HEAD").trim(),
    sym,
    markers,
    index: git(dir, "ls-files", "-s"),
    status: git(dir, "status", "--porcelain=v1", "--untracked-files=all"),
    stashes: git(dir, "stash", "list", "--format=%H"),
  });
}

const OPERATION: Record<Stop, string | undefined> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  am: "am",
  stash: undefined, // unmerged files, no operation
};

const DOOR_NAMES = ["merge", "rebase", "cherry-pick", "revert", "stash apply", "checkout", "checkout --detach", "new branch at HEAD"];

function doors(t: { other: string; main: string }): { name: string; op: ApplyOp }[] {
  return [
    { name: "merge", op: { kind: "merge", target: "refs/heads/other", args: ["merge", "--no-edit", "refs/heads/other"] } },
    { name: "rebase", op: { kind: "rebase", onto: "refs/heads/other", args: ["rebase", "refs/heads/other"] } },
    { name: "cherry-pick", op: { kind: "cherry-pick", commit: t.other, args: ["cherry-pick", t.other] } },
    { name: "revert", op: { kind: "revert", commit: t.main, args: ["revert", "--no-edit", t.main] } },
    { name: "stash apply", op: { kind: "stash", stash: "stash@{0}" } },
    { name: "checkout", op: { kind: "checkout", target: "other", args: ["checkout", "other"] } },
    { name: "checkout --detach", op: { kind: "checkout", target: t.other, args: ["checkout", "--detach", t.other] } },
    { name: "new branch at HEAD", op: newBranchAtHead("fresh") },
  ];
}

// ── the table: every stop × every door ──────────────────────────────────────

for (const stop of STOPS) {
  for (const resolved of [false, true]) {
    // A conflicted stash pop, resolved, is no stop at all: no operation, nothing
    // unmerged — just the user's changes, which is the in-the-way table's.
    if (stop === "stash" && resolved) continue;
    test(`${stop}${resolved ? ", resolved but not continued" : ", conflicted"}: every door is blocked BY it, or runs — never git's text, never "your changes", the stop untouched`, async () => {
      for (const name of DOOR_NAMES) {
        const r = stopped(stop, resolved);
        const d = { name };
        const op = doors(r).find((x) => x.name === name)!.op;
        const before = state(r.dir);
        const out = await runApplying(r.proc, op);
        assert.equal(out.inTheWay, undefined, `${d.name}: the stop's own files are never "your uncommitted changes"`);
        if (out.result.code === 0) {
          // git let it run — only a stash apply may: it touches no operation
          // file (a stash applied over a staged resolution merges into it).
          // With no operation at all (a conflicted stash pop), a branch made
          // at HEAD ends nothing either.
          assert.ok(
            d.name === "stash apply" || (stop === "stash" && d.name === "new branch at HEAD"),
            `${d.name}: never run over a stopped operation`,
          );
          assert.equal(out.blocked, undefined, `${d.name}: ran, so not blocked`);
          assert.equal(state(r.dir).includes(`"markers":""`), before.includes(`"markers":""`), "the operation still stopped");
          continue;
        }
        assert.ok(out.blocked, `${d.name}: refused, and said as blocked by the stop — git said: ${out.result.stderr}`);
        assert.equal(out.blocked.kind, op.kind);
        assert.equal(out.blocked.operation, OPERATION[stop], `${d.name}: names the operation`);
        assert.equal(out.blocked.unmerged, resolved ? 0 : 1, `${d.name}: counts what is left to resolve`);
        assert.equal(state(r.dir), before, `${d.name}: NOTHING changed — HEAD, the markers, the index, the files, the stash list`);
      }
    });
  }
}

test("a switch is refused while an operation is stopped, and git is never run — the merge is NOT quietly ended", async () => {
  const r = stopped("merge", true);
  const before = state(r.dir);
  const out = await runApplying(r.proc, { kind: "checkout", target: "other", args: ["checkout", "other"] });
  assert.deepEqual(out.blocked, { kind: "checkout", operation: "merge", unmerged: 0 });
  assert.equal(state(r.dir), before);
  assert.ok(existsSync(join(r.dir, ".git", "MERGE_HEAD")), "still merging");
  // What git itself would have done — the reason for the rule.
  git(r.dir, "checkout", "-q", "other");
  assert.ok(!existsSync(join(r.dir, ".git", "MERGE_HEAD")), "git checkout ends the merge silently");
});

// What git itself does when these commands run over a stop — the reasons
// runApplying's endsOrMoves refuses them before git runs. Pinned so the rule
// can be revisited if git changes, and never on a guess.

/** A stop resolved to HEAD's own side: the index equals HEAD, nothing unmerged. */
function resolvedToOurs(stop: Stop): ReturnType<typeof stopped> {
  const r = stopped(stop, false);
  git(r.dir, "checkout", "--ours", "--", "a.txt");
  git(r.dir, "add", "a.txt");
  return r;
}

test("git: a fast-forward merge over a stopped rebase moves HEAD out from under it", async () => {
  const r = stopped("rebase", true);
  const at = git(r.dir, "rev-parse", "HEAD").trim();
  git(r.dir, "merge", "--no-edit", "refs/heads/other");
  assert.notEqual(git(r.dir, "rev-parse", "HEAD").trim(), at, "HEAD moved");
  assert.ok(existsSync(join(r.dir, ".git", "rebase-merge")), "under a rebase that is still stopped");
});

test("git: a rebase over a clean tree runs under a stopped cherry-pick, moving HEAD out from under it", async () => {
  const r = resolvedToOurs("cherry-pick");
  const at = git(r.dir, "rev-parse", "HEAD").trim();
  git(r.dir, "rebase", "refs/heads/other");
  assert.notEqual(git(r.dir, "rev-parse", "HEAD").trim(), at, "HEAD moved");
  assert.ok(existsSync(join(r.dir, ".git", "CHERRY_PICK_HEAD")), "under a cherry-pick that is still stopped");
});

test("git: a pick over a stopped merge commits UNDER it — the merge then records it in its own first parent", async () => {
  const r = resolvedToOurs("merge");
  const at = git(r.dir, "rev-parse", "HEAD").trim();
  git(r.dir, "cherry-pick", r.other);
  assert.equal(git(r.dir, "rev-parse", "HEAD~1").trim(), at, "a commit went in under the merge");
  assert.ok(existsSync(join(r.dir, ".git", "MERGE_HEAD")), "which is still stopped");
});

test("git: a merge refused over a stopped revert's staged resolution ENDS the revert", async () => {
  const r = stopped("revert", true);
  tryGit(r.dir, "merge", "--no-edit", "refs/heads/other");
  assert.ok(!existsSync(join(r.dir, ".git", "REVERT_HEAD")), "REVERT_HEAD removed by a merge that never ran");
});

test("a rebase stopped at a deliberate `edit` is still a rebase in progress: a switch is refused, a pick runs", async () => {
  const r = stopped("merge", false);
  git(r.dir, "merge", "--abort");
  // edit-stop at "main changes a"
  const seq = join(r.dir, "..", "seq.sh");
  writeFileSync(seq, '#!/bin/sh\nsed -i.bak "1s/^pick/edit/" "$1"\n', { mode: 0o755 });
  execFileSync("git", ["rebase", "-i", "HEAD~1"], {
    cwd: r.dir,
    stdio: "ignore",
    env: { ...process.env, GIT_SEQUENCE_EDITOR: seq, GIT_EDITOR: "true" },
  });
  assert.ok(existsSync(join(r.dir, ".git", "rebase-merge")), "paused at edit");
  const sw = await runApplying(r.proc, { kind: "checkout", target: "other", args: ["checkout", "other"] });
  assert.deepEqual(sw.blocked, { kind: "checkout", operation: "rebase", unmerged: 0 });
  // Picking a commit in at an edit stop is ordinary git, and it runs.
  const pick = await runApplying(r.proc, { kind: "cherry-pick", commit: r.other, args: ["cherry-pick", r.other] });
  assert.equal(pick.result.code, 0, pick.result.stderr);
  assert.equal(pick.blocked, undefined);
});

test("a pick that STOPS on conflicts during an edit pause is its own stop, not blocked", async () => {
  const r = stopped("merge", false);
  git(r.dir, "merge", "--abort");
  const seq = join(r.dir, "..", "seq.sh");
  writeFileSync(seq, '#!/bin/sh\nsed -i.bak "1s/^pick/edit/" "$1"\n', { mode: 0o755 });
  execFileSync("git", ["rebase", "-i", "HEAD~1"], {
    cwd: r.dir,
    stdio: "ignore",
    env: { ...process.env, GIT_SEQUENCE_EDITOR: seq, GIT_EDITOR: "true" },
  });
  const feature = git(r.dir, "rev-parse", "feature").trim();
  const pick = await runApplying(r.proc, { kind: "cherry-pick", commit: feature, args: ["cherry-pick", feature] });
  assert.notEqual(pick.result.code, 0);
  assert.equal(pick.blocked, undefined, "the pick stopped on a conflict of its own — git's state changed");
  assert.ok(existsSync(join(r.dir, ".git", "CHERRY_PICK_HEAD")));
});

test("Stash & Retry never stashes a stopped operation's resolution out of it", async () => {
  for (const stop of ["am", "cherry-pick", "revert"] as Stop[]) {
    const r = stopped(stop, true);
    const before = state(r.dir);
    const out = await stashAndRetry(r.proc, { kind: "cherry-pick", commit: r.other, args: ["cherry-pick", r.other] });
    assert.equal(out.stashed, undefined, `${stop}: nothing stashed`);
    assert.ok(out.blocked, `${stop}: blocked by the stop`);
    assert.equal(state(r.dir), before, `${stop}: the stop and its resolution untouched`);
  }
});

// ── the pull ────────────────────────────────────────────────────────────────

for (const stop of STOPS) {
  for (const resolved of [false, true]) {
    if (stop === "stash" && resolved) continue; // no stop: the user's changes
    for (const mode of [undefined, "merge", "rebase"] as const) {
      test(`a ${mode ?? "mode-less"} pull over a ${stop}${resolved ? " resolved but not continued" : ", conflicted"}: blocked by it before anything runs — never \`dirty\`, never git's text`, async () => {
        const r = stopped(stop, resolved);
        const ctx = new GitContext({ root: r.dir });
        contexts.push(ctx);
        const before = state(r.dir);
        const fetched = git(r.dir, "for-each-ref", "refs/remotes/");
        const pulled = await ctx.sync.pull(mode ? { mode } : undefined);
        assert.equal(pulled.ok, false);
        assert.equal(pulled.dirty, undefined, "the stop's files are never the user's work in the way");
        assert.deepEqual(
          pulled.blocked,
          OPERATION[stop] ? { operation: OPERATION[stop], conflicted: resolved ? 0 : 1 } : { conflicted: 1 },
        );
        assert.equal(state(r.dir), before, "nothing changed");
        assert.equal(git(r.dir, "for-each-ref", "refs/remotes/"), fetched, "nothing fetched: the pull never ran");
      });
    }
  }
}

test("git: what a pull does over a stop it is not refused by — the reason it is not run", async () => {
  // A rebasing pull over a revert whose resolution was put back to HEAD's
  // side: git runs it, and HEAD moves out from under the revert.
  const r = resolvedToOurs("revert");
  const at = git(r.dir, "rev-parse", "HEAD").trim();
  git(r.dir, "pull", "-q", "--rebase");
  assert.notEqual(git(r.dir, "rev-parse", "HEAD").trim(), at, "HEAD moved");
  assert.ok(existsSync(join(r.dir, ".git", "REVERT_HEAD")), "under a revert that is still stopped");
  // A merging pull refused over the revert's staged resolution: git removes
  // REVERT_HEAD on its way out, as the merge above does.
  const s = stopped("revert", true);
  tryGit(s.dir, "pull", "--no-rebase", "--no-edit");
  assert.ok(!existsSync(join(s.dir, ".git", "REVERT_HEAD")), "a refused pull ended the revert");
});

test("a stopped cherry-pick blocks the pull before the remote is even asked", async () => {
  const r = stopped("cherry-pick", true);
  git(r.dir, "remote", "set-url", "origin", join(r.dir, "..", "no-such-remote.git"));
  const ctx = new GitContext({ root: r.dir });
  contexts.push(ctx);
  const pulled = await ctx.sync.pull({ mode: "merge" });
  assert.equal(pulled.ok, false);
  assert.deepEqual(pulled.blocked, { operation: "cherry-pick", conflicted: 0 });
  assert.equal(await ctx.sync.pausedOperation().then((p) => p?.operation), "cherry-pick", "and the question asked before a pull says the same");
});

// ── the words ───────────────────────────────────────────────────────────────

test("the sentence names what is stopped, what is left, and what it is in the way of", () => {
  assert.equal(
    operationInTheWayMessage({ kind: "cherry-pick", operation: "merge", unmerged: 2 }),
    "A merge is still in progress, with 2 files still conflicted. Resolve them and commit the merge — or abort it — before cherry-picking.",
  );
  assert.equal(
    operationInTheWayMessage({ kind: "checkout", operation: "rebase", unmerged: 0 }),
    "A rebase is still in progress. Continue it — or abort it — before checking out.",
  );
  assert.equal(
    operationInTheWayMessage({ kind: "merge", operation: "am", unmerged: 1 }),
    "Applying patches (git am) is still in progress, with 1 file still conflicted. Resolve it and continue — or abort it — before merging.",
  );
  assert.equal(
    operationInTheWayMessage({ kind: "stash", unmerged: 3 }),
    "3 files are still conflicted. Resolve them before applying a stash.",
  );
});
