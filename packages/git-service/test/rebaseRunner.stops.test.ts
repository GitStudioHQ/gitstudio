// The rebase runner at its stops and refusals: an `edit` row (git exits 0 and
// the rebase is still live), a `--continue` or `--skip` that lands on the next
// `edit`, a `--continue` git refuses at a stop, a held index.lock under
// skip/abort, verbs with no rebase at all, a folder that is not a repository,
// the run observer, and the reword queue's hand-over when the files around it
// cannot be written. Real repositories and the real installers throughout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortRebase,
  abortRebaseAt,
  continueRebase,
  isRebaseInProgress,
  runRebasePlan,
  skipRebase,
  type RebaseRunOptions,
} from "../src/RebaseRunner";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

/** base, then one/two/three each adding its own file. */
function fourCommits(name: string): { r: Repo; sha: Record<string, string> } {
  const r = makeRepo(name);
  const sha: Record<string, string> = {};
  for (const n of ["base", "one", "two", "three"]) {
    r.write(`${n}.txt`, `${n}\n`);
    sha[n] = r.commitAll(n);
  }
  return { r, sha };
}

const subjects = (r: Repo, range = "HEAD~3..HEAD"): string[] =>
  r.git("log", "--format=%s", range).trim().split("\n");

const stagingQueue = (r: Repo): string => join(r.root, ".git", "gitstudio-reword-queue.json");
const liveQueue = (r: Repo): string => join(r.root, ".git", "rebase-merge", "gitstudio-reword-queue.json");

test("an edit row pauses the run, and the rewords queued below it survive every stop to the end", async () => {
  const { r, sha } = fourCommits("edit-stops");
  try {
    const todo = [`edit ${sha.one} one`, `reword ${sha.two} two`, `edit ${sha.three} three`].join("\n") + "\n";
    const first = await runRebasePlan(r.root, {
      base: sha.base,
      todo,
      rewords: [{ sha: sha.two, message: "two, reworded" }],
    });
    assert.deepEqual(first, { status: "stopped", reason: "edit", message: "Rebase paused for editing." });
    assert.equal(await isRebaseInProgress(r.root), true);
    assert.equal(existsSync(liveQueue(r)), true, "the queue was handed to git's rebase directory");
    assert.equal(existsSync(stagingQueue(r)), false, "and is not left in .git");

    // --continue exits 0 at the next `edit` row: a stop, not the end.
    const second = await continueRebase(r.root);
    assert.deepEqual(second, { status: "stopped", reason: "edit", message: "Rebase paused for editing." });
    assert.equal(existsSync(liveQueue(r)), true, "the queue is still there for the rest");

    const last = await continueRebase(r.root);
    assert.deepEqual(last, { status: "done" });
    assert.equal(await isRebaseInProgress(r.root), false);
    assert.deepEqual(subjects(r), ["three", "two, reworded", "one"], "the reword landed, after two stops");
  } finally {
    r.cleanup();
  }
});

test("a --continue git refuses at a stop is reported as still stopped, in git's words", async () => {
  const { r, sha } = fourCommits("continue-refused");
  try {
    const out = await runRebasePlan(r.root, {
      base: sha.base,
      todo: `edit ${sha.one} one\npick ${sha.two} two\n`,
      rewords: [],
    });
    assert.equal(out.status, "stopped");
    // git's refusal over an unstaged edit talks about "merge conflicts", so
    // it reads as a conflict stop — still a stop, with git's own sentence.
    r.write("base.txt", "an unstaged edit\n");
    const cont = await continueRebase(r.root);
    assert.equal(cont.status, "stopped");
    assert.match(cont.status === "stopped" ? cont.message : "", /merge conflicts/, "git's explanation, not a canned line");
    assert.equal(await isRebaseInProgress(r.root), true, "the rebase is still live");
    r.git("checkout", "--", "base.txt");

    // A refusal that is nothing like a conflict — the index is locked — is a
    // stop of unknown reason, carrying git's words.
    const lock = join(r.root, ".git", "index.lock");
    writeFileSync(lock, "");
    const locked = await continueRebase(r.root);
    assert.equal(locked.status, "stopped");
    assert.equal(locked.status === "stopped" && locked.reason, "unknown");
    assert.match(locked.status === "stopped" ? locked.message : "", /index\.lock/);
    removeTempRepo(lock);
    assert.deepEqual(await continueRebase(r.root), { status: "done" });
  } finally {
    r.cleanup();
  }
});

test("with the index locked, skip is still stopped and abort fails — both saying why, and the queue stays", async () => {
  const { r, sha } = fourCommits("locked");
  try {
    await runRebasePlan(r.root, {
      base: sha.base,
      todo: `edit ${sha.one} one\nreword ${sha.two} two\n`,
      rewords: [{ sha: sha.two, message: "two, reworded" }],
    });
    const lock = join(r.root, ".git", "index.lock");
    writeFileSync(lock, "");

    const skip = await skipRebase(r.root);
    assert.equal(skip.status, "stopped");
    assert.equal(skip.status === "stopped" && skip.reason, "unknown");
    assert.match(skip.status === "stopped" ? skip.message : "", /index\.lock/);

    const abort = await abortRebase(r.root);
    assert.equal(abort.status, "failed");
    assert.match(abort.status === "failed" ? abort.message : "", /index\.lock/, "git's reason, not a canned line");
    assert.equal(await abortRebaseAt(r.root), false, "the boolean form fails too");
    assert.equal(await isRebaseInProgress(r.root), true, "nothing was aborted");
    assert.equal(existsSync(liveQueue(r)), true, "and the typed messages were not thrown away");

    removeTempRepo(lock);
    assert.equal(await abortRebaseAt(r.root), true);
    assert.equal(await isRebaseInProgress(r.root), false);
    assert.equal(r.sha("HEAD"), sha.three, "back where it started");
  } finally {
    r.cleanup();
  }
});

test("a successful boolean abort also sweeps up a staging queue a run left behind", async () => {
  const { r, sha } = fourCommits("sweep");
  try {
    await runRebasePlan(r.root, { base: sha.base, todo: `edit ${sha.one} one\n`, rewords: [] });
    writeFileSync(stagingQueue(r), "[]");
    assert.equal(await abortRebaseAt(r.root), true);
    assert.equal(existsSync(stagingQueue(r)), false);
  } finally {
    r.cleanup();
  }
});

test("continue and skip with no rebase in progress fail with git's reason", async () => {
  const { r } = fourCommits("none");
  try {
    for (const verb of [continueRebase, skipRebase]) {
      const out = await verb(r.root);
      assert.equal(out.status, "failed");
      assert.match(out.status === "failed" ? out.message : "", /no rebase in progress/i);
    }
  } finally {
    r.cleanup();
  }
});

test("a skip past a conflict that lands on an edit row is a stop, not the end", async () => {
  const r = makeRepo("skip-edit");
  try {
    r.write("f.txt", "a\n");
    const base = r.commitAll("base");
    r.write("f.txt", "b\n");
    const one = r.commitAll("one");
    r.write("f.txt", "c\n");
    const two = r.commitAll("two");
    // `two` onto base conflicts (it edits b→c where base has a); `one` applies.
    const out = await runRebasePlan(r.root, { base, todo: `pick ${two} two\nedit ${one} one\n`, rewords: [] });
    assert.equal(out.status, "stopped");
    assert.equal(out.status === "stopped" && out.reason, "conflict");

    const skipped = await skipRebase(r.root);
    assert.deepEqual(skipped, { status: "stopped", reason: "edit", message: "Rebase paused for editing." });
    assert.equal(r.read("f.txt"), "b\n", "one was applied, two skipped");
    assert.deepEqual(await skipRebase(r.root), { status: "done" }, "skipping the edit row finishes");
  } finally {
    r.cleanup();
  }
});

test("outside a repository every verb fails and nothing claims a rebase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-rebase-norepo-"));
  try {
    assert.equal(await isRebaseInProgress(dir), false);
    const run = await runRebasePlan(dir, { base: "HEAD~1", todo: "", rewords: [] });
    assert.equal(run.status, "failed");
    assert.match(run.status === "failed" ? run.message : "", /not a git repository/i);
    assert.equal(run.status === "failed" && run.expected, undefined, "not the user's state: reportable");
    const abort = await abortRebase(dir);
    assert.equal(abort.status, "failed");
    assert.match(abort.status === "failed" ? abort.message : "", /not a git repository/i);
  } finally {
    removeTempRepo(dir);
  }
});

test("the run observer sees every git invocation, and one that throws never breaks the rebase", async () => {
  const { r, sha } = fourCommits("observer");
  try {
    const events: Parameters<NonNullable<RebaseRunOptions["onRun"]>>[0][] = [];
    const out = await runRebasePlan(
      r.root,
      { base: sha.base, todo: `pick ${sha.one} one\npick ${sha.two} two\npick ${sha.three} three\n`, rewords: [] },
      { onRun: (e) => events.push(e) },
    );
    assert.deepEqual(out, { status: "done" });
    const rebase = events.find((e) => e.args.includes("rebase") && e.args.includes("-i"));
    assert.ok(rebase, "the rebase itself was observed");
    assert.equal(rebase.exitCode, 0);
    assert.equal(rebase.failed, false);
    assert.equal(rebase.stderr, undefined, "stderr only for failures");
    assert.ok(rebase.durationMs >= 0);

    const failed: typeof events = [];
    const abort = await abortRebase(r.root, { onRun: (e) => failed.push(e) });
    assert.equal(abort.status, "failed");
    assert.equal(failed[0].failed, true);
    assert.notEqual(failed[0].exitCode, 0);
    assert.match(failed[0].stderr ?? "", /no rebase in progress/i, "a failure carries git's stderr");

    const thrower = await runRebasePlan(
      r.root,
      { base: sha.base, todo: `pick ${sha.two} two\npick ${sha.one} one\npick ${sha.three} three\n`, rewords: [] },
      {
        onRun: () => {
          throw new Error("observer bug");
        },
      },
    );
    assert.deepEqual(thrower, { status: "done" });
    assert.deepEqual(subjects(r), ["three", "one", "two"], "the reorder still happened");
  } finally {
    r.cleanup();
  }
});

test("a message whose lines start with every spare comment character is kept whole", async () => {
  const { r, sha } = fourCommits("allchars");
  try {
    const lines = [";a", "@b", "!c", "$d", "%e", "^f", "&g", "*h", "+i", "=j", "~k", "|l", ":m", "?n"];
    const message = lines.join("\n");
    const out = await runRebasePlan(r.root, {
      base: sha.base,
      todo: `pick ${sha.one} one\nreword ${sha.two} two\npick ${sha.three} three\n`,
      rewords: [{ sha: sha.two, message }],
    });
    assert.deepEqual(out, { status: "done" });
    assert.equal(r.git("log", "-1", "--format=%B", "HEAD~1").trimEnd(), message, "no line was taken for a comment");
  } finally {
    r.cleanup();
  }
});

test("when the comment-character note cannot be written the reword still lands and finishing still clears the queue", async () => {
  const { r, sha } = fourCommits("charnote");
  try {
    // A directory where the note goes: writing it fails, and so does removing
    // it at the end — neither may break the run.
    const note = `${stagingQueue(r)}.commentchar`;
    mkdirSync(note);
    const out = await runRebasePlan(r.root, {
      base: sha.base,
      todo: `pick ${sha.one} one\nreword ${sha.two} two\npick ${sha.three} three\n`,
      rewords: [{ sha: sha.two, message: "two, reworded" }],
    });
    assert.deepEqual(out, { status: "done" });
    assert.deepEqual(subjects(r), ["three", "two, reworded", "one"]);
    assert.equal(existsSync(stagingQueue(r)), false, "the queue was removed");
    assert.equal(existsSync(join(r.root, ".git", "gitstudio-reword-msg.js")), false, "and so was its installer");
  } finally {
    r.cleanup();
  }
});

test("a queue that cannot be handed to the paused rebase is not left in .git for the next one", async () => {
  const { r, sha } = fourCommits("handover");
  try {
    // The exec row puts a directory where the queue would be moved to, so
    // the hand-over fails when the `break` row pauses.
    const todo =
      [
        `pick ${sha.one} one`,
        "exec mkdir .git/rebase-merge/gitstudio-reword-queue.json",
        "break",
        `reword ${sha.two} two`,
        `pick ${sha.three} three`,
      ].join("\n") + "\n";
    const out = await runRebasePlan(r.root, { base: sha.base, todo, rewords: [{ sha: sha.two, message: "never installed" }] });
    assert.deepEqual(out, { status: "stopped", reason: "edit", message: "Rebase paused for editing." });
    assert.equal(existsSync(stagingQueue(r)), false, "not left where the next rebase of this branch would find it");
    assert.equal(existsSync(join(r.root, ".git", "gitstudio-reword-msg.js")), false);

    // With no queue to honour, --continue commits the original message.
    assert.deepEqual(await continueRebase(r.root), { status: "done" });
    assert.deepEqual(subjects(r), ["three", "two", "one"]);
  } finally {
    r.cleanup();
  }
});

/** A repo whose index holds a conflicted `stash pop`, with rebase.autoStash on. */
function unmergedWithAutoStash(name: string): { r: Repo; sha: Record<string, string> } {
  const { r, sha } = fourCommits(name);
  r.write("three.txt", "stashed\n");
  r.git("stash", "-q");
  r.write("three.txt", "committed\n");
  sha.four = r.commitAll("four");
  assert.notEqual(r.tryGit("stash", "pop"), 0, "fixture: the pop conflicts");
  r.git("config", "rebase.autoStash", "true");
  return { r, sha };
}

test("a rebase git cannot autostash over an unmerged index rewrites nothing and leaves no queue", async () => {
  const { r, sha } = unmergedWithAutoStash("autostash-unmerged");
  try {
    const out = await runRebasePlan(r.root, {
      base: sha.two,
      todo: `reword ${sha.three} three\npick ${sha.four} four\n`,
      rewords: [{ sha: sha.three, message: "three, reworded" }],
    });
    assert.notEqual(out.status, "done");
    assert.equal(await isRebaseInProgress(r.root), false, "no rebase was started");
    assert.equal(r.sha("HEAD"), sha.four, "nothing was rewritten");
    assert.equal(existsSync(stagingQueue(r)), false, "and no queue is left for the next rebase to find");
    assert.ok(r.git("ls-files", "-u").trim().length > 0, "the conflicted pop is still the user's to resolve");
  } finally {
    r.cleanup();
  }
});

// git refuses this run up front ("f.txt: needs merge … fatal: Cannot
// autostash", exit 128, no rebase directory), and runRebasePlan used to match
// "needs merge" in that output and answer `{status: "stopped", reason:
// "conflict"}` — a paused rebase that did not exist, whose Continue/Abort then
// failed with "no rebase in progress". It is now refused before anything is
// written, as the user's own state.
test("a rebase git refuses to autostash over an unmerged index is a failure, not a stop", async () => {
  const { r, sha } = unmergedWithAutoStash("autostash-verdict");
  try {
    const out = await runRebasePlan(r.root, {
      base: sha.two,
      todo: `pick ${sha.three} three\npick ${sha.four} four\n`,
      rewords: [],
    });
    assert.equal(out.status, "failed");
    assert.equal(out.status === "failed" && out.expected, true, "the user's unmerged index, not ours to crash-report");
    assert.equal(await isRebaseInProgress(r.root), false);
  } finally {
    r.cleanup();
  }
});
